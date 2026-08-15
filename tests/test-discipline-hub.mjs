/**
 * discipline-hub 单元测试：O1 聚合 / O2 仲裁 / O7 查询
 * 运行：node test-discipline-hub.mjs
 */
import { pathToFileURL } from 'node:url'

function makeCtx() {
  const listeners = new Map()
  return {
    logger: { info: () => {}, warn: (...a) => console.log('[warn]', ...a) },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    async emit(event, ...args) {
      for (const h of listeners.get(event) || []) {
        const next = async () => ({ kind: 'enter', messages: [] })
        const r = await h(...args, next)
        if (r !== undefined) return r
      }
      return undefined
    },
    effect(fn) { return fn() },
  }
}

const fakeAgent = (id, turn = 1) => ({
  id,
  session: { header: { id }, events: [{ type: 'turn/start', data: { turn } }] },
  steers: [],
  steer(m) { this.steers.push(m) },
})

let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

const mod = await import(pathToFileURL('plugins/discipline-hub.mjs').href)

// =========================================================================
console.log('\n=== 测试 1: O1 __errLog 聚合 + 错误分类 ===')
const ctx = makeCtx()
mod.apply(ctx, {})
const agent = fakeAgent('hub-1')
// 失败：顺序依赖
await ctx.emit('tools/result',
  { name: 'pwsh', arguments: { command: 'node scripts/fixup-asar.mjs staging' }, agent },
  { isError: true, content: [{ type: 'text', text: 'app.asar not found at D:\\x\\resources\\app.asar' }] })
// 失败：旧快照
await ctx.emit('tools/result',
  { name: 'edit', arguments: { file_path: 'D:\\x\\a.mjs', old_string: 'abc' }, agent },
  { isError: true, content: [{ type: 'text', text: 'Error: old_string was not found in "D:\\x\\a.mjs"' }] })
// 失败：缺模块
await ctx.emit('tools/result',
  { name: 'pwsh', arguments: { command: 'node -e "require(\'x\')"' }, agent },
  { isError: true, content: [{ type: 'text', text: 'Cannot find module x' }] })
// 成功（应记为 success 不增加失败）
await ctx.emit('tools/result',
  { name: 'pwsh', arguments: { command: 'echo ok' }, agent },
  { isError: false, content: [{ type: 'text', text: 'ok' }] })

assert(ctx.__errLog.length === 4, `__errLog 记录 4 条 (got ${ctx.__errLog.length})`)
const classes = ctx.__errLog.map(r => r.errorClass)
assert(classes.includes('order-dep'), `顺序依赖分类 order-dep (${classes.join(',')})`)
assert(classes.includes('stale-snapshot'), `旧快照分类 stale-snapshot`)
assert(classes.includes('missing-module'), `缺模块分类 missing-module`)
assert(classes.includes('success'), `成功记录为 success`)
assert(ctx.__errLog.every(r => r.turn === 1 && r.tool && r.fp), '每条含 turn/tool/fp')

// =========================================================================
console.log('\n=== 测试 2: O7 turn 统计 ===')
assert(ctx.__hubStats.turnFails('hub-1') === 3, `turn 失败数=3 (got ${ctx.__hubStats.turnFails('hub-1')})`)
assert(ctx.__hubStats.turnFails('other') === 0, `未知 agent=0`)

// =========================================================================
console.log('\n=== 测试 3: O2 提醒仲裁（优先级 + 限流） ===')
const ctx3 = makeCtx()
mod.apply(ctx3, {})
const agent3 = fakeAgent('hub-3')
// 排队 3 条（优先级乱序）
ctx3.__reminder('hub-3', { priority: 6, text: 'todo 提醒' })
ctx3.__reminder('hub-3', { priority: 1, text: 'deny 提醒' })
ctx3.__reminder('hub-3', { priority: 4, text: '反思提醒' })
const r3 = await ctx3.emit('agent/pre-step', { agent: agent3, turn: 1, signal: null })
const texts = (r3?.messages || []).map(m => m.content?.[0]?.text || '')
assert(texts.length === 2, `单步限流 2 条 (got ${texts.length})`)
assert(texts[0].includes('deny'), `最高优先级 deny 先注入 (${texts.join(' | ')})`)
assert(texts.some(t => t.includes('反思')), `次高优先级反思注入`)
assert(!texts.some(t => t.includes('todo')), `todo 被挤出（限流）`)
// 第二次 pre-step：剩余 todo 注入
const r3b = await ctx3.emit('agent/pre-step', { agent: agent3, turn: 1, signal: null })
const textsB = (r3b?.messages || []).map(m => m.content?.[0]?.text || '')
assert(textsB.length === 1 && textsB[0].includes('todo'), `剩余 todo 下步注入`)

// =========================================================================
console.log('\n=== 测试 4: fingerprint 边界（fs 工具/无参数/循环引用） ===')
const ctx4 = makeCtx()
mod.apply(ctx4, {})
const agent4 = fakeAgent('hub-4')
// file_path 工具（edit）
await ctx4.emit('tools/result',
  { name: 'edit', arguments: { file_path: 'D:\\x\\a.mjs', old_string: 'abc' }, agent: agent4 },
  { isError: true, content: [{ type: 'text', text: 'old_string was not found' }] })
// path 参数工具（read）
await ctx4.emit('tools/result',
  { name: 'read', arguments: { path: 'b.mjs' }, agent: agent4 },
  { isError: true, content: [{ type: 'text', text: 'cannot' }] })
// 无 command/file_path/path 工具 → JSON.stringify
await ctx4.emit('tools/result',
  { name: 'todo_write', arguments: { todos: [1] }, agent: agent4 },
  { isError: true, content: [{ type: 'text', text: 'err' }] })
// 循环引用 → fingerprint catch
const cyc = { self: null }; cyc.self = cyc
await ctx4.emit('tools/result',
  { name: 'weird', arguments: cyc, agent: agent4 },
  { isError: true, content: [{ type: 'text', text: 'err' }] })
// 无 exec.agent → 直接返回
const before4 = ctx4.__errLog.length
await ctx4.emit('tools/result', { name: 'pwsh', arguments: { command: 'x' } }, { isError: true, content: [{ type: 'text', text: 'e' }] })
assert(ctx4.__errLog.length === before4, '无 agent 不记录')
// 无 session.events → turn=0
const agent4b = { id: 'hub-4b', session: {} }
await ctx4.emit('tools/result', { name: 'pwsh', arguments: { command: 'y' }, agent: agent4b },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
assert(ctx4.__errLog.at(-1).turn === 0, `无 events turn=0 (got ${ctx4.__errLog.at(-1).turn})`)
assert(ctx4.__errLog.length === before4 + 1, `记录 ${before4 + 1} 条 (got ${ctx4.__errLog.length})`)

// =========================================================================
console.log('\n=== 测试 5: errLog 容量保护（errLogLimit） ===')
const ctx5 = makeCtx()
mod.apply(ctx5, { errLogLimit: 3 })
const agent5 = fakeAgent('hub-5')
for (let i = 0; i < 5; i++) {
  await ctx5.emit('tools/result',
    { name: 'pwsh', arguments: { command: `cap-${i}` }, agent: agent5 },
    { isError: true, content: [{ type: 'text', text: 'e' }] })
}
assert(ctx5.__errLog.length === 3, `errLog 限制 3 条 (got ${ctx5.__errLog.length})`)
assert(ctx5.__errLog[0].fp.includes('cap-2'), `保留最新 3 条 (${ctx5.__errLog[0].fp})`)

// =========================================================================
console.log('\n=== 测试 6: __reminder 参数校验 + __hubStats 接口 ===')
const ctx6 = makeCtx()
mod.apply(ctx6, {})
// 无 agentId / 无 text → 忽略
ctx6.__reminder(null, { text: 'x' })
ctx6.__reminder('hub-6', {})
ctx6.__reminder('hub-6', { text: 'ok', priority: 0 })
const agent6 = fakeAgent('hub-6')
const next6 = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
const r6 = await ctx6.emit('agent/pre-step', { agent: agent6, turn: 1, messages: [], signal: null }, next6)
const t6 = (r6?.messages || []).map(m => m.content?.[0]?.text || '').join('|')
assert(t6.includes('ok') && !t6.includes('x'), `校验后仅注入有效提醒`)
// priority 默认 5
ctx6.__reminder('hub-6', { text: 'default-priority' })
const r6b = await ctx6.emit('agent/pre-step', { agent: agent6, turn: 1, messages: [], signal: null }, next6)
assert((r6b?.messages || []).some(m => m.content?.[0]?.text === 'default-priority'), 'priority 默认生效')
// __hubStats 接口
assert(typeof ctx6.__hubStats.errLog === 'function' && Array.isArray(ctx6.__hubStats.errLog()), 'errLog() 接口')
assert(typeof ctx6.__hubStats.classify === 'function', 'classify 导出')
// pre-step 非 enter / 无 agent / 空队列 → 原样
ctx6.__reminder('hub-6c', { text: 'zzz' })
const r6c = await ctx6.emit('agent/pre-step', { turn: 1, messages: [], signal: null }, async () => ({ kind: 'reject' }))
assert(r6c?.kind === 'reject', '非 enter 原样返回')
const r6d = await ctx6.emit('agent/pre-step', { turn: 1, messages: [], signal: null }, next6)
assert(r6d?.kind === 'enter' && !(r6d?.messages || []).some(m => m.content?.[0]?.text === 'zzz'), '无 agent 不注入队列消息')

// =========================================================================
console.log('\n=== 测试 7: 清理 timer — turnStats 与 reminderQueues 清理 ===')
const ctx7 = makeCtx()
let cb7 = null
const rsi7 = global.setInterval
const rci7 = global.clearInterval
global.setInterval = (cb) => { cb7 = cb; return 1 }
global.clearInterval = () => {}
const realNow7 = Date.now
try {
  mod.apply(ctx7, {})
  assert(typeof cb7 === 'function', '清理 timer 注册')
  const agent7 = fakeAgent('hub-7')
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: 'a' }, agent: agent7 },
    { isError: true, content: [{ type: 'text', text: 'e' }] })
  // 排队一条提醒（ts=now）
  ctx7.__reminder('hub-7', { text: 'old-reminder' })
  // 拨快 31 分钟 → 清理 → reminderQueues 全旧删除、turnStats fails>0 保留
  Date.now = () => realNow7() + 31 * 60 * 1000
  cb7()
  Date.now = realNow7
  // 清理后 pre-step 不应注入旧提醒（队列已删）
  const next7 = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
  const r7 = await ctx7.emit('agent/pre-step', { agent: agent7, turn: 1, messages: [], signal: null }, next7)
  assert(!(r7?.messages || []).some(m => m.content?.[0]?.text === 'old-reminder'), '旧提醒队列被清理')
  // turnStats 保留（fails=1>0）→ turnFails 仍工作
  assert(ctx7.__hubStats.turnFails('hub-7') === 1, `turnStats 保留 (got ${ctx7.__hubStats.turnFails('hub-7')})`)
} finally {
  global.setInterval = rsi7
  global.clearInterval = rci7
  Date.now = realNow7
}

// =========================================================================
console.log('\n=== 测试 8: isFailure exitCode 分支（value.exitCode 数字非 0） ===')
const ctx8 = makeCtx()
mod.apply(ctx8, {})
const agent8 = fakeAgent('hub-8')
// exitCode=1 → 失败（isFailure true → errorClass 分类）
await ctx8.emit('tools/result',
  { name: 'pwsh', arguments: { command: 'exit1' }, agent: agent8 },
  { isError: false, value: { kind: 'foreground', exitCode: 1 }, content: [{ type: 'text', text: '[exit code: 1]' }] })
assert(ctx8.__errLog.at(-1).isFailure === true, `exitCode=1 判失败 (got ${ctx8.__errLog.at(-1).isFailure})`)
// exitCode=0 → 不判失败 → success
await ctx8.emit('tools/result',
  { name: 'pwsh', arguments: { command: 'exit0' }, agent: agent8 },
  { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
assert(ctx8.__errLog.at(-1).isFailure === false, `exitCode=0 判成功 (got ${ctx8.__errLog.at(-1).isFailure})`)
// result null → success 记录
const len8 = ctx8.__errLog.length
await ctx8.emit('tools/result', { name: 'pwsh', arguments: { command: 'nullres' }, agent: agent8 }, null)
assert(ctx8.__errLog.length === len8 + 1 && ctx8.__errLog.at(-1).isFailure === false, 'result null 记录为 success')
// classify 空文本 → unknown；无匹配 → generic
assert(ctx8.__hubStats.classify('', ctx8.__errLog._cfg || { errorClasses: [] }) === 'unknown', '空文本 classify unknown')
assert(ctx8.__hubStats.classify('普通文本', { errorClasses: [] }) === 'generic', '无匹配 classify generic')

// =========================================================================
console.log('\n=== 测试 9: 剩余分支（extractText/isFailure 边界、fingerprint 缺失、跨 turn、排序） ===')
const ctx9 = makeCtx()
mod.apply(ctx9, {})
const agent9 = fakeAgent('hub-9')
// extractText：content 数组含非对象元素 + 非 enumerable text getter（catch）
const evilBlock = {}
Object.defineProperty(evilBlock, 'text', { get() { throw new Error('boom') }, enumerable: false })
await ctx9.emit('tools/result', { name: 'pwsh', arguments: { command: 'mixed-content' }, agent: agent9 },
  { isError: true, content: [42, 'raw', evilBlock] })
// isFailure：value.exitCode getter 抛 → catch
const evilValue = {}
Object.defineProperty(evilValue, 'exitCode', { get() { throw new Error('boom') }, enumerable: false })
await ctx9.emit('tools/result', { name: 'pwsh', arguments: { command: 'evil-value' }, agent: agent9 },
  { isError: false, value: evilValue })
// isFailure：content falsy（undefined）→ JSON.stringify(result)
await ctx9.emit('tools/result', { name: 'pwsh', arguments: { command: 'no-content' }, agent: agent9 },
  { isError: false, content: undefined })
// fingerprint：exec.name 缺失 + arguments 缺失
await ctx9.emit('tools/result', { arguments: { command: 'noname' }, agent: agent9 },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
await ctx9.emit('tools/result', { name: 'pwsh', agent: agent9 },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
// fingerprint：file_path 空串（108:40）
await ctx9.emit('tools/result', { name: 'edit', arguments: { file_path: '' }, agent: agent9 },
  { isError: true, content: [{ type: 'text', text: 'old_string was not found' }] })
// turn 推断：events 存在但无 turn/start → ?? 0（130:90）
const agent9b = { id: 'hub-9b', session: { events: [{ type: 'other', data: {} }] } }
await ctx9.emit('tools/result', { name: 'pwsh', arguments: { command: 'no-turnstart' }, agent: agent9b },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
assert(ctx9.__errLog.at(-1).turn === 0, `events 无 turn/start → turn=0 (got ${ctx9.__errLog.at(-1).turn})`)
// 跨 turn 重置（149:28）：turn=1 失败 → turn=2 失败 → fails 重置
const agent9c = fakeAgent('hub-9c', 1)
await ctx9.emit('tools/result', { name: 'pwsh', arguments: { command: 't1' }, agent: agent9c },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
const agent9c2 = fakeAgent('hub-9c', 2)
await ctx9.emit('tools/result', { name: 'pwsh', arguments: { command: 't2' }, agent: agent9c2 },
  { isError: true, content: [{ type: 'text', text: 'e' }] })
assert(ctx9.__hubStats.turnFails('hub-9c') === 1, `跨 turn 重置后 fails=1 (got ${ctx9.__hubStats.turnFails('hub-9c')})`)
// 同优先级按 ts 排序（190:45）
const ctx9d = makeCtx()
mod.apply(ctx9d, {})
ctx9d.__reminder('hub-9d', { text: 'later', priority: 5 })
const agent9d = fakeAgent('hub-9d')
const next9d = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
await new Promise((resolve) => setTimeout(resolve, 5)) // ts 不同
ctx9d.__reminder('hub-9d', { text: 'earlier-same-priority', priority: 5 })
const r9d = await ctx9d.emit('agent/pre-step', { agent: agent9d, turn: 1, messages: [], signal: null }, next9d)
const t9d = (r9d?.messages || []).map(m => m.content?.[0]?.text || '').join('|')
assert(t9d.includes('earlier-same-priority'), `同优先级按 ts 排序注入`)

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)