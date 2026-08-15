/**
 * dsh-skill-loader 单元测试：skill 清单注入 + 关键词点名 + 状态清理
 * 运行：node test-skill-loader.mjs
 */
import { pathToFileURL } from 'node:url'

function makeCtx() {
  const listeners = new Map()
  const effects = []
  const cleanups = []
  return {
    logger: { info: () => {}, warn: (...a) => console.log('[warn]', ...a) },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    async emit(event, ...args) {
      const handlers = listeners.get(event) || []
      const callChain = async (i) => {
        if (i >= handlers.length) {
          return this.tailResult ?? { kind: 'enter', messages: args[0]?.messages ?? [] }
        }
        const next = () => callChain(i + 1)
        return await handlers[i](...args, next)
      }
      return await callChain(0)
    },
    effect(fn) { effects.push(fn); const c = fn(); cleanups.push(c); return c },
    _listeners: listeners,
    _effects: effects,
    _cleanups: cleanups,
  }
}

const fakeAgent = (id) => ({ id, session: { events: [] } })
const userMsg = (text, sourceKind = 'user') => ({
  id: 'm-' + Math.random().toString(36).slice(2),
  role: 'user',
  content: [{ type: 'text', text }],
  source: sourceKind ? { kind: sourceKind } : undefined,
})

let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

const mod = await import(pathToFileURL('plugins/dsh-skill-loader.mjs').href)
const injected = (r) => (r?.messages || []).filter(m => m?.source?.plugin === 'dsh-skill-loader')
const injectedTexts = (r) => injected(r).map(m => m.content?.[0]?.text || '')

// =========================================================================
console.log('\n=== 测试 1: enabled=false 不注册钩子 ===')
const ctx0 = makeCtx()
mod.apply(ctx0, { enabled: false })
assert(ctx0._listeners.size === 0, `enabled=false 无钩子 (got ${ctx0._listeners.size})`)

// =========================================================================
console.log('\n=== 测试 2: 首次 pre-step 注入 skill 清单 ===')
const ctx2 = makeCtx()
mod.apply(ctx2, {})
const agent2 = fakeAgent('s-2')
const r2 = await ctx2.emit('agent/pre-step', { agent: agent2, turn: 1, signal: null, messages: [userMsg('你好')] })
const t2 = injectedTexts(r2)
assert(t2.length === 1, `注入 1 条 (got ${t2.length})`)
assert(t2[0].includes('可用的纪律 skill'), '清单消息格式')
for (const skillName of ['dsh-error-protocol', 'dsh-error-triage', 'debug-by-root-cause', 'local-first', 'dsh-fast-lookup', 'plan-before-execute']) {
  assert(t2[0].includes(skillName), `清单含 ${skillName}`)
}

// =========================================================================
console.log('\n=== 测试 3: 同 agent 二次 pre-step 不重复清单 ===')
const r3 = await ctx2.emit('agent/pre-step', { agent: agent2, turn: 1, signal: null, messages: [userMsg('打包失败了')] })
const t3 = injectedTexts(r3)
assert(t3.filter(t => t.includes('可用的纪律 skill')).length === 0, `清单不重复注入 (got ${t3.length} 条)`)
assert(t3.some(t => t.includes('dsh-error-triage')), `二次注入为点名（命中 error-triage）`)

// =========================================================================
console.log('\n=== 测试 4: 不同 agent 各自注入一次清单 ===')
const ctx4 = makeCtx()
mod.apply(ctx4, {})
const a4a = fakeAgent('s-4a')
const a4b = fakeAgent('s-4b')
const r4a = await ctx4.emit('agent/pre-step', { agent: a4a, turn: 1, signal: null, messages: [userMsg('你好')] })
const r4b = await ctx4.emit('agent/pre-step', { agent: a4b, turn: 1, signal: null, messages: [userMsg('你好')] })
assert(injectedTexts(r4a).some(t => t.includes('可用的纪律 skill')), 'agent A 首步注入清单')
assert(injectedTexts(r4b).some(t => t.includes('可用的纪律 skill')), 'agent B 首步注入清单')

// =========================================================================
console.log('\n=== 测试 5: 关键词命中 → 点名加载 ===')
const ctx5 = makeCtx()
mod.apply(ctx5, {})
const agent5 = fakeAgent('s-5')
await ctx5.emit('agent/pre-step', { agent: agent5, turn: 1, signal: null, messages: [userMsg('你好')] }) // 首步清单
const r5 = await ctx5.emit('agent/pre-step', { agent: agent5, turn: 1, signal: null, messages: [userMsg('这个错误一直报 exit code 1，卡住了')] })
const t5 = injectedTexts(r5).join('\n')
assert(t5.includes('dsh-error-protocol'), `命中 error 关键词点名 error-protocol`)
assert(t5.includes('debug-by-root-cause'), `命中失败关键词点名 debug-by-root-cause`)
assert(t5.includes('先用 skill 工具加载'), '点名消息要求先加载')

// =========================================================================
console.log('\n=== 测试 6: 无命中关键词 → 不点名 ===')
const ctx6 = makeCtx()
mod.apply(ctx6, {})
const agent6 = fakeAgent('s-6')
await ctx6.emit('agent/pre-step', { agent: agent6, turn: 1, signal: null, messages: [userMsg('你好')] })
const r6 = await ctx6.emit('agent/pre-step', { agent: agent6, turn: 1, signal: null, messages: [userMsg('帮我写一段代码')] })
assert(injectedTexts(r6).length === 0, `无关键词不注入 (got ${injectedTexts(r6).length})`)

// =========================================================================
console.log('\n=== 测试 7: 每 turn 点名限流（maxInjectsPerTurn=1） ===')
const ctx7 = makeCtx()
mod.apply(ctx7, {})
const agent7 = fakeAgent('s-7')
await ctx7.emit('agent/pre-step', { agent: agent7, turn: 1, signal: null, messages: [userMsg('你好')] })
const r7a = await ctx7.emit('agent/pre-step', { agent: agent7, turn: 1, signal: null, messages: [userMsg('打包失败')] })
const r7b = await ctx7.emit('agent/pre-step', { agent: agent7, turn: 1, signal: null, messages: [userMsg('还是失败')] })
assert(injectedTexts(r7a).length === 1, `第 1 次点名注入 (got ${injectedTexts(r7a).length})`)
assert(injectedTexts(r7b).length === 0, `第 2 次点名被限流 (got ${injectedTexts(r7b).length})`)

// =========================================================================
console.log('\n=== 测试 8: maxInjectsPerTurn=2 可点名 2 次 ===')
const ctx8 = makeCtx()
mod.apply(ctx8, { maxInjectsPerTurn: 2 })
const agent8 = fakeAgent('s-8')
await ctx8.emit('agent/pre-step', { agent: agent8, turn: 1, signal: null, messages: [userMsg('你好')] })
const counts8 = []
for (let i = 0; i < 3; i++) {
  const r = await ctx8.emit('agent/pre-step', { agent: agent8, turn: 1, signal: null, messages: [userMsg('打包失败')] })
  counts8.push(injectedTexts(r).length)
}
assert(counts8.join(',') === '1,1,0', `3 次调用注入 1,1,0 (got ${counts8.join(',')})`)

// =========================================================================
console.log('\n=== 测试 9: 无 agent → 不注入 ===')
const ctx9 = makeCtx()
mod.apply(ctx9, {})
const r9 = await ctx9.emit('agent/pre-step', { turn: 1, signal: null, messages: [userMsg('打包失败')] })
assert(injectedTexts(r9).length === 0, `无 agent 不注入 (got ${injectedTexts(r9).length})`)

// =========================================================================
console.log('\n=== 测试 10: 非 enter decision 原样返回 ===')
const ctx10 = makeCtx()
ctx10.tailResult = { kind: 'reject' }
mod.apply(ctx10, {})
const r10 = await ctx10.emit('agent/pre-step', { agent: fakeAgent('s-10'), turn: 1, signal: null, messages: [userMsg('打包失败')] })
assert(r10?.kind === 'reject', '非 enter 原样透传')

// =========================================================================
console.log('\n=== 测试 11: 无用户消息（仅 assistant）→ 点名不触发 ===')
const ctx11 = makeCtx()
mod.apply(ctx11, {})
const agent11 = fakeAgent('s-11')
const r11 = await ctx11.emit('agent/pre-step', { agent: agent11, turn: 1, signal: null, messages: [userMsg('打包失败', 'assistant')] })
const t11 = injectedTexts(r11)
assert(t11.filter(t => t.includes('可用的纪律 skill')).length === 1, '首步仍注入清单（agent 首次）')
assert(t11.filter(t => t.includes('当前任务匹配')).length === 0, '无用户消息不点名')

// =========================================================================
console.log('\n=== 测试 12: 注入消息结构合法 ===')
const ctx12 = makeCtx()
mod.apply(ctx12, {})
const r12 = await ctx12.emit('agent/pre-step', { agent: fakeAgent('s-12'), turn: 1, signal: null, messages: [userMsg('你好')] })
const m12 = injected(r12)[0]
assert(!!m12?.id, '消息有 id')
assert(m12?.role === 'user', 'role=user')
assert(m12?.content?.[0]?.type === 'text', 'content text 块')
assert(m12?.source?.kind === 'plugin' && m12?.source?.plugin === 'dsh-skill-loader', 'source 标注插件')

// =========================================================================
console.log('\n=== 测试 13: config.skills 自定义注册表 ===')
const ctx13 = makeCtx()
mod.apply(ctx13, { skills: [
  { name: 'my-custom-skill', trigger: '遇到 X 时用', keywords: ['X'] },
  { name: 'no-keywords-skill', trigger: '无关键词条目' }, // 无 keywords → 走 || []
] })
const agent13 = fakeAgent('s-13')
const r13a = await ctx13.emit('agent/pre-step', { agent: agent13, turn: 1, signal: null, messages: [userMsg('你好')] })
assert(injectedTexts(r13a)[0].includes('my-custom-skill'), '清单含自定义 skill')
const r13b = await ctx13.emit('agent/pre-step', { agent: agent13, turn: 1, signal: null, messages: [userMsg('遇到 X 了')] })
assert(injectedTexts(r13b)[0].includes('my-custom-skill'), '自定义关键词命中点名')
const r13c = await ctx13.emit('agent/pre-step', { agent: agent13, turn: 1, signal: null, messages: [userMsg('遇到 X 了')] })
assert(injectedTexts(r13c).length === 0, `无关键词条目不参与点名（限流后 0 条）`)

// =========================================================================
console.log('\n=== 测试 14: 空内容用户消息 → 不点名 ===')
const ctx14 = makeCtx()
mod.apply(ctx14, {})
const agent14 = fakeAgent('s-14')
await ctx14.emit('agent/pre-step', { agent: agent14, turn: 1, signal: null, messages: [userMsg('你好')] })
const r14 = await ctx14.emit('agent/pre-step', { agent: agent14, turn: 1, signal: null, messages: [{ id: 'e', role: 'user', content: [], source: { kind: 'user' } }] })
assert(injectedTexts(r14).length === 0, `空内容不点名 (got ${injectedTexts(r14).length})`)

// =========================================================================
console.log('\n=== 测试 14b: 无 source / content undefined / null 元素消息 → 不崩 ===')
const ctx14b = makeCtx()
mod.apply(ctx14b, {})
const agent14b = fakeAgent('s-14b')
await ctx14b.emit('agent/pre-step', { agent: agent14b, turn: 1, signal: null, messages: [userMsg('你好')] })
const r14b = await ctx14b.emit('agent/pre-step', { agent: agent14b, turn: 1, signal: null, messages: [
  { id: 'f', role: 'user', content: [{ type: 'text', text: '打包失败' }] }, // 无 source
  null, // null 元素
  { id: 'h', role: 'user', content: undefined, source: { kind: 'user' } }, // content undefined
] })
assert(injectedTexts(r14b).some(t => t.includes('dsh-error-triage')), `无 source 消息触发点名 (got ${injectedTexts(r14b).length} 条)`)

// =========================================================================
console.log('\n=== 测试 14c: content 含非 text 块 + text 块 → 点名命中 ===')
const ctx14c = makeCtx()
mod.apply(ctx14c, {})
const agent14c = fakeAgent('s-14c')
await ctx14c.emit('agent/pre-step', { agent: agent14c, turn: 1, signal: null, messages: [userMsg('你好')] })
const r14c = await ctx14c.emit('agent/pre-step', { agent: agent14c, turn: 1, signal: null, messages: [{ id: 'g', role: 'user', content: [{ type: 'image', url: 'x' }, { type: 'text', text: '打包失败' }], source: { kind: 'user' } }] })
assert(injectedTexts(r14c).some(t => t.includes('dsh-error-triage')), `混合 content 命中点名`)

// =========================================================================
console.log('\n=== 测试 15: 清理 timer — 旧记录被清理、新记录保留 ===')
const ctx15 = makeCtx()
let cb15 = null
const rsi15 = global.setInterval
const rci15 = global.clearInterval
global.setInterval = (cb) => { cb15 = cb; return 1 }
global.clearInterval = () => {}
const realNow15 = Date.now
try {
  mod.apply(ctx15, {}) // effect 立即执行 → 捕获 cb15
  const agent15 = fakeAgent('s-15')
  // 首步注入清单（listShownAt 记 now）+ 二步点名（injected 记 now）
  await ctx15.emit('agent/pre-step', { agent: agent15, turn: 1, signal: null, messages: [userMsg('你好')] })
  await ctx15.emit('agent/pre-step', { agent: agent15, turn: 1, signal: null, messages: [userMsg('打包失败')] })
  assert(typeof cb15 === 'function', 'setInterval 回调被捕获')
  // 拨快 31 分钟 → cutoff = now+1min > at → 全部清理
  Date.now = () => realNow15() + 31 * 60 * 1000
  cb15()
  Date.now = realNow15
  // 清理后 agent15 再次首步应重新注入清单（证明 listShownAt 已删）
  const r15b = await ctx15.emit('agent/pre-step', { agent: agent15, turn: 1, signal: null, messages: [userMsg('你好')] })
  assert(injectedTexts(r15b).some(t => t.includes('可用的纪律 skill')), '旧清单记录被清理（重新注入）')
  // 新记录保留：注入新 agent 后拨快 1 分钟 → 不删
  await ctx15.emit('agent/pre-step', { agent: fakeAgent('s-15c'), turn: 1, signal: null, messages: [userMsg('你好')] })
  Date.now = () => realNow15() + 60 * 1000
  cb15()
  Date.now = realNow15
  const r15d = await ctx15.emit('agent/pre-step', { agent: fakeAgent('s-15d'), turn: 1, signal: null, messages: [userMsg('你好')] })
  assert(injectedTexts(r15d).some(t => t.includes('可用的纪律 skill')), '新记录保留（新 agent 不受影响）')
} finally {
  global.setInterval = rsi15
  global.clearInterval = rci15
  Date.now = realNow15
}

// =========================================================================
console.log('\n=== 测试 16: effect 清理函数可调用（clearInterval） ===')
const ctx16 = makeCtx()
mod.apply(ctx16, {})
assert(ctx16._cleanups.length === 1, `注册 1 个 effect (got ${ctx16._cleanups.length})`)
ctx16._cleanups[0]() // 不抛错即通过
assert(true, 'cleanup 调用成功')

// =========================================================================
console.log('\n=== 测试 18: decision.messages 为 undefined → || [] 兜底不崩 ===')
const ctx18 = makeCtx()
mod.apply(ctx18, {})
const agent18 = fakeAgent('s-18')
// 第 1 步：正常注入清单（listShownAt 记录），tailResult 默认带 messages
await ctx18.emit('agent/pre-step', { agent: agent18, turn: 1, signal: null, messages: [userMsg('你好')] })
// 第 2 步：切 tailResult 为无 messages 的 enter → 钩子 1 透传 → 钩子 2 走 || [] 兜底
ctx18.tailResult = { kind: 'enter' }
const r18 = await ctx18.emit('agent/pre-step', { agent: agent18, turn: 1, signal: null, messages: [userMsg('打包失败')] })
assert(r18?.kind === 'enter', `messages undefined 兜底为 [] 不崩 (got kind=${r18?.kind})`)

// =========================================================================
console.log('\n=== 测试 17: 模块元数据 ===')
assert(mod.name === 'dsh-skill-loader', `name 导出 (got ${mod.name})`)
assert(typeof mod.apply === 'function', 'apply 为函数')

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
for (const c of makeCtx()._cleanups) c()
process.exit(failed > 0 ? 1 : 0)
