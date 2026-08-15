/**
 * dsh-fast-locate 单元测试：工具注册、子串/glob 匹配、node_modules/.git 跳过、
 * 多根并行、limit 截断、空 pattern、根目录不存在。
 * 运行：node test-fast-locate.mjs
 */
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, writeFile, rm, truncate, symlink } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'

// ── 按 parentURL 区分 mock：只替换 fast-locate 模块看到的 node:fs/promises ──
// 用途：确定性触发 scanRoot 的子目录 readdir 失败（95-96 行），避免 fs 竞态
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:fs/promises' && context.parentURL?.includes('dsh-fast-locate.mjs')) {
      return { url: 'mock:fs/promises-for-floc', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(specifier, context, nextLoad) {
    if (specifier === 'mock:fs/promises-for-floc') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { readdir as _readdir, stat as _stat } from 'node:fs/promises'
          const failSet = () => globalThis.__flocFail || new Set()
          const statFailSet = () => globalThis.__flocStatFail || new Set()
          const norm = (p) => String(p).replace(/\\\\/g, '/').toLowerCase()
          export function readdir(p, opts) {
            if (failSet().has(norm(p))) {
              return Promise.reject(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))
            }
            return _readdir(p, opts)
          }
          export function stat(p) {
            if (statFailSet().has(norm(p))) {
              return Promise.reject(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))
            }
            return _stat(p)
          }
        `,
      }
    }
    return nextLoad(specifier, context)
  },
})
delete globalThis.__flocFail

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
// output.render 函数（185 行）
const renderOut = tool.output.render({}, '渲染输出')
assert(Array.isArray(renderOut) && renderOut[0]?.type === 'text' && renderOut[0].text === '渲染输出', 'render 返回 text 块')

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

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 9: humanSize KB/MB/GB 分支（大文件 + 稀疏文件） ===')
const bigBase = await mkdtemp(path.join(os.tmpdir(), 'floc-big-'))
await writeFile(path.join(bigBase, 'k.txt'), 'x'.repeat(2048)) // 2KB → KB
await writeFile(path.join(bigBase, 'm.txt'), 'x'.repeat(2 * 1048576)) // 2MB → MB
const gPath = path.join(bigBase, 'g.txt')
await writeFile(gPath, '') // truncate 不创建文件，先建空文件
await truncate(gPath, 2 * 1073741824) // 2GB 稀疏文件 → GB（不实际占磁盘）
const r9 = await tool.execute({ pattern: '.txt', roots: [bigBase] }, exec)
assert(r9.includes('2.0 KB'), `KB 分支 (${r9.includes('2.0 KB')})`)
assert(r9.includes('2.0 MB'), `MB 分支`)
assert(r9.includes('2.00 GB'), `GB 分支`)

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 10: 子目录读取失败（mock readdir 拒绝）→ 静默跳过 ===')
const failBase = await mkdtemp(path.join(os.tmpdir(), 'floc-fail-'))
await mkdir(path.join(failBase, 'sub1'), { recursive: true })
await writeFile(path.join(failBase, 'sub1', 'target.txt'), 'x')
await writeFile(path.join(failBase, 'keep.txt'), 'x')
globalThis.__flocFail = new Set([path.join(failBase, 'sub1').replace(/\\/g, '/').toLowerCase()])
const r10 = await tool.execute({ pattern: 'target', roots: [failBase] }, exec)
assert(!r10.includes('无法扫描的根目录'), '子目录读失败不报根目录错误')
assert(r10.includes('找到 0 个匹配'), `子目录读失败静默跳过 (${r10.slice(0, 60)}…)`)
delete globalThis.__flocFail

await rm(bigBase, { recursive: true, force: true })
await rm(failBase, { recursive: true, force: true })

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 测试 11: execute 边界（pattern undefined/默认根/skipDirs/maxVisited/junction/stat 失败） ===')
// pattern undefined → 55:27 || '' → 报错
const r11a = await tool.execute({}, exec)
assert(r11a.includes('不能为空'), `pattern undefined 报错 (${r11a.slice(0, 40)})`)
// 无 roots → 默认根（192:8）
const r11b = await tool.execute({ pattern: 'host-boot' }, exec)
assert(r11b.startsWith('fast_locate: 找到'), `无 roots 用默认根 (${r11b.slice(0, 40)}…)`)
// skipDirs 参数（197-198）：额外跳过 sub → sub/deep.mjs 不再命中
const r11c = await tool.execute({ pattern: 'deep', roots: [rootA], skipDirs: ['sub'] }, exec)
assert(r11c.includes('找到 0 个匹配'), `skipDirs 合并生效 (${r11c.slice(0, 50)}…)`)
// 对照：不传 skipDirs 时 deep.mjs 命中
const r11c2 = await tool.execute({ pattern: 'deep', roots: [rootA] }, exec)
assert(r11c2.includes('找到 1 个匹配'), `默认不跳 sub（对照）`)
// maxVisited 截断（84/88/128/144）
const ctx11 = makeCtx()
mod.apply(ctx11, { maxVisited: 2 })
const r11d = await ctx11.registered[0].execute({ pattern: 'host-boot', roots: [rootA, rootB] }, exec)
assert(r11d.includes('访问上限'), `maxVisited 截断提示 (${r11d.slice(0, 80)}…)`)
// 层内条目级截断（88:37）：单层 ≥3 个可访问子目录 + maxVisited=2
const wideBase = await mkdtemp(path.join(os.tmpdir(), 'floc-wide-'))
for (const s of ['s1', 's2', 's3']) {
  await mkdir(path.join(wideBase, s))
  await writeFile(path.join(wideBase, s, 'probe.txt'), 'x')
}
const ctx11w = makeCtx()
mod.apply(ctx11w, { maxVisited: 2 })
const r11w = await ctx11w.registered[0].execute({ pattern: 'probe', roots: [wideBase] }, exec)
assert(r11w.includes('访问上限'), `层内截断提示 (${r11w.slice(0, 80)}…)`)
// 层间截断（84:35）：单 scanRoot 内一层结束后 visited 达上限且还有下一层
const deepBase = await mkdtemp(path.join(os.tmpdir(), 'floc-deep-'))
await mkdir(path.join(deepBase, 'mid', 'leaf'), { recursive: true })
await writeFile(path.join(deepBase, 'mid', 'leaf', 'probe.txt'), 'x')
const ctx11d = makeCtx()
mod.apply(ctx11d, { maxVisited: 2 })
const r11dd = await ctx11d.registered[0].execute({ pattern: 'probe', roots: [deepBase] }, exec)
assert(r11dd.includes('访问上限'), `层间截断提示 (${r11dd.slice(0, 80)}…)`)
// junction 目录跳过（100:32，Windows junction 不需要管理员权限）
const linkBase = await mkdtemp(path.join(os.tmpdir(), 'floc-link-'))
await mkdir(path.join(linkBase, 'real'))
await writeFile(path.join(linkBase, 'real', 'target.txt'), 'x')
try {
  await symlink(path.join(linkBase, 'real'), path.join(linkBase, 'linkdir'), 'junction')
  const r11e = await tool.execute({ pattern: 'target', roots: [linkBase] }, exec)
  assert(r11e.includes('找到 1 个匹配'), `junction 不进入（无循环）`)
} catch {
  assert(true, 'junction 创建失败跳过（无权限环境）')
}
// stat 失败 → 默认 statLike（110:12）
const normP = (p) => String(p).replace(/\\/g, '/').toLowerCase()
globalThis.__flocStatFail = new Set([normP(path.join(rootA, 'host-boot.ts'))])
const r11f = await tool.execute({ pattern: 'host-boot', roots: [rootA] }, exec)
assert(r11f.includes('host-boot.ts'), `stat 失败用默认值仍返回 (${r11f.slice(0, 60)}…)`)
delete globalThis.__flocStatFail

await rm(linkBase, { recursive: true, force: true })
await rm(wideBase, { recursive: true, force: true })
await rm(deepBase, { recursive: true, force: true })
await rm(base, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
