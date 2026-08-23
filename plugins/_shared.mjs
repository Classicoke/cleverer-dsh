/**
 * _shared.mjs — 纪律插件公共工具（DRY 重构 2026-08-16）
 *
 * 原先 fingerprint/isFailure/extractText/classify/bigram/currentTurn/cleanupTimer
 * 在 anti-stuck / discipline-hub / env-triage / skill-evolver 中各自复制实现，
 * 修复一处漏三处。本模块统一为单一实现（取各版本行为并集，最保守），
 * 各插件只保留自己的业务逻辑。
 *
 * 约束：零依赖纯 ESM；所有函数保持与迁移前逐字等价的行为
 * （426 项单测黑盒验证，行为不可变）。
 */

// ── 工具结果判定 ──────────────────────────────────────────────────────

/** 判断一次工具结果是否算"失败"（isError / exitCode / 渲染文本失败标记） */
export function isFailure(result) {
  if (!result) return false
  if (result.isError === true) return true
  // 兜底 1: canonical value 里的 exitCode（pwsh/bash 工具的 value 形状）
  try {
    const v = result.value
    if (v && typeof v === 'object') {
      const code = v.exitCode
      if (typeof code === 'number' && code !== 0) return true
    }
  } catch { /* ignore */ }
  // 兜底 2: 渲染文本里的失败标记（[exit code: N]、error、failed 等）
  const txt = JSON.stringify(result.content || result || '').toLowerCase()
  return /(\[exit code: [1-9]|error|exception|traceback|command failed|failed:|exit code: [1-9])/.test(txt)
}

/** 提取工具结果纯文本（content 数组 → join；失败原因用）。
 *  必须提取纯文本而非 JSON.stringify——JSON 转义会把反斜杠变 `\\`，
 *  导致路径归一化后 `resources//app.asar` 匹配失败（P0-3 实测坑）。 */
export function extractText(result, limit = 300) {
  try {
    const c = result?.content
    if (Array.isArray(c)) {
      const joined = c.map(b => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '').join(' ')
      if (joined) return joined.slice(0, limit)
    }
  } catch { /* ignore */ }
  return JSON.stringify(result || '').slice(0, limit)
}

// ── 工具调用指纹 ──────────────────────────────────────────────────────

/**
 * 固定多点取样摘要：长参数不再"截前 N 字符"（前缀截断会让 limit 之后的
 * 差异全部丢失，不同长参数被误判为同一指纹），而是在整串上按固定分布取
 * 若干样本窗口（首、中、尾全覆盖），并附总长度 + 全长 FNV-1a 哈希：
 *  - 样本窗口：任意位置的差异都能反映进指纹（尤其尾部差异必被捕获）；
 *  - 全长哈希：样本窗口未覆盖区域的差异也以 32 位哈希参与区分（满足分布）。
 * 串长 ≤ limit 时原样返回（保持旧行为，短参数指纹可读）。
 */
export function sampleDigest(s, { limit = 300, points = 8, window = 24 } = {}) {
  const str = String(s)
  if (str.length <= limit) return str
  const last = str.length - window
  const parts = []
  for (let i = 0; i < points; i++) {
    const pos = Math.min(last, Math.floor((i * last) / (points - 1)))
    parts.push(str.slice(pos, pos + window))
  }
  // FNV-1a 32 位：覆盖样本窗口之间的全部区域
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `#${str.length}#${parts.join('|')}#${hash.toString(16).padStart(8, '0')}`
}

/**
 * 参数的确定性序列化：键排序 + 递归 + 循环引用/深对象防护。
 * 同一组参数无论键序如何都得到同一串；不同参数得到不同串。
 * `description` 是展示元数据而非执行参数，排除以免"同命令换描述"逃过重复检测。
 */
const OMIT_KEYS = new Set(['description'])

function canonicalValue(v, seen, depth = 0) {
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'string') return JSON.stringify(v)
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v)
  if (t === 'undefined') return 'undefined'
  if (t === 'function') return `[fn:${v.name || 'anon'}]`
  if (t === 'symbol') return `[sym:${String(v)}]`
  if (depth > 8) return '[Deep]'
  if (seen.has(v)) return '[Circular]'
  seen.add(v)
  let out
  try {
    if (Array.isArray(v)) {
      out = '[' + v.map(x => canonicalValue(x, seen, depth + 1)).join(',') + ']'
    } else if (v instanceof Date) {
      out = JSON.stringify(v.toISOString())
    } else {
      const keys = Object.keys(v).filter(k => !OMIT_KEYS.has(k)).sort()
      out = '{' + keys.map(k => {
        let val
        try { val = canonicalValue(v[k], seen, depth + 1) } catch { val = '[Getter]' }
        return JSON.stringify(k) + ':' + val
      }).join(',') + '}'
    }
  } catch {
    out = '[Unserializable]'
  }
  seen.delete(v)
  return out
}

/**
 * shell 命令归一化：去掉 cd 前缀 / env 设置 / 管道尾部装饰 / 重定向 / 2>&1 /
 * Select-Object 行数 / Select-String 过滤器（P0-3 加强模糊化），
 * 让"同一命令微调装饰层"仍落入同一指纹。
 */
function normalizeCommand(command) {
  return String(command)
    .replace(/^cd\s+[^;]+;\s*/, '')                    // 去 cd 前缀
    .replace(/\$env:[A-Z_]+(\s*=\s*'[^']*'|\s*=\s*"[^"]*")?;\s*/g, '') // 去 env 设置
    .replace(/\s*2>&1\s*/g, ' ')                        // 去 2>&1
    .replace(/\s*\*\s*>\s*[^;]+/g, ' ')                 // 去 *> 重定向到文件
    .replace(/\s*\|\s*Select-Object\s+-Last\s+\d+/g, '') // 去 | Select-Object -Last N
    .replace(/\s*\|\s*Select-Object\s+-First\s+\d+/g, '') // 去 | Select-Object -First N
    .replace(/\s*\|\s*Select-String\s+[^|]*$/g, '')     // 去尾部 | Select-String ...
    .replace(/\s*\|\s*Select-Object\s+[^|]*$/g, '')     // 去尾部 | Select-Object ...
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 计算一次工具调用的"指纹"——归一化后的身份，用于识别"完全相同的重试"。
 *
 * 2026-08-24 修复（分段 Read 误杀）：
 *  - 旧实现只取 file_path / 只取 command 前缀，忽略其余参数 → 不同 offset/limit
 *    的 Read、长命令 limit 之后的差异全部撞同一指纹 → 误 deny。
 *  - 现在：覆盖工具调用的全部参数（键排序确定性序列化，description 除外），
 *    长参数用固定多点取样摘要（sampleDigest）而非前缀截断。
 */
export function fingerprint(exec, { limit = 300, points = 8, window = 24 } = {}) {
  const name = exec?.name || '?'
  const args = exec?.arguments
  let sig = ''
  try {
    if (args && typeof args === 'object') {
      if (typeof args.command === 'string') {
        // 命令类工具：command 归一化后取样；其余参数（workdir/timeout_ms 等）一并纳入
        const rest = {}
        for (const k of Object.keys(args)) {
          if (k !== 'command' && !OMIT_KEYS.has(k)) rest[k] = args[k]
        }
        const restSig = sampleDigest(canonicalValue(rest, new WeakSet()), { limit, points, window })
        const cmdSig = sampleDigest(normalizeCommand(args.command), { limit, points, window })
        sig = restSig === '{}' ? cmdSig : `${cmdSig}|${restSig}`
      } else {
        // 文件/通用工具：全部参数参与（read 的 offset/limit、write 的 content、
        // edit 的 old_string/new_string 都不再被忽略）
        sig = sampleDigest(canonicalValue(args, new WeakSet()), { limit, points, window })
      }
    } else {
      // 无参数 / 非对象参数 → 序列化兜底（无参数时 '{}'，与旧行为一致）
      sig = sampleDigest(canonicalValue(args ?? {}, new WeakSet()), { limit, points, window })
    }
  } catch {
    sig = sampleDigest(String(args ?? ''), { limit, points, window })
  }
  return `${name}::${sig}`
}

// ── 错误分类 ──────────────────────────────────────────────────────────

/** 错误分类关键词表（按特异性排序：具体模式在前，避免 "old_string was
 *  not found" 被 order-dep 的 "not found" 抢先） */
export const ERROR_CLASSES = [
  ['stale-snapshot', /old_string was not found/i],
  ['missing-module', /(cannot resolve|Cannot find module|module not found|ERR_MODULE_NOT_FOUND|ERR_DLOPEN)/i],
  ['order-dep', /(not found|ENOENT|no such file|module cannot be found)/i],
  ['permission', /(permission denied|EACCES|EPERM|denied)/i],
  ['network', /(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|fetch failed|socket)/i],
  ['syntax', /(SyntaxError|Unexpected token|Parse error)/i],
]

/** 按关键词表匹配错误文本，返回 cls（无匹配 → 'generic'，空文本 → 'unknown'）。
 *  兼容两种条目格式：`[cls, re]` 对数组（env-triage 风格）或 `{cls, re}` 对象数组（hub 风格）。 */
export function classifyError(txt, classes = ERROR_CLASSES) {
  if (!txt) return 'unknown'
  for (const entry of classes) {
    const [cls, re] = Array.isArray(entry) ? entry : [entry.cls, entry.re]
    if (re.test(txt)) return cls
  }
  return 'generic'
}

// ── 相似度：字符 bigram Jaccard ───────────────────────────────────────

/** 字符 bigram 集合（去空白/标点/符号，小写） */
export function charBigrams(s) {
  const set = new Set()
  const t = String(s).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}

/** bigram Jaccard 相似度（任一输入为空 → 0） */
export function similarity(a, b) {
  const A = charBigrams(a)
  const B = charBigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

// ── turn 推断 ─────────────────────────────────────────────────────────

/** 从 agent 的 session 事件流推断当前 turn 号（无则 0） */
export function currentTurn(agent) {
  try {
    const events = agent?.session?.events
    if (!events) return 0
    const last = [...events].findLast(e => e.type === 'turn/start')
    return last && last.type === 'turn/start' ? last.data.turn : 0
  } catch {
    return 0
  }
}

// ── 状态清理 timer ────────────────────────────────────────────────────

/**
 * 创建"10 分钟周期清理超过 30 分钟未活动状态"的 timer。
 * 返回 cleanup 函数（clearInterval 包装）；内部用全局 setInterval，
 * 测试可用 fake 替换捕获回调。
 */
export function makeCleanupTimer(fn) {
  const timer = setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000
    fn(cutoff)
  }, 10 * 60 * 1000)
  return () => clearInterval(timer)
}
