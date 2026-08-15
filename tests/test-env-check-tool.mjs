/**
 * dsh-env-check-tool 单元测试：工具注册、env_check all / 单项 / 无效项。
 * 运行：node test-env-check-tool.mjs
 */
import { pathToFileURL } from 'node:url'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 5a: 脚本超时无输出（err + out 空 + stderr 空 → 47 falsy 分支） ===')
const tmpDir5 = await mkdtemp(path.join(os.tmpdir(), 'envck-'))
const sleepScript = path.join(tmpDir5, 'sleep.mjs')
await writeFile(sleepScript, 'setTimeout(() => {}, 5000)')
const ctx5 = makeCtx()
mod.apply(ctx5, { scriptPath: sleepScript, timeoutMs: 200 })
const r5 = await ctx5.registered[0].execute({}, exec)
assert(r5.includes('env_check 执行失败'), `超时无输出返回错误文本 (${r5.slice(0, 60)}…)`)

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 5b: 脚本超时有输出（out 非空 → 走 50 行，err.code 非数字 → 0） ===')
const tmpDir5b = await mkdtemp(path.join(os.tmpdir(), 'envck-'))
const printSleepScript = path.join(tmpDir5b, 'print-sleep.mjs')
await writeFile(printSleepScript, "console.log('partial before timeout'); setTimeout(() => {}, 5000)")
const ctx5b = makeCtx()
mod.apply(ctx5b, { scriptPath: printSleepScript, timeoutMs: 200 })
const r5b = await ctx5b.registered[0].execute({}, exec)
assert(r5b.includes('partial before timeout') && r5b.includes('(exit 0)'), `超时有输出保留并报 exit 0 (${r5b.slice(0, 60)}…)`)

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 6: 脚本 stdout+stderr 混合且退出非 0（51 truthy：err && !out 为 false + errOut 有） ===')
const tmpDir6 = await mkdtemp(path.join(os.tmpdir(), 'envck-'))
const mixedScript = path.join(tmpDir6, 'mixed.mjs')
await writeFile(mixedScript, "console.log('partial output'); console.error('warn detail'); process.exit(2)")
const ctx6 = makeCtx()
mod.apply(ctx6, { scriptPath: mixedScript })
const r6 = await ctx6.registered[0].execute({}, exec)
assert(r6.includes('partial output'), `stdout 保留 (${r6.slice(0, 50)}…)`)
assert(r6.includes('warn detail'), `stderr 进入 [stderr] 尾注`)
assert(r6.includes('(exit 2)'), `退出码 2 报告`)

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 7: item 空白字符串 → 回退 all ===')
const r7 = await tool.execute({ item: '   ' }, exec)
assert(r7.includes('通过') || r7.includes('dep-consistency'), `空白 item 回退 all`)

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 8: output.render 函数 ===')
const renderOut = tool.output.render({}, '渲染文本')
assert(Array.isArray(renderOut) && renderOut[0]?.type === 'text' && renderOut[0].text === '渲染文本', 'render 返回 text 块')

await rm(tmpDir5, { recursive: true, force: true })
await rm(tmpDir5b, { recursive: true, force: true })
await rm(tmpDir6, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
