/**
 * dsh-cordis-discipline 单元测试：动态插件热加载三层纪律
 * 运行：node test-cordis-discipline.mjs
 */
import { pathToFileURL } from 'node:url'

function makeCtx() {
  const listeners = new Map()
  const effects = []
  const cleanups = []
  return {
    logger: { info: (...a) => console.log('[info]', ...a), warn: () => {} },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    async emit(event, ...args) {
      const handlers = listeners.get(event) || []
      const callChain = async (i) => {
        if (i >= handlers.length) return undefined
        const next = () => callChain(i + 1)
        return await handlers[i](...args, next)
      }
      return await callChain(0)
    },
    effect(fn) { effects.push(fn); const c = fn(); cleanups.push(c); return c },
    systemPrompt: { section() {} },
    sections: [],
    _listeners: listeners,
    _cleanups: cleanups,
  }
}

const fakeAgent = (id) => ({ id, session: { events: [] }, steers: [], steer(m) { this.steers.push(m) } })
const exec = (name, args = {}, agent = fakeAgent('c-1')) => ({ name, arguments: args, agent })
const NEXT = async () => ({ kind: 'allow' })

let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

const mod = await import(pathToFileURL('plugins/dsh-cordis-discipline.mjs').href)

// =========================================================================
console.log('\n=== 测试 1: 模块元数据 + 纪律段注册 ===')
assert(mod.name === 'dsh-cordis-discipline', `name 导出`)
assert(Array.isArray(mod.inject) && mod.inject.includes('systemPrompt'), 'inject 声明 systemPrompt')
const ctx1 = makeCtx()
const secs1 = []
ctx1.systemPrompt.section = (s) => secs1.push(s)
mod.apply(ctx1, {})
assert(secs1.length === 1, `注册纪律段 (got ${secs1.length})`)
assert(secs1[0].name === 'cordis-discipline' && secs1[0].order === 110, '段 name/order')
assert(secs1[0].text.includes('动态插件纪律'), '默认纪律文本')
const ctx1b = makeCtx()
const secs1b = []
ctx1b.systemPrompt.section = (s) => secs1b.push(s)
mod.apply(ctx1b, { text: '自定义 cordis 纪律' })
assert(secs1b[0].text === '自定义 cordis 纪律', 'config.text 覆盖')

// =========================================================================
console.log('\n=== 测试 2: 非 cordis 工具直通 ===')
const ctx2 = makeCtx()
mod.apply(ctx2, {})
const r2 = await ctx2.emit('tools/pre-execute', exec('pwsh', { command: 'ls' }), NEXT)
assert(r2?.kind === 'allow', `非 cordis 工具直通 (got ${JSON.stringify(r2)})`)

// =========================================================================
console.log('\n=== 测试 3: exec 为空直通 ===')
const ctx3 = makeCtx()
mod.apply(ctx3, {})
const r3 = await ctx3.emit('tools/pre-execute', null, NEXT)
assert(r3?.kind === 'allow', 'exec null 直通')

// =========================================================================
console.log('\n=== 测试 4: cordis_define 缺 name → deny ===')
const ctx4 = makeCtx()
mod.apply(ctx4, {})
const r4 = await ctx4.emit('tools/pre-execute', exec('cordis_define', { code: 'x' }), NEXT)
assert(r4?.kind === 'deny' && r4.reason.includes('name'), `缺 name 被拒 (${r4?.reason?.slice(0, 30)}…)`)

// =========================================================================
console.log('\n=== 测试 5: cordis_define 有 name 无 code/client → deny ===')
const ctx5 = makeCtx()
mod.apply(ctx5, {})
const r5 = await ctx5.emit('tools/pre-execute', exec('cordis_define', { name: 'plug-a' }), NEXT)
assert(r5?.kind === 'deny' && r5.reason.includes('code'), `无代码被拒 (${r5?.reason?.slice(0, 30)}…)`)

// =========================================================================
console.log('\n=== 测试 6: cordis_define 正常（code）→ 放行 + 记录 pending ===')
const ctx6 = makeCtx()
mod.apply(ctx6, {})
const agent6 = fakeAgent('c-6')
const r6 = await ctx6.emit('tools/pre-execute', exec('cordis_define', { name: 'plug-a', code: 'export default {}' }, agent6), NEXT)
assert(r6?.kind === 'allow', 'define 放行')
// run 时"已定义"判定：pendingDefine 非空 → 放行
const r6b = await ctx6.emit('tools/pre-execute', exec('cordis_run', { id: 'plug-a' }, agent6), NEXT)
assert(r6b?.kind === 'allow', `define 后 run 放行`)

// =========================================================================
console.log('\n=== 测试 7: cordis_define 用 client 代码 → 放行（|| 分支） ===')
const ctx7 = makeCtx()
mod.apply(ctx7, {})
const r7 = await ctx7.emit('tools/pre-execute', exec('cordis_define', { name: 'plug-b', client: 'console.log(1)' }), NEXT)
assert(r7?.kind === 'allow', `client 代码也放行`)

// =========================================================================
console.log('\n=== 测试 8: cordis_run 未 define → deny ===')
const ctx8 = makeCtx()
mod.apply(ctx8, {})
const agent8 = fakeAgent('c-8')
const r8 = await ctx8.emit('tools/pre-execute', exec('cordis_run', { id: 'ghost' }, agent8), NEXT)
assert(r8?.kind === 'deny' && r8.reason.includes('cordis_define'), `未定义 run 被拒 (${r8?.reason?.slice(0, 30)}…)`)

// =========================================================================
console.log('\n=== 测试 9: cordis_run 无 id 参数 → id=? 仍执行 ===')
const ctx9 = makeCtx()
mod.apply(ctx9, {})
const agent9 = fakeAgent('c-9')
await ctx9.emit('tools/pre-execute', exec('cordis_define', { name: 'p9', code: 'x' }, agent9), NEXT)
const r9 = await ctx9.emit('tools/pre-execute', exec('cordis_run', {}, agent9), NEXT)
assert(r9?.kind === 'allow', `run 无 id 仍放行（id=?）`)

// =========================================================================
console.log('\n=== 测试 10: cordis_undefine 运行中 → deny ===')
const ctx10 = makeCtx()
mod.apply(ctx10, {})
const agent10 = fakeAgent('c-10')
await ctx10.emit('tools/pre-execute', exec('cordis_define', { name: 'p10', code: 'x' }, agent10), NEXT)
await ctx10.emit('tools/pre-execute', exec('cordis_run', { id: 'p10' }, agent10), NEXT)
const r10 = await ctx10.emit('tools/pre-execute', exec('cordis_undefine', { id: 'p10' }, agent10), NEXT)
assert(r10?.kind === 'deny' && r10.reason.includes('运行中'), `运行中 undefine 被拒`)

// =========================================================================
console.log('\n=== 测试 11: stop 后 undefine 放行 + 删除状态 ===')
const ctx11 = makeCtx()
mod.apply(ctx11, {})
const agent11 = fakeAgent('c-11')
await ctx11.emit('tools/pre-execute', exec('cordis_define', { name: 'p11', code: 'x' }, agent11), NEXT)
await ctx11.emit('tools/pre-execute', exec('cordis_run', { id: 'p11' }, agent11), NEXT)
await ctx11.emit('tools/pre-execute', exec('cordis_stop', { id: 'p11' }, agent11), NEXT)
const r11 = await ctx11.emit('tools/pre-execute', exec('cordis_undefine', { id: 'p11' }, agent11), NEXT)
assert(r11?.kind === 'allow', `stop 后 undefine 放行`)
// 再次 undefine 同 id（状态已删）→ 仍放行（幂等）
const r11b = await ctx11.emit('tools/pre-execute', exec('cordis_undefine', { id: 'p11' }, agent11), NEXT)
assert(r11b?.kind === 'allow', `重复 undefine 幂等`)

// =========================================================================
console.log('\n=== 测试 12: cordis_stop 移除 running ===')
const ctx12 = makeCtx()
mod.apply(ctx12, {})
const agent12 = fakeAgent('c-12')
await ctx12.emit('tools/pre-execute', exec('cordis_define', { name: 'p12', code: 'x' }, agent12), NEXT)
await ctx12.emit('tools/pre-execute', exec('cordis_run', { id: 'p12' }, agent12), NEXT)
await ctx12.emit('tools/pre-execute', exec('cordis_stop', { id: 'p12' }, agent12), NEXT)
// stop 后 undefine 应放行（running 已清）
const r12 = await ctx12.emit('tools/pre-execute', exec('cordis_undefine', { id: 'p12' }, agent12), NEXT)
assert(r12?.kind === 'allow', 'stop 清 running 后 undefine 放行')

// =========================================================================
console.log('\n=== 测试 13: 其他 cordis 工具（inspect 族）→ 直通 ===')
const ctx13 = makeCtx()
mod.apply(ctx13, {})
const r13 = await ctx13.emit('tools/pre-execute', exec('cordis_inspect', { id: 'x' }), NEXT)
assert(r13?.kind === 'allow', `cordis_inspect 直通 (${JSON.stringify(r13)})`)

// =========================================================================
console.log('\n=== 测试 14: 无 agent（agentId=global） ===')
const ctx14 = makeCtx()
mod.apply(ctx14, {})
// 先测：global 状态无任何 define 时 run 应被拒
const r14b = await ctx14.emit('tools/pre-execute', { name: 'cordis_run', arguments: {} }, NEXT)
assert(r14b?.kind === 'deny', `无 agent 未定义 run 被拒（global 状态隔离）`)
// 再测：global define 后 run 放行
const noAgentExec = { name: 'cordis_define', arguments: { name: 'g', code: 'x' } }
const r14 = await ctx14.emit('tools/pre-execute', noAgentExec, NEXT)
assert(r14?.kind === 'allow', `无 agent define 放行（global 状态）`)
const r14c = await ctx14.emit('tools/pre-execute', { name: 'cordis_run', arguments: { id: 'g' } }, NEXT)
assert(r14c?.kind === 'allow', `global define 后 run 放行`)

// =========================================================================
console.log('\n=== 测试 15: tools/result — define 成功（value 含 dyn-<n>）→ 移入 defined ===')
const ctx15 = makeCtx()
mod.apply(ctx15, {})
const agent15 = fakeAgent('c-15')
await ctx15.emit('tools/pre-execute', exec('cordis_define', { name: 'p15', code: 'x' }, agent15), NEXT)
const r15 = await ctx15.emit('tools/result',
  exec('cordis_define', { name: 'p15', code: 'x' }, agent15),
  { isError: false, value: 'Created plugin dyn-42' })
assert(r15 === undefined, 'result 事件无返回值')
// run 应该能放行（defined 非空，通过 pendingDefine 全标记）
const r15b = await ctx15.emit('tools/pre-execute', exec('cordis_run', { id: 'p15' }, agent15), NEXT)
assert(r15b?.kind === 'allow', 'define 确认后 run 放行')

// =========================================================================
console.log('\n=== 测试 16: tools/result — define 成功（content 含 pluginId JSON） ===')
const ctx16 = makeCtx()
mod.apply(ctx16, {})
const agent16 = fakeAgent('c-16')
await ctx16.emit('tools/pre-execute', exec('cordis_define', { name: 'p16', code: 'x' }, agent16), NEXT)
await ctx16.emit('tools/result',
  exec('cordis_define', { name: 'p16', code: 'x' }, agent16),
  { isError: false, content: [{ type: 'text', text: '{"pluginId":"real-16"}' }] })
const r16 = await ctx16.emit('tools/pre-execute', exec('cordis_run', { id: 'p16' }, agent16), NEXT)
assert(r16?.kind === 'allow', 'content pluginId 确认后 run 放行')

// =========================================================================
console.log('\n=== 测试 17: tools/result — define 失败 → 清 pending ===')
const ctx17 = makeCtx()
mod.apply(ctx17, {})
const agent17 = fakeAgent('c-17')
await ctx17.emit('tools/pre-execute', exec('cordis_define', { name: 'p17', code: 'x' }, agent17), NEXT)
await ctx17.emit('tools/result',
  exec('cordis_define', { name: 'p17', code: 'x' }, agent17),
  { isError: true, content: [{ type: 'text', text: 'boom' }] })
// define 失败 → pending 清空 → run 应被拒
const r17 = await ctx17.emit('tools/pre-execute', exec('cordis_run', { id: 'p17' }, agent17), NEXT)
assert(r17?.kind === 'deny', `define 失败后 run 被拒 (${r17?.kind})`)

// =========================================================================
console.log('\n=== 测试 18: tools/result — run 成功无操作 / 非 define/run 工具忽略 ===')
const ctx18 = makeCtx()
mod.apply(ctx18, {})
const agent18 = fakeAgent('c-18')
await ctx18.emit('tools/result', exec('cordis_stop', { id: 'x' }, agent18), { isError: false, value: 'ok' })
await ctx18.emit('tools/result', exec('pwsh', { command: 'ls' }, agent18), { isError: true, value: 'err' })
await ctx18.emit('tools/result', exec('cordis_run', { id: 'r18' }, agent18), { isError: false, value: 'ok' })
await ctx18.emit('tools/result', null, { isError: false })
assert(true, '非相关 result 静默忽略')

// =========================================================================
console.log('\n=== 测试 19: tools/result — 无 agent / result 空 → 不崩 ===')
const ctx19 = makeCtx()
mod.apply(ctx19, {})
await ctx19.emit('tools/result', exec('cordis_define', { name: 'p19', code: 'x' }), { isError: false })
await ctx19.emit('tools/result', exec('cordis_define', { name: 'p19b', code: 'x' }, fakeAgent('c-19b')), undefined)
assert(true, '无 agent / result undefined 不崩')

// =========================================================================
console.log('\n=== 测试 13b: cordis 工具 arguments undefined → 不崩（|| {} 兜底） ===')
const ctx13b = makeCtx()
mod.apply(ctx13b, {})
const r13b = await ctx13b.emit('tools/pre-execute', { name: 'cordis_run', arguments: undefined }, NEXT)
assert(r13b?.kind === 'deny', `arguments undefined 的 run 被拒不崩 (${r13b?.kind})`)
const r13c = await ctx13b.emit('tools/pre-execute', { name: 'cordis_stop' }, NEXT) // 无 arguments 字段
assert(r13c?.kind === 'allow', `arguments 缺失的 stop 直通不崩`)

// =========================================================================
console.log('\n=== 测试 13c: cordis_undefine 无 id 参数 → id=? 直通 ===')
const ctx13c = makeCtx()
mod.apply(ctx13c, {})
const r13d = await ctx13c.emit('tools/pre-execute', exec('cordis_undefine', {}), NEXT)
assert(r13d?.kind === 'allow', `undefine 无 id 直通 (${r13d?.kind})`)

// =========================================================================
console.log('\n=== 测试 13d: cordis_stop 用 packageId 参数 → 放行 ===')
const ctx13d = makeCtx()
mod.apply(ctx13d, {})
const agent13d = fakeAgent('c-13d')
await ctx13d.emit('tools/pre-execute', exec('cordis_define', { name: 'p13d', code: 'x' }, agent13d), NEXT)
await ctx13d.emit('tools/pre-execute', exec('cordis_run', { id: 'p13d' }, agent13d), NEXT)
const r13e = await ctx13d.emit('tools/pre-execute', exec('cordis_stop', { packageId: 'p13d' }, agent13d), NEXT)
assert(r13e?.kind === 'allow', `stop 用 packageId 直通`)
// stop 生效 → undefine 放行
const r13f = await ctx13d.emit('tools/pre-execute', exec('cordis_undefine', { id: 'p13d' }, agent13d), NEXT)
assert(r13f?.kind === 'allow', 'packageId stop 后 undefine 放行')

// =========================================================================
console.log('\n=== 测试 19b: define 成功但无 pendingDefine（直接 result） → || [] 兜底 ===')
const ctx19b = makeCtx()
mod.apply(ctx19b, {})
const agent19b = fakeAgent('c-19b2')
// 不经过 pre-execute define（pendingDefine 从未创建），直接 result 成功
await ctx19b.emit('tools/result',
  exec('cordis_define', { name: 'p19b', code: 'x' }, agent19b),
  { isError: false, value: 'dyn-77' })
// pendingDefine 为 undefined → || [] 兜底 → defined 加入 dyn-77 → run 放行
const r19b = await ctx19b.emit('tools/pre-execute', exec('cordis_run', { id: 'dyn-77' }, agent19b), NEXT)
assert(r19b?.kind === 'allow', '无 pending 的 define 成功仍生效（dyn id 入 defined）')

// =========================================================================
console.log('\n=== 测试 20: turn-stopping — running 非空 → steer 提醒 ===')
const ctx20 = makeCtx()
mod.apply(ctx20, {})
const agent20 = fakeAgent('c-20')
await ctx20.emit('tools/pre-execute', exec('cordis_define', { name: 'p20', code: 'x' }, agent20), NEXT)
await ctx20.emit('tools/pre-execute', exec('cordis_run', { id: 'p20' }, agent20), NEXT)
await ctx20.emit('agent/turn-stopping', { agent: agent20, turn: 1 })
assert(agent20.steers.length === 1, `steer 1 次 (got ${agent20.steers.length})`)
const steerText = agent20.steers[0]?.content?.[0]?.text || ''
assert(steerText.includes('cordis_stop'), `steer 提醒 stop (${steerText.slice(0, 30)}…)`)

// =========================================================================
console.log('\n=== 测试 21: turn-stopping — running 空 / 无 state / 无 agent → 不 steer ===')
const ctx21 = makeCtx()
mod.apply(ctx21, {})
const agent21 = fakeAgent('c-21')
await ctx21.emit('agent/turn-stopping', { agent: agent21, turn: 1 }) // 无 state
await ctx21.emit('agent/turn-stopping', { agent: fakeAgent('c-21b'), turn: 1 })
await ctx21.emit('agent/turn-stopping', { turn: 1 }) // 无 agent
assert(agent21.steers.length === 0, `无运行中插件不 steer`)
// 有 state 但 running 空
const agent21c = fakeAgent('c-21c')
await ctx21.emit('tools/pre-execute', exec('cordis_define', { name: 'p21', code: 'x' }, agent21c), NEXT)
await ctx21.emit('agent/turn-stopping', { agent: agent21c, turn: 1 })
assert(agent21c.steers.length === 0, `defined 但无 running 不 steer`)

// =========================================================================
console.log('\n=== 测试 22: turn-stopping — steer 抛异常被捕获 ===')
const ctx22 = makeCtx()
mod.apply(ctx22, {})
const agent22 = { id: 'c-22', session: { events: [] }, steer() { throw new Error('steer boom') } }
await ctx22.emit('tools/pre-execute', exec('cordis_define', { name: 'p22', code: 'x' }, agent22), NEXT)
await ctx22.emit('tools/pre-execute', exec('cordis_run', { id: 'p22' }, agent22), NEXT)
await ctx22.emit('agent/turn-stopping', { agent: agent22, turn: 1 })
assert(true, 'steer 异常被 catch 不致命')

// =========================================================================
console.log('\n=== 测试 23: 状态清理 — 空闲 agent 删除、活跃 agent 保留 ===')
const ctx23 = makeCtx()
let cb23 = null
const rsi23 = global.setInterval
const rci23 = global.clearInterval
global.setInterval = (cb) => { cb23 = cb; return 1 }
global.clearInterval = () => {}
const realNow23 = Date.now
try {
  mod.apply(ctx23, {})
  assert(typeof cb23 === 'function', '清理 timer 注册')
  // 空闲 agent（无 define/run）
  const idleAgent = fakeAgent('c-23idle')
  await ctx23.emit('tools/pre-execute', exec('cordis_stop', { id: 'nothing' }, idleAgent), NEXT) // 产生 state 但全空
  // 活跃 agent
  const activeAgent = fakeAgent('c-23active')
  await ctx23.emit('tools/pre-execute', exec('cordis_define', { name: 'p23', code: 'x' }, activeAgent), NEXT)
  await ctx23.emit('tools/pre-execute', exec('cordis_run', { id: 'p23' }, activeAgent), NEXT)
  // 触发清理：空闲的被删、活跃的保留
  Date.now = () => realNow23() + 31 * 60 * 1000
  cb23()
  Date.now = realNow23
  // 活跃 agent 的 running 还在 → 仍能 steer
  await ctx23.emit('agent/turn-stopping', { agent: activeAgent, turn: 1 })
  assert(activeAgent.steers.length === 1, '活跃 agent 状态保留（turn-stopping 仍触发）')
} finally {
  global.setInterval = rsi23
  global.clearInterval = rci23
  Date.now = realNow23
}

// =========================================================================
console.log('\n=== 测试 24: effect cleanup 可调用 ===')
const ctx24 = makeCtx()
mod.apply(ctx24, {})
assert(ctx24._cleanups.length === 2, `注册 2 个 effect（纪律段+状态清理）(got ${ctx24._cleanups.length})`)
ctx24._cleanups[0]?.()
ctx24._cleanups[1]?.()
assert(true, 'cleanup 不抛错')

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
