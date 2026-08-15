/**
 * discipline-hub — 纪律插件协作中枢（M1.5，O1+O2+O7）
 *
 * 解决的问题（打包日志取证）：
 *  - O1 数据流断裂：4 个插件各在 tools/result 独立统计失败，无共享记录 →
 *    env-triage/skill-evolver 读"连续 N 次失败"要自己重算。
 *    hub 统一聚合 __errLog（schema 化 + 错误分类），全插件从它读。
 *  - O2 提醒注入冲突：pre-step 上 3 个注入器各发各的，同一步可塞 3 条
 *    reminder → hub 提供统一注入口 ctx.__reminder()，按优先级合并、
 *    单步最多 1-2 条。
 *  - O7 生命周期：turn/start → pre-step → tools/result → turn-stopping →
 *    turn/end 各阶段统计与清理由 hub 统一维护。
 *
 * 用法（其他插件）：
 *   ctx.__errLog.push({ ... })           // O1: 写失败记录（或由 hub 自动聚合）
 *   ctx.__reminder({ priority, text })   // O2: 排队一条提醒，pre-step 仲裁注入
 *   ctx.__hubStats.turnFails(agentId)    // O7: 查当前 turn 失败数
 *
 * 零依赖纯 ESM。挂载（必须在所有纪律插件之前，作为顶层 hub）：
 *   ~/.dsh/cordis.patch.yml 最顶部:
 *   - id: discipline-hub
 *     name: 'file:///.../discipline-hub.mjs'
 */
import { randomUUID } from 'node:crypto'

export const name = 'discipline-hub'

const PLUGIN_SOURCE = { kind: 'plugin', plugin: name }

/** 提醒优先级（数值越小越优先注入） */
export const REMINDER_PRIORITY = {
  deny: 1,           // anti-stuck 拒绝重试（最高）
  'root-cause': 2,   // env-triage 溯源卡
  special: 3,        // anti-stuck 精准提醒（顺序依赖/旧快照）
  reflect: 4,        // 反思
  'tool-density': 5, // 工具级密度
  todo: 6,           // plan-discipline
  skill: 7,          // skill-loader 点名
}

const DEFAULT_CONFIG = {
  /** 单步最多注入几条提醒（防刷屏） */
  maxRemindersPerStep: 2,
  /** __errLog 上限（超过则丢弃最旧） */
  errLogLimit: 500,
  /** 错误分类关键词表（按特异性排序：具体模式在前，避免 "old_string was not found" 被 order-dep 的 "not found" 抢先） */
  errorClasses: [
    { cls: 'stale-snapshot', re: /old_string was not found/i },
    { cls: 'missing-module', re: /(cannot resolve|Cannot find module|module not found|ERR_MODULE_NOT_FOUND|ERR_DLOPEN)/i },
    { cls: 'order-dep', re: /(not found|ENOENT|no such file|module cannot be found)/i },
    { cls: 'permission', re: /(permission denied|EACCES|EPERM|denied)/i },
    { cls: 'network', re: /(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|fetch failed|socket)/i },
    { cls: 'syntax', re: /(SyntaxError|Unexpected token|Parse error)/i },
  ],
}

/** 提取工具结果纯文本（与 anti-stuck 同源逻辑，避免 JSON 转义坑） */
function extractText(result) {
  try {
    const c = result?.content
    if (Array.isArray(c)) {
      const joined = c.map(b => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '').join(' ')
      if (joined) return joined.slice(0, 300)
    }
  } catch { /* ignore */ }
  return JSON.stringify(result || '').slice(0, 300)
}

/** 判定是否失败 */
function isFailure(result) {
  if (!result) return false
  if (result.isError === true) return true
  try {
    const v = result.value
    if (v && typeof v === 'object') {
      const code = v.exitCode
      if (typeof code === 'number' && code !== 0) return true
    }
  } catch { /* ignore */ }
  const txt = JSON.stringify(result.content || result || '').toLowerCase()
  return /(\[exit code: [1-9]|error|exception|traceback|command failed|failed:|exit code: [1-9])/.test(txt)
}

/** 错误分类：按关键词表匹配，返回 cls */
function classify(txt, cfg) {
  if (!txt) return 'unknown'
  for (const { cls, re } of cfg.errorClasses) {
    if (re.test(txt)) return cls
  }
  return 'generic'
}

/** 指纹（精简版，供 __errLog 记录） */
function fingerprint(exec) {
  const name = exec.name || '?'
  const args = exec.arguments || {}
  let sig = ''
  try {
    if (typeof args.command === 'string') {
      sig = args.command
        .replace(/^cd\s+[^;]+;\s*/, '')
        .replace(/\$env:[A-Z_]+(\s*=\s*'[^']*'|\s*=\s*"[^"]*")?;\s*/g, '')
        .replace(/\s*2>&1\s*/g, ' ')
        .replace(/\s*\*\s*>\s*[^;]+/g, ' ')
        .replace(/\s*\|\s*Select-(Object|String)[^|]*/g, '')
        .replace(/\s+/g, ' ').trim().slice(0, 200)
    } else if (typeof args.file_path === 'string' || typeof args.path === 'string') {
      sig = args.file_path || args.path || ''
    } else {
      sig = JSON.stringify(args).slice(0, 200)
    }
  } catch { sig = String(args).slice(0, 200) }
  return `${name}::${sig}`
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  ctx.logger?.info?.('discipline-hub: loaded (errLog aggregation + reminder arbitration)')

  // ── O1: __errLog 统一失败记录 ────────────────────────────────────────
  if (!Array.isArray(ctx.__errLog)) ctx.__errLog = []
  // turn 级统计：agentId -> { turn, fails, firstAt }
  const turnStats = new Map()

  // hub 自己聚合 tools/result（所有失败都记录，带分类）
  ctx.on('tools/result', (exec, result) => {
    if (!exec?.agent) return
    const txt = extractText(result)
    const turn = exec.agent.session?.events
      ? [...exec.agent.session.events].findLast(e => e.type === 'turn/start')?.data?.turn ?? 0
      : 0
    const rec = {
      at: Date.now(),
      turn,
      tool: exec.name,
      fp: fingerprint(exec),
      errorClass: isFailure(result) ? classify(txt, cfg) : 'success',
      isFailure: isFailure(result),
      text: txt.slice(0, 200),
    }
    ctx.__errLog.push(rec)
    // 容量保护
    if (ctx.__errLog.length > cfg.errLogLimit) {
      ctx.__errLog.splice(0, ctx.__errLog.length - cfg.errLogLimit)
    }
    // turn 统计
    if (rec.isFailure) {
      const st = turnStats.get(exec.agent.id) || { turn, fails: 0 }
      if (st.turn !== turn) { st.turn = turn; st.fails = 0 }
      st.fails += 1
      turnStats.set(exec.agent.id, st)
    }
  })

  // O7: 查询接口——当前 turn 失败数
  ctx.__hubStats = {
    turnFails(agentId) {
      return turnStats.get(agentId)?.fails ?? 0
    },
    errLog() { return ctx.__errLog },
    classify,
  }

  // ── O2: 提醒仲裁 ─────────────────────────────────────────────────────
  // agentId -> 待注入提醒队列 [{priority, text, ts}]
  const reminderQueues = new Map()
  ctx.__reminder = (agentId, payload) => {
    if (!agentId || !payload?.text) return
    const q = reminderQueues.get(agentId) || []
    q.push({
      priority: payload.priority ?? 5,
      text: payload.text,
      ts: Date.now(),
      id: payload.id ?? randomUUID(),
    })
    reminderQueues.set(agentId, q)
  }

  // pre-step：仲裁注入——从队列取最高优先级 1-2 条，追加到 messages
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    const agent = payload?.agent
    if (!agent) return decision

    const q = reminderQueues.get(agent.id)
    if (!q || q.length === 0) return decision

    // 按优先级排序，取前 maxRemindersPerStep 条
    q.sort((a, b) => a.priority - b.priority || a.ts - b.ts)
    const take = q.splice(0, cfg.maxRemindersPerStep)
    const msgs = take.map(p => ({
      id: p.id,
      role: 'user',
      content: [{ type: 'text', text: p.text }],
      source: PLUGIN_SOURCE,
    }))
    return { kind: 'enter', messages: [...decision.messages, ...msgs] }
  })

  // ── 清理 ─────────────────────────────────────────────────────────────
  ctx.effect(() => {
    const timer = setInterval(() => {
      const cutoff = Date.now() - 30 * 60 * 1000
      for (const [agentId, st] of turnStats) {
        if (st.fails === 0) turnStats.delete(agentId)
      }
      for (const [agentId, q] of reminderQueues) {
        if (q.every(r => r.ts < cutoff)) reminderQueues.delete(agentId)
      }
    }, 10 * 60 * 1000)
    return () => clearInterval(timer)
  }, 'discipline-hub: state cleanup')
}
