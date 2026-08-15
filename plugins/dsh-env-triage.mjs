/**
 * dsh-env-triage — 方案级溯源与纠偏插件（M2，O3 职责分层 + O4 根因回写）
 *
 * 与 anti-stuck 的分工（O3）：
 *   anti-stuck  = 工具级：同参 deny / 旧快照 / 顺序依赖（精确、即时）
 *   env-triage  = 方案级：换参溯源 / 3 方案全败→报告 / turn 复盘（策略、事后）
 *   触发条件互斥：anti-stuck 管"第 3 次同参"，env-triage 管"第 2 种方案失败"。
 *
 * 数据源：discipline-hub 的 ctx.__errLog（O1 聚合）。读不写，O4 回写根因标记
 * （rootCause/solution 字段）供 skill-evolver 取高质量沉淀素材。
 *
 * 三张卡：
 *   1. 溯源卡：同 agent 连续失败 ≥2 次且涉及 ≥2 个不同工具/方案 →
 *      注入"读该工具源码/文档定位根因，勿继续换参"（debug-by-root-cause 执行者）
 *   2. 绕圈卡：≥3 种不同方案（指纹差异大）均失败 →
 *      注入"停下，向用户报告，不再试第 4 种"（A 路径 5 hack 教训）
 *   3. turn 复盘：turn-stopping 时若 turn 失败 ≥5 → 注入方案级复盘
 *      （与 anti-stuck 的 steer 协同但侧重方案演进而非工具行为）
 *
 * 零依赖纯 ESM。挂载：cordis.patch.yml 的 insert 列表（在 discipline-hub 之后）。
 */
import { randomUUID } from 'node:crypto'
import { isFailure, extractText, classifyError, similarity, currentTurn, makeCleanupTimer } from './_shared.mjs'

export const name = 'dsh-env-triage'

const PLUGIN_SOURCE = { kind: 'plugin', plugin: name }

const DEFAULT_CONFIG = {
  /** 溯源卡触发：连续失败 ≥ N 次 */
  minFailsForTrace: 2,
  /** 绕圈卡触发：不同方案失败 ≥ N 种 */
  maxSchemesBeforeReport: 3,
  /** turn 复盘触发：turn 失败 ≥ N 次 */
  maxTurnFailsForReview: 5,
  /** 每 turn 最多注入提醒次数 */
  maxRemindersPerTurn: 2,
  /** 方案判定：指纹差异 ≥ 此值视为"不同方案"（bigram Jaccard） */
  schemeDistinctThreshold: 0.4,
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  ctx.logger?.info?.('dsh-env-triage: loaded (scheme-level tracing)')

  // agentId -> { turn, fails: [{fp, cls, ts}], warned: {trace, circle, review} }
  const state = new Map()

  function stateFor(agentId) {
    let s = state.get(agentId)
    if (!s) { s = { turn: 0, fails: [], warned: {} }; state.set(agentId, s) }
    return s
  }

  // ── 1. 观察失败（tools/result）：记录到本插件状态（与 hub 并行）────────
  ctx.on('tools/result', (exec, result) => {
    if (!exec?.agent) return
    // 非失败直接忽略（成功会重置 turn 内失败？不——连续失败窗口只往前看）
    const isFail = isFailure(result)
    if (!isFail) return

    const agentId = exec.agent.id
    const s = stateFor(agentId)
    const turn = currentTurn(exec.agent)
    if (s.turn !== turn) { s.turn = turn; s.fails = [] }

    // 从 hub __errLog 拿分类（若 hub 存在）；独立分类器兜底
    let cls = 'generic'
    const text = extractText(result, 150)
    // 独立分类（与 hub classify 同规则，避免依赖 errLog 时序/字段完整性）
    cls = classifyError(text)
    // errLog 反查补充（仅当独立分类未命中且 hub 存在）
    if (cls === 'generic' && Array.isArray(ctx.__errLog)) {
      const last = [...ctx.__errLog].reverse().find(r => r.errorClass && r.text && text && r.text.includes(text.slice(0, 30)))
      if (last) cls = last.errorClass
    }
    s.fails.push({ fp: `${exec.name}::${String(exec.arguments?.command || exec.arguments?.file_path || '').slice(0, 80)}`, cls, ts: Date.now(), text })
    if (s.fails.length > 12) s.fails.shift()
  })

  // ── 2. 溯源卡 / 绕圈卡（agent/pre-step）───────────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    const agent = payload?.agent
    if (!agent) return decision

    const s = stateFor(agent.id)
    if (s.fails.length < cfg.minFailsForTrace) return decision

    // 方案数：按指纹 bigram 相似度分组（< 阈值算不同方案）
    const fps = [...new Set(s.fails.map(f => f.fp))]
    let schemes = 1
    for (let i = 1; i < fps.length; i++) {
      if (Math.max(...fps.slice(0, i).map(f => similarity(f, fps[i]))) < cfg.schemeDistinctThreshold) schemes++
    }
    const warned = s.warned
    const reminders = []

    // 绕圈卡优先（更严重）：≥3 种方案全败 → 报告用户
    if (schemes >= cfg.maxSchemesBeforeReport && !warned.circle) {
      warned.circle = true
      reminders.push({
        text: `【env-triage 绕圈卡】你已尝试 ${schemes} 种不同方案均失败（本 turn 累计 ${s.fails.length} 次失败）。继续试第 ${schemes + 1} 种大概率还是同一根因。**停下**：1) 总结已试方案与各自失败点；2) 读取工具源码/文档定位根因；3) 定位不了就向用户如实报告，请用户决策。`,
        priority: 2, // root-cause 级
      })
    } else if (schemes >= 2 && !warned.trace) {
      // 溯源卡：≥2 种方案失败 → 读源码定位（不再换参）
      warned.trace = true
      reminders.push({
        text: `【env-triage 溯源卡】检测到 ${schemes} 种不同方案连续失败——继续换参数大概率无效，很可能是同一环境根因（依赖/构建配置/权限）。现在**读相关工具源码或文档定位根因**，而不是再试新方案。已失败方案：${fps.slice(-3).map(f => f.split('::')[0] + ':' + f.split('::')[1]?.slice(0, 40)).join(' | ')}`,
        priority: 2,
      })
    }

    if (reminders.length === 0) return decision

    // 通过 hub 仲裁（若存在），否则直接注入
    if (typeof ctx.__reminder === 'function') {
      for (const r of reminders) ctx.__reminder(agent.id, r)
      return decision // hub 会在它的 pre-step 注入
    }
    // 无 hub 兜底：直接注入第一条
    const msg = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: reminders[0].text }],
      source: PLUGIN_SOURCE,
    }
    return { kind: 'enter', messages: [...decision.messages, msg] }
  })

  // ── 3. turn 复盘 + O4 根因回写（agent/turn-stopping）────────────────
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!agent) return
    const s = stateFor(agent.id)
    if (s.fails.length < cfg.maxTurnFailsForReview || s.warned.review) return
    s.warned.review = true

    // 按错误分类聚合，找最高频类 → 作为根因候选回写 __errLog（O4）
    const byCls = {}
    for (const f of s.fails) byCls[f.cls] = (byCls[f.cls] || 0) + 1
    const topCls = Object.entries(byCls).sort((a, b) => b[1] - a[1])[0]
    if (topCls && Array.isArray(ctx.__errLog)) {
      // 给本 turn 同类的失败记录打根因标记（供 skill-evolver 取料）
      for (const r of ctx.__errLog) {
        if (r.turn === turn && r.errorClass === topCls[0] && !r.rootCause) {
          r.rootCause = topCls[0]
          r.rootCauseCount = topCls[1]
        }
      }
    }

    const text = `【env-triage turn 复盘】本 turn 失败 ${s.fails.length} 次，最高频错误类：${topCls ? topCls[0] : 'unknown'}（${topCls ? topCls[1] : 0} 次）。请做方案级复盘：这些失败是否同一根因？下一步是修根因、换技术路线、还是向用户报告？`
    try {
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: PLUGIN_SOURCE,
      })
    } catch { /* 不致命 */ }
  })

  // ── 清理 ─────────────────────────────────────────────────────────────
  ctx.effect(() => makeCleanupTimer((cutoff) => {
    for (const [agentId, s] of state) {
      if (s.fails.length === 0 || s.fails[s.fails.length - 1].ts < cutoff) state.delete(agentId)
    }
  }), 'dsh-env-triage: state cleanup')
}
