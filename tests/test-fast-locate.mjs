/**
 * dsh-fast-locate 单元测试：工具注册、子串/glob 匹配、node_modules/.git 跳过、
 * 多根并行、limit 截断、空 pattern、根目录不存在。
 * 运行：node test-fast-locate.mjs
 */
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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

const mod = await import(pathToFileURL('plugins/dsh-fast-locate.mjs').href)

// ── 构造测试目录树 ──────────────────────────────────────────────────────
const base = await mkdtemp(path.join(os.tmpdir(), 'floc-'))
const rootA = path.join(base, 'rootA')
const rootB = path.join(base, 'rootB')
await mkdir(path.join(rootA, 'sub'), { recursive: true })
await mkdir(path.join(rootA, 'node_modules', 'pkg'), { recursive: true })
await mkdir(path.join(rootA, '.git'), { recursive: true })
await mkdir(path.join(rootB), { recursive: true })
await writeFile(path.join(rootA, 'host-boot.ts'), '// boot')
await writeFile(path.join(rootA, 'sub', 'deep.mjs'), 'export {}')
await writeFile(path.join(rootA, 'node_modules', 'host-boot-x.mjs'), '// noise')
await writeFile(path.join(rootA, '.git', 'host-boot-config'), 'noise')
await writeFile(path.join(rootB, 'host-boot.ts.bak'), '// bak')
await writeFile(path.join(rootB, 'unrelated.txt'), 'txt')

const exec = { signal: new AbortController().signal }

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 1: 工具注册 ===')
const ctx1 = makeCtx()
mod.apply(ctx1, {})
assert(ctx1.registered.length === 1, `注册 1 个工具 (got ${ctx1.registered.length})`)
const tool = ctx1.registered[0]
assert(tool.name === 'fast_locate', '工具名 fast_locate')
assert(tool.parameters?.required?.includes('pattern'), 'pattern 必填')

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 2: 子串匹配 + 噪音目录跳过 + 多根并行 ===')
const r2 = await tool.execute({ pattern: 'host-boot', roots: [rootA, rootB] }, exec)
assert(r2.includes('找到 2 个匹配'), `多根各命中 1 个 (${r2.slice(0, 60)})`)
assert(r2.includes('host-boot.ts'), '命中 rootA/host-boot.ts')
assert(r2.includes('host-boot.ts.bak'), '命中 rootB/host-boot.ts.bak')
assert(!r2.includes('node_modules'), 'node_modules 被跳过')
assert(!r2.includes('.git'), '.git 被跳过')
assert(!r2.includes('unrelated.txt'), '不匹配文件不返回')

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 3: glob 匹配 (*.mjs) ===')
const r3 = await tool.execute({ pattern: '*.mjs', roots: [rootA] }, exec)
assert(r3.includes('deep.mjs'), `glob 命中 sub/deep.mjs (${r3.slice(0, 80)})`)
assert(!r3.includes('host-boot-x.mjs'), 'node_modules 内的 .mjs 仍被跳过')

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 4: 无匹配 ===')
const r4 = await tool.execute({ pattern: 'zzz-no-such-file', roots: [rootA, rootB] }, exec)
assert(r4.includes('找到 0 个匹配'), '0 匹配')

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 5: limit 截断 ===')
const r5 = await tool.execute({ pattern: 'host-boot', roots: [rootA, rootB], limit: 1 }, exec)
assert(r5.includes('仅显示前 1 个'), `limit 截断提示 (${r5.slice(0, 100)})`)
assert(r5.includes('共 2 个匹配'), '总数仍报告 2')

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 6: 空 pattern ===')
const r6 = await tool.execute({ pattern: '   ' }, exec)
assert(r6.includes('不能为空'), '空 pattern 报错')

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 7: 根目录不存在 ===')
const r7 = await tool.execute({ pattern: 'x', roots: [path.join(base, 'no-such-dir')] }, exec)
assert(r7.includes('无法扫描的根目录'), '不存在根目录报错不崩溃')

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 8: 文件与目录都返回 ===')
const r8 = await tool.execute({ pattern: 'rootA', roots: [base] }, exec)
assert(r8.includes('[dir]'), '目录类型标记存在')

await rm(base, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
