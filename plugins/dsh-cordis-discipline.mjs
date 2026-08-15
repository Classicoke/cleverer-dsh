/**
 * dsh-cordis-discipline — 动态插件热加载纪律（cordis_* 工具使用规范）
 *
 * cordis 动态插件 = 模型在 vm 沙箱里写代码、定义插件、热加载到实时运行时。
 * 官方立场："应当像对待 bash 访问一样对待"、"沙箱不是安全边界"。
 * 本插件把这条立场变成运行时纪律，三层：
 *
 *  1. 意识层：system-prompt section 注入 cordis 使用纪律（每轮可见）
 *  2. 行为层：tools/pre-execute 强制前置条件——
 *     - cordis_run 前必须有同会话 cordis_define（拦截"凭空运行"）
 *     - cordis_undefine 前必须先 stop（拦截"带病卸载"）
 *     - cordis_define 拒绝空代码 / 缺 name（拦截"空定义"）
 *  3. 遗留层：agent/turn-stopping 检查本 turn 是否还有 running 的动态插件
 *     → steer 提醒 stop（拦截"拔了电源就走"）
 *
 * 零依赖纯 ESM。挂载：
 *   ~/.dsh/cordis.patch.yml → - id: dsh-cordis-discipline
 *                                name: 'file:///.../dsh-cordis-discipline.mjs'
 */

import { randomUUID } from 'node:crypto'

export const name = 'dsh-cordis-discipline'
export const inject = ['systemPrompt']

const PLUGIN_SOURCE = { kind: 'plugin', plugin: name }

/** cordis 工具名族 */
const CORDIS_TOOLS = new Set([
  'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine',
  'cordis_inspect', 'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
  'cordis_runtime_inspect',
])

/** 系统提示词纪律段（order 110：工具引导区） */
const DISCIPLINE_TEXT = `## 动态插件纪律（cordis_* 工具）

cordis 动态插件在实时进程中执行你写的代码，能力与 bash 同级、沙箱不是安全边界。必须遵守：

1. **先用 inspect 再 define**：定义前用 cordis_inspect 查同名插件是否已存在，避免冲突。
2. **run 前必须 define**：只能运行本会话已定义的插件；运行新版本前先 stop 旧版本。
3. **用完必须 stop**：实验结束后 cordis_stop 清理，不留运行中的插件。
4. **undefine 前先 stop**：卸载前必须已停止，禁止带病卸载。
5. **不做危险操作**：不写逃逸沙箱的代码（globalThis 注入、直接改运行时服务）、不尝试读敏感凭据。
6. **实验结果不冒充正式插件**：动态包只活在进程内存里，验证后要转正式插件走常规开发流程。
7. **用最小代码验证**：先写最小可跑的 hello 级插件确认机制，再扩展功能，不要一次提交大段未经验证的代码。`

export function apply(ctx, config = {}) {
  const text = config.text || DISCIPLINE_TEXT

  // 1. 意识层：注入纪律段
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'cordis-discipline',
    order: 110,
    text,
  }), 'dsh-cordis-discipline: register section')

  // 2. 行为层：前置条件拦截
  // per-agent 状态: agentId -> { defined: Set<id>, running: Set<id> }
  const state = new Map()
  function stateFor(agentId) {
    let s = state.get(agentId)
    if (!s) { s = { defined: new Set(), running: new Set() }; state.set(agentId, s) }
    return s
  }

  // 从工具参数里提取插件标识（cordis_define 返回 dyn-<n>，但 pre-execute 拿不到
  // 返回值；用 name/idPrefix 跟踪，结果由 tools/result 确认后补全）
  function extractIds(exec) {
    const args = exec.arguments || {}
    const ids = []
    for (const k of ['pluginId', 'packageId', 'id', 'name']) {
      if (typeof args[k] === 'string' && args[k]) ids.push(args[k])
    }
    return ids
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec || !CORDIS_TOOLS.has(exec.name)) return next()
    const args = exec.arguments || {}
    const agent = exec.agent
    const agentId = agent?.id || 'global'
    const s = stateFor(agentId)

    switch (exec.name) {
      case 'cordis_define': {
        // 必须有名称和可执行代码（host 或 client 至少一半）
        const hasName = typeof args.name === 'string' && args.name.trim().length > 0
        const hasCode = typeof args.code === 'string' && args.code.trim().length > 0
          || typeof args.client === 'string' && args.client.trim().length > 0
        if (!hasName) {
          return { kind: 'deny', reason: '[cordis-discipline] cordis_define 必须提供 name（插件标识）。先想清楚插件要做什么再定义。' }
        }
        if (!hasCode) {
          return { kind: 'deny', reason: '[cordis-discipline] cordis_define 必须提供 code 或 client（可执行代码）。空定义没有意义，且会浪费运行时资源。' }
        }
        // 记录"准备定义"（结果确认在 tools/result）
        s.pendingDefine = s.pendingDefine || new Set()
        s.pendingDefine.add(args.name)
        ctx.logger?.info?.(`dsh-cordis-discipline: define ${args.name} (agent ${agentId})`)
        return next()
      }
      case 'cordis_run': {
        const id = extractIds(exec)[0] || args.packageId || '?'
        // 必须本会话 define 过
        const defined = s.defined.size > 0 || (s.pendingDefine && s.pendingDefine.size > 0)
        if (!defined) {
          return { kind: 'deny', reason: `[cordis-discipline] cordis_run 前必须先 cordis_define（本会话内）。当前会话没有已定义的动态插件，无法运行 ${id}。流程：define → run → stop。` }
        }
        s.running.add(id)
        ctx.logger?.info?.(`dsh-cordis-discipline: run ${id} (agent ${agentId})`)
        return next()
      }
      case 'cordis_undefine': {
        const id = extractIds(exec)[0] || '?'
        // 如果该插件还在 running 集合里，拒绝直接卸载
        if (s.running.has(id)) {
          return { kind: 'deny', reason: `[cordis-discipline] 插件 ${id} 仍在运行中。先 cordis_stop 再 cordis_undefine，禁止带病卸载（运行中的插件注册的 effect 需要先 dispose）。` }
        }
        s.defined.delete(id)
        s.pendingDefine?.delete(id)
        return next()
      }
      case 'cordis_stop': {
        const id = extractIds(exec)[0] || args.packageId || '?'
        // 允许 stop 未跟踪的（防御性），stop 后移除 running 标记
        s.running.delete(id)
        return next()
      }
      default:
        return next()
    }
  })

  // tools/result：确认 define 成功（结果里含 dyn-<n> 或 pluginId）
  ctx.on('tools/result', (exec, result) => {
    if (!exec || !exec.agent) return
    if (exec.name !== 'cordis_define' && exec.name !== 'cordis_run') return
    const agentId = exec.agent.id
    const s = stateFor(agentId)
    if (result && !result.isError) {
      const txt = JSON.stringify(result.value || result.content || '')
      // define 成功：从 pending 移入 defined
      if (exec.name === 'cordis_define') {
        const m = txt.match(/dyn-\d+|"pluginId":"([^"]+)"/)
        if (m) {
          const realId = m[1] || m[0]
          s.defined.add(realId)
          // 把 pending 里所有 name 都标记为 defined（保守，防误拦）
          for (const n of s.pendingDefine || []) s.defined.add(n)
          s.pendingDefine?.clear()
        }
      }
    } else if (exec.name === 'cordis_define' && result?.isError) {
      // define 失败：清掉 pending，避免污染后续 run 校验
      s.pendingDefine?.clear()
    }
  })

  // 3. 遗留层：turn 结束还有 running → 提醒 stop
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!agent) return
    const s = state.get(agent.id)
    if (!s || s.running.size === 0) return
    const running = [...s.running].join(', ')
    try {
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `【动态插件纪律】本回合还有运行中的动态插件：${running}。如果实验已完成，请 cordis_stop 清理；如果还要继续用，说明原因。动态插件会占用进程资源，不该在回合结束后遗留。` }],
        source: PLUGIN_SOURCE,
      })
      ctx.logger?.info?.(`dsh-cordis-discipline: steered cleanup for running ${running}`)
    } catch { /* steer 失败不致命 */ }
  })

  // 状态清理
  ctx.effect(() => {
    const timer = setInterval(() => {
      const cutoff = Date.now() - 30 * 60 * 1000
      for (const [agentId, s] of state) {
        if (s.running.size === 0 && s.defined.size === 0) state.delete(agentId)
      }
    }, 10 * 60 * 1000)
    return () => clearInterval(timer)
  }, 'dsh-cordis-discipline: state cleanup')
}
