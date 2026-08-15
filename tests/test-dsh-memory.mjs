/**
 * dsh-memory 单元测试：存储 CRUD、快照渲染、查重拒绝、上限、原子写入。
 * 运行：node test-dsh-memory.mjs
 */
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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
      for (const h of listeners.get(event) || []) {
        const next = async () => ({ kind: 'enter', messages: [] })
        const r = await h(...args, next)
        if (r !== undefined) return r
      }
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

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
