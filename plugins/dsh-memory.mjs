/**
 * dsh-memory — DSH 跨会话长记忆插件（Hermes MEMORY.md/USER.md 同款机制）
 *
 * 两个持久化记忆库：
 *   MEMORY.md  — Agent 自己的笔记（环境事实、项目约定、工具怪癖、教训）
 *   USER.md    — 对用户的了解（偏好、沟通风格、工作习惯、身份背景）
 *
 * 机制（对齐 Hermes）：
 *  - 条目以 § 分隔，受字符上限约束（默认 2200/1375），满则要求模型合并
 *  - memory 工具：add / replace / remove / list，目标 memory / user
 *  - 会话第一步注入冻结快照（<system-reminder> 包裹），中途写入不改快照
 *  - 连续 nudgeInterval 轮无写入后提醒模型持久化新知识
 *  - 原子写入（临时文件 + rename），损坏文件先备份再拒绝覆盖
 *  - 查重：add 时与现有条目比对，高度重复 → 拒绝并提示合并（防记忆膨胀）
 *
 * 零依赖纯 ESM，挂载：
 *   ~/.dsh/cordis.patch.yml → - id: dsh-memory
 *                                name: 'file:///.../dsh-memory.mjs'
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-memory'
/** 需要 tools 服务来注册 memory 工具（cordis inject 机制） */
export const inject = ['tools']

const DEFAULT_CONFIG = {
  memoryEnabled: true,
  userEnabled: true,
  memoryCharLimit: 2200,
  userCharLimit: 1375,
  nudgeInterval: 10,
  /** 新增条目前与现有条目的最小相似度（超过则拒绝，要求合并）
   *  P0-4：0.75 → 0.62——实测 13:05/13:06 两次措辞不同但高度重复的项目描述
   *  包含度仅 ~0.6x，0.75 拦不住；0.62 拦措辞变体重复，仍低于"同主题不同信息"的误杀线 */
  dedupThreshold: 0.62,
  /** 查重只对不低于该长度的条目生效（短条目浓缩度高，避免包含度虚高误杀） */
  minDedupLength: 8,
  /** P0-4：时间窗去重（秒）——同一 agent 在窗口内 add 相似度 ≥ 0.5 的内容 → 拒绝（防 1 分钟内重复写） */
  dedupTimeWindowSec: 60,
  /** P0-4：force 不再完全绕过查重——force=true 时相似度 ≥ 0.85 仍拒绝，0.62~0.85 允许但返回警告 */
  forceHardBlockThreshold: 0.85,
  dir: undefined,
}

function resolveDir(cfg) {
  if (cfg.dir) return cfg.dir
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'memories')
}

// ── 存储层 ──────────────────────────────────────────────────────────────

const SEP = '\n§\n'
const HEADER = (label) => `# ${label}\n`

function parseEntries(text) {
  const body = text.split('\n').filter(l => l.startsWith('# ')).length > 0
    ? text.slice(text.indexOf('\n') + 1)
    : text
  return body.split(SEP).map(s => s.trim()).filter(Boolean)
}

function renderEntries(entries) {
  return entries.join(SEP)
}

/** 读取记忆文件；不存在 → 空；损坏 → null（调用方决定备份拒绝） */
async function loadStore(dir, file) {
  const p = path.join(dir, file)
  try {
    const raw = await readFile(p, 'utf8')
    return { raw, entries: parseEntries(raw) }
  } catch (e) {
    if (e.code === 'ENOENT') return { raw: '', entries: [] }
    return null // 存在但读不出
  }
}

/** 原子写入：临时文件 + rename；保持人类可读格式 */
async function saveStore(dir, file, entries, title) {
  await mkdir(dir, { recursive: true })
  const p = path.join(dir, file)
  const tmp = path.join(dir, `.${file}.${randomUUID()}.tmp`)
  const text = HEADER(title) + renderEntries(entries) + (entries.length ? '\n' : '')
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, p)
}

function sizeOf(entries) {
  return renderEntries(entries).length
}

// ── 相似度（含中文的包含度指标，比纯 bigram Jaccard 更贴合记忆查重）──
function charSet(s) {
  return new Set(String(s).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''))
}
function containment(a, b) {
  // a 的字符有多少比例出现在 b 中（0..1）
  const A = charSet(a)
  const B = charSet(b)
  if (A.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / A.size
}
/** 双向包含度的最大值：任一方向覆盖率高即视为重复 */
function similarity(a, b) {
  return Math.max(containment(a, b), containment(b, a))
}

/** 查重：新条目 vs 现有条目，返回最相似的一条 */
function findDuplicate(entries, content) {
  let best = null
  let bestScore = 0
  for (const e of entries) {
    const s = similarity(content, e)
    if (s > bestScore) { bestScore = s; best = e }
  }
  return best ? { entry: best, score: bestScore } : null
}

// ── 记忆库操作（返回给工具的结果 + 内部状态）────────────────────────────

function makeStore(cfg, dir) {
  const files = {
    memory: { file: 'MEMORY.md', limit: cfg.memoryCharLimit, title: 'MEMORY (your personal notes)', enabled: cfg.memoryEnabled },
    user: { file: 'USER.md', limit: cfg.userCharLimit, title: 'USER PROFILE (who the user is)', enabled: cfg.userEnabled },
  }
  // 缓存: kind -> { entries, lastRaw }，外部编辑漂移检测
  const cache = new Map()
  // P0-4: kind -> 最近一次 add 时间戳（时间窗去重）
  const lastAddAt = new Map()

  async function ensureLoaded(kind) {
    const f = files[kind]
    if (!f.enabled) throw new Error(`memory store "${kind}" is disabled`)
    const loaded = await loadStore(dir, f.file)
    if (loaded === null) {
      // 存在但读不出 → 备份后当作空（绝不静默丢数据）
      const bak = path.join(dir, `${f.file}.bak.${Date.now()}`)
      try { await rename(path.join(dir, f.file), bak) } catch { /* ignore */ }
      const fresh = { raw: '', entries: [] }
      cache.set(kind, fresh)
      return fresh
    }
    cache.set(kind, loaded)
    return loaded
  }

  async function list(kind) {
    const s = await ensureLoaded(kind)
    return s.entries
  }

  async function add(kind, content, opts = {}) {
    const f = files[kind]
    const s = await ensureLoaded(kind)
    if (s.entries.some(e => e === content)) {
      return { ok: false, reason: 'duplicate', message: '该条目已存在，不要重复添加' }
    }
    // P0-4 时间窗去重：同 kind 在窗口内重复 add 高度相似内容 → 拒绝
    const now = Date.now()
    const lastAt = lastAddAt.get(kind)
    if (lastAt !== undefined && now - lastAt < cfg.dedupTimeWindowSec * 1000) {
      const candidates = s.entries.filter(e => e.length >= cfg.minDedupLength && content.length >= cfg.minDedupLength)
      if (candidates.length > 0) {
        const dup = findDuplicate(candidates, content)
        if (dup && dup.score >= 0.5) {
          return {
            ok: false,
            reason: 'too-similar-window',
            message: `在 ${cfg.dedupTimeWindowSec} 秒内重复添加相似内容（相似度 ${dup.score.toFixed(2)}）——刚 add 过类似条目，如需更新请用 replace 修改原条目，不要新增重复记忆。\n现有条目: ${dup.entry.slice(0, 200)}`,
            duplicate: dup.entry,
          }
        }
      }
    }
    // 查重：高度相似 → 拒绝并建议合并（仅对足够长的条目生效——
    // 短条目高度浓缩，包含度指标虚高，误杀风险大于重复风险）
    const dup = s.entries.some(e => e.length >= cfg.minDedupLength && content.length >= cfg.minDedupLength)
      ? findDuplicate(s.entries.filter(e => e.length >= cfg.minDedupLength), content)
      : null
    if (dup && dup.score >= cfg.dedupThreshold) {
      // P0-4 force 分级：≥0.85 即使 force 也拒绝；0.62~0.85 允许但警告
      if (!opts.force || dup.score >= cfg.forceHardBlockThreshold) {
        return {
          ok: false,
          reason: 'too-similar',
          message: `新条目与现有条目相似度 ${dup.score.toFixed(2)} ≥ ${cfg.dedupThreshold}，禁止新增重复记忆。应改用 replace 合并或补充增量信息。\n现有条目: ${dup.entry.slice(0, 200)}`,
          duplicate: dup.entry,
        }
      }
      // force 但相似度 0.62~0.85：允许写入，但返回警告
      lastAddAt.set(kind, now)
      const entries = [...s.entries, content]
      await saveStore(dir, f.file, entries, f.title)
      cache.set(kind, { raw: '', entries })
      return {
        ok: true,
        reason: 'added-with-warning',
        message: `已添加（force 绕过，注意与现有条目相似度 ${dup.score.toFixed(2)}，建议后续用 replace 合并）。当前 ${entries.length} 条，${sizeOf(entries)}/${f.limit} 字符`,
      }
    }
    const entries = [...s.entries, content]
    const over = sizeOf(entries) - f.limit
    if (over > 0 && !opts.force) {
      return {
        ok: false,
        reason: 'over-limit',
        message: `超出字符上限 ${over} 字符。请先合并现有条目（用 replace 精简），或删除冗余条目后再 add。当前条目列表:\n${s.entries.map((e, i) => `${i + 1}. ${e.slice(0, 150)}`).join('\n')}`,
        entries: s.entries,
      }
    }
    lastAddAt.set(kind, now)
    await saveStore(dir, f.file, entries, f.title)
    cache.set(kind, { raw: '', entries })
    return { ok: true, reason: 'added', message: `已添加。当前 ${entries.length} 条，${sizeOf(entries)}/${f.limit} 字符` }
  }

  async function replace(kind, index, content) {
    const f = files[kind]
    const s = await ensureLoaded(kind)
    if (index < 1 || index > s.entries.length) {
      return { ok: false, reason: 'bad-index', message: `索引 ${index} 越界（现有 ${s.entries.length} 条）` }
    }
    const entries = [...s.entries]
    entries[index - 1] = content
    const over = sizeOf(entries) - f.limit
    if (over > 0) {
      return { ok: false, reason: 'over-limit', message: `替换后仍超出 ${over} 字符，请精简` }
    }
    await saveStore(dir, f.file, entries, f.title)
    cache.set(kind, { raw: '', entries })
    return { ok: true, reason: 'replaced', message: `已替换第 ${index} 条` }
  }

  async function remove(kind, index) {
    const f = files[kind]
    const s = await ensureLoaded(kind)
    if (index < 1 || index > s.entries.length) {
      return { ok: false, reason: 'bad-index', message: `索引 ${index} 越界（现有 ${s.entries.length} 条）` }
    }
    const entries = s.entries.filter((_, i) => i !== index - 1)
    await saveStore(dir, f.file, entries, f.title)
    cache.set(kind, { raw: '', entries })
    return { ok: true, reason: 'removed', message: `已删除第 ${index} 条，剩 ${entries.length} 条` }
  }

  return { files, cache, list, add, replace, remove, dir }
}

// ── 快照渲染（对齐 Hermes 的注入格式）────────────────────────────────────
function renderSnapshot(store) {
  const blocks = []
  const usage = []
  for (const [kind, f] of Object.entries(store.files)) {
    if (!f.enabled) continue
    const s = store.cache.get(kind)
    if (!s || s.entries.length === 0) continue
    const used = sizeOf(s.entries)
    const pct = Math.round((used / f.limit) * 100)
    const label = kind === 'memory'
      ? `MEMORY (your personal notes) [${pct}% — ${used}/${f.limit} chars]`
      : `USER PROFILE (who the user is) [${pct}% — ${used}/${f.limit} chars]`
    const body = s.entries.join('\n§\n').replaceAll('</system-reminder>', '<\\/system-reminder>')
    blocks.push(`════════════════════════════════\n${label}\n════════════════════════════════\n${body}`)
    usage.push(f)
  }
  if (blocks.length === 0) return ''
  const usageNote = usage.length === 2
    ? 'Use the memory tool to add/replace/remove entries. When near the limit, merge entries instead of adding.'
    : 'Use the memory tool to add/replace/remove entries.'
  return `<system-reminder>\n以下为跨会话持久记忆。写入会立即持久化，但本快照在会话中保持不变。\n\n${blocks.join('\n\n')}\n\n${usageNote}\n</system-reminder>`
}

// ── 插件主体 ────────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  if (!cfg.memoryEnabled && !cfg.userEnabled) {
    throw new TypeError('dsh-memory: memoryEnabled and userEnabled cannot both be false')
  }
  const dir = resolveDir(cfg)
  const store = makeStore(cfg, dir)
  ctx.logger?.info?.('dsh-memory: plugin loaded (cross-session memory)')

  // ── 1. 注册 memory 工具（原始 JSON Schema，零依赖）────────────────────
  const toolName = 'memory'
  ctx.effect(() => ctx.tools.register({
    name: toolName,
    description: '管理跨会话持久记忆。目标 memory=Agent 自己的笔记（环境事实/项目约定/工具怪癖/教训），user=对用户的了解（偏好/风格/习惯）。add 前先 list 查重，重复或相似条目必须用 replace 合并而非新增。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove', 'list'],
          description: 'add=新增条目; replace=按索引替换; remove=按索引删除; list=列出全部条目',
        },
        target: {
          type: 'string',
          enum: ['memory', 'user'],
          description: '目标记忆库',
        },
        content: {
          type: 'string',
          description: 'add/replace 时的条目内容；list/remove 不需要',
        },
        index: {
          type: 'number',
          description: 'replace/remove 时的 1 起始条目索引',
        },
        force: {
          type: 'boolean',
          description: 'true 时绕过相似度查重强制写入（仅在确认现有条目确实需要替换时用）',
        },
      },
      required: ['action', 'target'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const kind = args.target === 'user' ? 'user' : 'memory'
      try {
        switch (args.action) {
          case 'list': {
            const entries = await store.list(kind)
            if (entries.length === 0) return `(${kind} 记忆库为空)`
            return `${kind} 记忆 (${entries.length} 条):\n${entries.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
          }
          case 'add': {
            const r = await store.add(kind, String(args.content || '').trim(), { force: args.force === true })
            return r.ok ? r.message : `${r.message}\n操作未执行。`
          }
          case 'replace': {
            const r = await store.replace(kind, Number(args.index), String(args.content || '').trim())
            return r.ok ? r.message : `${r.message}\n操作未执行。`
          }
          case 'remove': {
            const r = await store.remove(kind, Number(args.index))
            return r.ok ? r.message : `${r.message}\n操作未执行。`
          }
          default:
            return `未知 action: ${args.action}`
        }
      } catch (e) {
        return `memory 操作失败: ${String(e)}`
      }
    },
  }), 'dsh-memory: register memory tool')

  // ── 2. 会话第一步注入快照（agent/pre-step，对齐 @hyls9527 做法）────────
  const injectedTurn = new WeakMap()
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    const agent = payload.agent
    if (!agent) return decision
    const seen = injectedTurn.get(agent) ?? -1
    if (payload.turn <= seen) return decision
    injectedTurn.set(agent, payload.turn)
    const snapshot = renderSnapshot(store)
    if (!snapshot) return decision
    const msg = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: snapshot }],
      source: { kind: 'plugin', plugin: 'dsh-memory' },
    }
    return { kind: 'enter', messages: [...decision.messages, msg] }
  })

  // ── 3. nudge 提醒：连续 N 轮无写入后提醒持久化 ─────────────────────────
  if (cfg.nudgeInterval > 0) {
    const sinceWrite = new WeakMap()
    ctx.on('tools/result', (exec, result) => {
      if (!exec || !exec.agent) return
      const agent = exec.agent
      if (exec.name === toolName && result && !result.isError) {
        sinceWrite.set(agent, 0)
        return
      }
      sinceWrite.set(agent, (sinceWrite.get(agent) ?? 0) + 1)
    })
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (!decision || decision.kind !== 'enter') return decision
      const agent = payload.agent
      if (!agent) return decision
      const rounds = sinceWrite.get(agent) ?? 0
      if (rounds < cfg.nudgeInterval) return decision
      const text = `<system-reminder>已连续 ${rounds} 轮没有写入记忆。如果本轮出现了值得跨会话记住的事实（用户偏好、环境信息、教训），请用 memory 工具持久化；没有则忽略本条提醒。</system-reminder>`
      sinceWrite.set(agent, 0)
      const msg = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-memory' },
      }
      return { kind: 'enter', messages: [...decision.messages, msg] }
    })
  }
}
