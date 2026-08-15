/**
 * dsh-env-check-tool 单元测试：工具注册、env_check all / 单项 / 无效项。
 * 运行：node test-env-check-tool.mjs
 */
import { pathToFileURL } from 'node:url'

function makeCtx() {
  const registered = []
  return {
    logger: { info: () => {}, warn: () => {} },
    registered,
    tools: { register(def) { registered.push(def); return () => {} } },
    on() { return () => {} },
    effect(fn) { const c = fn(); return () => (typeof c === 'function' ? c() : undefined) },
  }
}

let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

const mod = await import(pathToFileURL('plugins/dsh-env-check-tool.mjs').href)
const exec = { signal: new AbortController().signal }

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 1: 工具注册 ===')
const ctx1 = makeCtx()
mod.apply(ctx1, {})
assert(ctx1.registered.length === 1, `注册 1 个工具 (got ${ctx1.registered.length})`)
const tool = ctx1.registered[0]
assert(tool.name === 'env_check', '工具名 env_check')
assert(!tool.parameters.required || tool.parameters.required.length === 0, 'item 非必填')

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 2: env_check all（真实脚本） ===')
const r2 = await tool.execute({}, exec)
assert(r2.includes('通过'), `all 汇总行存在 (${r2.slice(-80).trim()})`)
assert(r2.includes('dep-consistency'), '包含检查项 id')
assert(r2.includes('(exit 0)') || r2.includes('(exit 1)'), '含退出码')

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 3: 单项检查 ===')
const r3 = await tool.execute({ item: 'collector-mode' }, exec)
assert(r3.includes('collector-mode'), '单项命中 collector-mode')

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 4: 无效脚本路径（不崩溃，返回错误文本） ===')
const ctx4 = makeCtx()
mod.apply(ctx4, { scriptPath: 'C:/no-such/script.mjs' })
const tool4 = ctx4.registered[0]
const r4 = await tool4.execute({}, exec)
assert(r4.includes('env_check 执行失败'), '脚本缺失返回错误文本')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
