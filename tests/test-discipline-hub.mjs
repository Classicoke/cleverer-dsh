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

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
