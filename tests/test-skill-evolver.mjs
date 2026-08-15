/**
 * skill-evolver 单元测试：模拟 cordis 上下文 + 临时技能目录。
 * 运行：node test-skill-evolver.mjs
 */
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
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
    _listeners: listeners,
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
const agent4b = fakeAgent('agent-4b')
// 失败指纹含绝对路径（正是本次垃圾 skill 的形态）
await ctx4b.emit('tools/result', { name: 'read', arguments: { file_path: 'D:\\\\repo\\\\src\\\\host-boot.ts' }, agent: agent4b },
  { isError: true, content: [{ type: 'text', text: 'EACCES permission denied' }] })
await ctx4b.emit('tools/result', { name: 'read', arguments: { file_path: 'D:\\\\repo\\\\src\\\\host-boot.ts' }, agent: agent4b },
  { isError: true, content: [{ type: 'text', text: 'EACCES permission denied' }] })
// 换路成功：改用 grep
await ctx4b.emit('tools/result', { name: 'grep', arguments: { path: 'D:\\\\repo', pattern: 'host-boot' }, agent: agent4b },
  { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'found' }] })
await ctx4b.emit('agent/turn-stopping', { agent: agent4b, turn: 1, signal: null })
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

// =========================================================================
console.log('\n=== 测试 6: 指纹/失败判定/文本边界（不落盘） ===')
const dir6 = await mkdtemp(path.join(os.tmpdir(), 'se-6-'))
const ctx6 = makeCtx()
mod.apply(ctx6, { skillsDir: dir6 })
const a6 = fakeAgent('agent-6')
// name 缺失 / arguments 缺失 / file_path 空串 / 循环引用
await ctx6.emit('tools/result', { arguments: { command: 'x' }, agent: a6 }, { isError: true, content: [{ type: 'text', text: 'e' }] })
await ctx6.emit('tools/result', { name: 'pwsh', agent: a6 }, { isError: true, content: [{ type: 'text', text: 'e' }] })
await ctx6.emit('tools/result', { name: 'edit', arguments: { file_path: '' }, agent: a6 }, { isError: true, content: [{ type: 'text', text: 'e' }] })
const cyc6 = { self: null }; cyc6.self = cyc6
await ctx6.emit('tools/result', { name: 'x', arguments: cyc6, agent: a6 }, { isError: true, content: [{ type: 'text', text: 'e' }] })
// result null / value getter 抛 / content falsy / content 数组含非对象
await ctx6.emit('tools/result', { name: 'pwsh', arguments: { command: 'rnull' }, agent: a6 }, null)
const evilVal6 = {}
Object.defineProperty(evilVal6, 'exitCode', { get() { throw new Error('boom') }, enumerable: false })
await ctx6.emit('tools/result', { name: 'pwsh', arguments: { command: 'evilv' }, agent: a6 }, { isError: false, value: evilVal6 })
await ctx6.emit('tools/result', { name: 'pwsh', arguments: { command: 'nocontent' }, agent: a6 }, { isError: false, content: undefined })
await ctx6.emit('tools/result', { name: 'pwsh', arguments: { command: 'mixed' }, agent: a6 }, { isError: true, content: [42, null, { type: 'text', text: 'real' }] })
// resultText catch（非 enumerable getter）
const evilBlock6 = {}
Object.defineProperty(evilBlock6, 'text', { get() { throw new Error('boom') }, enumerable: false })
await ctx6.emit('tools/result', { name: 'pwsh', arguments: { command: 'evilb' }, agent: a6 }, { isError: true, content: [evilBlock6] })
// 无 exec / 无 agent
await ctx6.emit('tools/result', null, { isError: true })
await ctx6.emit('tools/result', { name: 'pwsh', arguments: { command: 'na' } }, { isError: true, content: [{ type: 'text', text: 'e' }] })
// 同指纹成功（重试成功）→ 不清 pending、不收割（351）
const a6b = fakeAgent('agent-6b')
await ctx6.emit('tools/result', { name: 'pwsh', arguments: { command: 'retry-me' }, agent: a6b }, { isError: true, content: [{ type: 'text', text: 'e' }] })
await ctx6.emit('tools/result', { name: 'pwsh', arguments: { command: 'retry-me' }, agent: a6b }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
// 成功但失败不足 minFails（1 次）→ 不收割
const a6c = fakeAgent('agent-6c')
await ctx6.emit('tools/result', { name: 'pwsh', arguments: { command: 'fail-once' }, agent: a6c }, { isError: true, content: [{ type: 'text', text: 'e' }] })
await ctx6.emit('tools/result', { name: 'pwsh', arguments: { command: 'success-other' }, agent: a6c }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx6.emit('agent/turn-stopping', { agent: a6c, turn: 1 })
const files6 = await readDir(dir6)
assert(files6.length === 0, `边界场景不沉淀 (got ${files6.length})`)
await rm(dir6, { recursive: true, force: true })

// =========================================================================
console.log('\n=== 测试 7: 质量门槛各拒绝路径（不落盘） ===')
const dir7 = await mkdtemp(path.join(os.tmpdir(), 'se-7-'))
const ctx7 = makeCtx()
const warns7 = []
ctx7.logger.warn = (...a) => warns7.push(a.join(' '))
mod.apply(ctx7, { skillsDir: dir7 })
const mkLesson = (agent, failCmd, okCmd, failText = '[exit code: 1] x') => {
  const a = fakeAgent(agent)
  return { a, failCmd, okCmd, failText }
}
// 7a: 解法是工具调用串（edit::path）→ rejected（title 多词避开通用词门槛）
{
  const { a, failCmd, failText } = mkLesson('agent-7a', 'pnpm alpha install fix', 'edit::D:\\\\x\\\\a.mjs')
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: failCmd }, agent: a }, { isError: true, content: [{ type: 'text', text: failText }] })
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: failCmd }, agent: a }, { isError: true, content: [{ type: 'text', text: failText }] })
  await ctx7.emit('tools/result', { name: 'edit', arguments: { file_path: 'D:\\\\x\\\\a.mjs', old_string: 'o' }, agent: a }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
  await ctx7.emit('agent/turn-stopping', { agent: a, turn: 1 })
}
// 7b: 解法过短（<8 字符）→ rejected
{
  const { a, failCmd, okCmd, failText } = mkLesson('agent-7b', 'pnpm b', 'fixed')
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: failCmd }, agent: a }, { isError: true, content: [{ type: 'text', text: failText }] })
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: failCmd }, agent: a }, { isError: true, content: [{ type: 'text', text: failText }] })
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: okCmd }, agent: a }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
  await ctx7.emit('agent/turn-stopping', { agent: a, turn: 1 })
}
// 7c: 标题过短（<4 字符）→ rejected
{
  const a = fakeAgent('agent-7c')
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: 'ab' }, agent: a }, { isError: true, content: [{ type: 'text', text: 'e' }] })
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: 'ab' }, agent: a }, { isError: true, content: [{ type: 'text', text: 'e' }] })
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: 'abc' }, agent: a }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
  await ctx7.emit('agent/turn-stopping', { agent: a, turn: 1 })
}
// 7d: 标题是通用词（exit/error 开头且 ≤2 词）→ rejected
{
  const a = fakeAgent('agent-7d')
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: 'exit 1' }, agent: a }, { isError: true, content: [{ type: 'text', text: 'e' }] })
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: 'exit 1' }, agent: a }, { isError: true, content: [{ type: 'text', text: 'e' }] })
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: 'exit 0' }, agent: a }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
  await ctx7.emit('agent/turn-stopping', { agent: a, turn: 1 })
}
// 7e: symptom 含工具残留且超长（>200）→ rejected
{
  const a = fakeAgent('agent-7e')
  const longResidue = `<path>C:/x/a.mjs</path><content>${'x'.repeat(250)}</content>`
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: 'residue command fix alpha' }, agent: a }, { isError: true, content: [{ type: 'text', text: longResidue }] })
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: 'residue command fix alpha' }, agent: a }, { isError: true, content: [{ type: 'text', text: longResidue }] })
  await ctx7.emit('tools/result', { name: 'pwsh', arguments: { command: 'residue command fix alpha --ok' }, agent: a }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
  await ctx7.emit('agent/turn-stopping', { agent: a, turn: 1 })
}
const files7 = await readDir(dir7)
assert(files7.length === 0, `质量门槛拒绝全部沉淀 (got ${files7.length})`)
assert(warns7.some(w => w.includes('solution-not-human')), `解法短/工具串被拒（7a/7b 走 159）(got ${warns7.join(' | ').slice(0, 120)})`)
assert(warns7.some(w => w.includes('symptom-has-tool-residue')), `症状残留被拒（7e 走 161）`)
assert(warns7.some(w => w.includes('title-too-generic')), `通用词标题被拒（7c/7d 走 156）`)
await rm(dir7, { recursive: true, force: true })

// =========================================================================
console.log('\n=== 测试 8: learn 中间带增量 / 跨 agent skipped / learn 异常 ===')
// 8a: 相似度落中间带（similarityThreshold 与 mergeThreshold 之间）→ incremented（非 merge）
const dir8 = await mkdtemp(path.join(os.tmpdir(), 'se-8-'))
const ctx8 = makeCtx()
mod.apply(ctx8, { skillsDir: dir8, similarityThreshold: 0.2, mergeThreshold: 0.9 })
const a8 = fakeAgent('agent-8')
// 第一条：普通经验（命令多词 → title 超过 2 词，避免通用词门槛）
await ctx8.emit('tools/result', { name: 'pwsh', arguments: { command: 'alpha build fix command' }, agent: a8 }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] alpha failed' }] })
await ctx8.emit('tools/result', { name: 'pwsh', arguments: { command: 'alpha build fix command' }, agent: a8 }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] alpha failed' }] })
await ctx8.emit('tools/result', { name: 'pwsh', arguments: { command: 'alpha build fix command --force' }, agent: a8 }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx8.emit('agent/turn-stopping', { agent: a8, turn: 1 })
assert((await readDir(dir8)).length === 1, '第一条新建')
// 8b: 跨 agent 同解法 → learnedSet 无此 key → learn 返回 skipped（already-present）→ 404 else 分支
const a8b = fakeAgent('agent-8b')
await ctx8.emit('tools/result', { name: 'pwsh', arguments: { command: 'alpha build fix command' }, agent: a8b }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] alpha failed' }] })
await ctx8.emit('tools/result', { name: 'pwsh', arguments: { command: 'alpha build fix command' }, agent: a8b }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] alpha failed' }] })
await ctx8.emit('tools/result', { name: 'pwsh', arguments: { command: 'alpha build fix command --force' }, agent: a8b }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx8.emit('agent/turn-stopping', { agent: a8b, turn: 1 })
const c8 = await readFile(path.join(dir8, (await readDir(dir8))[0]), 'utf8')
assert((c8.match(/### \d{4}-\d{2}-\d{2}/g) || []).length === 0, '跨 agent 同解法被 already-present 跳过（无新增量）')
// 8c: learn 抛异常 → catch（skillsDir 是文件而非目录 → mkdir/writeFile 抛）
const ctx8c = makeCtx()
const fileAsDir = path.join(dir8, 'blocker.txt')
await writeFile(fileAsDir, 'x')
mod.apply(ctx8c, { skillsDir: fileAsDir })
const a8c = fakeAgent('agent-8c')
await ctx8c.emit('tools/result', { name: 'pwsh', arguments: { command: 'learn fail command alpha' }, agent: a8c }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] boom' }] })
await ctx8c.emit('tools/result', { name: 'pwsh', arguments: { command: 'learn fail command alpha' }, agent: a8c }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] boom' }] })
await ctx8c.emit('tools/result', { name: 'pwsh', arguments: { command: 'learn fail command alpha --fixed' }, agent: a8c }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx8c.emit('agent/turn-stopping', { agent: a8c, turn: 1 }) // 不抛错即通过
assert(true, 'learn 异常被捕获')
await rm(dir8, { recursive: true, force: true })

// =========================================================================
console.log('\n=== 测试 9: apply/观察边界（enabled=false / 限流 / bash 收割 / DSH_HOME / listSkills） ===')
// enabled=false → 无钩子
const ctx9 = makeCtx()
mod.apply(ctx9, { enabled: false, skillsDir: dir5 })
assert(ctx9._listeners.size === 0, `enabled=false 无钩子`)
// 限流（maxLessonsPerTurn=1）：两个卡点只沉淀 1 条
const dir9 = await mkdtemp(path.join(os.tmpdir(), 'se-9-'))
const ctx9b = makeCtx()
mod.apply(ctx9b, { skillsDir: dir9, maxLessonsPerTurn: 1 })
const a9b = fakeAgent('agent-9b')
for (const c of ['first command alpha build', 'second command beta build']) {
  await ctx9b.emit('tools/result', { name: 'pwsh', arguments: { command: c }, agent: a9b }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
  await ctx9b.emit('tools/result', { name: 'pwsh', arguments: { command: c }, agent: a9b }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
  await ctx9b.emit('tools/result', { name: 'pwsh', arguments: { command: `${c} --ok` }, agent: a9b }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
}
await ctx9b.emit('agent/turn-stopping', { agent: a9b, turn: 1 })
assert((await readDir(dir9)).length === 1, `maxLessonsPerTurn 限流 (got ${(await readDir(dir9)).length})`)
// bash 工具成功收割（367 bash 分支）
const ctx9c = makeCtx()
mod.apply(ctx9c, { skillsDir: dir9 })
const a9c = fakeAgent('agent-9c')
await ctx9c.emit('tools/result', { name: 'bash', arguments: { command: 'bash retry deploy fix' }, agent: a9c }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx9c.emit('tools/result', { name: 'bash', arguments: { command: 'bash retry deploy fix' }, agent: a9c }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx9c.emit('tools/result', { name: 'bash', arguments: { command: 'bash retry deploy fix --ok' }, agent: a9c }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx9c.emit('agent/turn-stopping', { agent: a9c, turn: 1 })
const files9c = await readDir(dir9)
assert(files9c.some(f => f.includes('bash')), `bash 收割沉淀 (${files9c.join(',')})`)
// DSH_HOME 未设 → resolveSkillsDir 用 homedir（不落盘验证，仅不崩）
const ctx9d = makeCtx()
mod.apply(ctx9d, {})
// turn-stopping 无 agent
await ctx9d.emit('agent/turn-stopping', { turn: 1 })
assert(true, 'apply/观察边界执行')
await rm(dir9, { recursive: true, force: true })

// =========================================================================
console.log('\n=== 测试 10: PATH_TITLE_RE / 空技能文件 / symptom 空 / listSkills / 中间带增量 ===')
// 10a: 标题命中 PATH_TITLE_RE（read- 前缀工具名）→ rejected
const dir10 = await mkdtemp(path.join(os.tmpdir(), 'se-10-'))
const ctx10 = makeCtx()
const warns10 = []
ctx10.logger.warn = (...a) => warns10.push(a.join(' '))
mod.apply(ctx10, { skillsDir: dir10 })
const a10a = fakeAgent('agent-10a')
const readHelper = { name: 'read-helper', arguments: { path: 'src/host-boot.ts' }, agent: a10a }
await ctx10.emit('tools/result', readHelper, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx10.emit('tools/result', readHelper, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx10.emit('tools/result', { name: 'pwsh', arguments: { command: 'read helper workaround fix' }, agent: a10a }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx10.emit('agent/turn-stopping', { agent: a10a, turn: 1 })
// 10b: symptom 空（失败无文本）+ failCount 有 → 新建走 239 falsy（'- （无记录）'）+ 272 || ''
const a10b = fakeAgent('agent-10b')
await ctx10.emit('tools/result', { name: 'pwsh', arguments: { command: 'silent fail command alpha' }, agent: a10b }, { isError: true, content: [] })
await ctx10.emit('tools/result', { name: 'pwsh', arguments: { command: 'silent fail command alpha' }, agent: a10b }, { isError: true, content: [] })
await ctx10.emit('tools/result', { name: 'pwsh', arguments: { command: 'silent fail command alpha --ok' }, agent: a10b }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx10.emit('agent/turn-stopping', { agent: a10b, turn: 1 })
const files10 = await readDir(dir10)
assert(files10.length === 1, `10a 拒绝 + 10b 新建 (got ${files10.length})`)
assert(files10[0].includes('silent'), `10b 新建成功 (${files10.join(',')})`)
assert(warns10.some(w => w.includes('title-is-path')), `10a 因路径标题被拒（154 行）(got ${warns10.join(' | ').slice(0, 120)})`)
// 10c: 空技能文件 → similarity 空串分支（115）+ 新建第二个
await writeFile(path.join(dir10, 'empty-skill.md'), '')
const a10c = fakeAgent('agent-10c')
await ctx10.emit('tools/result', { name: 'pwsh', arguments: { command: 'gamma build fix command' }, agent: a10c }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx10.emit('tools/result', { name: 'pwsh', arguments: { command: 'gamma build fix command' }, agent: a10c }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx10.emit('tools/result', { name: 'pwsh', arguments: { command: 'gamma build fix command --ok' }, agent: a10c }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx10.emit('agent/turn-stopping', { agent: a10c, turn: 1 })
const files10c = await readDir(dir10)
assert(files10c.length === 3, `空技能文件不阻塞新建 (got ${files10c.length})`)
// 10d: listSkills 子目录 SKILL.md（180/183）→ 查重时被读到
await mkdir(path.join(dir10, 'nested-skill'))
await writeFile(path.join(dir10, 'nested-skill', 'SKILL.md'), '---\nname: nested\ndescription: d\n---\nbeta build fix command related content here')
// 10e: 中间带 incremented（mergeThreshold=2.0 永不 merge，强制走 289）：新 agent 同卡点不同解法
const ctx10e = makeCtx()
mod.apply(ctx10e, { skillsDir: dir10, mergeThreshold: 2.0 })
const a10e = fakeAgent('agent-10e')
await ctx10e.emit('tools/result', { name: 'pwsh', arguments: { command: 'gamma build fix command' }, agent: a10e }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx10e.emit('tools/result', { name: 'pwsh', arguments: { command: 'gamma build fix command' }, agent: a10e }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx10e.emit('tools/result', { name: 'pwsh', arguments: { command: 'gamma build fix command --clean' }, agent: a10e }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx10e.emit('agent/turn-stopping', { agent: a10e, turn: 1 })
const c10e = await readFile(path.join(dir10, 'pwsh-gamma-build-fix-command.md'), 'utf8')
assert(c10e.includes('--clean') && (c10e.match(/### \d{4}-\d{2}-\d{2}/g) || []).length === 1, `中间带增量写入 (${c10e.slice(0, 60)}…)`)
// 10f: similarityThreshold 提高 → 289 false → 新建（match 存在但 score 不足，用无关卡点避免同名覆盖）
const ctx10f = makeCtx()
mod.apply(ctx10f, { skillsDir: dir10, similarityThreshold: 0.99 })
const a10f = fakeAgent('agent-10f')
await ctx10f.emit('tools/result', { name: 'pwsh', arguments: { command: 'omega unrelated command build' }, agent: a10f }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx10f.emit('tools/result', { name: 'pwsh', arguments: { command: 'omega unrelated command build' }, agent: a10f }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx10f.emit('tools/result', { name: 'pwsh', arguments: { command: 'omega unrelated command build --solved' }, agent: a10f }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx10f.emit('agent/turn-stopping', { agent: a10f, turn: 1 })
const files10f = await readDir(dir10)
assert(files10f.includes('pwsh-omega-unrelated-command-build.md'), `score 不足仍新建（289 false）(got ${files10f.join(',')})`)
// 10g: solution 为空（成功命令空串）→ isToolCallString('') 的 || '' 分支（149:36）
const ctx10g = makeCtx()
mod.apply(ctx10g, { skillsDir: dir10 })
const a10g = fakeAgent('agent-10g')
await ctx10g.emit('tools/result', { name: 'pwsh', arguments: { command: 'delta build fix command' }, agent: a10g }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx10g.emit('tools/result', { name: 'pwsh', arguments: { command: 'delta build fix command' }, agent: a10g }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx10g.emit('tools/result', { name: 'pwsh', arguments: { command: '' }, agent: a10g }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx10g.emit('agent/turn-stopping', { agent: a10g, turn: 1 })
// 10h: 子目录 SKILL.md 是目录 → readFile 抛 → catch（185:6）
await mkdir(path.join(dir10, 'broken-skill', 'SKILL.md'), { recursive: true })
// 10i: 多候选收割（fails 不同 → 360 的 v.fails > best.v.fails）
const ctx10i = makeCtx()
mod.apply(ctx10i, { skillsDir: dir10 })
const a10i = fakeAgent('agent-10i')
await ctx10i.emit('tools/result', { name: 'pwsh', arguments: { command: 'zeta low fail cmd' }, agent: a10i }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
await ctx10i.emit('tools/result', { name: 'pwsh', arguments: { command: 'zeta low fail cmd' }, agent: a10i }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
for (let i = 0; i < 3; i++) {
  await ctx10i.emit('tools/result', { name: 'pwsh', arguments: { command: 'eta high fail cmd' }, agent: a10i }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
}
await ctx10i.emit('tools/result', { name: 'pwsh', arguments: { command: 'eta high fail cmd --solved' }, agent: a10i }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
await ctx10i.emit('agent/turn-stopping', { agent: a10i, turn: 1 })
const c10i = await readFile(path.join(dir10, 'pwsh-eta-high-fail.md'), 'utf8')
assert(c10i.includes('连续失败 3 次'), `多候选收割高失败指纹 (${c10i.slice(0, 60)}…)`)
// 10j: 状态清理 timer（416-420）：旧 track 删除、活跃保留
const ctx10j = makeCtx()
let cb10j = null
const rsi10j = global.setInterval
const rci10j = global.clearInterval
global.setInterval = (cb) => { cb10j = cb; return 1 }
global.clearInterval = () => {}
const realNow10j = Date.now
try {
  mod.apply(ctx10j, { skillsDir: dir10 })
  assert(typeof cb10j === 'function', '清理 timer 注册')
  const a10j = fakeAgent('agent-10j')
  await ctx10j.emit('tools/result', { name: 'pwsh', arguments: { command: 'old cmd alpha' }, agent: a10j }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
  const a10j2 = fakeAgent('agent-10j2')
  await ctx10j.emit('tools/result', { name: 'pwsh', arguments: { command: 'fresh cmd beta' }, agent: a10j2 }, { isError: true, content: [{ type: 'text', text: '[exit code: 1] e' }] })
  Date.now = () => realNow10j() + 31 * 60 * 1000
  cb10j()
  Date.now = realNow10j
  // agent-10j 状态已清：turn-stopping 无 pending → 不学习（清理生效无副作用）
  await ctx10j.emit('agent/turn-stopping', { agent: a10j, turn: 1 })
  assert(true, '清理 timer 执行不崩')
} finally {
  global.setInterval = rsi10j
  global.clearInterval = rci10j
  Date.now = realNow10j
}
await rm(dir10, { recursive: true, force: true })

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
