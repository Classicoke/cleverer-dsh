/**
 * dsh-skill-provider 单元测试：runtime skill 注册 + frontmatter 解析 + 容错
 * 运行：node test-skill-provider.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function makeCtx() {
  const registrations = []
  const effects = []
  const warnings = []
  return {
    logger: { info: () => {}, warn: (...a) => warnings.push(a.join(' ')) },
    skills: {
      register(r) { registrations.push(r); return () => {} },
    },
    effect(fn) { const c = fn(); effects.push(c); return c },
    _registrations: registrations,
    _effects: effects,
    _warnings: warnings,
  }
}

let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

const mod = await import(pathToFileURL('plugins/dsh-skill-provider.mjs').href)

// =========================================================================
console.log('\n=== 测试 1: 模块元数据 ===')
assert(mod.name === 'dsh-skill-provider', `name 导出 (got ${mod.name})`)
assert(typeof mod.apply === 'function', 'apply 为函数')
assert(Array.isArray(mod.inject) && mod.inject.includes('skills'), `inject 含 skills (got ${JSON.stringify(mod.inject)})`)

// =========================================================================
console.log('\n=== 测试 2: enabled=false 不注册 ===')
const ctx0 = makeCtx()
mod.apply(ctx0, { enabled: false })
assert(ctx0._registrations.length === 0, `无注册 (got ${ctx0._registrations.length})`)
assert(ctx0._effects.length === 0, `无 effect (got ${ctx0._effects.length})`)

// =========================================================================
console.log('\n=== 测试 3: 真实 skills 目录注册 6 个 ===')
const ctx1 = makeCtx()
mod.apply(ctx1, {})
const names = ctx1._registrations.map((r) => r.name).sort()
assert(ctx1._registrations.length === 6, `注册 6 个 (got ${ctx1._registrations.length})`)
assert(ctx1._effects.length === 6, `6 个 effect (got ${ctx1._effects.length})`)
const expected = ['debug-by-root-cause', 'dsh-error-protocol', 'dsh-error-triage', 'dsh-fast-lookup', 'local-first', 'plan-before-execute']
assert(JSON.stringify(names) === JSON.stringify([...expected].sort()), `名字集合正确 (got ${names.join(', ')})`)

// =========================================================================
console.log('\n=== 测试 4: 注册字段（description/content/source/path）===')
const byName = new Map(ctx1._registrations.map((r) => [r.name, r]))
for (const n of expected) {
  const r = byName.get(n)
  assert(r && typeof r.description === 'string' && r.description.length > 0, `${n} description 非空`)
  assert(r && typeof r.content === 'string' && r.content.length > 0, `${n} content 非空`)
  assert(r && r.source === 'bundled', `${n} source=bundled (got ${r?.source})`)
  assert(r && typeof r.path === 'string' && r.path.endsWith(`${n}.md`), `${n} path 指向包内文件`)
}
// content 是正文（frontmatter 剥离）：以 # 开头而非 ---
for (const n of expected) {
  const r = byName.get(n)
  assert(r && r.content.startsWith('#') && !r.content.startsWith('---'), `${n} content 不含 frontmatter`)
}
// whenToUse 可选：dsh-fast-lookup 无、其余有
const fastLookup = byName.get('dsh-fast-lookup')
assert(fastLookup.whenToUse === undefined, `dsh-fast-lookup 无 whenToUse`)
for (const n of expected.filter((x) => x !== 'dsh-fast-lookup')) {
  assert(byName.get(n).whenToUse && byName.get(n).whenToUse.length > 0, `${n} whenToUse 存在`)
}

// =========================================================================
console.log('\n=== 测试 5: 容错——坏目录/坏文件跳过不崩 ===')
// 5a. 目录不存在 → warn 不崩、零注册
const ctxBad = makeCtx()
mod.apply(ctxBad, { skillsDir: join(tmpdir(), 'no-such-skill-dir-' + Date.now()) })
assert(ctxBad._registrations.length === 0, `不存在目录零注册`)
assert(ctxBad._warnings.some((w) => w.includes('cannot read skills dir')), `打 warn 日志`)

// 5b. 坏文件（无 name / 无 frontmatter）→ 跳过，好文件正常注册
const tmpDir = mkdtempSync(join(tmpdir(), 'cdsh-skills-'))
try {
  writeFileSync(join(tmpDir, 'no-name.md'), '---\ndescription: missing name\n---\nbody\n')
  writeFileSync(join(tmpDir, 'no-frontmatter.md'), '# plain body without frontmatter\n')
  writeFileSync(join(tmpDir, 'bad-name.md'), '---\nname: Bad_Name!\ndescription: x\n---\nbody\n')
  writeFileSync(join(tmpDir, 'good.md'), '---\nname: good-skill\ndescription: a good skill\nwhenToUse: when needed\n---\n# Good body\n')
  const ctxMix = makeCtx()
  mod.apply(ctxMix, { skillsDir: tmpDir })
  assert(ctxMix._registrations.length === 1, `只注册 1 个好文件 (got ${ctxMix._registrations.length})`)
  assert(ctxMix._registrations[0].name === 'good-skill', '好文件 name 正确')
  assert(ctxMix._registrations[0].whenToUse === 'when needed', '好文件 whenToUse 解析')
  assert(ctxMix._registrations[0].content.startsWith('# Good body'), '好文件 content 剥离 frontmatter')
  assert(ctxMix._warnings.length >= 3, `3 个坏文件各打 warn (got ${ctxMix._warnings.length})`)
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}

// =========================================================================
console.log('\n=== 测试 6: 真实 skills 目录文件数一致性 ===')
const realCount = readdirSync(join(process.cwd(), 'skills')).filter((f) => f.endsWith('.md')).length
assert(realCount === 6, `skills/ 目录 6 个 .md (got ${realCount})`)

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
