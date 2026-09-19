/**
 * radar-notify — 雷达新候选提醒插件（配合 agentic-radar-run.ps1）
 *
 * 机制（2026-09-03 v3：pre-step 直接注入）：
 *  每个 agent/pre-step（决策进入前）检查 pending-review.json；
 *  若存在未提醒的 high 新候选 → 把提醒注入当前即将进入的 agent
 *  （与 dsh-env-triage 同模式，绕开 __reminder 队列的 agentId/时序问题），
 *  并置 reminded=true 防重复。
 *
 * v2 教训：turn-stopping + ctx.__reminder 队列方案实测提醒未达 GUI 会话
 * （reminded 置 true 但消息未注入）——队列消费的 agentId 与触发方可能不匹配。
 *
 * 零依赖纯 ESM；挂载同 discipline-board。
 */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const name = 'radar-notify'

const DEFAULT_CONFIG = {
  enabled: true,
  pendingFile: undefined,
  prefix: '【agentic-radar 雷达提醒】',
  pluginSource: 'radar-notify',
}

function resolvePendingFile(cfg) {
  if (cfg.pendingFile) return cfg.pendingFile
  return path.join('C:\\Users\\66345\\dsh-work', 'gbrain-learn', 'agentic-radar', 'pending-review.json')
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  if (!cfg.enabled) return
  ctx.logger?.info?.('radar-notify: plugin loaded (notify radar candidates via pre-step injection)')

  const pendingFile = resolvePendingFile(cfg)
  // agentId+turn -> 已注入标记（防同 turn 多 step 重复注入）
  const injectedKeys = new Set()

  async function checkAndBuild() {
    try {
      const raw = await readFile(pendingFile, 'utf8').catch(() => null)
      if (!raw) return null
      const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
      const pending = JSON.parse(clean)
      if (!pending || pending.reminded) return null
      const high = (pending.candidates || []).filter(c => c.rel === 'high')
      if (high.length === 0) return null
      const lines = high.slice(0, 5).map(c => {
        const nm = c.name || c.title || c.url || '?'
        const desc = (c.desc || '').slice(0, 90)
        const pop = c.stars || c.points || ''
        return `• ${nm}${pop ? ` (${pop})` : ''}: ${desc}`
      }).join('\n')
      const text = `${cfg.prefix}扫描到 ${high.length} 个新 high 相关候选，请审阅是否借鉴机制：
${lines}
（详情见 gbrain-learn\\agentic-radar\\${pending.scan_file || 'radar'}；审阅后借鉴机制可进专员 jsonl，或否决）`
      return { text, pending }
    } catch {
      return null
    }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    const agent = payload?.agent
    if (!agent) return decision
    const key = `${agent.id}:${agent.turn}`
    if (injectedKeys.has(key)) return decision

    const found = await checkAndBuild()
    if (!found) return decision

    const msg = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: found.text }],
      source: cfg.pluginSource,
    }
    // 无论是否被消费都标记，防重复（下次雷达 run 重置 reminded）
    try {
      found.pending.reminded = true
      await writeFile(pendingFile, JSON.stringify(found.pending, null, 2), 'utf8')
    } catch (e) {
      ctx.logger?.warn?.(`radar-notify: mark reminded failed: ${String(e)}`)
    }
    injectedKeys.add(key)
    ctx.logger?.info?.(`radar-notify: injected into agent=${agent.id} turn=${agent.turn}`)
    return { kind: 'enter', messages: [...decision.messages, msg] }
  })
}
