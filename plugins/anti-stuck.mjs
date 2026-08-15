/**
 * anti-stuck — DSH 执行纪律插件（防死磕）
 *
 * 治三种病（对应 DSH 开发 session 的诊断）：
 *  1. 死磕：同一工具+同一参数连续失败 N 次 → 第 N+1 次相同调用直接 deny，强制换路
 *  2. 盲改：失败累计超标 → 在下一步注入"先定位根因再动手"的强制提醒
 *  3. 无反思：每个 turn 结束前检查失败密度，超标则 steer 一次反思总结
 *
 * 零依赖纯 ESM：不 import 任何 @deepseek-ai/* 包，只监听 cordis 事件。
 * 挂载方式：preset 组装文件里加一行
 *   - id: anti-stuck
 *     name: './plugins/anti-stuck.mjs'
 * （相对路径从 preset 目录解析）
 */

import { randomUUID } from 'node:crypto'

export const name = 'anti-stuck'

/** 插件配置（均可选） */
export const Config = undefined // 用普通对象即可，见 apply 的 config 参数

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'anti-stuck' }

const DEFAULT_CONFIG = {
  /** 同一指纹连续失败多少次后拒绝下一次相同调用 */
  maxSameFingerprintFails: 2,
  /** 单个 turn 内累计失败达到多少次后注入反思提醒 */
  maxFailsBeforeReflect: 3,
  /** 单个 turn 内累计失败达到多少次后在 turn-stopping 强制反思 */
  maxFailsBeforeSteer: 5,
  /** 每 agent 最多记住多少指纹（防内存膨胀） */
  maxFingerprintsPerAgent: 64,
  /** 注入提醒的最小间隔（秒），防刷屏 */
  reminderCooldownSec: 20,
  /** 同工具不同参数连续失败达到多少次 → 工具级密度提醒（P0-3 新增） */
  maxSameToolFails: 4,
  /** 产物路径注册表：失败文本命中 not found + 这些路径 → 顺序依赖提醒（P0-3 新增） */
  productPaths: [
    'release/win-unpacked/resources/app.asar',
    'win-unpacked/resources/app.asar',
    'resources/app.asar',
    'dist-main',
    'dist-renderer',
    '.pnpm-store',
  ],
}

/**
 * 计算一次工具调用的"指纹"——归一化后的身份，用于识别"完全相同的重试"。
 * pwsh/bash 命令去掉 cd 前缀、管道尾部装饰；edit/write 用文件路径 + 内容摘要。
 * P0-3 加强模糊化：去 env 前缀 / Select-Object 行数 / 重定向 / 2>&1 / Select-String 过滤器，
 * 让"同一命令微调装饰层"也落入同一指纹（本次 28→6 覆盖率过低的根因）。
 */
function fingerprint(exec) {
  const name = exec.name || '?'
  const args = exec.arguments || {}
  let sig = ''
  try {
    if (typeof args.command === 'string') {
      // shell 类工具：归一化命令（加强模糊化）
      sig = args.command
        .replace(/^cd\s+[^;]+;\s*/, '')                    // 去 cd 前缀
        .replace(/\$env:[A-Z_]+(\s*=\s*'[^']*'|\s*=\s*"[^"]*")?;\s*/g, '') // 去 env 设置
        .replace(/\s*2>&1\s*/g, ' ')                        // 去 2>&1
        .replace(/\s*\*\s*>\s*[^;]+/g, ' ')                 // 去 *> 重定向到文件
        .replace(/\s*\|\s*Select-Object\s+-Last\s+\d+/g, '') // 去 | Select-Object -Last N
        .replace(/\s*\|\s*Select-Object\s+-First\s+\d+/g, '') // 去 | Select-Object -First N
        .replace(/\s*\|\s*Select-String\s+[^|]*$/g, '')     // 去尾部 | Select-String ...
        .replace(/\s*\|\s*Select-Object\s+[^|]*$/g, '')     // 去尾部 | Select-Object ...
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300)
    } else if (typeof args.file_path === 'string' || typeof args.path === 'string') {
      // fs 类工具：文件路径 + 关键参数摘要
      const fp = args.file_path || args.path || ''
      if (name === 'edit') {
        const oldStr = String(args.old_string || '').slice(0, 80)
        sig = `${fp}::${oldStr}`
      } else {
        sig = fp
      }
    } else {
      sig = JSON.stringify(args).slice(0, 300)
    }
  } catch {
    sig = String(args).slice(0, 300)
  }
  return `${name}::${sig}`
}

/** 判断一次工具结果是否算"失败"（用于死磕统计） */
function isFailure(result) {
  if (!result) return false
  if (result.isError === true) return true
  // 兜底 1: canonical value 里的 exitCode（pwsh/bash 工具的 value 形状）
  try {
    const v = result.value
    if (v && typeof v === 'object') {
      const code = v.exitCode
      if (typeof code === 'number' && code !== 0) return true
    }
  } catch { /* ignore */ }
  // 兜底 2: 渲染文本里的失败标记（[exit code: N]、error、failed 等）
  const txt = JSON.stringify(result.content || result || '').toLowerCase()
  return /(\[exit code: [1-9]|error|exception|traceback|command failed|failed:|exit code: [1-9])/.test(txt)
}

/** 归一化的文本内容（用于失败原因提取）
 *  P0-3 fix：必须提取纯文本而非 JSON.stringify——JSON 转义会把反斜杠变
 *  `\\`（双反斜杠），导致路径归一化后 `resources//app.asar` 匹配失败。 */
function failureText(result) {
  try {
    const c = result?.content
    if (Array.isArray(c)) {
      const texts = c.map(b => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '')
      const joined = texts.join(' ')
      if (joined) return joined.slice(0, 400)
    }
  } catch { /* ignore */ }
  return JSON.stringify(result || '').slice(0, 400)
}

/** 从 agent 的 session 事件流推断当前 turn 号（无则 0） */
function currentTurn(agent) {
  try {
    const events = agent?.session?.events
    if (!events) return 0
    const last = [...events].findLast(e => e.type === 'turn/start')
    return last && last.type === 'turn/start' ? last.data.turn : 0
  } catch {
    return 0
  }
}

/** 某 agent 当前 turn 内的失败总数（按失败记录归属的 turn 聚合） */
function turnFailsOf(failState, agentId, turn) {
  const s = failState.get(agentId)
  if (!s) return 0
  let n = 0
  for (const v of s.values()) {
    if (v.turn === turn) n += v.count
  }
  return n
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  ctx.logger?.info?.('anti-stuck: plugin loaded (execution discipline active)')

  // agentId -> Map<fingerprint, {count, firstAt, lastAt, lastFailureText, turn}>
  const failState = new Map()
  // agentId -> Map<toolName, {count, lastAt, turn}>  工具级失败密度（P0-3）
  const toolFailState = new Map()
  // agentId -> Map<kind, {text, at, turn}>  特殊错误（顺序依赖/旧快照）（P0-3）
  const specialState = new Map()
  // agentId -> 最近一次提醒时间戳
  const lastReminderAt = new Map()

  function stateFor(agentId) {
    let s = failState.get(agentId)
    if (!s) {
      s = new Map()
      failState.set(agentId, s)
    }
    return s
  }

  function toolStateFor(agentId) {
    let s = toolFailState.get(agentId)
    if (!s) {
      s = new Map()
      toolFailState.set(agentId, s)
    }
    return s
  }

  function specialFor(agentId) {
    let s = specialState.get(agentId)
    if (!s) {
      s = new Map()
      specialState.set(agentId, s)
    }
    return s
  }

  /** P0-3：顺序依赖检测——失败文本含 not found/ENOENT 且命中产物路径注册表 */
  function detectOrderDep(txt) {
    if (!/(not found|ENOENT|no such file)/i.test(txt)) return null
    // 路径分隔符归一化（Windows 反斜杠 vs 注册表正斜杠）
    const norm = txt.replace(/\\/g, '/')
    const hit = cfg.productPaths.find(p => norm.includes(p))
    return hit ? { hit } : null
  }

  /** P0-3：旧快照检测——edit 失败 old_string was not found */
  function detectStaleSnapshot(exec, txt) {
    if (exec.name !== 'edit') return null
    if (!/old_string was not found/i.test(txt)) return null
    return { file: exec.arguments?.file_path || exec.arguments?.path || '' }
  }

  function totalFails(agentId) {
    let n = 0
    for (const v of stateFor(agentId).values()) n += v.count
    return n
  }

  /** 本插件自己 deny 产生的失败不计数（reason 带特征前缀） */
  const DENY_PREFIX = '[anti-stuck]'

  // ── 1. 统计失败（tools/result: emit，无副作用）───────────────────────────
  ctx.on('tools/result', (exec, result) => {
    if (!exec || !exec.agent) return
    const agentId = exec.agent.id
    const fp = fingerprint(exec)
    const s = stateFor(agentId)

    if (isFailure(result)) {
      const txt = failureText(result)
      // 忽略自己 deny 产生的失败
      if (txt.includes(DENY_PREFIX)) return
      const turn = currentTurn(exec.agent)
      const rec = s.get(fp) || { count: 0, firstAt: Date.now(), lastAt: 0, lastFailureText: txt, turn }
      rec.count += 1
      rec.lastAt = Date.now()
      rec.lastFailureText = txt
      rec.turn = turn
      s.set(fp, rec)
      // 容量保护
      if (s.size > cfg.maxFingerprintsPerAgent) {
        const oldest = [...s.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0]
        if (oldest) s.delete(oldest[0])
      }
      // P0-3：工具级失败密度（同工具不同参数也算）
      const tName = exec.name || '?'
      const ts = toolStateFor(agentId)
      const trec = ts.get(tName) || { count: 0, lastAt: 0, turn }
      trec.count += 1
      trec.lastAt = Date.now()
      trec.turn = turn
      ts.set(tName, trec)
      // P0-3：特殊错误检测（顺序依赖 / 旧快照）
      const sp = specialFor(agentId)
      const od = detectOrderDep(txt)
      if (od) {
        sp.set(`order-dep:${od.hit}`, { text: `检测到 ${od.hit} 不存在——它通常是前置构建/打包步骤的产物。运行本命令前先验证前置产物已生成（检查流水线顺序），例如：先跑 --dir 再跑 fixup。`, at: Date.now(), turn })
      }
      const ss = detectStaleSnapshot(exec, txt)
      if (ss) {
        sp.set(`stale-snapshot:${ss.file}`, { text: `edit 的 old_string 在 ${ss.file} 中未找到——文件内容已被改动或你的 old_string 是旧快照。先 read 该文件当前内容，再以实际内容为 old_string 重试。`, at: Date.now(), turn })
      }
      // 共享 __errLog（M1.5 协作层预留：hub 存在时写入）
      if (ctx.__errLog && Array.isArray(ctx.__errLog)) {
        ctx.__errLog.push({ at: Date.now(), turn, tool: exec.name, fp, errorClass: od ? 'order-dep' : ss ? 'stale-snapshot' : 'same-tool', text: txt.slice(0, 200) })
      }
    } else {
      // 成功：清掉该指纹的失败记录（连续失败才算死磕）
      s.delete(fp)
      // P0-3：工具级也衰减（同工具成功一次 → 密度-1，防误报）
      const tName = exec.name || '?'
      const ts = toolStateFor(agentId)
      const trec = ts.get(tName)
      if (trec) {
        trec.count = Math.max(0, trec.count - 1)
        if (trec.count === 0) ts.delete(tName)
      }
    }
  })

  // ── 2. 拒绝完全相同的重试（tools/pre-execute: waterfall）─────────────────
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec || !exec.agent) return next()
    const agentId = exec.agent.id
    const fp = fingerprint(exec)
    const rec = stateFor(agentId).get(fp)
    if (rec && rec.count >= cfg.maxSameFingerprintFails) {
      const reason = `${DENY_PREFIX} 你已连续 ${rec.count} 次以相同参数调用 ${exec.name} 失败（相同指纹）。禁止第 ${rec.count + 1} 次相同重试。现在必须换路：1) 先读取相关源码/配置/文档定位失败根因；2) 换一种方法或参数；3) 若定位不了，向用户如实报告卡点。`
      ctx.logger?.warn?.(`anti-stuck: denied duplicate ${exec.name} (fail x${rec.count})`)
      return { kind: 'deny', reason }
    }
    return next()
  })

  // ── 3. 注入反思提醒（agent/pre-step: waterfall）──────────────────────────
  ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
    const downstream = await next()
    if (!downstream || downstream.kind !== 'enter') return downstream
    if (!agent) return downstream

    const agentId = agent.id
    const now = Date.now()
    const cooldownOk = now - (lastReminderAt.get(agentId) || 0) > cfg.reminderCooldownSec * 1000
    // 本 turn 已注入过则跳过（用 turn 号记忆）
    const lastInjectedTurn = ctx.__antiStuckInjectedTurn?.get?.(agentId)
    if (lastInjectedTurn === turn || !cooldownOk) return downstream

    // P0-3 优先级 1：特殊错误（顺序依赖 / 旧快照）——精准提醒
    const sp = specialFor(agentId)
    const specialEntries = [...sp.entries()].filter(([, v]) => v.turn === turn)
    if (specialEntries.length > 0) {
      const [kind, v] = specialEntries[specialEntries.length - 1]
      sp.delete(kind) // 消费掉，防止重复注入
      if (!ctx.__antiStuckInjectedTurn) ctx.__antiStuckInjectedTurn = new Map()
      ctx.__antiStuckInjectedTurn.set(agentId, turn)
      lastReminderAt.set(agentId, now)
      const ours = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `【anti-stuck 精准提醒】${v.text}` }],
        source: PLUGIN_SOURCE,
      }
      return { kind: 'enter', messages: [...downstream.messages, ours] }
    }

    // P0-3 优先级 2：工具级失败密度（同工具不同参数连续失败）
    const ts = toolStateFor(agentId)
    const hotTools = [...ts.entries()]
      .filter(([, r]) => r.count >= cfg.maxSameToolFails && r.turn === turn)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 2)
    if (hotTools.length > 0) {
      const list = hotTools.map(([t, r]) => `  - ${t}（本 turn 已失败 ${r.count} 次，参数各异）`).join('\n')
      if (!ctx.__antiStuckInjectedTurn) ctx.__antiStuckInjectedTurn = new Map()
      ctx.__antiStuckInjectedTurn.set(agentId, turn)
      lastReminderAt.set(agentId, now)
      const ours = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `【工具级失败提醒】同一工具反复失败且参数各不相同——很可能是同一根因在不同深度暴露（例如构建流水线：A 环节修好 → B 环节下一个错误暴露）。\n${list}\n\n停下分析：这些失败是否同源？按流水线环节分组定位根因，不要继续换参数重试。` }],
        source: PLUGIN_SOURCE,
      }
      return { kind: 'enter', messages: [...downstream.messages, ours] }
    }

    const turnFails = turnFailsOf(failState, agentId, turn)
    if (turnFails < cfg.maxFailsBeforeReflect && totalFails(agentId) < cfg.maxFailsBeforeReflect * 2) {
      return downstream
    }

    // 组装提醒文本：列出失败最多的前 3 个指纹；若本 turn 密度高但没有
    // 重复指纹，则用总数兜底（多命令连续失败同样需要反思）
    const s = stateFor(agentId)
    const top = [...s.entries()]
      .filter(([, r]) => r.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3)
      .map(([fp, r]) => `  - ${fp}（连续失败 ${r.count} 次）`)
      .join('\n')

    let text
    if (top) {
      text = `【执行纪律提醒】检测到你在本任务中反复失败：\n${top}\n\n停止重试。现在必须：1) 读取相关源码/配置/文档，定位失败的根因（不是换措辞重试，是找原因）；2) 如已定位，换一种实现方式；3) 若仍无法解决，停下来向用户如实报告卡点，不要假装完成。`
    } else {
      text = `【执行纪律提醒】检测到本回合已累计失败 ${turnFails} 次（累计 ${totalFails(agentId)} 次），且尚未取得进展。现在必须：1) 停下来总结卡点在哪里、已尝试了什么、为什么失败；2) 读取相关源码/配置/文档定位根因；3) 换一种方法，或向用户如实报告卡点，不要盲目继续。`
    }
    if (!ctx.__antiStuckInjectedTurn) ctx.__antiStuckInjectedTurn = new Map()
    ctx.__antiStuckInjectedTurn.set(agentId, turn)
    lastReminderAt.set(agentId, now)

    const ours = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: PLUGIN_SOURCE,
    }
    return { kind: 'enter', messages: [...downstream.messages, ours] }
  })

  // ── 4. 高失败密度时强制反思（agent/turn-stopping: serial）────────────────
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    if (!agent) return
    const agentId = agent.id
    // P0-5（2026-08-16 验收测试实测）：steer 防重复——同 turn 只 steer 一次。
    // 测试会话暴露：单 turn 长会话（无 turn/end）里 turn-stopping 每次 LLM 轮次
    // 结束都触发，失败计数不重置 → 相同文本+相同计数循环 steer 7+ 次，
    // agent 被迫 ask_user_question 打断（agent 自记教训"反思循环误报"）。
    const lastSteeredTurn = ctx.__antiStuckSteeredTurn?.get?.(agentId)
    if (lastSteeredTurn === turn) return
    const turnFails = turnFailsOf(failState, agentId, turn)
    // P0-3：工具级密度也纳入 steer 触发
    const ts = toolStateFor(agentId)
    const toolFails = [...ts.values()].filter(r => r.turn === turn).reduce((n, r) => n + r.count, 0)
    if (turnFails >= cfg.maxFailsBeforeSteer || toolFails >= cfg.maxSameToolFails * 2) {
      if (!ctx.__antiStuckSteeredTurn) ctx.__antiStuckSteeredTurn = new Map()
      ctx.__antiStuckSteeredTurn.set(agentId, turn)
      const text = `【强制反思】本回合累计失败 ${turnFails} 次（工具级累计 ${toolFails} 次）。在继续之前，先总结：卡点是什么？已尝试了什么？为什么失败？下一步应该换什么方法（或是否该向用户报告）？不要盲目继续。`
      try {
        agent.steer({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: PLUGIN_SOURCE,
        })
        ctx.logger?.warn?.(`anti-stuck: steered reflection for ${agentId} (${turnFails} fails this turn)`)
      } catch {
        // steer 失败不致命
      }
    }
  })

  // ── 清理：agent 销毁时释放状态 ────────────────────────────────────────────
  ctx.effect(() => {
    const timer = setInterval(() => {
      // 每 10 分钟清理一次超过 30 分钟未活动的 agent 状态
      const cutoff = Date.now() - 30 * 60 * 1000
      for (const [agentId, s] of failState) {
        const last = Math.max(...[...s.values()].map(v => v.lastAt), 0)
        if (last < cutoff) failState.delete(agentId)
      }
      for (const [agentId, ts2] of toolFailState) {
        const last = Math.max(...[...ts2.values()].map(v => v.lastAt), 0)
        if (last < cutoff) toolFailState.delete(agentId)
      }
      for (const [agentId, sp] of specialState) {
        const last = Math.max(...[...sp.values()].map(v => v.at), 0)
        if (last < cutoff) specialState.delete(agentId)
      }
      for (const [agentId, at] of lastReminderAt) {
        if (at < cutoff) lastReminderAt.delete(agentId)
      }
    }, 10 * 60 * 1000)
    return () => clearInterval(timer)
  }, 'anti-stuck: state cleanup')
}
