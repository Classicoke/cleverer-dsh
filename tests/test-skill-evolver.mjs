/**
 * skill-evolver 单元测试：模拟 cordis 上下文 + 临时技能目录。
 * 运行：node test-skill-evolver.mjs
 */
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// ── 迷你 cordis Context ──────────────────────────────────────────────
function makeCtx() {
  const listeners = new Map()
  return {
    logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.log('[warn]', ...a) },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {
        const arr = listeners.get(event)
        const i = arr.indexOf(handler)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    async emit(event, ...args) {
      for (const h of listeners.get(event) || []) {
        const next = async () => ({ kind: 'allow' })
        const r = await h(...args, next)
        if (r !== undefined) return r
      }
    },
    effect(fn) {
      const cleanup = fn()
      return () => (typeof cleanup === 'function' ? cleanup() : undefined)
    },
  }
}

const fakeAgent = (id, turn = 1) => ({
  id,
  session: { header: { id }, events: [{ type: 'turn/start', data: { turn } }] },
})

let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

// ── 工具 ──────────────────────────────────────────────────────────────
const mod = await import(pathToFileURL('plugins/skill-evolver.mjs').href)

async function readDir(dir) {
  return (await readdir(dir)).filter(n => n.endsWith('.md'))
}

// =========================================================================
console.log('\n=== 测试 1: 失败2次→成功 → turn 结束新建技能 ===')
const dir1 = await mkdtemp(path.join(os.tmpdir(), 'se-1-'))
const ctx1 = makeCtx()
mod.apply(ctx1, { skillsDir: dir1 })
const a1 = fakeAgent('agent-1')
const cmd = 'pnpm run build'
// 失败 2 次
await ctx1.emit('tools/result', { name: 'pwsh', arguments: { command: cmd }, agent: a1 },
  { isError: false, value: { exitCode: 1 }, content: [{ type: 'text', text: '[exit code: 1] build error' }] })
await ctx1.emit('tools/result', { name: 'pwsh', arguments: { command: cmd }, agent: a1 },
  { isError: false, value: { exitCode: 1 }, content: [{ type: 'text', text: '[exit code: 1] build error' }] })
// 成功（换参数）
await ctx1.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build --force' }, agent: a1 },
  { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx1.emit('agent/turn-stopping', { agent: a1, turn: 1, signal: null })
const files1 = await readDir(dir1)
assert(files1.length === 1, `新建 1 个技能 (got ${files1.length})`)
const content1 = await readFile(path.join(dir1, files1[0]), 'utf8')
assert(content1.includes('name: '), 'frontmatter 有 name')
assert(content1.includes('有效解法'), '包含有效解法')
assert(content1.includes('pnpm run build --force'), '解法内容正确')

// =========================================================================
console.log('\n=== 测试 2: 相似经验（解法不同）→ 增量写入同一技能（不新建） ===')
const ctx2 = makeCtx()
mod.apply(ctx2, { skillsDir: dir1 })
const a2 = fakeAgent('agent-2')
// 失败：同样 pnpm build 家族（归一化后与 test1 的失败指纹相同）
const cmd2 = 'cd D:\\proj; pnpm run build 2>&1 | Select-Object -Last 1'
await ctx2.emit('tools/result', { name: 'pwsh', arguments: { command: cmd2 }, agent: a2 },
  { isError: false, value: { exitCode: 1 }, content: [{ type: 'text', text: '[exit code: 1]' }] })
await ctx2.emit('tools/result', { name: 'pwsh', arguments: { command: cmd2 }, agent: a2 },
  { isError: false, value: { exitCode: 1 }, content: [{ type: 'text', text: '[exit code: 1]' }] })
// 解法不同：这次用 --no-cache（不是 test1 的 --force）
await ctx2.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build --no-cache' }, agent: a2 },
  { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx2.emit('agent/turn-stopping', { agent: a2, turn: 1, signal: null })
const files2 = await readDir(dir1)
assert(files2.length === 1, `仍只有 1 个技能文件 (got ${files2.length})`)
const content2 = await readFile(path.join(dir1, files2[0]), 'utf8')
assert(content2.includes('--no-cache'), '增量包含新解法')
const incSections2 = (content2.match(/^\s*### \d{4}-\d{2}-\d{2}/gm) || []).length
assert(incSections2 === 1, `追加了增量 section (got ${incSections2})`)

// =========================================================================
console.log('\n=== 测试 3: 同卡点+同解法 → 跳过（不重复写） ===')
const ctx3 = makeCtx()
mod.apply(ctx3, { skillsDir: dir1 })
const a3 = fakeAgent('agent-3')
// 学一条: 卡点=pnpm run build, 解法=--verbose
await ctx3.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build' }, agent: a3 },
  { isError: false, value: { exitCode: 1 }, content: [{ type: 'text', text: '[exit code: 1]' }] })
await ctx3.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build' }, agent: a3 },
  { isError: false, value: { exitCode: 1 }, content: [{ type: 'text', text: '[exit code: 1]' }] })
await ctx3.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build --verbose' }, agent: a3 },
  { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx3.emit('agent/turn-stopping', { agent: a3, turn: 1, signal: null })
const skillFile3 = (await readDir(dir1))[0]
const afterFirst = await readFile(path.join(dir1, skillFile3), 'utf8')
// 基线: test2 已增量 1 条(--no-cache); test3 第一轮 --verbose → 共 2 条
const incAfterFirst = (afterFirst.match(/^\s*### \d{4}-\d{2}-\d{2}/gm) || []).length
assert(incAfterFirst === 2, `第一轮学习写入增量 (got ${incAfterFirst}, 基线1+本轮1=2)`)
// 第二次同样的经验（同卡点+同解法）→ 应跳过
await ctx3.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build' }, agent: a3 },
  { isError: false, value: { exitCode: 1 }, content: [{ type: 'text', text: '[exit code: 1]' }] })
await ctx3.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build' }, agent: a3 },
  { isError: false, value: { exitCode: 1 }, content: [{ type: 'text', text: '[exit code: 1]' }] })
await ctx3.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run build --verbose' }, agent: a3 },
  { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx3.emit('agent/turn-stopping', { agent: a3, turn: 1, signal: null })
const afterSecond = await readFile(path.join(dir1, skillFile3), 'utf8')
const incCount = (afterSecond.match(/^\s*### \d{4}-\d{2}-\d{2}/gm) || []).length
assert(incCount === 2, `重复经验未再追加 (增量 section 数=${incCount}, 应保持 2)`)

// =========================================================================
console.log('\n=== 测试 4: 完全不同经验 → 新建第二个技能 ===')
const ctx4 = makeCtx()
mod.apply(ctx4, { skillsDir: dir1 })
const a4 = fakeAgent('agent-4')
// 用非路径卡点（普通命令名），验证正常新建
await ctx4.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run test:unit' }, agent: a4 },
  { isError: true, content: [{ type: 'text', text: 'EACCES permission denied' }] })
await ctx4.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run test:unit' }, agent: a4 },
  { isError: true, content: [{ type: 'text', text: 'EACCES permission denied' }] })
// 换路成功：加 --no-sandbox
await ctx4.emit('tools/result', { name: 'pwsh', arguments: { command: 'pnpm run test:unit --no-sandbox' }, agent: a4 },
  { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx4.emit('agent/turn-stopping', { agent: a4, turn: 1, signal: null })
const files4 = await readDir(dir1)
assert(files4.length === 2, `非路径经验正常新建第 2 个技能 (got ${files4.length})`)

// =========================================================================
console.log('\n=== 测试 4b: 路径名卡点 → 拒绝沉淀（P0-2 泛化门槛） ===')
const dir4b = await mkdtemp(path.join(os.tmpdir(), 'se-4b-'))
const ctx4b = makeCtx()
mod.apply(ctx4b, { skillsDir: dir4b })
const a4b = fakeAgent('agent-4b')
// 失败指纹含绝对路径（正是本次垃圾 skill 的形态）
await ctx4b.emit('tools/result', { name: 'read', arguments: { file_path: 'D:\\\\deepseek-harness-master\\\\apps\\\\desktop\\\\src\\\\host-boot.ts' }, agent: a4b },
  { isError: true, content: [{ type: 'text', text: 'EACCES permission denied' }] })
await ctx4b.emit('tools/result', { name: 'read', arguments: { file_path: 'D:\\\\deepseek-harness-master\\\\apps\\\\desktop\\\\src\\\\host-boot.ts' }, agent: a4b },
  { isError: true, content: [{ type: 'text', text: 'EACCES permission denied' }] })
// 换路成功：改用 grep
await ctx4b.emit('tools/result', { name: 'grep', arguments: { path: 'D:\\\\deepseek-harness-master', pattern: 'host-boot' }, agent: a4b },
  { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'found' }] })
await ctx4b.emit('agent/turn-stopping', { agent: a4b, turn: 1, signal: null })
const files4b = await readDir(dir4b)
assert(files4b.length === 0, `路径名卡点被拒绝，不产生垃圾 skill (got ${files4b.length})`)
await rm(dir4b, { recursive: true, force: true })

// =========================================================================
console.log('\n=== 测试 5: 不满足 minFailsToLearn → 不学习 ===')
const dir5 = await mkdtemp(path.join(os.tmpdir(), 'se-5-'))
const ctx5 = makeCtx()
mod.apply(ctx5, { skillsDir: dir5, minFailsToLearn: 3 })
const a5 = fakeAgent('agent-5')
// 只失败 1 次就成功 → 不够格
await ctx5.emit('tools/result', { name: 'pwsh', arguments: { command: 'x' }, agent: a5 },
  { isError: true, content: [{ type: 'text', text: 'err' }] })
await ctx5.emit('tools/result', { name: 'pwsh', arguments: { command: 'x2' }, agent: a5 },
  { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx5.emit('agent/turn-stopping', { agent: a5, turn: 1, signal: null })
const files5 = await readDir(dir5)
assert(files5.length === 0, `失败不足阈值不学习 (got ${files5.length})`)

// 清理
await rm(dir1, { recursive: true, force: true })
await rm(dir5, { recursive: true, force: true })

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
