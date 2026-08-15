/**
 * dsh-plan-discipline 单元测试：多步骤任务 → todo 规划提醒
 * 运行：node test-plan-discipline.mjs
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
        const next = async () => this.nextResult ?? ({ kind: 'enter', messages: args[0]?.messages ?? [] })
        const r = await h(...args, next)
        if (r !== undefined) return r
      }
      return undefined
    },
    effect() { return () => {} },
    _listeners: listeners,
  }
}

const fakeAgent = (id, events = []) => ({ id, session: { events } })
const userMsg = (text, sourceKind = 'user') => ({
  id: 'm-' + Math.random().toString(36).slice(2),
  role: 'user',
  content: [{ type: 'text', text }],
  source: sourceKind ? { kind: sourceKind } : undefined,
})
const enterDecision = (messages) => ({ kind: 'enter', messages })

let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

const mod = await import(pathToFileURL('plugins/dsh-plan-discipline.mjs').href)

// =========================================================================
console.log('\n=== 测试 1: enabled=false 不注册钩子 ===')
const ctx0 = makeCtx()
mod.apply(ctx0, { enabled: false })
assert(ctx0._listeners.size === 0, `enabled=false 时无钩子注册 (got ${ctx0._listeners.size})`)
// 对照：enabled 默认时注册了 pre-step
const ctx0b = makeCtx()
mod.apply(ctx0b, {})
assert(ctx0b._listeners.has('agent/pre-step'), `enabled 默认注册 pre-step`)

// =========================================================================
console.log('\n=== 测试 2: 步骤词消息 → 注入 todo 提醒 ===')
const ctx2 = makeCtx()
mod.apply(ctx2, {})
const agent2 = fakeAgent('p-2', [])
const r2 = await ctx2.emit('agent/pre-step', { agent: agent2, turn: 1, signal: null, messages: [userMsg('请先创建项目结构，然后写核心代码，最后跑测试')] })
const texts2 = (r2?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').map(m => m.content?.[0]?.text || '')
assert(texts2.length === 1, `注入 1 条提醒 (got ${texts2.length})`)
assert(texts2[0].includes('todo_write'), '提醒要求用 todo_write')
assert(!texts2[0].includes('已失败'), '无失败时不使用试错期文本')

// =========================================================================
console.log('\n=== 测试 3: 数量词消息 → 注入 ===')
const ctx3 = makeCtx()
mod.apply(ctx3, {})
const r3 = await ctx3.emit('agent/pre-step', { agent: fakeAgent('p-3'), turn: 1, signal: null, messages: [userMsg('帮我处理 3 个文件')] })
const n3 = (r3?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n3 === 1, `数量词命中注入 (got ${n3})`)

// =========================================================================
console.log('\n=== 测试 4: 无多步骤信号 → 不打扰 ===')
const ctx4 = makeCtx()
mod.apply(ctx4, {})
const r4 = await ctx4.emit('agent/pre-step', { agent: fakeAgent('p-4'), turn: 1, signal: null, messages: [userMsg('帮我看看这个报错')] })
const n4 = (r4?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n4 === 0, `无信号不注入 (got ${n4})`)

// =========================================================================
console.log('\n=== 测试 5: 短消息（<6 字符）不打扰 ===')
const ctx5 = makeCtx()
mod.apply(ctx5, {})
const r5 = await ctx5.emit('agent/pre-step', { agent: fakeAgent('p-5'), turn: 1, signal: null, messages: [userMsg('你好')] })
const n5 = (r5?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n5 === 0, `短消息不注入 (got ${n5})`)

// =========================================================================
console.log('\n=== 测试 6: 本 turn 已写 todo → 不提醒 ===')
const ctx6 = makeCtx()
mod.apply(ctx6, {})
const agent6 = fakeAgent('p-6', [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'todo/write', data: {} },
])
const r6 = await ctx6.emit('agent/pre-step', { agent: agent6, turn: 1, signal: null, messages: [userMsg('请先做 A 然后做 B')] })
const n6 = (r6?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n6 === 0, `已写 todo 不重复提醒 (got ${n6})`)

// =========================================================================
console.log('\n=== 测试 7: 本 turn 已结束 → 视为有计划不提醒 ===')
const ctx7 = makeCtx()
mod.apply(ctx7, {})
const agent7 = fakeAgent('p-7', [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'turn/end', data: {} },
])
const r7 = await ctx7.emit('agent/pre-step', { agent: agent7, turn: 1, signal: null, messages: [userMsg('先做 A 再做 B')] })
const n7 = (r7?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n7 === 0, `turn 已结束不提醒 (got ${n7})`)

// =========================================================================
console.log('\n=== 测试 8: 无 session.events → 保守不提醒 ===')
const ctx8 = makeCtx()
mod.apply(ctx8, {})
const agent8 = { id: 'p-8', session: {} }
const r8 = await ctx8.emit('agent/pre-step', { agent: agent8, turn: 1, signal: null, messages: [userMsg('先做 A 再做 B')] })
const n8 = (r8?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n8 === 0, `无事件日志保守不提醒 (got ${n8})`)

// =========================================================================
console.log('\n=== 测试 9: events getter 抛异常 → 保守不提醒 ===')
const ctx9 = makeCtx()
mod.apply(ctx9, {})
const agent9 = { id: 'p-9', session: { get events() { throw new Error('boom') } } }
const r9 = await ctx9.emit('agent/pre-step', { agent: agent9, turn: 1, signal: null, messages: [userMsg('先做 A 再做 B')] })
const n9 = (r9?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n9 === 0, `events 异常保守不提醒 (got ${n9})`)

// =========================================================================
console.log('\n=== 测试 10: turn 号不匹配的 turn/start → 不误判已规划 ===')
const ctx10 = makeCtx()
mod.apply(ctx10, {})
const agent10 = fakeAgent('p-10', [{ type: 'turn/start', data: { turn: 2 } }]) // 其他 turn 的 start
const r10 = await ctx10.emit('agent/pre-step', { agent: agent10, turn: 1, signal: null, messages: [userMsg('先做 A 再做 B')] })
const n10 = (r10?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n10 === 1, `其他 turn 的 start 不影响本 turn 判断 (got ${n10})`)

// =========================================================================
console.log('\n=== 测试 11: 每 turn 限流（maxRemindersPerTurn=1） ===')
const ctx11 = makeCtx()
mod.apply(ctx11, {})
const agent11 = fakeAgent('p-11', [])
const msg11 = () => [userMsg('先做 A 再做 B')]
const r11a = await ctx11.emit('agent/pre-step', { agent: agent11, turn: 1, signal: null, messages: msg11() })
const n11a = (r11a?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
const r11b = await ctx11.emit('agent/pre-step', { agent: agent11, turn: 1, signal: null, messages: msg11() })
const n11b = (r11b?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n11a === 1 && n11b === 0, `第 1 次注入、第 2 次限流 (${n11a}/${n11b})`)

// =========================================================================
console.log('\n=== 测试 12: maxRemindersPerTurn=2 可注入 2 次 ===')
const ctx12 = makeCtx()
mod.apply(ctx12, { maxRemindersPerTurn: 2 })
const agent12 = fakeAgent('p-12', [])
const n12 = []
for (let i = 0; i < 3; i++) {
  const r = await ctx12.emit('agent/pre-step', { agent: agent12, turn: 1, signal: null, messages: [userMsg('先做 A 再做 B')] })
  n12.push((r?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length)
}
assert(n12.join(',') === '1,1,0', `3 次调用注入 1,1,0 (got ${n12.join(',')})`)

// =========================================================================
console.log('\n=== 测试 13: hub 失败数 ≥3 → 试错期刷新文本 ===')
const ctx13 = makeCtx()
ctx13.__hubStats = { turnFails: () => 5 }
mod.apply(ctx13, {})
const r13 = await ctx13.emit('agent/pre-step', { agent: fakeAgent('p-13'), turn: 1, signal: null, messages: [userMsg('先做 A 再做 B')] })
const t13 = (r13?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').map(m => m.content?.[0]?.text || '')[0]
assert(t13.includes('已失败 5 次'), `试错期文本含失败数 (${t13?.slice(0, 40)}…)`)
assert(t13.includes('todo 列表未同步更新'), '试错期文本提示更新计划')

// =========================================================================
console.log('\n=== 测试 14: hub 失败数 <3 → 普通文本 ===')
const ctx14 = makeCtx()
ctx14.__hubStats = { turnFails: () => 2 }
mod.apply(ctx14, {})
const r14 = await ctx14.emit('agent/pre-step', { agent: fakeAgent('p-14'), turn: 1, signal: null, messages: [userMsg('先做 A 再做 B')] })
const t14 = (r14?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').map(m => m.content?.[0]?.text || '')[0]
assert(t14.includes('todo_write') && !t14.includes('已失败'), '失败<3 用普通提醒')

// =========================================================================
console.log('\n=== 测试 15: hub 不存在 → 普通文本 ===')
const ctx15 = makeCtx()
mod.apply(ctx15, {}) // 无 __hubStats
const r15 = await ctx15.emit('agent/pre-step', { agent: fakeAgent('p-15'), turn: 1, signal: null, messages: [userMsg('先做 A 再做 B')] })
const t15 = (r15?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').map(m => m.content?.[0]?.text || '')[0]
assert(t15.includes('todo_write'), '无 hub 时用普通提醒')

// =========================================================================
console.log('\n=== 测试 16: 非 enter decision 原样返回 ===')
const ctx16 = makeCtx()
ctx16.nextResult = { kind: 'reject', reason: 'x' }
mod.apply(ctx16, {})
const r16 = await ctx16.emit('agent/pre-step', { agent: fakeAgent('p-16'), turn: 1, signal: null, messages: [userMsg('先做 A 再做 B')] })
assert(r16?.kind === 'reject' && r16?.reason === 'x', '非 enter 原样返回（reject 透传）')

// =========================================================================
console.log('\n=== 测试 17: 无 agent → 原样返回 ===')
const ctx17 = makeCtx()
mod.apply(ctx17, {})
const r17 = await ctx17.emit('agent/pre-step', { turn: 1, signal: null, messages: [userMsg('先做 A 再做 B')] })
const n17 = (r17?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n17 === 0, `无 agent 不注入 (got ${n17})`)

// =========================================================================
console.log('\n=== 测试 18: 无用户消息 → 不注入 ===')
const ctx18 = makeCtx()
mod.apply(ctx18, {})
const r18 = await ctx18.emit('agent/pre-step', { agent: fakeAgent('p-18'), turn: 1, signal: null, messages: [userMsg('先做 A 再做 B', 'assistant')] })
const n18 = (r18?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n18 === 0, `无用户消息不注入 (got ${n18})`)

// =========================================================================
console.log('\n=== 测试 19: 注入消息结构合法 ===')
const ctx19 = makeCtx()
mod.apply(ctx19, {})
const r19 = await ctx19.emit('agent/pre-step', { agent: fakeAgent('p-19'), turn: 1, signal: null, messages: [userMsg('先做 A 再做 B')] })
const msg19 = (r19?.messages || []).find(m => m.source?.plugin === 'dsh-plan-discipline')
assert(!!msg19?.id, '注入消息有 id')
assert(msg19?.role === 'user', 'role=user')
assert(msg19?.content?.[0]?.type === 'text', 'content 为 text 块')
assert(msg19?.source?.kind === 'plugin', 'source.kind=plugin')

// =========================================================================
console.log('\n=== 测试 20: 空内容消息 → 无信号不注入 ===')
const ctx20 = makeCtx()
mod.apply(ctx20, {})
const r20 = await ctx20.emit('agent/pre-step', { agent: fakeAgent('p-20'), turn: 1, signal: null, messages: [{ id: 'x', role: 'user', content: [], source: { kind: 'user' } }] })
const n20 = (r20?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n20 === 0, `空内容消息不注入 (got ${n20})`)

// =========================================================================
console.log('\n=== 测试 21: content 为 undefined 的消息不崩 ===')
const ctx21 = makeCtx()
mod.apply(ctx21, {})
const r21 = await ctx21.emit('agent/pre-step', { agent: fakeAgent('p-21'), turn: 1, signal: null, messages: [{ id: 'y', role: 'user', content: undefined, source: { kind: 'user' } }] })
const n21 = (r21?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n21 === 0, `content undefined 不崩不注入 (got ${n21})`)

// =========================================================================
console.log('\n=== 测试 22: content 含非 text 块（跳过取文本） ===')
const ctx22 = makeCtx()
mod.apply(ctx22, {})
const r22 = await ctx22.emit('agent/pre-step', { agent: fakeAgent('p-22'), turn: 1, signal: null, messages: [{ id: 'z', role: 'user', content: [{ type: 'image', url: 'x' }, { type: 'text', text: '先做 A 再做 B' }], source: { kind: 'user' } }] })
const n22 = (r22?.messages || []).filter(m => m.source?.plugin === 'dsh-plan-discipline').length
assert(n22 === 1, `非 text 块跳过、text 块命中注入 (got ${n22})`)

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
