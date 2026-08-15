/**
 * anti-stuck 插件单元测试：模拟 cordis Context，验证三条核心逻辑。
 * 运行：node test-anti-stuck.mjs
 */
import { pathToFileURL } from 'node:url'

// ── 迷你 cordis Context 模拟 ──────────────────────────────────────────────
function makeCtx() {
  const listeners = new Map()
  const steers = []
  const enters = []
  return {
    logger: { warn: (...a) => console.log('[logger]', ...a) },
    steers,
    enters,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {
        const arr = listeners.get(event)
        const i = arr.indexOf(handler)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    async emit(event, ...args) {
      for (const h of listeners.get(event) || []) {
        const next = async () => {
          /* 默认穿过 */
          return args[args.length - 1]?.__decision ?? { kind: 'allow' }
        }
        const r = await h(...args, next)
        if (r !== undefined) return r
      }
      return undefined
    },
    effect(fn, label) {
      const cleanup = fn()
      return () => (typeof cleanup === 'function' ? cleanup() : undefined)
    },
  }
}

const fakeAgent = (id, turn = 1) => ({
  id,
  session: {
    header: { id },
    events: [{ type: 'turn/start', data: { turn } }],
  },
  steer(msg) { ctx.steers.push({ id, msg }) },
})

let ctx

// ── 断言工具 ──────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

// ── 导入插件 ──────────────────────────────────────────────────────────────
const mod = await import(pathToFileURL('plugins/anti-stuck.mjs').href)

// =========================================================================
console.log('\n=== 测试 1: 连续失败 → 拒绝相同重试 ===')
ctx = makeCtx()
mod.apply(ctx, {})
const agent = fakeAgent('agent-1')

// 第一次失败
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build 2>&1 | Select-Object -Last 1' }, agent },
  { isError: true, content: [{ type: 'text', text: 'error: failed' }] })
// 第二次失败（同一命令）
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build 2>&1 | Select-Object -Last 1' }, agent },
  { isError: true, content: [{ type: 'text', text: 'error: failed again' }] })
// 第三次调用同一命令 → 应被 deny
const decision = await ctx.emit('tools/pre-execute',
  { name: 'pwsh', arguments: { command: 'pnpm run build 2>&1 | Select-Object -Last 1' }, agent })
assert(decision.kind === 'deny', `第三次相同调用被拒绝 (got ${decision.kind})`)
assert(decision.reason.includes('连续 2 次'), '拒绝理由说明连续失败次数')

// 不同命令 → 不应被拒绝
const okDecision = await ctx.emit('tools/pre-execute',
  { name: 'pwsh', arguments: { command: 'dir' }, agent })
assert(okDecision.kind === 'allow' || okDecision.kind === undefined, `不同命令不被拒绝 (got ${okDecision.kind})`)

// =========================================================================
console.log('\n=== 测试 2: 成功清零连续计数 ===')
ctx = makeCtx()
mod.apply(ctx, {})
const agentB = fakeAgent('agent-b')
// build 失败 2 次
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build' }, agent: agentB },
  { isError: true, content: [{ type: 'text', text: 'err1' }] })
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build' }, agent: agentB },
  { isError: true, content: [{ type: 'text', text: 'err2' }] })
// 此时应 deny
const d1 = await ctx.emit('tools/pre-execute',
  { name: 'pwsh', arguments: { command: 'pnpm run build' }, agent: agentB })
assert(d1.kind === 'deny', `失败2次后同命令被拒绝 (got ${d1.kind})`)
// build 成功 → 清零
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build' }, agent: agentB },
  { isError: false, content: [{ type: 'text', text: 'ok' }] })
// 再失败 1 次 → 不应立即 deny（计数已重置为 1）
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build' }, agent: agentB },
  { isError: true, content: [{ type: 'text', text: 'err3' }] })
const d2 = await ctx.emit('tools/pre-execute',
  { name: 'pwsh', arguments: { command: 'pnpm run build' }, agent: agentB })
assert(d2.kind !== 'deny', `成功清零后同命令失败1次不拒绝 (got ${d2.kind})`)

// =========================================================================
console.log('\n=== 测试 3: 失败密度高 → pre-step 注入提醒 ===')
ctx = makeCtx()
mod.apply(ctx, {})
const agent2 = fakeAgent('agent-2')
// 4 次不同命令的失败（同工具 pwsh 密度达到 maxSameToolFails=4 → 工具级提醒）
for (let i = 0; i < 4; i++) {
  await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: `failing-cmd-${i}` }, agent: agent2 },
    { isError: true, content: [{ type: 'text', text: 'boom' }] })
}
// 模拟 pre-step: next 返回 enter
const next = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
const preStepResult = await ctx.emit('agent/pre-step', { agent: agent2, turn: 1, messages: [], signal: null }, next)
assert(preStepResult.kind === 'enter', 'pre-step 返回 enter')
const hasReminder = preStepResult.messages.some(m => m.content.some(b => b.type === 'text' && (b.text.includes('执行纪律提醒') || b.text.includes('工具级失败提醒') || b.text.includes('anti-stuck 精准提醒'))))
assert(hasReminder, '注入包含提醒文本（工具级/纪律/精准任一）')

// =========================================================================
console.log('\n=== 测试 4: turn-stopping 高失败 → steer 反思（且同 turn 不重复） ===')
// 新 agent，turn=2 内 6 次失败
const agent4 = fakeAgent('agent-4', 2)
ctx = makeCtx()
mod.apply(ctx, {})
for (let i = 0; i < 6; i++) {
  await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: `failing2-${i}` }, agent: agent4 },
    { isError: true, content: [{ type: 'text', text: 'boom' }] })
}
await ctx.emit('agent/turn-stopping', { agent: agent4, turn: 2, signal: null })
// P0-5：同 turn 再次触发 turn-stopping → 不应重复 steer
await ctx.emit('agent/turn-stopping', { agent: agent4, turn: 2, signal: null })
await ctx.emit('agent/turn-stopping', { agent: agent4, turn: 2, signal: null })
assert(ctx.steers.length === 1, `turn-stopping 触发 steer (1 次, got ${ctx.steers.length})`)
assert(ctx.steers[0].msg.content[0].text.includes('强制反思'), 'steer 内容为强制反思')
// P0-5：新 turn 失败再触发 → 应再次 steer（turn 变化重置去重）
const agent4b = fakeAgent('agent-4b', 3)
ctx = makeCtx()
mod.apply(ctx, {})
for (let i = 0; i < 6; i++) {
  await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: `failing2b-${i}` }, agent: agent4b },
    { isError: true, content: [{ type: 'text', text: 'boom' }] })
}
await ctx.emit('agent/turn-stopping', { agent: agent4b, turn: 3, signal: null })
await ctx.emit('agent/turn-stopping', { agent: agent4b, turn: 3, signal: null })
assert(ctx.steers.length === 1, `新 turn 首次 steer (got ${ctx.steers.length})`)
// turn 3 → turn 4 事件（模拟新 turn）后应可再次 steer
const agent4c = fakeAgent('agent-4c', 4)
ctx = makeCtx()
mod.apply(ctx, {})
for (let i = 0; i < 6; i++) {
  await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: `failing2c-${i}` }, agent: agent4c },
    { isError: true, content: [{ type: 'text', text: 'boom' }] })
}
await ctx.emit('agent/turn-stopping', { agent: agent4c, turn: 4, signal: null })
assert(ctx.steers.length === 1, `turn 4 首次 steer 正常`)

// =========================================================================
console.log('\n=== 测试 5: 指纹归一化（等价命令识别） ===')
ctx = makeCtx()
mod.apply(ctx, {})
const agent3 = fakeAgent('agent-3')
// 两次命令字符串略有不同（cd 前缀、尾部装饰），但归一化后应视为同一指纹
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'cd D:\\x; pnpm run build 2>&1 | Select-Object -Last 1' }, agent: agent3 },
  { isError: true, content: [{ type: 'text', text: 'err1' }] })
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build' }, agent: agent3 },
  { isError: true, content: [{ type: 'text', text: 'err2' }] })
const decision3 = await ctx.emit('tools/pre-execute',
  { name: 'pwsh', arguments: { command: 'cd D:\\y; pnpm run build 2>&1 | Select-Object -Last 3' }, agent: agent3 })
assert(decision3.kind === 'deny', `归一化后视为相同指纹被拒绝 (got ${decision3.kind})`)

// =========================================================================
console.log('\n=== 测试 6: pwsh 真实失败形状（isError=false + value.exitCode=1） ===')
ctx = makeCtx()
mod.apply(ctx, {})
const agent6 = fakeAgent('agent-6')
// 模拟 pwsh 工具的真实结果：isError=false，失败信号在 value.exitCode
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'node -e "process.exit(1)"' }, agent: agent6 },
  { isError: false, value: { kind: 'foreground', exitCode: 1 }, content: [{ type: 'text', text: '[exit code: 1]\nstdout: ...' }] })
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'node -e "process.exit(1)"' }, agent: agent6 },
  { isError: false, value: { kind: 'foreground', exitCode: 1 }, content: [{ type: 'text', text: '[exit code: 1]\nstdout: ...' }] })
const d6 = await ctx.emit('tools/pre-execute',
  { name: 'pwsh', arguments: { command: 'node -e "process.exit(1)"' }, agent: agent6 })
assert(d6.kind === 'deny', `pwsh 真实失败形状被识别并拒绝 (got ${d6.kind})`)

// =========================================================================
console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
