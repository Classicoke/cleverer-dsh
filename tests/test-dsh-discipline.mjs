/**
 * dsh-discipline 单元测试：系统提示词纪律段注册
 * 运行：node test-dsh-discipline.mjs
 */
import { pathToFileURL } from 'node:url'

let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

/** 收集 systemPrompt.section 注册的上下文 */
function makeCtx() {
  const sections = []
  return {
    logger: { info: (...a) => console.log('[info]', ...a) },
    effect(fn) { return fn() }, // 立即执行注册回调
    systemPrompt: { section(s) { sections.push(s) } },
    sections,
  }
}

const mod = await import(pathToFileURL('plugins/dsh-discipline.mjs').href)

// =========================================================================
console.log('\n=== 测试 1: 默认纪律段注册 ===')
const ctx = makeCtx()
mod.apply(ctx, {})
assert(ctx.sections.length === 1, `注册 1 个 section (got ${ctx.sections.length})`)
const s0 = ctx.sections[0]
assert(s0.name === 'execution-discipline', `section name=execution-discipline`)
assert(s0.order === 50, `默认 order=50 (got ${s0.order})`)
assert(typeof s0.text === 'string' && s0.text.includes('执行纪律'), 'text 为纪律正文')
assert(s0.text.includes('11.'), '纪律含 11 条（动环境前先确认）')

// =========================================================================
console.log('\n=== 测试 2: config.text 覆盖 ===')
const ctx2 = makeCtx()
mod.apply(ctx2, { text: '自定义纪律文本' })
assert(ctx2.sections[0].text === '自定义纪律文本', `text 覆盖生效 (got ${ctx2.sections[0].text})`)

// =========================================================================
console.log('\n=== 测试 3: config.order 覆盖 ===')
const ctx3 = makeCtx()
mod.apply(ctx3, { order: 110 })
assert(ctx3.sections[0].order === 110, `order 覆盖生效 (got ${ctx3.sections[0].order})`)

// =========================================================================
console.log('\n=== 测试 4: order=0 保留（?? 语义：0 不是 null/undefined） ===')
const ctx4 = makeCtx()
mod.apply(ctx4, { order: 0 })
assert(ctx4.sections[0].order === 0, `order=0 保留 (got ${ctx4.sections[0].order})`)

// =========================================================================
console.log('\n=== 测试 5: 无 logger 不崩（ctx.logger 可选） ===')
const ctx5 = { effect(fn) { return fn() }, systemPrompt: { section() {} } }
try {
  mod.apply(ctx5, {})
  assert(true, '无 logger 时 apply 正常')
} catch (e) {
  assert(false, `无 logger 时 apply 抛错: ${e.message}`)
}

// =========================================================================
console.log('\n=== 测试 6: effect 回调在 apply 时执行（注册即生效） ===')
const ctx6 = makeCtx()
mod.apply(ctx6, {})
assert(ctx6.sections.length === 1, 'effect 回调立即执行（section 已注册）')

// =========================================================================
console.log('\n=== 测试 7: 模块导出元数据 ===')
assert(mod.name === 'dsh-discipline', `name 导出正确`)
assert(Array.isArray(mod.inject) && mod.inject.includes('systemPrompt'), 'inject 声明 systemPrompt')
assert(typeof mod.apply === 'function', 'apply 为函数')

// =========================================================================
console.log('\n=== 测试 8: 纪律正文质量（11 条全在，含关键条款） ===')
const text = ctx.sections[0].text
const clauses = ['交付产物', '绝不编造', '说做就做', '失败换路', '先验证再交付', '本地优先', '小步快跑', '先验证前置产物', '编辑前重读', '探测命令沉淀', '动环境前先确认']
for (const c of clauses) {
  assert(text.includes(c), `含条款「${c}」`)
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
