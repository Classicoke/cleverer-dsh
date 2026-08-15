/**
 * skill-evolver — DSH 技能自动学习与迭代插件（Hermes 同款机制）
 *
 * 做什么：
 *  1. 观察：监听 tools/result，追踪每个"指纹"（工具+参数）从连续失败到
 *     最终成功的解法路径 —— 失败是学费，解法是知识
 *  2. 提炼：turn 结束时把本 turn 的 (卡点 → 有效解法) 对沉淀为一条经验
 *  3. 查重：与 ~/.dsh/skills/ 现有技能计算字符 bigram Jaccard 相似度
 *     - 相似度 ≥ 阈值 → 不新建，增量追加到最匹配的现有技能
 *     - 相似度 < 阈值 → 新建技能文件
 *  4. 防重复：内部记忆 + 文件内容双重去重，同一经验绝不写两遍
 *
 * 零依赖纯 ESM：只用 node 内置模块，挂载方式同 anti-stuck：
 *   ~/.dsh/cordis.patch.yml → - id: skill-evolver
 *                                name: 'file:///.../skill-evolver.mjs'
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fingerprint, isFailure, extractText, similarity, makeCleanupTimer } from './_shared.mjs'

export const name = 'skill-evolver'

const DEFAULT_CONFIG = {
  enabled: true,
  /** 相似度阈值：≥ 此值视为重复 → 增量写入；< 此值 → 新建 */
  similarityThreshold: 0.55,
  /** P0-2：与手写纪律 skill 相似度 ≥ 此值 → 强制并入（不新建，防垃圾 skill 与权威版分家） */
  mergeThreshold: 0.7,
  /** 同一指纹至少连续失败多少次才值得学习 */
  minFailsToLearn: 2,
  /** 每个 turn 最多沉淀几条经验（防噪音） */
  maxLessonsPerTurn: 3,
  /** 经验去重后，写入的增量 section 标题 */
  incrementHeader: '## 增量经验',
  /** 技能根目录；默认 <dshHome>/skills（与 skill-filesystem 的用户根一致） */
  skillsDir: undefined,
}

/** 解析技能目录：显式配置 > $DSH_HOME > ~/.dsh */
function resolveSkillsDir(cfg) {
  if (cfg.skillsDir) return cfg.skillsDir
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'skills')
}

// ── 指纹/失败判定/文本提取/相似度：来自 _shared.mjs ──────────────────────

/** 从命令文本提取短标题（供技能名/场景标题） */
function shortTitle(fp) {
  const [tool, ...rest] = fp.split('::')
  const cmd = (rest.join('::') || tool).slice(0, 120)
  return `${tool}: ${cmd}`
}

// ── 技能名：kebab-case（skill-filesystem 硬性要求） ─────────────────────
function kebabFrom(text) {
  const stop = new Set(['the', 'and', 'for', 'with', 'node', 'cmd', 'run', 'use', 'via', 'on', 'in', 'of'])
  const tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) || []
  const kept = [...new Set(tokens.filter(t => t.length > 1 && !stop.has(t)))].slice(0, 6)
  return kept.length > 0 ? kept.join('-') : `lesson-${Date.now().toString(36)}`
}

// ── P0-2：泛化门槛 ────────────────────────────────────────────────────
/** 1. 名称门槛：标题含绝对路径形态（read-<路径> / C:\ 等）→ 拒绝沉淀 */
const PATH_TITLE_RE = /(?:[A-Za-z]:[\\/]|^read-|^\w+::)/

/** 2. 内容清洗：剥离工具输出残留（<path>/<type>/<content> XML 标记与文件内容行） */
function cleanToolResidue(s) {
  return String(s || '')
    .replace(/<path>[^<]*<\/path>/g, '')
    .replace(/<type>[^<]*<\/type>/g, '')
    .replace(/<content>[\s\S]*?<\/content>/g, '')
    .replace(/<[a-z]+>/g, '')
    .replace(/<\/[a-z]+>/g, '')
    .replace(/\s*\d+:\s/g, ' ')  // 去行号前缀（"80: * @param"）
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 3. 解法语义校验：纯工具调用串（edit::path / read::path）→ 拒绝，要求人类可读描述 */
const TOOL_CALL_RE = /^(edit|read|grep|pwsh|bash|write|node)\s*::/
function isToolCallString(s) {
  return TOOL_CALL_RE.test(String(s || '').trim())
}

/** 4. 泛化质量总校验：不满足任一 → 跳过沉淀（记日志） */
function passesQualityGate(lesson) {
  const title = String(lesson.title || '')
  if (PATH_TITLE_RE.test(title)) return { ok: false, reason: `title-is-path: ${title.slice(0, 60)}` }
  if (title.length < 4 || /^(pwsh|bash|node|exit|error)/i.test(title) && title.split(/\s+/).length <= 2) {
    return { ok: false, reason: `title-too-generic: ${title.slice(0, 60)}` }
  }
  const sol = String(lesson.solution || '')
  if (isToolCallString(sol) || sol.length < 8) return { ok: false, reason: `solution-not-human: ${sol.slice(0, 60)}` }
  const sym = String(lesson.symptom || '')
  if (/<path>|<content>|<type>/.test(sym) && sym.length > 200) return { ok: false, reason: 'symptom-has-tool-residue' }
  return { ok: true }
}

/** 读取技能目录下所有平铺 <name>.md 与 <name>/SKILL.md，返回 [{name, file, content}] */
async function listSkills(skillsDir) {
  const out = []
  let entries = []
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    try {
      if (e.isFile() && e.name.endsWith('.md')) {
        const content = await readFile(path.join(skillsDir, e.name), 'utf8')
        out.push({ name: e.name.replace(/\.md$/, ''), file: path.join(skillsDir, e.name), content })
      } else if (e.isDirectory()) {
        const sk = path.join(skillsDir, e.name, 'SKILL.md')
        const content = await readFile(sk, 'utf8').catch(() => null)
        if (content !== null) out.push({ name: e.name, file: sk, content })
      }
    } catch { /* skip unreadable */ }
  }
  return out
}

/** 查重：返回相似度最高的现有技能（无则 null） */
async function findBestMatch(skillsDir, lessonBody, lessonTitle) {
  const skills = await listSkills(skillsDir)
  let best = null
  let bestScore = 0
  for (const s of skills) {
    // 标题与正文各算一次，取高者；正文权重略大
    const score = Math.max(similarity(lessonBody, s.content), similarity(lessonTitle, s.name) * 1.2)
    if (score > bestScore) {
      bestScore = score
      best = s
    }
  }
  return best ? { ...best, score: bestScore } : null
}

/** 构造一条增量 section（追加到现有技能正文末尾） */
function buildIncrement(lesson, existing) {
  const date = new Date().toISOString().slice(0, 10)
  const lines = [
    '',
    `### ${date} · ${lesson.title}`,
    '',
  ]
  if (lesson.symptom) lines.push(`- 症状: ${lesson.symptom}`)
  if (lesson.failCount) lines.push(`- 失败尝试: 连续 ${lesson.failCount} 次相同操作失败`)
  lines.push(`- 有效解法: ${lesson.solution}`)
  lines.push('')
  return lines.join('\n')
}

/** 构造一个新技能文件全文 */
function buildNewSkill(lesson) {
  const name = kebabFrom(lesson.title)
  const desc = `从 DSH 实战中沉淀的经验: ${lesson.title}`.slice(0, 120)
  return [
    '---',
    `name: ${name}`,
    `description: ${desc}`,
    '---',
    '',
    `# ${lesson.title}`,
    '',
    '## 场景',
    '',
    lesson.title,
    '',
    '## 失败教训',
    '',
    lesson.symptom ? `- 症状: ${lesson.symptom}` : '- （无记录）',
    lesson.failCount ? `- 连续失败 ${lesson.failCount} 次后才找到解法` : '',
    '',
    '## 有效解法',
    '',
    lesson.solution,
    '',
    '## 陷阱',
    '',
    '- 同一操作失败 2 次以上不要原样重试，先定位根因（见 debug-by-root-cause）',
    '',
  ].filter(l => l !== '').join('\n')
}

/**
 * 核心：沉淀一条经验。查重 → 重复则增量，否则新建。
 * P0-2：入口先过泛化质量门槛（路径名/工具串/残留 → 拒绝），
 * 再清洗工具输出残留，最后查重。
 * 返回 { action: 'created' | 'incremented' | 'skipped' | 'rejected', file?, score?, reason? }
 */
async function learn(skillsDir, lesson, cfg) {
  // P0-2 门槛 1：标题/解法/症状 质量校验
  const gate = passesQualityGate(lesson)
  if (!gate.ok) {
    return { action: 'rejected', reason: gate.reason }
  }
  // P0-2 门槛 2：清洗工具输出残留
  const cleanLesson = {
    ...lesson,
    title: cleanToolResidue(lesson.title),
    symptom: cleanToolResidue(lesson.symptom),
    solution: cleanToolResidue(lesson.solution),
  }
  const lessonBody = `${cleanLesson.title}\n${cleanLesson.solution}\n${cleanLesson.symptom || ''}`
  const match = await findBestMatch(skillsDir, lessonBody, cleanLesson.title)

  // 双保险去重：目标文件正文里已含这条解法 → 跳过
  if (match) {
    const solutionFp = cleanLesson.solution.slice(0, 80)
    if (match.content.includes(solutionFp)) {
      return { action: 'skipped', score: match.score, reason: 'already-present' }
    }
  }
  // P0-2 门槛 3：与手写纪律 skill 相似度过高 → 并入（不新建）
  if (match && match.score >= cfg.mergeThreshold) {
    const increment = buildIncrement(cleanLesson, match.content)
    await appendFile(match.file, increment, 'utf8')
    return { action: 'incremented', file: match.file, score: match.score }
  }

  if (match && match.score >= cfg.similarityThreshold) {
    const increment = buildIncrement(cleanLesson, match.content)
    await appendFile(match.file, increment, 'utf8')
    return { action: 'incremented', file: match.file, score: match.score }
  }

  // 新建
  await mkdir(skillsDir, { recursive: true })
  const name = kebabFrom(cleanLesson.title)
  const file = path.join(skillsDir, `${name}.md`)
  const content = buildNewSkill(cleanLesson)
  await writeFile(file, content, 'utf8')
  return { action: 'created', file, score: match ? match.score : 0 }
}

// ── 插件主体 ──────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  if (!cfg.enabled) return
  ctx.logger?.info?.('skill-evolver: plugin loaded (auto-learn skills with dedup)')

  const skillsDir = resolveSkillsDir(cfg)

  // agentId -> Map<fp, {fails, lastError, solvedAt, solution}>
  const track = new Map()
  // agentId -> 已沉淀经验指纹集合（跨 turn 记忆，防重复学习）
  const learned = new Map()
  // agentId -> turn 内待沉淀队列
  const pending = new Map()

  function trackFor(agentId) {
    let m = track.get(agentId)
    if (!m) { m = new Map(); track.set(agentId, m) }
    return m
  }
  function pendingFor(agentId) {
    let q = pending.get(agentId)
    if (!q) { q = []; pending.set(agentId, q) }
    return q
  }
  function learnedFor(agentId) {
    let s = learned.get(agentId)
    if (!s) { s = new Set(); learned.set(agentId, s) }
    return s
  }

  // 1. 观察工具结果：失败累积，成功收割
  ctx.on('tools/result', (exec, result) => {
    if (!exec || !exec.agent) return
    const agentId = exec.agent.id
    const fp = fingerprint(exec)
    const t = trackFor(agentId)

    if (isFailure(result)) {
      const rec = t.get(fp) || { fails: 0, lastError: '', solvedAt: 0, solution: '' }
      rec.fails += 1
      rec.lastError = extractText(result) || rec.lastError
      t.set(fp, rec)
    } else {
      // 成功：收割"尚未解决"的失败指纹——解法 = 当前成功的命令
      // （换路后的命令指纹 ≠ 失败指纹，所以查的是整个 track，不是当前指纹）
      const rec = t.get(fp)
      if (rec) {
        // 同一指纹成功 = 重试成功，不算解法；直接清掉失败状态
        t.delete(fp)
      }
      const q = pendingFor(agentId)
      if (q.length >= cfg.maxLessonsPerTurn) return
      // 找失败次数最多且未收割的指纹
      let best = null
      for (const [k, v] of t) {
        if (v.solvedAt === 0 && v.fails >= cfg.minFailsToLearn && (best === null || v.fails > best.v.fails)) {
          best = { k, v }
        }
      }
      if (best) {
        best.v.solvedAt = Date.now()
        best.v.solution = fp.split('::')[0] === 'pwsh' || fp.split('::')[0] === 'bash'
          ? (exec.arguments?.command || fp)
          : fp
        best.v.failFp = best.k  // 卡点指纹（查重主键：同卡点合并，解法增量）
        // 从 track 移除（已收割），防止重复学习
        t.delete(best.k)
        q.push(best.v)
      }
    }
  })

  // 2. turn 结束：沉淀本 turn 经验
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (!agent) return
    const agentId = agent.id
    const q = pending.get(agentId)
    if (!q || q.length === 0) return
    pending.set(agentId, [])

    const learnedSet = learnedFor(agentId)
    for (const rec of q) {
      if (rec.solvedAt === 0) continue
      const dedupKey = rec.solution.slice(0, 80)
      if (learnedSet.has(dedupKey)) continue
      const lesson = {
        // 卡点为主标题（同卡点合并），解法为增量
        title: shortTitle(rec.failFp || rec.solution),
        symptom: rec.lastError,
        failCount: rec.fails,
        solution: rec.solution,
      }
      try {
        const outcome = await learn(skillsDir, lesson, cfg)
        if (outcome.action === 'rejected') {
          ctx.logger?.warn?.(`skill-evolver: rejected low-quality lesson "${lesson.title}" (${outcome.reason})`)
        } else if (outcome.action !== 'skipped') {
          learnedSet.add(dedupKey)
          ctx.logger?.info?.(`skill-evolver: ${outcome.action} skill for "${lesson.title}"${outcome.file ? ` -> ${outcome.file}` : ''}${outcome.score !== undefined ? ` (similarity ${outcome.score.toFixed(2)})` : ''}`)
        } else {
          ctx.logger?.info?.(`skill-evolver: skipped duplicate lesson "${lesson.title}"`)
        }
      } catch (e) {
        ctx.logger?.warn?.(`skill-evolver: learn failed: ${String(e)}`)
      }
    }
  })

  // 3. 状态清理
  ctx.effect(() => makeCleanupTimer((cutoff) => {
    for (const [agentId, m] of track) {
      const last = Math.max(...[...m.values()].map(v => v.solvedAt || v.fails ? Date.now() : 0), 0)
      if (last < cutoff) track.delete(agentId)
    }
  }), 'skill-evolver: state cleanup')
}
