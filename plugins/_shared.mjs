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
 * 计算一次工具调用的"指纹"——归一化后的身份，用于识别"完全相同的重试"。
 * shell 类命令去掉 cd 前缀 / env 设置 / 管道尾部装饰 / 重定向 / 2>&1 /
 * Select-Object 行数 / Select-String 过滤器（P0-3 加强模糊化），
 * 让"同一命令微调装饰层"也落入同一指纹；edit 用文件路径 + old_string 摘要。
 */
export function fingerprint(exec, { limit = 300 } = {}) {
  const name = exec.name || '?'
  const args = exec.arguments || {}
  let sig = ''
  try {
    if (typeof args.command === 'string') {
      sig = args.command
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
        .slice(0, limit)
    } else if (typeof args.file_path === 'string' || typeof args.path === 'string') {
      const fp = args.file_path || args.path || ''
      if (name === 'edit') {
        const oldStr = String(args.old_string || '').slice(0, 80)
        sig = `${fp}::${oldStr}`
      } else {
        sig = fp
      }
    } else {
      sig = JSON.stringify(args).slice(0, limit)
    }
  } catch {
    sig = String(args).slice(0, limit)
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
