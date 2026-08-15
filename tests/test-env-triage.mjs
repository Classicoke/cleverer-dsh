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
    effect() { return () => {} },
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

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)

