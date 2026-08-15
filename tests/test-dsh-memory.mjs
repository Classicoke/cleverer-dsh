/**
 * dsh-memory 单元测试：存储 CRUD、快照渲染、查重拒绝、上限、原子写入。
 * 运行：node test-dsh-memory.mjs
 */
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function makeCtx() {
  const listeners = new Map()
  const registered = []
  return {
    logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.log('[warn]', ...a) },
    registered,
    tools: {
      register(def) { registered.push(def); return () => {} },
    },
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
      const handlers = listeners.get(event) || []
      const callChain = async (i) => {
        if (i >= handlers.length) return { kind: 'enter', messages: [] }
        const next = () => callChain(i + 1)
        return await handlers[i](...args, next)
      }
      return await callChain(0)
    },
    effect(fn) { const c = fn(); return () => (typeof c === 'function' ? c() : undefined) },
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

const mod = await import(pathToFileURL('plugins/dsh-memory.mjs').href)

// =========================================================================
console.log('\n=== 测试 1: 工具注册 + add/list/remove ===')
const dir1 = await mkdtemp(path.join(os.tmpdir(), 'mem-1-'))
const ctx1 = makeCtx()
mod.apply(ctx1, { dir: dir1 })
assert(ctx1.registered.length === 1, `注册 1 个工具 (got ${ctx1.registered.length})`)
const tool = ctx1.registered[0]
assert(tool.name === 'memory', '工具名 memory')
assert(tool.parameters?.properties?.action?.enum?.length === 4, 'action 枚举 4 项')

const rAdd = await tool.execute({ action: 'add', target: 'memory', content: '用户偏好中文回答' }, { signal: new AbortController().signal })
assert(rAdd.includes('已添加'), `add 成功 (${rAdd.slice(0, 60)})`)

const rList = await tool.execute({ action: 'list', target: 'memory' }, { signal: new AbortController().signal })
assert(rList.includes('用户偏好中文回答'), 'list 返回条目')

const rAdd2 = await tool.execute({ action: 'add', target: 'memory', content: '项目用 pnpm workspace' }, { signal: new AbortController().signal })
assert(rAdd2.includes('已添加'), '第二条 add 成功')

const rRemove = await tool.execute({ action: 'remove', target: 'memory', index: 1 }, { signal: new AbortController().signal })
assert(rRemove.includes('已删除'), 'remove 成功')

// =========================================================================
console.log('\n=== 测试 2: 查重拒绝（相似条目不让新增） ===')
const dir2 = await mkdtemp(path.join(os.tmpdir(), 'mem-2-'))
const ctx2 = makeCtx()
mod.apply(ctx2, { dir: dir2 })
const tool2 = ctx2.registered[0]
await tool2.execute({ action: 'add', target: 'memory', content: '用户偏好中文回答问题' }, { signal: new AbortController().signal })
const dup = await tool2.execute({ action: 'add', target: 'memory', content: '用户喜欢用中文回答' }, { signal: new AbortController().signal })
assert(dup.includes('重复'), `相似条目被时间窗/查重拒绝 (${dup.slice(0, 80)})`)
// force 也不绕过时间窗（P0-4：时间窗防 1 分钟内重复写，force 只绕过相似度查重）
const forced = await tool2.execute({ action: 'add', target: 'memory', content: '用户喜欢用中文回答', force: true }, { signal: new AbortController().signal })
assert(forced.includes('重复'), `force 不绕过时间窗 (${forced.slice(0, 80)})`)
// force 绕过相似度查重（时间窗关闭场景 → added-with-warning）
const dir2b = await mkdtemp(path.join(os.tmpdir(), 'mem-2b-'))
const ctx2b = makeCtx()
mod.apply(ctx2b, { dir: dir2b, dedupTimeWindowSec: 0 })
const tool2b = ctx2b.registered[0]
await tool2b.execute({ action: 'add', target: 'memory', content: '用户偏好中文回答问题' }, { signal: new AbortController().signal })
const forcedB = await tool2b.execute({ action: 'add', target: 'memory', content: '用户喜欢用中文回答', force: true }, { signal: new AbortController().signal })
assert(forcedB.includes('已添加') && forcedB.includes('force'), `force 绕过相似度查重但带警告 (${forcedB.slice(0, 80)})`)
await rm(dir2, { recursive: true, force: true })
await rm(dir2b, { recursive: true, force: true })

// =========================================================================
console.log('\n=== 测试 3: 字符上限 → 要求合并 ===')
const dir3 = await mkdtemp(path.join(os.tmpdir(), 'mem-3-'))
const ctx3 = makeCtx()
mod.apply(ctx3, { dir: dir3, memoryCharLimit: 60 })
const tool3 = ctx3.registered[0]
const long1 = '第一条记忆内容是有关环境的重要事实信息，这一条写得很长是为了测试字符上限机制'
const long2 = '第二条记忆内容也同样写得比较长，用来验证达到上限后模型会被要求先合并'
await tool3.execute({ action: 'add', target: 'memory', content: long1 }, { signal: new AbortController().signal })
const over = await tool3.execute({ action: 'add', target: 'memory', content: long2 }, { signal: new AbortController().signal })
assert(over.includes('超出字符上限'), `超限被拒绝并提示合并 (${over.slice(0, 60)})`)
assert(over.includes('当前条目列表'), '返回条目列表供模型合并')

// =========================================================================
console.log('\n=== 测试 4: 会话快照注入 ===')
const dir4 = await mkdtemp(path.join(os.tmpdir(), 'mem-4-'))
const ctx4 = makeCtx()
mod.apply(ctx4, { dir: dir4 })
const tool4 = ctx4.registered[0]
await tool4.execute({ action: 'add', target: 'memory', content: '快照测试条目' }, { signal: new AbortController().signal })
await tool4.execute({ action: 'add', target: 'user', content: '用户是财务人员' }, { signal: new AbortController().signal })
const agent4 = fakeAgent('a4', 1)
const next4 = async () => ({ kind: 'enter', messages: [{ id: 'x', role: 'user', content: [], source: {} }] })
const decision = await ctx4.emit('agent/pre-step', { agent: agent4, turn: 1, messages: [], signal: null }, next4)
const snapshotMsg = decision.messages[decision.messages.length - 1]
const txt = snapshotMsg.content[0].text
assert(txt.includes('MEMORY (your personal notes)'), '快照含 MEMORY 标题')
assert(txt.includes('USER PROFILE'), '快照含 USER 标题')
assert(txt.includes('快照测试条目'), '快照含 memory 条目')
assert(txt.includes('用户是财务人员'), '快照含 user 条目')
assert(txt.includes('<system-reminder>'), '快照用 system-reminder 包裹')

// 第二次 pre-step（同 turn）不重复注入
const decision2 = await ctx4.emit('agent/pre-step', { agent: agent4, turn: 1, messages: [], signal: null }, next4)
assert(decision2.messages.length === 1, '同 turn 不重复注入')

// =========================================================================
console.log('\n=== 测试 5: 持久化到磁盘（跨会话存活） ===')
const dir5 = await mkdtemp(path.join(os.tmpdir(), 'mem-5-'))
const ctx5 = makeCtx()
mod.apply(ctx5, { dir: dir5 })
const tool5 = ctx5.registered[0]
await tool5.execute({ action: 'add', target: 'memory', content: '跨会话持久条目' }, { signal: new AbortController().signal })
const files5 = await readdir(dir5)
assert(files5.includes('MEMORY.md'), `MEMORY.md 落盘 (${files5.join(',')})`)
const raw5 = await readFile(path.join(dir5, 'MEMORY.md'), 'utf8')
assert(raw5.includes('跨会话持久条目'), '文件内容正确')
assert(!files5.some(f => f.includes('.tmp')), '无临时文件残留')

// 新插件实例（模拟新会话/新进程）能读回
const ctx5b = makeCtx()
mod.apply(ctx5b, { dir: dir5 })
const tool5b = ctx5b.registered[0]
const r5b = await tool5b.execute({ action: 'list', target: 'memory' }, { signal: new AbortController().signal })
assert(r5b.includes('跨会话持久条目'), '新实例读回记忆')

// =========================================================================
console.log('\n=== 测试 6: replace ===')
const ctx6 = makeCtx()
mod.apply(ctx6, { dir: dir5 }) // 复用 dir5 的 MEMORY.md
const tool6 = ctx6.registered[0]
const r6 = await tool6.execute({ action: 'replace', target: 'memory', index: 1, content: '跨会话持久条目(已更新)' }, { signal: new AbortController().signal })
assert(r6.includes('已替换'), `replace 成功 (${r6.slice(0, 50)})`)
const r6b = await tool6.execute({ action: 'list', target: 'memory' }, { signal: new AbortController().signal })
assert(r6b.includes('已更新') && !r6b.includes('跨会话持久条目\n'), 'replace 生效')

// 清理
for (const d of [dir1, dir2, dir3, dir4, dir5]) await rm(d, { recursive: true, force: true })

// =========================================================================
console.log('\n=== 测试 7: store 边界（精确重复/disabled/损坏文件/越界/空库相似度） ===')
const dir7 = await mkdtemp(path.join(os.tmpdir(), 'mem-7-'))
const ctx7 = makeCtx()
mod.apply(ctx7, { dir: dir7 })
const tool7 = ctx7.registered[0]
const exec7 = { signal: new AbortController().signal }
// 精确重复 add
await tool7.execute({ action: 'add', target: 'memory', content: '精确重复条目内容' }, exec7)
const dupExact = await tool7.execute({ action: 'add', target: 'memory', content: '精确重复条目内容' }, exec7)
assert(dupExact.includes('已存在'), `精确重复被拒 (${dupExact.slice(0, 50)})`)
// 完全不同内容 → findDuplicate 返回 null（130 null 分支）
await tool7.execute({ action: 'add', target: 'memory', content: 'alpha beta gamma delta' }, exec7)
// replace/remove 越界
const badRep = await tool7.execute({ action: 'replace', target: 'memory', index: 99, content: 'x' }, exec7)
assert(badRep.includes('越界') && badRep.includes('操作未执行'), `replace 越界`)
const badRem = await tool7.execute({ action: 'remove', target: 'memory', index: 0 }, exec7)
assert(badRem.includes('越界'), `remove 越界`)
// remove 全部条目 → 空库
await tool7.execute({ action: 'remove', target: 'memory', index: 1 }, exec7)
await tool7.execute({ action: 'remove', target: 'memory', index: 1 }, exec7)
await tool7.execute({ action: 'remove', target: 'memory', index: 1 }, exec7)
const emptyList = await tool7.execute({ action: 'list', target: 'memory' }, exec7)
assert(emptyList.includes('为空'), `空库 list (${emptyList.slice(0, 40)})`)
// 未知 action + disabled store + execute catch
const unknown = await tool7.execute({ action: 'explode', target: 'memory' }, exec7)
assert(unknown.includes('未知 action'), `未知 action (${unknown.slice(0, 40)})`)
const dir7b = await mkdtemp(path.join(os.tmpdir(), 'mem-7b-'))
const ctx7b = makeCtx()
mod.apply(ctx7b, { dir: dir7b, memoryEnabled: false })
const tool7b = ctx7b.registered[0]
const disabled = await tool7b.execute({ action: 'add', target: 'memory', content: 'x' }, exec7)
assert(disabled.includes('memory 操作失败'), `disabled store 被 catch (${disabled.slice(0, 60)})`)
// 损坏文件（MEMORY.md 是目录）→ 备份后当空
const dir7c = await mkdtemp(path.join(os.tmpdir(), 'mem-7c-'))
await mkdir(path.join(dir7c, 'MEMORY.md'))
const ctx7c = makeCtx()
mod.apply(ctx7c, { dir: dir7c })
const tool7c = ctx7c.registered[0]
const afterCorrupt = await tool7c.execute({ action: 'add', target: 'memory', content: '损坏后重建条目' }, exec7)
assert(afterCorrupt.includes('已添加'), `损坏文件备份后重建 (${afterCorrupt.slice(0, 50)})`)
await rm(dir7, { recursive: true, force: true })
await rm(dir7b, { recursive: true, force: true })
await rm(dir7c, { recursive: true, force: true })

// =========================================================================
console.log('\n=== 测试 8: 无 # 标题文件解析 + 空相似度 + 快照边界 ===')
// 无 # 标题的 MEMORY.md（手工格式）→ parseEntries 63 分支
const dir8 = await mkdtemp(path.join(os.tmpdir(), 'mem-8-'))
await writeFile(path.join(dir8, 'MEMORY.md'), '手工条目一\n§\n手工条目二\n')
const ctx8 = makeCtx()
mod.apply(ctx8, { dir: dir8 })
const tool8 = ctx8.registered[0]
const r8 = await tool8.execute({ action: 'list', target: 'memory' }, { signal: new AbortController().signal })
assert(r8.includes('手工条目一') && r8.includes('手工条目二'), `无标题文件解析 (${r8.slice(0, 60)})`)
// 快照：空库 → 不注入（379）
const ctx8b = makeCtx()
mod.apply(ctx8b, { dir: await mkdtemp(path.join(os.tmpdir(), 'mem-8b-')) })
const agent8b = fakeAgent('a8b', 1)
const r8b = await ctx8b.emit('agent/pre-step', { agent: agent8b, turn: 1, messages: [], signal: null })
assert(!(r8b?.messages || []).some(m => m.source?.plugin === 'dsh-memory'), `空库快照不注入`)
// pre-step 非 enter / 无 agent
const ctx8c = makeCtx()
mod.apply(ctx8c, { dir: dir8 })
const r8c = await ctx8c.emit('agent/pre-step', { agent: fakeAgent('a8c', 1), turn: 1 }, async () => ({ kind: 'reject' }))
assert(r8c?.kind === 'reject', '非 enter 原样返回')
const r8d = await ctx8c.emit('agent/pre-step', { turn: 1, messages: [], signal: null })
assert(r8d?.kind === 'enter', '无 agent 原样返回')
// 单库启用（memory 禁用）→ 快照 only user + usageNote else（287）
const ctx8e = makeCtx()
mod.apply(ctx8e, { dir: dir8, memoryEnabled: false })
const tool8e = ctx8e.registered[0]
await tool8e.execute({ action: 'add', target: 'user', content: '用户偏好英语沟通' }, { signal: new AbortController().signal })
const agent8e = fakeAgent('a8e', 1)
const r8e = await ctx8e.emit('agent/pre-step', { agent: agent8e, turn: 1, messages: [], signal: null })
const t8e = (r8e?.messages || []).map(m => m.content?.[0]?.text || '').join('')
assert(t8e.includes('USER PROFILE') && !t8e.includes('MEMORY ('), `单库快照`)
// 都禁用 → apply throw（294）
const ctx8f = makeCtx()
let threw = false
try { mod.apply(ctx8f, { dir: dir8, memoryEnabled: false, userEnabled: false }) } catch { threw = true }
assert(threw, '双禁用 apply 抛错')
await rm(dir8, { recursive: true, force: true })

// =========================================================================
console.log('\n=== 测试 9: replace 超限 + nudge 提醒 ===')
// replace 超限（244）
const dir9 = await mkdtemp(path.join(os.tmpdir(), 'mem-9-'))
const ctx9 = makeCtx()
mod.apply(ctx9, { dir: dir9, memoryCharLimit: 10 })
const tool9 = ctx9.registered[0]
const exec9 = { signal: new AbortController().signal }
await tool9.execute({ action: 'add', target: 'memory', content: '短条目内容' }, exec9)
const overRep = await tool9.execute({ action: 'replace', target: 'memory', index: 1, content: '这是一个非常非常长的替换内容用来触发超限拒绝机制' }, exec9)
assert(overRep.includes('超出'), `replace 超限 (${overRep.slice(0, 50)})`)
// nudge：连续 N 轮无写入 → pre-step 提醒；memory 写入 → 重置
const dir9b = await mkdtemp(path.join(os.tmpdir(), 'mem-9b-'))
const ctx9b = makeCtx()
mod.apply(ctx9b, { dir: dir9b, nudgeInterval: 2 })
const agent9b = fakeAgent('a9b', 1)
// 1 轮非 memory 工具 → 无提醒
await ctx9b.emit('tools/result', { name: 'pwsh', arguments: { command: 'x' }, agent: agent9b }, { isError: false })
let d = await ctx9b.emit('agent/pre-step', { agent: agent9b, turn: 1, messages: [], signal: null })
assert(!(d?.messages || []).some(m => m.content?.[0]?.text?.includes('没有写入记忆')), `1 轮无提醒`)
// 2 轮 → 提醒
await ctx9b.emit('tools/result', { name: 'pwsh', arguments: { command: 'y' }, agent: agent9b }, { isError: false })
d = await ctx9b.emit('agent/pre-step', { agent: agent9b, turn: 1, messages: [], signal: null })
assert((d?.messages || []).some(m => m.content?.[0]?.text?.includes('没有写入记忆')), `2 轮触发提醒`)
// memory 写入成功 → 计数重置
const tool9b = ctx9b.registered[0]
await tool9b.execute({ action: 'add', target: 'memory', content: 'nudge 重置条目' }, exec9)
await ctx9b.emit('tools/result', { name: 'memory', arguments: { action: 'add' }, agent: agent9b }, { isError: false, value: 'ok' })
d = await ctx9b.emit('agent/pre-step', { agent: agent9b, turn: 1, messages: [], signal: null })
assert(!(d?.messages || []).some(m => m.content?.[0]?.text?.includes('没有写入记忆')), `写入后计数重置`)
// nudgeInterval=0 → 不注册 nudge
const ctx9c = makeCtx()
mod.apply(ctx9c, { dir: dir9, nudgeInterval: 0 })
const agent9c = fakeAgent('a9c', 1)
await ctx9c.emit('tools/result', { name: 'pwsh', arguments: { command: 'z' }, agent: agent9c }, { isError: false })
const d9c = await ctx9c.emit('agent/pre-step', { agent: agent9c, turn: 1, messages: [], signal: null })
assert(!(d9c?.messages || []).some(m => m.content?.[0]?.text?.includes('没有写入记忆')), `nudgeInterval=0 无 nudge`)
await rm(dir9, { recursive: true, force: true })
await rm(dir9b, { recursive: true, force: true })

// =========================================================================
console.log('\n=== 测试 10: too-similar 拒绝（时间窗外）/ DSH_HOME / replace 无 content / nudge 边界 ===')
// 时间窗外 + 相似度 ≥0.62（非 force）→ too-similar 拒绝（200-207）
const dir10 = await mkdtemp(path.join(os.tmpdir(), 'mem-10-'))
const ctx10 = makeCtx()
mod.apply(ctx10, { dir: dir10, dedupTimeWindowSec: 0 })
const tool10 = ctx10.registered[0]
const exec10 = { signal: new AbortController().signal }
await tool10.execute({ action: 'add', target: 'memory', content: '用户偏好中文回答问题' }, exec10)
const similar10 = await tool10.execute({ action: 'add', target: 'memory', content: '用户喜欢用中文回答' }, exec10)
assert(similar10.includes('禁止新增重复记忆'), `时间窗外相似被拒（too-similar）(got ${similar10.slice(0, 60)})`)
// force + 相似度 ≥0.85 → 仍拒绝（forceHardBlockThreshold）
const dir10b = await mkdtemp(path.join(os.tmpdir(), 'mem-10b-'))
const ctx10b = makeCtx()
mod.apply(ctx10b, { dir: dir10b, dedupTimeWindowSec: 0 })
const tool10b = ctx10b.registered[0]
await tool10b.execute({ action: 'add', target: 'memory', content: '用户偏好中文回答问题' }, exec10)
const hardBlock = await tool10b.execute({ action: 'add', target: 'memory', content: '用户偏好中文回答问题（补充细节）', force: true }, exec10)
assert(hardBlock.includes('禁止新增重复记忆'), `force + 高相似仍拒绝 (${hardBlock.slice(0, 60)})`)
// DSH_HOME 分支（51：resolveDir 用环境变量）
const dshHome10 = await mkdtemp(path.join(os.tmpdir(), 'mem-home-'))
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = dshHome10
try {
  const ctx10c = makeCtx()
  mod.apply(ctx10c, {}) // 不传 dir → 走 DSH_HOME
  const tool10c = ctx10c.registered[0]
  const r10c = await tool10c.execute({ action: 'add', target: 'memory', content: 'DSH_HOME 定位条目' }, exec10)
  assert(r10c.includes('已添加'), `DSH_HOME 定位存储 (${r10c.slice(0, 50)})`)
  const files10c = await readdir(path.join(dshHome10, 'memories'))
  assert(files10c.includes('MEMORY.md'), `DSH_HOME/memories/MEMORY.md 落盘`)
} finally {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
}
// replace 无 content（352:88 || ''）
const r10d = await tool10.execute({ action: 'replace', target: 'memory', index: 1 }, exec10)
assert(r10d.includes('操作未执行') || r10d.includes('已替换'), `replace 无 content 不崩`)
// nudge 边界：无 agent result 不计数 + nudgeInterval=1 立即提醒
const ctx10e = makeCtx()
mod.apply(ctx10e, { dir: dir10, nudgeInterval: 1 })
await ctx10e.emit('tools/result', { name: 'pwsh', arguments: { command: 'x' } }, { isError: false }) // 无 agent → 不计数
const a10e = fakeAgent('a10e', 1)
await ctx10e.emit('tools/result', { name: 'pwsh', arguments: { command: 'y' }, agent: a10e }, { isError: false })
const r10e = await ctx10e.emit('agent/pre-step', { agent: a10e, turn: 1, messages: [], signal: null })
assert((r10e?.messages || []).some(m => m.content?.[0]?.text?.includes('没有写入记忆')), `nudgeInterval=1 立即提醒`)
await rm(dir10, { recursive: true, force: true })
await rm(dir10b, { recursive: true, force: true })
await rm(dshHome10, { recursive: true, force: true })

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
