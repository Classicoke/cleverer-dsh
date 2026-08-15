/**
 * dsh-skill-loader — 纪律 skill 加载促进插件（P0-1）
 *
 * 问题：system-reminder 指示 "call the skill tool"，但 agent 全程 0 次调用
 * （打包任务取证：三个手写纪律 skill 从未被正式加载）。根因是 skill 清单
 * 只在会话开头注入一次，且无"场景 → skill"的显式映射，agent 不知道何时该加载。
 *
 * 本插件：
 *  1. turn/start 时注入**条件化** skill 清单——只列 skill 名 + 一句话触发条件
 *     （不注入全文，防撑爆上下文；全文由 skill 工具按需加载）
 *  2. 用户消息命中某 skill 的触发条件 → 在 pre-step 点名该 skill，要求先加载
 *  3. 与 dsh-discipline 纪律段互补：纪律段是静态行为准则，本插件是动态场景映射
 *
 * 零依赖纯 ESM。挂载：
 *   ~/.dsh/cordis.patch.yml → - id: dsh-skill-loader
 *                              name: 'file:///.../dsh-skill-loader.mjs'
 */
import { randomUUID } from 'node:crypto'
import { makeCleanupTimer } from './_shared.mjs'

export const name = 'dsh-skill-loader'

const PLUGIN_SOURCE = { kind: 'plugin', plugin: name }

/** 默认 skill 注册表：场景关键词 → skill 名 + 触发条件说明 */
const DEFAULT_SKILLS = [
  {
    name: 'dsh-error-protocol',
    trigger: '工具失败/报错时：六步协议（分类→诊断→决策→验证→沉淀）',
    keywords: ['失败', '报错', 'error', 'failed', 'exit code', '找不到', 'cannot', 'ENOENT', '卡住', '重试'],
  },
  {
    name: 'dsh-error-triage',
    trigger: '错误已分类但不知怎么诊断/修：查路由表（打包/依赖/原生模块/权限/网络）',
    keywords: ['打包', 'electron-builder', 'asar', 'sharp', 'dlopen', '镜像', 'collector', '依赖'],
  },
  {
    name: 'debug-by-root-cause',
    trigger: '工具调用连续失败 2 次以上，或需要定位失败根因',
    keywords: ['失败', '报错', 'error', 'failed', '卡住', '重试', '找不到', 'cannot', 'ENOENT'],
  },
  {
    name: 'local-first',
    trigger: '需要查事实（版本/API/配置）时，先查本地源码/文档/配置',
    keywords: ['查一下', '怎么用', '版本', '是什么', '哪里', '找一下', '查查'],
  },
  {
    name: 'dsh-fast-lookup',
    trigger: '找文件/查东西/定位实体：先 fast_locate 一步扫描（并行多根、跳过噪音目录），别串行 grep→pwsh',
    keywords: ['在哪', '找文件', '搜', '位置', '路径', '查找', '定位', '找一下', '查查'],
  },
  {
    name: 'plan-before-execute',
    trigger: '多步骤任务（先/然后/逐个/多个文件/流程）',
    keywords: ['先', '然后', '接着', '第一步', '第二步', '依次', '逐个', '分别', '流程', '多个', '几个'],
  },
]

export function apply(ctx, config = {}) {
  const enabled = config.enabled ?? true
  if (!enabled) return
  const skills = config.skills ?? DEFAULT_SKILLS
  const maxInjectsPerTurn = config.maxInjectsPerTurn ?? 1

  ctx.logger?.info?.(`dsh-skill-loader: loaded (${skills.length} skills registered)`)

  // agentId -> 本 turn 已注入次数
  const injected = new Map()
  // agentId -> 会话级清单注入时间戳（每 agent 仅一次，防刷屏）
  const listShownAt = new Map()

  /** 用户消息文本 → 命中的 skill 列表 */
  function matchSkills(text) {
    if (!text) return []
    const hits = []
    for (const s of skills) {
      const kw = s.keywords || []
      if (kw.some(k => text.includes(k))) hits.push(s)
    }
    return hits
  }

  // ── 1. 会话级 skill 清单（每个 agent 首步注入一次）────────────────────
  // DSH 无 agent/turn-start 事件（实查 runtime-types.ts），pre-step 是唯一
  // 可返回消息的注入点；用 listShown 保证只注入一次，不刷屏。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    const agent = payload?.agent
    if (!agent || listShownAt.has(agent.id)) return decision

    const list = skills.map(s => `- \`${s.name}\`：${s.trigger}`).join('\n')
    const text = `<system-reminder>可用的纪律 skill（任务命中触发条件时，先用 skill 工具加载对应 skill 再行动）：\n${list}\n</system-reminder>`
    const msg = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: PLUGIN_SOURCE,
    }
    listShownAt.set(agent.id, Date.now())
    return { kind: 'enter', messages: [...decision.messages, msg] }
  })

  // ── 2. agent/pre-step：用户消息命中触发条件 → 点名加载 ────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    const agent = payload?.agent
    if (!agent) return decision

    const userMsgs = (decision.messages || []).filter(m =>
      m?.source?.kind === 'user' || m?.source?.kind === undefined)
    if (userMsgs.length === 0) return decision

    const userText = userMsgs.map(m =>
      (m?.content || []).map(b => b?.type === 'text' ? b.text : '').join('')
    ).join('\n')

    const hits = matchSkills(userText)
    if (hits.length === 0) return decision

    // 每 turn 限流
    const count = injected.get(agent.id) ?? 0
    if (count >= maxInjectsPerTurn) return decision
    injected.set(agent.id, count + 1)

    const named = hits.map(s => `\`${s.name}\``).join(' / ')
    const text = `<system-reminder>当前任务匹配纪律 skill：${named}。先用 skill 工具加载对应 skill 并按其中步骤执行（不要跳过加载直接凭印象做）。</system-reminder>`
    const msg = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: PLUGIN_SOURCE,
    }
    return { kind: 'enter', messages: [...decision.messages, msg] }
  })

  // ── 清理 ─────────────────────────────────────────────────────────────
  ctx.effect(() => makeCleanupTimer((cutoff) => {
    for (const [agentId, at] of injected) {
      if (at < cutoff) injected.delete(agentId)
    }
    for (const [agentId, at] of listShownAt) {
      if (at < cutoff) listShownAt.delete(agentId)
    }
  }), 'dsh-skill-loader: state cleanup')
}
