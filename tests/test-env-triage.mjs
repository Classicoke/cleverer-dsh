/**
 * dsh-env-triage 单元测试：溯源卡 / 绕圈卡 / turn 复盘 + O4 回写
 * 运行：node test-env-triage.mjs
 */
import { pathToFileURL } from 'node:url'

function makeCtx() {
  const listeners = new Map()
  return {
    logger: { info: () => {}, warn: (...a) => console.log('[warn]', ...a) },
    __errLog: [],
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

const mod = await import(pathToFileURL('plugins/dsh-env-triage.mjs').href)

const fail = (tool, cmd, agent, cls = 'generic') => ({ name: tool, arguments: { command: cmd }, agent })

// =========================================================================
console.log('\n=== 测试 1: 溯源卡（2 种方案失败 → 读源码提醒） ===')
const ctx = makeCtx()
mod.apply(ctx, {})
const agent = fakeAgent('t-1')
// 方案 1: 改 manifest 失败
await ctx.emit('tools/result', fail('pwsh', 'pnpm install --filter app', agent), { isError: true, content: [{ type: 'text', text: 'error: peer dep' }] })
ctx.__errLog.push({ tool: 'pwsh', fp: 'pwsh::pnpm install --filter app', errorClass: 'generic', turn: 1, isFailure: true })
// 方案 2: 删文件失败
await ctx.emit('tools/result', fail('pwsh', 'Remove-Item node_modules', agent), { isError: true, content: [{ type: 'text', text: 'error: denied' }] })
ctx.__errLog.push({ tool: 'pwsh', fp: 'pwsh::Remove-Item node_modules', errorClass: 'permission', turn: 1, isFailure: true })
const r1 = await ctx.emit('agent/pre-step', { agent, turn: 1, signal: null })
const t1 = JSON.stringify(r1)
assert(t1.includes('溯源卡'), `溯源卡注入 (${t1.slice(0, 80)})`)
assert(t1.includes('读相关工具源码'), '含读源码指令')

// =========================================================================
console.log('\n=== 测试 2: 绕圈卡（3 种方案失败 → 停下报告） ===')
const ctx2 = makeCtx()
mod.apply(ctx2, {})
const agent2 = fakeAgent('t-2')
await ctx2.emit('tools/result', fail('pwsh', 'npm-install-fix', agent2), { isError: true, content: [{ type: 'text', text: 'err1' }] })
ctx2.__errLog.push({ tool: 'pwsh', fp: 'pwsh::npm-install-fix', errorClass: 'generic', turn: 1, isFailure: true })
await ctx2.emit('tools/result', fail('pwsh', 'Remove-Item-node_modules-clean', agent2), { isError: true, content: [{ type: 'text', text: 'err2' }] })
ctx2.__errLog.push({ tool: 'pwsh', fp: 'pwsh::Remove-Item-node_modules-clean', errorClass: 'generic', turn: 1, isFailure: true })
await ctx2.emit('tools/result', fail('pwsh', 'Set-Content-package-manager-field', agent2), { isError: true, content: [{ type: 'text', text: 'err3' }] })
ctx2.__errLog.push({ tool: 'pwsh', fp: 'pwsh::Set-Content-package-manager-field', errorClass: 'generic', turn: 1, isFailure: true })
const r2 = await ctx2.emit('agent/pre-step', { agent: agent2, turn: 1, signal: null })
const t2 = JSON.stringify(r2)
assert(t2.includes('绕圈卡'), `绕圈卡注入 (${t2.slice(0, 80)})`)
assert(t2.includes('向用户如实报告'), '含报告用户指令')

// =========================================================================
console.log('\n=== 测试 3: turn 复盘 + O4 根因回写 ===')
const ctx3 = makeCtx()
mod.apply(ctx3, {})
const agent3 = fakeAgent('t-3', 1)
// 5 次同分类失败
for (let i = 0; i < 5; i++) {
  await ctx3.emit('tools/result', fail('pwsh', `cmd-${i}`, agent3), { isError: true, content: [{ type: 'text', text: 'Cannot find module x' }] })
  ctx3.__errLog.push({ tool: 'pwsh', fp: `pwsh::cmd-${i}`, errorClass: 'missing-module', turn: 1, isFailure: true })
}
await ctx3.emit('agent/turn-stopping', { agent: agent3, turn: 1, signal: null })
assert(agent3.steers.length === 1, `turn 复盘 steer 1 次 (got ${agent3.steers.length})`)
assert(agent3.steers[0].content?.[0]?.text.includes('turn 复盘'), 'steer 含 turn 复盘')
// O4: __errLog 里同分类记录被打根因标记
const marked = ctx3.__errLog.filter(r => r.rootCause === 'missing-module')
assert(marked.length === 5, `O4 根因回写 5 条 (got ${marked.length})`)
assert(marked[0].rootCauseCount === 5, '含根因计数')

// =========================================================================
console.log('\n=== 测试 4: 单一方案失败不触发（不打扰） ===')
const ctx4 = makeCtx()
mod.apply(ctx4, {})
const agent4 = fakeAgent('t-4')
await ctx4.emit('tools/result', fail('pwsh', 'only-one', agent4), { isError: true, content: [{ type: 'text', text: 'err' }] })
ctx4.__errLog.push({ tool: 'pwsh', fp: 'pwsh::only-one', errorClass: 'generic', turn: 1, isFailure: true })
const r4 = await ctx4.emit('agent/pre-step', { agent: agent4, turn: 1, signal: null })
assert(!JSON.stringify(r4).includes('env-triage'), `单方案失败不触发 (got ${JSON.stringify(r4).slice(0, 60)})`)

// =========================================================================
console.log('\n=== 测试 5: 观察层边界（无 agent/exitCode 文本/跨 turn/反查/容量） ===')
const ctx5 = makeCtx()
mod.apply(ctx5, {})
// 无 agent → 忽略
await ctx5.emit('tools/result', { name: 'pwsh', arguments: { command: 'x' } }, { isError: true, content: [{ type: 'text', text: 'e' }] })
// isError false + exit code 文本 → 判失败
const agent5 = fakeAgent('t-5')
await ctx5.emit('tools/result', fail('pwsh', 'exit1', agent5), { isError: false, content: [{ type: 'text', text: '[exit code: 1] boom' }] })
// isError false + 干净文本 → 忽略
await ctx5.emit('tools/result', fail('pwsh', 'ok-cmd', agent5), { isError: false, content: [{ type: 'text', text: 'all good' }] })
// content 数组含非对象元素 + 无 name/command（fp || 分支）
await ctx5.emit('tools/result', { name: '', arguments: {}, agent: agent5 }, { isError: true, content: [42, 'raw'] })
// 无 events 无 turn/start → turn=0
const agent5b = { id: 't-5b', session: { events: [{ type: 'other' }] } }
await ctx5.emit('tools/result', fail('pwsh', 'noturn', agent5b), { isError: true, content: [{ type: 'text', text: 'Cannot find module x' }] })
// errLog 反查命中（独立分类 generic → errLog 匹配 → cls 更新）
const ctx5c = makeCtx()
mod.apply(ctx5c, {})
const agent5c = fakeAgent('t-5c')
ctx5c.__errLog.push({ tool: 'pwsh', fp: 'x', errorClass: 'network', turn: 1, isFailure: true, text: 'weird internal failure 2 happened here' })
await ctx5c.emit('tools/result', fail('pwsh', 'mystery2', agent5c), { isError: true, content: [{ type: 'text', text: 'weird internal failure 2' }] })
// 容量 shift（13 次失败）
const ctx5d = makeCtx()
mod.apply(ctx5d, {})
const agent5d = fakeAgent('t-5d')
for (let i = 0; i < 13; i++) {
  await ctx5d.emit('tools/result', fail('pwsh', `bulk-${i}`, agent5d), { isError: true, content: [{ type: 'text', text: 'e' }] })
}
// 跨 turn 重置：turn=1 失败 → turn=2 失败
const ctx5e = makeCtx()
mod.apply(ctx5e, {})
const agent5e = fakeAgent('t-5e', 1)
await ctx5e.emit('tools/result', fail('pwsh', 't1', agent5e), { isError: true, content: [{ type: 'text', text: 'e' }] })
const agent5e2 = fakeAgent('t-5e', 2)
await ctx5e.emit('tools/result', fail('pwsh', 't2', agent5e2), { isError: true, content: [{ type: 'text', text: 'e' }] })
assert(true, '观察层边界路径全部执行')

// =========================================================================
console.log('\n=== 测试 6: pre-step 边界（非 enter/无 agent/单方案/hub 仲裁/空指纹） ===')
// 非 enter → 原样
const ctx6 = makeCtx()
mod.apply(ctx6, {})
const r6a = await ctx6.emit('agent/pre-step', { agent: fakeAgent('t-6a'), turn: 1 }, async () => ({ kind: 'reject' }))
assert(r6a?.kind === 'reject', '非 enter 原样返回')
// 无 agent → 原样
const r6b = await ctx6.emit('agent/pre-step', { turn: 1 }, async () => ({ kind: 'enter', messages: [] }))
assert(r6b?.kind === 'enter', '无 agent 原样返回')
// 单方案 2 次失败（同命令）→ reminders 空 → 无注入
const ctx6c = makeCtx()
mod.apply(ctx6c, {})
const agent6c = fakeAgent('t-6c')
for (let i = 0; i < 2; i++) {
  await ctx6c.emit('tools/result', fail('pwsh', 'same-cmd', agent6c), { isError: true, content: [{ type: 'text', text: 'e' }] })
  ctx6c.__errLog.push({ tool: 'pwsh', fp: 'pwsh::same-cmd', errorClass: 'generic', turn: 1, isFailure: true })
}
const r6c = await ctx6c.emit('agent/pre-step', { agent: agent6c, turn: 1, signal: null })
assert(!JSON.stringify(r6c).includes('env-triage'), `同方案失败不触发卡 (${JSON.stringify(r6c).slice(0, 60)})`)
// hub 仲裁：__reminder 存在 → 排队返回 decision（不直接注入）
const ctx6d = makeCtx()
const queued6d = []
ctx6d.__reminder = (id, r) => queued6d.push({ id, ...r })
mod.apply(ctx6d, {})
const agent6d = fakeAgent('t-6d')
await ctx6d.emit('tools/result', fail('pwsh', 'plan-a', agent6d), { isError: true, content: [{ type: 'text', text: 'err a' }] })
ctx6d.__errLog.push({ tool: 'pwsh', fp: 'pwsh::plan-a', errorClass: 'generic', turn: 1, isFailure: true })
await ctx6d.emit('tools/result', fail('pwsh', 'plan-b-different', agent6d), { isError: true, content: [{ type: 'text', text: 'err b' }] })
ctx6d.__errLog.push({ tool: 'pwsh', fp: 'pwsh::plan-b-different', errorClass: 'generic', turn: 1, isFailure: true })
const r6d = await ctx6d.emit('agent/pre-step', { agent: agent6d, turn: 1, signal: null })
assert(queued6d.length === 1 && queued6d[0].text.includes('溯源卡'), `hub 仲裁排队 (got ${queued6d.length})`)
assert(!JSON.stringify(r6d).includes('env-triage'), 'hub 存在时不直接注入')
// 空指纹 sim（纯符号命令 → bigrams 空 → sim=0）
const ctx6e = makeCtx()
mod.apply(ctx6e, {})
const agent6e = fakeAgent('t-6e')
await ctx6e.emit('tools/result', { name: '', arguments: { command: '!!!' }, agent: agent6e }, { isError: true, content: [{ type: 'text', text: 'e1' }] })
ctx6e.__errLog.push({ tool: '', fp: '::!!!', errorClass: 'generic', turn: 1, isFailure: true })
await ctx6e.emit('tools/result', { name: '', arguments: { command: '???' }, agent: agent6e }, { isError: true, content: [{ type: 'text', text: 'e2' }] })
ctx6e.__errLog.push({ tool: '', fp: '::???', errorClass: 'generic', turn: 1, isFailure: true })
const r6e = await ctx6e.emit('agent/pre-step', { agent: agent6e, turn: 1, signal: null })
assert(JSON.stringify(r6e).includes('溯源卡'), `空指纹方案判定不崩且触发 (${JSON.stringify(r6e).slice(0, 60)})`)

// =========================================================================
console.log('\n=== 测试 7: turn-stopping 边界（无 agent/失败不足/已复盘/steer 异常） ===')
// 无 agent
const ctx7 = makeCtx()
mod.apply(ctx7, {})
await ctx7.emit('agent/turn-stopping', { turn: 1 })
// 失败不足（2 次 < 5）→ 无 steer
const ctx7b = makeCtx()
mod.apply(ctx7b, {})
const agent7b = fakeAgent('t-7b')
for (let i = 0; i < 2; i++) {
  await ctx7b.emit('tools/result', fail('pwsh', `few-${i}`, agent7b), { isError: true, content: [{ type: 'text', text: 'e' }] })
}
await ctx7b.emit('agent/turn-stopping', { agent: agent7b, turn: 1 })
assert(agent7b.steers.length === 0, `失败不足不复盘 (got ${agent7b.steers.length})`)
// 复盘后再次 → warned.review 挡
const ctx7c = makeCtx()
mod.apply(ctx7c, {})
const agent7c = fakeAgent('t-7c')
for (let i = 0; i < 5; i++) {
  await ctx7c.emit('tools/result', fail('pwsh', `rv-${i}`, agent7c), { isError: true, content: [{ type: 'text', text: 'Cannot find module x' }] })
  ctx7c.__errLog.push({ tool: 'pwsh', fp: `pwsh::rv-${i}`, errorClass: 'missing-module', turn: 1, isFailure: true })
}
await ctx7c.emit('agent/turn-stopping', { agent: agent7c, turn: 1 })
await ctx7c.emit('agent/turn-stopping', { agent: agent7c, turn: 1 })
assert(agent7c.steers.length === 1, `复盘去重 (got ${agent7c.steers.length})`)
// steer 抛异常 → catch
const ctx7d = makeCtx()
mod.apply(ctx7d, {})
const agent7d = { id: 't-7d', session: { events: [{ type: 'turn/start', data: { turn: 1 } }] }, steer() { throw new Error('boom') } }
for (let i = 0; i < 5; i++) {
  await ctx7d.emit('tools/result', fail('pwsh', `thr-${i}`, agent7d), { isError: true, content: [{ type: 'text', text: 'e' }] })
}
await ctx7d.emit('agent/turn-stopping', { agent: agent7d, turn: 1 })
assert(true, 'steer 异常被捕获')

// =========================================================================
console.log('\n=== 测试 8: 剩余分支（command failed 文本/session 无 events/content getter/清理 timer） ===')
// 文本 'command failed' → 74 正则尾部分支
const ctx8 = makeCtx()
mod.apply(ctx8, {})
const agent8 = fakeAgent('t-8')
await ctx8.emit('tools/result', fail('pwsh', 'cf', agent8), { isError: false, content: [{ type: 'text', text: 'command failed: exit code 2' }] })
// session 无 events → turn 三元 false 分支（81:6）
const agent8b = { id: 't-8b', session: {} }
await ctx8.emit('tools/result', fail('pwsh', 'noevents', agent8b), { isError: true, content: [{ type: 'text', text: 'e' }] })
// content getter 抛 → extractText catch（90:6）
const evilBlock = {}
Object.defineProperty(evilBlock, 'text', { get() { throw new Error('boom') }, enumerable: false })
const agent8c = fakeAgent('t-8c')
await ctx8.emit('tools/result', fail('pwsh', 'evil', agent8c), { isError: true, content: [evilBlock] })
// 清理 timer（198-204）：旧状态删除、活跃保留
const ctx8d = makeCtx()
let cb8d = null
const rsi8d = global.setInterval
const rci8d = global.clearInterval
global.setInterval = (cb) => { cb8d = cb; return 1 }
global.clearInterval = () => {}
const realNow8d = Date.now
try {
  mod.apply(ctx8d, {})
  assert(typeof cb8d === 'function', '清理 timer 注册')
  const agent8d = fakeAgent('t-8d', 1)
  await ctx8d.emit('tools/result', fail('pwsh', 'old1', agent8d), { isError: true, content: [{ type: 'text', text: 'e' }] })
  const agent8e = fakeAgent('t-8e', 1)
  await ctx8d.emit('tools/result', fail('pwsh', 'fresh', agent8e), { isError: true, content: [{ type: 'text', text: 'e' }] })
  // 拨快 31 分钟 → 清理：t-8d 旧删除、t-8e 新保留
  Date.now = () => realNow8d() + 31 * 60 * 1000
  cb8d()
  Date.now = realNow8d
  // t-8d 状态已清：turn=2 同 agent 失败 1 次 → 不会触发任何卡（无旧记录）
  const agent8d2 = fakeAgent('t-8d', 2)
  await ctx8d.emit('tools/result', fail('pwsh', 'after', agent8d2), { isError: true, content: [{ type: 'text', text: 'e' }] })
  const r8d = await ctx8d.emit('agent/pre-step', { agent: agent8d2, turn: 2, signal: null })
  assert(!JSON.stringify(r8d).includes('env-triage'), `旧状态清理后单次失败不触发`)
} finally {
  global.setInterval = rsi8d
  global.clearInterval = rci8d
  Date.now = realNow8d
}

// =========================================================================
console.log('\n=== 测试 9: isFail 判定 || 链（content falsy / result null） ===')
const ctx9 = makeCtx()
mod.apply(ctx9, {})
const agent9 = fakeAgent('t-9')
// result null → JSON.stringify('') → 不判失败（74:144 || '' 分支）
await ctx9.emit('tools/result', fail('pwsh', 'nullres', agent9), null)
// content undefined + result 自身含 error 文本 → 74:134 || result 分支
await ctx9.emit('tools/result', fail('pwsh', 'objerr', agent9), { isError: false, error: 'boom error happened' })
assert(true, 'isFail || 链边界执行')

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)

