/**
 * dsh-fast-locate — fast_locate 工具（功能层 tools-board 首批，2026-08-16）
 *
 * 问题：DSH 原生\"查东西\"路径慢——串行 Grep→Pwsh→HELLO 三步走，且先查定义
 * 后查实体、无环境先验。一次\"找文件在哪\"要 3+ 步工具调用。
 *
 * 本工具：一次调用 = 多根目录并行扫描（层内 Promise.all），跳过
 * node_modules/.git/dist 等噪音目录，返回结构化结果 [{path, type, size, mtime}]。
 *
 * 匹配规则：
 *   - pattern 含 * 或 ? → glob 风格（* 跨目录段，? 单字符），大小写不敏感
 *   - 否则 → 子串匹配（文件名/路径包含即中），大小写不敏感
 *   - 文件与目录都返回（type 区分）
 *
 * 安全：symlink 一律跳过（防循环）；文件访问数上限（默认 10 万）防卡死；
 * 根目录不存在返回错误文本不抛异常。
 *
 * 零依赖纯 ESM（node 内置 only）。挂载：
 *   ~/.dsh/tools-board.cordis.yml → - id: dsh-fast-locate
 *                                    name: 'file:///.../dsh-fast-locate.mjs'
 */
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export const name = 'dsh-fast-locate'
/** 需要 tools 服务来注册工具（cordis inject 机制，同 dsh-memory） */
export const inject = ['tools']

const DEFAULT_CONFIG = {
  /** 默认扫描根目录（无 roots 参数时） */
  defaultRoots: undefined,
  /** 默认最大深度（0=只看根目录自身） */
  maxDepth: 5,
  /** 结果上限 */
  limit: 50,
  /** 跳过的目录名（任意深度） */
  skipDirs: ['node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', '.venv', 'venv', '__pycache__', '.cache', '.next', '.turbo'],
  /** 访问文件/目录数硬上限（防失控扫描卡死） */
  maxVisited: 100000,
}

/** glob 模式转正则：* 跨段，? 单字符（不匹配路径分隔符） */
function globToRegex(glob) {
  const parts = glob.split('*')
  const body = parts.map((p, i) => {
    const seg = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '[^/\\\\]')
    return i < parts.length - 1 ? `${seg}[^/\\\\]*` : seg
  }).join('')
  return new RegExp(`^${body}$`, 'i')
}

/** 构造匹配器：含 glob 字符 → glob 正则；否则子串（大小写不敏感）。
 *  glob 同时测完整相对路径与 basename（find -name 直觉：*.mjs 应命中任意深度的 .mjs） */
function makeMatcher(pattern) {
  const p = String(pattern || '').trim()
  if (!p) return null
  if (/[*?]/.test(p)) {
    const re = globToRegex(p)
    return (rel, name) => re.test(rel) || (name != null && re.test(name))
  }
  const lower = p.toLowerCase()
  return (rel) => rel.toLowerCase().includes(lower)
}

/** 人类可读大小 */
function humanSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

/** 单根目录扫描：层内并行、跳过噪音目录、mtime 倒序 */
async function scanRoot(root, matcher, cfg) {
  const skip = new Set(cfg.skipDirs)
  const results = []
  let visited = 0
  let scannedDirs = 0
  let truncated = false

  // 队列元素: {abs, depth}；按层 BFS，层内 Promise.all 并行
  let frontier = [{ abs: root, depth: 0 }]
  while (frontier.length > 0) {
    if (visited >= cfg.maxVisited) { truncated = true; break }
    const layer = frontier
    frontier = []
    const entries = await Promise.all(layer.map(async ({ abs, depth }) => {
      if (visited >= cfg.maxVisited) return []
      visited++
      let dirents
      try {
        dirents = await readdir(abs, { withFileTypes: true })
      } catch (e) {
        if (depth === 0) throw e // 根目录读不到 → 向上抛（execute 记入 error 列表）
        return [] // 子目录权限/不存在 → 静默跳过
      }
      scannedDirs++
      const out = []
      for (const d of dirents) {
        if (d.isSymbolicLink()) continue // 防循环
        if (d.isDirectory() && skip.has(d.name)) continue
        const full = path.join(abs, d.name)
        const rel = full.slice(root.length + 1).replace(/\\/g, '/')
        let statLike = { size: 0, mtimeMs: 0 }
        if (d.isFile()) {
          try {
            // 只有文件需要 stat 拿 size/mtime；目录不 stat（省开销）
            const st = await stat(full)
            statLike = { size: st.size, mtimeMs: st.mtimeMs }
          } catch { /* stat 失败用默认 */ }
        }
        if (matcher(rel, d.name)) {
          results.push({
            path: full,
            type: d.isDirectory() ? 'dir' : 'file',
            size: d.isDirectory() ? 0 : statLike.size,
            mtimeMs: statLike.mtimeMs,
          })
        }
        if (d.isDirectory() && depth + 1 <= cfg.maxDepth) {
          out.push({ abs: full, depth: depth + 1 })
        }
      }
      return out
    }))
    frontier = entries.flat()
    // 防止单层目录爆炸（比如巨型 monorepo 根层），层内也要计数
    if (visited >= cfg.maxVisited) { truncated = true; break }
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { results, visited, scannedDirs, truncated }
}

function renderResults(agg, cfg, ms) {
  const total = agg.results.length
  const shown = agg.results.slice(0, cfg.limit)
  const lines = shown.map((r, i) => {
    const size = r.type === 'dir' ? '-' : humanSize(r.size)
    const mtime = r.mtimeMs > 0 ? new Date(r.mtimeMs).toISOString().slice(0, 19).replace('T', ' ') : '-'
    return `${i + 1}. [${r.type}] ${r.path}  (${size}, ${mtime})`
  })
  const more = total > shown.length ? `\n... 共 ${total} 个匹配，仅显示前 ${shown.length} 个（可调 limit）` : ''
  const truncNote = agg.truncated ? `\n⚠️ 达到访问上限（${cfg.maxVisited}），结果可能不完整` : ''
  return `fast_locate: 找到 ${total} 个匹配（扫描 ${agg.scannedDirs} 个目录 / ${agg.visited} 个条目，耗时 ${ms} ms）${truncNote}\n${lines.join('\n')}${more}`
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  ctx.logger?.info?.('dsh-fast-locate: plugin loaded (parallel locate tool)')

  ctx.effect(() => ctx.tools.register({
    name: 'fast_locate',
    description: '并行多根目录快速查找文件/目录（替代串行 grep→pwsh 三步走）。一次调用同时扫描多个根目录，自动跳过 node_modules/.git/dist 等噪音目录。pattern 含 * 或 ? 时按 glob（* 跨目录段、? 单字符），否则按路径子串匹配，均大小写不敏感。返回命中列表（路径/类型/大小/修改时间，按 mtime 倒序）。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '查找模式：含 * 或 ? 按 glob，否则子串匹配（如 host-boot、*.mjs、discipline）',
        },
        roots: {
          type: 'array',
          items: { type: 'string' },
          description: '扫描根目录（可多个，并行）。默认当前工作目录',
        },
        maxDepth: {
          type: 'number',
          description: `最大递归深度（默认 ${cfg.maxDepth}）`,
        },
        limit: {
          type: 'number',
          description: `结果条数上限（默认 ${cfg.limit}）`,
        },
        skipDirs: {
          type: 'array',
          items: { type: 'string' },
          description: '额外跳过的目录名（默认已跳过 node_modules/.git/dist/.venv 等）',
        },
      },
      required: ['pattern'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const matcher = makeMatcher(args.pattern)
      if (!matcher) return 'fast_locate: pattern 不能为空'
      const roots = Array.isArray(args.roots) && args.roots.length > 0
        ? args.roots.map(r => String(r))
        : (cfg.defaultRoots || [process.cwd()])
      const limit = Math.max(1, Math.min(500, Number(args.limit) || cfg.limit))
      // 注意：必须 Number(args.maxDepth ?? cfg.maxDepth)——Number(undefined) 是 NaN，
      // NaN ?? 默认值 仍是 NaN（?? 只认 null/undefined），会把 maxDepth 变 NaN 导致深度扫描失效
      const maxDepth = Math.max(0, Math.min(20, Number(args.maxDepth ?? cfg.maxDepth)))
      const skipDirs = Array.isArray(args.skipDirs) && args.skipDirs.length > 0
        ? [...cfg.skipDirs, ...args.skipDirs.map(String)]
        : cfg.skipDirs
      const scanCfg = { ...cfg, limit, maxDepth, skipDirs }

      const t0 = Date.now()
      const agg = { results: [], visited: 0, scannedDirs: 0, truncated: false }
      const resPerRoot = await Promise.all(roots.map(async (r) => {
        const abs = path.resolve(String(r))
        let rootRes
        try {
          rootRes = await scanRoot(abs, matcher, scanCfg)
        } catch (e) {
          return { error: `${abs}: ${String(e).slice(0, 200)}`, rootRes: null }
        }
        return { error: null, rootRes }
      }))
      const ms = Date.now() - t0

      const errors = resPerRoot.filter(r => r.error).map(r => r.error)
      for (const r of resPerRoot) {
        if (!r.rootRes) continue
        agg.results.push(...r.rootRes.results)
        agg.visited += r.rootRes.visited
        agg.scannedDirs += r.rootRes.scannedDirs
        agg.truncated = agg.truncated || r.rootRes.truncated
      }
      agg.results.sort((a, b) => b.mtimeMs - a.mtimeMs)

      let out = renderResults(agg, scanCfg, ms)
      if (errors.length > 0) {
        out += `\n\n⚠️ 无法扫描的根目录:\n${errors.map(e => `- ${e}`).join('\n')}`
      }
      return out
    },
  }), 'dsh-fast-locate: register fast_locate tool')
}
