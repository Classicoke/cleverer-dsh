/**
 * dsh-plan-discipline — 任务规划纪律（补 Hermes 的"3+ 步任务必须建 todo"）
 *
 * DSH 有 tool-todo（todo_write 工具）但无强制纪律——模型爱用不用。
 * 本插件在 pre-step 检测：用户消息呈现多步骤任务信号，而本 turn 尚未
 * 写过 todo/write 事件 → 注入一条提醒，要求先用 todo_write 建计划。
 *
 * 触发信号（启发式，避免误报）：
 *  - 用户消息含步骤词：先/然后/接着/第一步/第二步/依次/逐个/分别/依次…
 *  - 或含数量词 + 任务词：3 个文件 / 两个功能 / 多个模块…
 *  - 或含明确的多任务连接词：以及/并且 + 动词（改/写/建/跑/测/查）
 *
 * 每 turn 最多提醒 1 次；用户消息本身不含多步骤信号时不打扰。
 *
 * 零依赖纯 ESM。挂载：
 *   ~/.dsh/cordis.patch.yml → - id: dsh-plan-discipline
 *                                name: 'file:///.../dsh-plan-discipline.mjs'
 */

import { randomUUID } from 'node:crypto'

export const name = 'dsh-plan-discipline'

const PLUGIN_SOURCE = { kind: 'plugin', plugin: name }

/** 多步骤信号词（用户消息命中即视为需要规划） */
const STEP_WORDS = [
  '先', '然后', '接着', '再', '首先', '最后', '第一步', '第二步', '第三步',
  '依次', '逐个', '分别', '逐一', '按顺序', '按以下', '步骤如下', '流程',
]
const MULTI_TASK_PATTERN = /(\d+)\s*(个|份|处|条|项|个文件|个模块)/

/** 是否判断为用户请求了多步骤任务 */
function looksMultiStep(text) {
  if (!text || text.length < 6) return false
  if (STEP_WORDS.some(w => text.includes(w))) return true
  if (MULTI_TASK_PATTERN.test(text)) return true
  return false
}

/** 从 agent 会话日志找最近的 todo/write 事件 */
function hasTodoInTurn(agent, turn) {
  try {
    const events = agent?.session?.events
    if (!events) return true // 无日志可查，保守不提醒
    // 找当前 turn 内（turn/start 之后）是否有 todo/write
    let inTurn = false
    for (const e of events) {
      if (e.type === 'turn/start' && e.data.turn === turn) inTurn = true
      if (inTurn && e.type === 'todo/write') return true
      // 当前 turn 已结束（进入下一 turn）→ 视为已有计划，不提醒
      if (inTurn && e.type === 'turn/end') return true
    }
    // 当前 turn 还在进行中但没写过 todo → 需要提醒
    return false
  } catch {
    return true
  }
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled ?? true
  if (!enabled) return
  const maxRemindersPerTurn = config.maxRemindersPerTurn ?? 1

  ctx.logger?.info?.('dsh-plan-discipline: plugin loaded (todo planning nudge)')

  // agent -> 本 turn 已提醒次数
  const reminded = new WeakMap()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    const agent = payload.agent
    if (!agent) return decision

    // 只对"进入新 turn 的第一步"提醒（用户消息刚进来时）
    const userMsgs = decision.messages.filter(m =>
      m?.source?.kind === 'user' || m?.source?.kind === undefined)
    if (userMsgs.length === 0) return decision

    // 检查用户消息是否有多步骤信号
    const userText = userMsgs.map(m =>
      (m?.content || []).map(b => b?.type === 'text' ? b.text : '').join('')
    ).join('\n')
    if (!looksMultiStep(userText)) return decision

    // 本 turn 是否已写过 todo
    if (hasTodoInTurn(agent, payload.turn)) return decision

    // 每 turn 最多提醒 N 次
    const count = reminded.get(agent) ?? 0
    if (count >= maxRemindersPerTurn) return decision
    reminded.set(agent, count + 1)

    // P1-1：试错期强制刷新——从 hub 读 turn 失败数（O7），失败≥3 且
    // 距上次 todo 写入已过 N 步 → 提醒更新计划（本次 A 路径 5 hack 教训：
    // 试错 1 小时 todo 完全没更新）
    const hubFails = (typeof ctx.__hubStats?.turnFails === 'function')
      ? ctx.__hubStats.turnFails(agent.id)
      : 0
    let text
    if (hubFails >= (config.failDensityTodoRefresh ?? 3)) {
      text = `<system-reminder>检测到本 turn 已失败 ${hubFails} 次（来自纪律 hub 统计）但 todo 列表未同步更新。**试错期必须持续维护计划**：把已失败的方案标记/排除，更新剩余步骤与当前方案，再继续。计划是防绕圈的锚，不是摆设。</system-reminder>`
    } else {
      text = `<system-reminder>检测到任务包含多个步骤。请先用 todo_write 工具建立任务清单（列出步骤、标记第一个为 in_progress），再开始执行。任务中途每完成一步更新一次 todo 列表。</system-reminder>`
    }
    const msg = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: PLUGIN_SOURCE,
    }
    return { kind: 'enter', messages: [...decision.messages, msg] }
  })
}
