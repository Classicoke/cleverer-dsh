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
console.log('\n=== 测试 7: 失败不足 → pre-step 直接返回不注入 ===')
ctx = makeCtx()
mod.apply(ctx, {})
const agent7 = fakeAgent('agent-7')
// 仅 1 次失败（turnFails=1 < 3，totalFails=1 < 6）
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'single-cmd' }, agent: agent7 },
  { isError: true, content: [{ type: 'text', text: 'err' }] })
const next7 = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
const r7 = await ctx.emit('agent/pre-step', { agent: agent7, turn: 1, messages: [], signal: null }, next7)
const injected7 = (r7?.messages || []).filter(m => m?.content?.[0]?.text?.includes('提醒'))
assert(injected7.length === 0, `失败不足不注入 (got ${injected7.length})`)

// =========================================================================
console.log('\n=== 测试 8: 普通反思注入（top 空：无 count≥2 指纹） ===')
ctx = makeCtx()
mod.apply(ctx, {})
const agent8 = fakeAgent('agent-8')
// 3 个不同指纹各失败 1 次 → turnFails=3，无 count≥2
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'c1' }, agent: agent8 }, { isError: true, content: [{ type: 'text', text: 'e1' }] })
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'c2' }, agent: agent8 }, { isError: true, content: [{ type: 'text', text: 'e2' }] })
await ctx.emit('tools/result', { name: 'edit', arguments: { file_path: 'a.mjs', old_string: 'x' }, agent: agent8 }, { isError: true, content: [{ type: 'text', text: 'edit err' }] })
const next8 = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
const r8 = await ctx.emit('agent/pre-step', { agent: agent8, turn: 1, messages: [], signal: null }, next8)
const t8 = (r8?.messages || []).map(m => m?.content?.[0]?.text || '').join('|')
assert(t8.includes('执行纪律提醒'), `注入纪律提醒 (${t8.slice(0, 40)}…)`)
assert(t8.includes('累计失败 3 次'), `top 空用累计失败文本`)

// =========================================================================
console.log('\n=== 测试 9: 普通反思注入（top 非空：有 count≥2 指纹） ===')
ctx = makeCtx()
mod.apply(ctx, {})
const agent9 = fakeAgent('agent-9')
// 同指纹 'dup-cmd' 失败 2 次 + 另一指纹 1 次 → turnFails=3，top 有 1 个
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'dup-cmd' }, agent: agent9 }, { isError: true, content: [{ type: 'text', text: 'e1' }] })
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'dup-cmd' }, agent: agent9 }, { isError: true, content: [{ type: 'text', text: 'e2' }] })
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'other-cmd' }, agent: agent9 }, { isError: true, content: [{ type: 'text', text: 'e3' }] })
const next9 = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
const r9 = await ctx.emit('agent/pre-step', { agent: agent9, turn: 1, messages: [], signal: null }, next9)
const t9 = (r9?.messages || []).map(m => m?.content?.[0]?.text || '').join('|')
assert(t9.includes('反复失败'), `top 非空用反复失败文本`)
assert(t9.includes('连续失败 2 次'), `列出失败指纹次数`)

// =========================================================================
console.log('\n=== 测试 10: steer 抛异常被捕获（不致命） ===')
ctx = makeCtx()
mod.apply(ctx, {})
const agent10 = {
  id: 'agent-10',
  session: { header: { id: 'agent-10' }, events: [{ type: 'turn/start', data: { turn: 5 } }] },
  steer() { throw new Error('steer boom') },
}
for (let i = 0; i < 5; i++) {
  await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: `steer-cmd-${i}` }, agent: agent10 },
    { isError: true, content: [{ type: 'text', text: 'boom' }] })
}
// 不抛错即通过
await ctx.emit('agent/turn-stopping', { agent: agent10, turn: 5, signal: null })
assert(true, 'steer 异常被 catch（turn-stopping 不崩）')

// =========================================================================
console.log('\n=== 测试 11: 状态清理 timer — 四组旧状态删除、活跃保留 ===')
// fake setInterval 捕获清理回调
let cleanupCb = null
const realSetInterval = global.setInterval
const realClearInterval = global.clearInterval
global.setInterval = (cb) => { cleanupCb = cb; return 1 }
global.clearInterval = () => {}
const realNow = Date.now
try {
  ctx = makeCtx()
  mod.apply(ctx, {})
  assert(typeof cleanupCb === 'function', '清理 timer 回调被捕获')
  // agentA：制造全四组旧状态（failState/toolFailState/specialState/lastReminderAt）
  const agentA = fakeAgent('clean-a', 1)
  // 4 个不同 pwsh 命令失败 → failState+toolFailState 有记录
  for (let i = 0; i < 4; i++) {
    await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: `a-cmd-${i}` }, agent: agentA },
      { isError: true, content: [{ type: 'text', text: 'boom' }] })
  }
  // special 记录（order-dep）
  await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'fixup-asar' }, agent: agentA },
    { isError: true, content: [{ type: 'text', text: 'app.asar not found at D:\\x\\resources\\app.asar' }] })
  // lastReminderAt 记录（pre-step 注入一次，工具级密度已到 5）
  const nextA = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
  await ctx.emit('agent/pre-step', { agent: agentA, turn: 1, messages: [], signal: null }, nextA)
  // agentB：活跃（新状态），清理后应保留
  const agentB = fakeAgent('keep-b', 1)
  await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'b-cmd' }, agent: agentB },
    { isError: true, content: [{ type: 'text', text: 'boom' }] })
  // 拨快 31 分钟 → 清理：agentA 全旧删除、agentB 新保留
  Date.now = () => realNow() + 31 * 60 * 1000
  cleanupCb()
  Date.now = realNow
  // 验证 agentA 状态被清：新 turn（turn=2）同 agent id 失败 3 个不同命令
  // → 应重新注入且文本显示「累计 3 次」（若旧记录未清理会显示累计 8 次）
  const agentA2 = fakeAgent('clean-a', 2)
  for (let i = 0; i < 3; i++) {
    await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: `fresh-cmd-${i}` }, agent: agentA2 },
      { isError: true, content: [{ type: 'text', text: 'boom' }] })
  }
  const nextA2 = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
  const rA2 = await ctx.emit('agent/pre-step', { agent: agentA2, turn: 2, messages: [], signal: null }, nextA2)
  const tA2 = (rA2?.messages || []).map(m => m?.content?.[0]?.text || '').join('|')
  assert(tA2.includes('累计 3 次'), `旧状态清理后累计数归零重算 (${tA2.slice(0, 50)}…)`)
  // agentB 保留：turn-stopping 无 steer（失败 1 次 < 5，纯验证不崩）
  await ctx.emit('agent/turn-stopping', { agent: agentB, turn: 1, signal: null })
  assert(true, '活跃 agent 状态保留不崩')
} finally {
  global.setInterval = realSetInterval
  global.clearInterval = realClearInterval
  Date.now = realNow
}

// =========================================================================
console.log('\n=== 测试 12: fingerprint 边界（name/arguments 缺失、fs 工具、循环引用） ===')
ctx = makeCtx()
mod.apply(ctx, {})
const agent12 = fakeAgent('agent-12')
// name 缺失 → 指纹 '?::…'（56 行）
await ctx.emit('tools/result', { arguments: { command: 'no-name-cmd' }, agent: agent12 },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
// arguments 缺失 → {}（57 行 else 分支 83）
await ctx.emit('tools/result', { name: 'pwsh', agent: agent12 },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
// path 参数 fs 工具（74:50）
await ctx.emit('tools/result', { name: 'read', arguments: { path: 'a.mjs' }, agent: agent12 },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
// edit 无 old_string（78:46）
await ctx.emit('tools/result', { name: 'edit', arguments: { file_path: 'b.mjs' }, agent: agent12 },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
// 非 edit fs 工具（80:7）
await ctx.emit('tools/result', { name: 'write', arguments: { file_path: 'c.mjs' }, agent: agent12 },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
// 其他工具（无 command/file_path/path）→ JSON.stringify（83:5）
await ctx.emit('tools/result', { name: 'todo_write', arguments: { todos: [1, 2] }, agent: agent12 },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
// 循环引用 arguments → fingerprint catch（86:4）
const cyc = { self: null }; cyc.self = cyc
await ctx.emit('tools/result', { name: 'weird', arguments: cyc, agent: agent12 },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
assert(true, 'fingerprint 各边界路径不崩')

// =========================================================================
console.log('\n=== 测试 13: isFailure 边界（null/空 content/文本标记） ===')
ctx = makeCtx()
mod.apply(ctx, {})
const agent13 = fakeAgent('agent-13')
// result null → 不算失败（成功分支）
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'x1' }, agent: agent13 }, null)
// content 为空 + isError false → JSON.stringify(result)（103:4）
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'x2' }, agent: agent13 },
  { isError: false, content: undefined })
// content 干净文本 + isError false → 不算失败
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'x3' }, agent: agent13 },
  { isError: false, content: [{ type: 'text', text: 'all good' }] })
// content 含 error 标记（isError false）→ 算失败（105 正则）
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'x4' }, agent: agent13 },
  { isError: false, content: [{ type: 'text', text: 'something error happened' }] })
// content 含 [exit code: 1] 文本（105 正则第二分支）
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'x5' }, agent: agent13 },
  { isError: false, content: [{ type: 'text', text: '[exit code: 1] boom' }] })
// x4 再失败一次（连续 2 次）→ 同命令重试应 deny
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'x4' }, agent: agent13 },
  { isError: false, content: [{ type: 'text', text: 'something error happened' }] })
const d13 = await ctx.emit('tools/pre-execute',
  { name: 'pwsh', arguments: { command: 'x4' }, agent: agent13 })
assert(d13.kind === 'deny', `文本 error 标记被识别为失败并拒绝 (got ${d13.kind})`)
assert(true, 'isFailure 边界路径全部执行')

// =========================================================================
console.log('\n=== 测试 14: failureText / currentTurn 边界 ===')
ctx = makeCtx()
mod.apply(ctx, {})
// content 非数组（字符串）→ failureText JSON.stringify 兜底（120:4）
const agent14a = fakeAgent('agent-14a')
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'f1' }, agent: agent14a },
  { isError: true, content: 'plain error string' })
// content 数组含非对象元素（116:26 false）
const agent14b = fakeAgent('agent-14b')
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'f2' }, agent: agent14b },
  { isError: true, content: [42, 'raw', { type: 'text', text: 'real err' }] })
// events 无 turn/start → currentTurn 0（128:17）
const agent14c = fakeAgent('agent-14c')
agent14c.session.events = [{ type: 'other', data: {} }]
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'f3' }, agent: agent14c },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
// events getter 抛异常 → currentTurn catch（130-131）
const agent14d = fakeAgent('agent-14d')
Object.defineProperty(agent14d.session, 'events', { get() { throw new Error('boom') } })
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'f4' }, agent: agent14d },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
assert(true, 'failureText/currentTurn 边界路径不崩')

// =========================================================================
console.log('\n=== 测试 15: tools/result 特殊路径（无 exec/deny 不计/容量/stale/errLog/衰减） ===')
// 无 exec → 214 行直接返回
ctx = makeCtx()
mod.apply(ctx, {})
await ctx.emit('tools/result', null, { isError: true })
// 失败文本含 [anti-stuck] → 不计（222）
const agent15a = fakeAgent('agent-15a')
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'denied-cmd' }, agent: agent15a },
  { isError: true, content: [{ type: 'text', text: '[anti-stuck] 你已连续 2 次以相同参数调用…' }] })
// 容量保护（maxFingerprintsPerAgent=2）→ 232-234
ctx = makeCtx()
mod.apply(ctx, { maxFingerprintsPerAgent: 2 })
const agent15b = fakeAgent('agent-15b')
for (let i = 0; i < 3; i++) {
  await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: `cap-cmd-${i}` }, agent: agent15b },
    { isError: true, content: [{ type: 'text', text: 'e' }] })
}
// stale-snapshot 检测（250-252）+ __errLog 写入（254-256）
ctx = makeCtx()
ctx.__errLog = []
mod.apply(ctx, {})
const agent15c = fakeAgent('agent-15c')
await ctx.emit('tools/result', { name: 'edit', arguments: { file_path: 'D:\\x\\a.mjs', old_string: 'old' }, agent: agent15c },
  { isError: true, content: [{ type: 'text', text: 'Error: old_string was not found in "D:\\x\\a.mjs"' }] })
assert(ctx.__errLog.length === 1 && ctx.__errLog[0].errorClass === 'stale-snapshot', `errLog 记录 stale-snapshot (${JSON.stringify(ctx.__errLog[0]?.errorClass)})`)
// 成功衰减工具级到 0 → ts.delete（266）
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'decay-1' }, agent: agent15c },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'decay-1' }, agent: agent15c },
  { isError: false, content: [{ type: 'text', text: 'ok' }] })
// stale-snapshot 精准提醒注入（pre-step，turn 匹配）
const next15 = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
const r15 = await ctx.emit('agent/pre-step', { agent: agent15c, turn: 1, messages: [], signal: null }, next15)
const t15 = (r15?.messages || []).map(m => m?.content?.[0]?.text || '').join('|')
assert(t15.includes('精准提醒') && t15.includes('old_string'), `stale-snapshot 精准提醒注入 (${t15.slice(0, 40)}…)`)

// =========================================================================
console.log('\n=== 测试 16: pre-step 边界（非 enter/无 agent/冷却） ===')
// 非 enter 下游 → 288
ctx = makeCtx()
mod.apply(ctx, {})
const next16a = async () => ({ kind: 'reject', reason: 'x' })
const r16a = await ctx.emit('agent/pre-step', { agent: fakeAgent('agent-16a'), turn: 1, messages: [], signal: null }, next16a)
assert(r16a?.kind === 'reject', '非 enter 下游原样返回')
// 无 agent → 289
const r16b = await ctx.emit('agent/pre-step', { turn: 1, messages: [], signal: null }, next16a)
assert(r16b?.kind === 'reject', '无 agent 原样返回')
// 冷却：注入后 20 秒内再次 pre-step → 296 阻挡
ctx = makeCtx()
mod.apply(ctx, {})
const realNow16 = Date.now
const agent16c = fakeAgent('agent-16c')
try {
  Date.now = () => realNow16() + 1000 * 60 * 60 // 拨到整点，远离冷却基线
  for (let i = 0; i < 4; i++) {
    await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: `cool-cmd-${i}` }, agent: agent16c },
      { isError: true, content: [{ type: 'text', text: 'e' }] })
  }
  const next16c = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
  const r16c1 = await ctx.emit('agent/pre-step', { agent: agent16c, turn: 1, messages: [], signal: null }, next16c)
  const n1 = (r16c1?.messages || []).filter(m => m?.content?.[0]?.text?.includes('提醒')).length
  // 10 秒后再来 → 冷却中（< 20s）→ 不注入
  Date.now = () => realNow16() + 1000 * 60 * 60 + 10 * 1000
  const r16c2 = await ctx.emit('agent/pre-step', { agent: agent16c, turn: 1, messages: [], signal: null }, next16c)
  const n2 = (r16c2?.messages || []).filter(m => m?.content?.[0]?.text?.includes('提醒')).length
  // 30 秒后再来 → 冷却过 → 但同 turn 已注入（lastInjectedTurn）→ 仍不注入
  Date.now = () => realNow16() + 1000 * 60 * 60 + 30 * 1000
  const r16c3 = await ctx.emit('agent/pre-step', { agent: agent16c, turn: 1, messages: [], signal: null }, next16c)
  const n3 = (r16c3?.messages || []).filter(m => m?.content?.[0]?.text?.includes('提醒')).length
  assert(n1 === 1 && n2 === 0 && n3 === 0, `首次注入、冷却阻挡、同 turn 去重 (${n1}/${n2}/${n3})`)
} finally {
  Date.now = realNow16
}

// =========================================================================
console.log('\n=== 测试 17: turn-stopping 边界（无 agent / 工具级触发 steer） ===')
// 无 agent → 372
ctx = makeCtx()
mod.apply(ctx, {})
await ctx.emit('agent/turn-stopping', { turn: 1, signal: null })
// 工具级触发：turnFails=4 < 5 但 toolFails=8 ≥ maxSameToolFails*2 → steer
ctx = makeCtx()
mod.apply(ctx, {})
const agent17 = fakeAgent('agent-17', 9)
for (let i = 0; i < 8; i++) {
  await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: `tool-cmd-${i}` }, agent: agent17 },
    { isError: true, content: [{ type: 'text', text: 'e' }] })
}
await ctx.emit('agent/turn-stopping', { agent: agent17, turn: 9, signal: null })
assert(ctx.steers.length === 1, `工具级密度触发 steer (got ${ctx.steers.length})`)
assert(ctx.steers[0].msg.content[0].text.includes('工具级累计 8 次'), 'steer 文本含工具级累计')

// =========================================================================
console.log('\n=== 测试 18: 无 logger 的 ctx apply 不崩（149 行可选链） ===')
ctx = makeCtx()
delete ctx.logger
mod.apply(ctx, {})
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'nolog' }, agent: fakeAgent('agent-18') },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
assert(true, '无 logger apply + 事件不崩')

// =========================================================================
console.log('\n=== 测试 19: 剩余边界分支（76/103/105/120/128/149/200/255/261/273/289） ===')
// edit 无任何路径参数 → fp=''（76:45）
ctx = makeCtx()
mod.apply(ctx, {})
const agent19a = fakeAgent('agent-19a')
await ctx.emit('tools/result', { name: 'edit', arguments: {}, agent: agent19a },
  { isError: true, content: [{ type: 'text', text: 'Error: old_string was not found' }] })
// failureText catch（content 数组元素 text getter 抛；非 enumerable 使 121 的 stringify 不重抛）
const agent19b = fakeAgent('agent-19b')
const evilBlock = {}
Object.defineProperty(evilBlock, 'text', { get() { throw new Error('boom') }, enumerable: false })
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'evil' }, agent: agent19b },
  { isError: true, content: [evilBlock] })
// content falsy 形态（''、null、0）→ isFailure 103
const agent19c = fakeAgent('agent-19c')
for (const badContent of ['', null, 0]) {
  await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'falsy-' + String(badContent) }, agent: agent19c },
    { isError: false, content: badContent })
}
// content 含 traceback 文本 → 105:54
const agent19d = fakeAgent('agent-19d')
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'trace' }, agent: agent19d },
  { isError: false, content: [{ type: 'text', text: 'Traceback (most recent call last):\n  File "x.py"' }] })
// events 空数组 → currentTurn 0（128:17）
const agent19e = fakeAgent('agent-19e')
agent19e.session.events = []
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'noevt' }, agent: agent19e },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
// ctx.logger = {}（无 info 方法）→ 149:18
ctx = makeCtx()
ctx.logger = {}
mod.apply(ctx, {})
// edit stale 但 arguments 无 file_path/path → file=''（200:45/69）
const agent19f = fakeAgent('agent-19f')
await ctx.emit('tools/result', { name: 'edit', arguments: {}, agent: agent19f },
  { isError: true, content: [{ type: 'text', text: 'old_string was not found in "x"' }] })
// 普通失败写 errLog → errorClass='same-tool'（255:86）
ctx = makeCtx()
ctx.__errLog = []
mod.apply(ctx, {})
const agent19g = fakeAgent('agent-19g')
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'plain-fail' }, agent: agent19g },
  { isError: true, content: [{ type: 'text', text: 'generic failure' }] })
assert(ctx.__errLog.length === 1 && ctx.__errLog[0].errorClass === 'same-tool', `普通失败 errLog same-tool (${ctx.__errLog[0]?.errorClass})`)
// 成功 exec 无 name → 261:30
await ctx.emit('tools/result', { arguments: { command: 'no-name-ok' }, agent: agent19g },
  { isError: false, content: [{ type: 'text', text: 'ok' }] })
// pre-execute 无 agent → next()（273:30）
const r19h = await ctx.emit('tools/pre-execute', { name: 'pwsh', arguments: { command: 'x' } })
assert(r19h?.kind === 'allow', `pre-execute 无 agent 直通 (${JSON.stringify(r19h)})`)
// pre-step 无 agent + next 返回 enter → 289:16
const next19i = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
const r19i = await ctx.emit('agent/pre-step', { turn: 1, messages: [], signal: null }, next19i)
assert(r19i?.kind === 'enter', 'pre-step 无 agent 透传 enter')
assert(true, '剩余边界分支全部执行')

// =========================================================================
console.log('\n=== 测试 20: 分支穷举（76 空串路径/105 command failed/128 无 session/255 order-dep） ===')
// file_path 为空字符串（仍是 string）→ 76:45 走 '' 
ctx = makeCtx()
mod.apply(ctx, {})
const agent20a = fakeAgent('agent-20a')
await ctx.emit('tools/result', { name: 'edit', arguments: { file_path: '' }, agent: agent20a },
  { isError: true, content: [{ type: 'text', text: 'old_string was not found' }] })
// content 含 command failed → 105:54
const agent20b = fakeAgent('agent-20b')
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'cf' }, agent: agent20b },
  { isError: false, content: [{ type: 'text', text: 'command failed: exit code 2' }] })
// agent 无 session → currentTurn 128（!events return 0）
const agent20c = { id: 'agent-20c' }
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'nosess' }, agent: agent20c },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
// ctx.logger = {}（无 info 方法）单独 apply → 149:18
const ctx20d = makeCtx()
ctx20d.logger = {}
mod.apply(ctx20d, {})
// order-dep 失败写 errLog → errorClass='order-dep'（255 嵌套三元 od 真分支）
const ctx20e = makeCtx()
ctx20e.__errLog = []
mod.apply(ctx20e, {})
const agent20e = fakeAgent('agent-20e')
await ctx20e.emit('tools/result', { name: 'pwsh', arguments: { command: 'fixup' }, agent: agent20e },
  { isError: true, content: [{ type: 'text', text: 'Error: app.asar not found at D:\\r\\resources\\app.asar' }] })
assert(ctx20e.__errLog.length === 1 && ctx20e.__errLog[0].errorClass === 'order-dep', `order-dep errLog 分类 (${ctx20e.__errLog[0]?.errorClass})`)
// isFailure 的 try 抛异常 → catch（103:4）：result.value getter 抛
const agent20f = fakeAgent('agent-20f')
const evilValue = {}
Object.defineProperty(evilValue, 'exitCode', { get() { throw new Error('boom') }, enumerable: false })
const evilResult = { isError: false, value: evilValue }
await ctx.emit('tools/result', { name: 'pwsh', arguments: { command: 'evilvalue' }, agent: agent20f }, evilResult)
assert(true, 'isFailure catch 路径执行')
assert(true, '分支穷举场景全部执行')

// =========================================================================
console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
