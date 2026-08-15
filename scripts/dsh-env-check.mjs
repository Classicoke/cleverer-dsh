/**
 * dsh-env-check.mjs — 环境检查项注册表（M2-2）
 *
 * 通用可插拔环境检查：每个检查项 = { id, describe, check(dir, ctx) -> {ok, evidence} }
 * 检查项：
 *   dep-consistency       物化闭包 vs 声明依赖一致性（home patch 插件在 staging 是否可解析）
 *   native-binaries       sharp/koffi/ripgrep 平台二进制在 asar/unpacked 的存在性
 *   collector-mode        electron-builder 实际收集器模式（npm vs pnpm workspace）
 *   profile-plugin-resolve desktop profile 下 home patch 插件能否解析
 *   network-mirror        镜像环境变量是否设置（ELECTRON_MIRROR 等）
 *
 * 用法：
 *   node dsh-env-check.mjs all            # 全部检查
 *   node dsh-env-check.mjs collector-mode # 单项
 * 返回：每项 {ok, evidence}——evidence 是具体文件/命令证明，用户可自查（不甩模糊结论）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import os from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), '.dsh')
// REPO 优先环境变量，其次探测常见位置（发布版不硬编码本机路径）
function resolveRepo() {
  if (process.env.DSH_REPO) return process.env.DSH_REPO
  const candidates = [
    join(os.homedir(), 'deepseek-harness-master'),
    'D:/deepseek-harness-master',
    'C:/deepseek-harness-master',
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'apps/desktop/package.json'))) return c
  }
  return candidates[0] // 找不到就用第一个候选，让检查项自然报错提示
}
const REPO = resolveRepo()

// ── 检查项注册表 ──────────────────────────────────────────────────────
const CHECKS = {
  /** 1. 依赖一致性：cordis.patch.yml 引用的本地插件文件是否存在 */
  'dep-consistency': {
    describe: 'home patch 引用的本地插件文件存在性',
    check() {
      const patch = join(DSH_HOME, 'cordis.patch.yml')
      if (!existsSync(patch)) return { ok: false, evidence: `cordis.patch.yml 不存在: ${patch}` }
      const text = readFileSync(patch, 'utf8')
      const refs = [...text.matchAll(/name:\s*'file:\/\/\/([^']+)'/g)].map(m => m[1].replace(/\//g, '\\'))
      const missing = refs.filter(r => !existsSync(r))
      return {
        ok: missing.length === 0,
        evidence: missing.length === 0
          ? `patch 引用 ${refs.length} 个本地插件，全部存在（首: ${refs[0]?.split('\\').pop()}）`
          : `缺失 ${missing.length} 个: ${missing.join(' | ')}`,
      }
    },
  },

  /** 2. 原生二进制：sharp/koffi/ripgrep 平台包在 node_modules 的存在性 */
  'native-binaries': {
    describe: 'sharp/koffi/ripgrep 平台二进制（win32-x64）存在性',
    check() {
      const checks = [
        ['sharp', ['node_modules/@img/sharp-win32-x64', 'node_modules/@img/sharp-libvips-win32-x64']],
        ['koffi', ['node_modules/@koromix/koffi-win32-x64']],
        ['ripgrep', ['node_modules/@vscode/ripgrep-win32-x64']],
      ]
      const missing = []
      for (const [name, paths] of checks) {
        const any = paths.some(p => existsSync(join(REPO, 'apps/desktop', p)) || existsSync(join(REPO, 'apps/desktop/staging', p)))
        if (!any) missing.push(name)
      }
      return {
        ok: missing.length === 0,
        evidence: missing.length === 0
          ? 'win32-x64 平台二进制齐备（sharp/koffi/ripgrep）'
          : `缺失平台包: ${missing.join(', ')}——需加入 optionalDependencies 或用 fixup 补入 asar`,
      }
    },
  },

  /** 3. 收集器模式：electron-builder 实际用 npm 还是 pnpm workspace */
  'collector-mode': {
    describe: 'electron-builder 收集器模式（npm vs pnpm workspace）',
    check() {
      const rootPkg = join(REPO, 'package.json')
      let pm = 'unknown'
      if (existsSync(rootPkg)) {
        try {
          const j = JSON.parse(readFileSync(rootPkg, 'utf8'))
          pm = j.packageManager || '（无 packageManager 字段）'
        } catch { pm = '（package.json 解析失败）' }
      }
      // npm collector 生效的判据：staging/package.json 有 packageManager 且仓库根无 workspace 覆盖
      const stagingPkg = join(REPO, 'apps/desktop/staging/package.json')
      let stagingPm = null
      if (existsSync(stagingPkg)) {
        try { stagingPm = JSON.parse(readFileSync(stagingPkg, 'utf8')).packageManager || null } catch { /* ignore */ }
      }
      const rootWorkspace = existsSync(join(REPO, 'pnpm-workspace.yaml'))
      const verdict = stagingPm && pm.startsWith('pnpm')
        ? 'staging 声明了 npm 但仓库根 packageManager 是 pnpm → 会被覆盖，collector 仍是 pnpm'
        : stagingPm ? `staging packageManager=${stagingPm}` : 'staging 未声明 packageManager'
      return { ok: stagingPm !== null, evidence: `仓库根: ${pm} | workspace.yaml: ${rootWorkspace} | ${verdict}` }
    },
  },

  /** 4. profile 插件解析：desktop profile 下 home patch 插件能否解析 */
  'profile-plugin-resolve': {
    describe: 'desktop profile 下 home patch 插件解析',
    check() {
      const profiles = join(DSH_HOME, 'profiles')
      if (!existsSync(profiles)) return { ok: true, evidence: '无 profiles 目录（web-only 部署）' }
      const patch = join(DSH_HOME, 'cordis.patch.yml')
      if (!existsSync(patch)) return { ok: false, evidence: 'cordis.patch.yml 不存在' }
      const patchText = readFileSync(patch, 'utf8')
      const bareNames = [...patchText.matchAll(/name:\s*['"](@deepseek-ai\/[^'"]+)['"]/g)].map(m => m[1])
      const unresolved = []
      for (const dir of readdirSync(profiles)) {
        const pkgDir = join(profiles, dir, 'node_modules')
        if (!existsSync(pkgDir)) continue
        for (const name of bareNames) {
          const p = join(pkgDir, name)
          if (!existsSync(p)) unresolved.push(`${dir}:${name}`)
        }
      }
      return {
        ok: unresolved.length === 0,
        evidence: unresolved.length === 0
          ? `home patch 的 ${bareNames.length} 个 @deepseek-ai 包在 profiles node_modules 可解析`
          : `解析失败 ${unresolved.length} 处: ${unresolved.slice(0, 6).join(' | ')}（dev 靠 workspace 源码兜底，打包版会 boot fail）`,
      }
    },
  },

  /** 5. 镜像：electron 下载镜像环境变量 */
  'network-mirror': {
    describe: 'electron/builder 二进制镜像环境变量',
    check() {
      const missing = []
      if (!process.env.ELECTRON_MIRROR) missing.push('ELECTRON_MIRROR')
      if (!process.env.ELECTRON_BUILDER_BINARIES_MIRROR) missing.push('ELECTRON_BUILDER_BINARIES_MIRROR')
      return {
        ok: missing.length === 0,
        evidence: missing.length === 0
          ? `ELECTRON_MIRROR=${process.env.ELECTRON_MIRROR}`
          : `未设置: ${missing.join(', ')}——打包下载 electron 可能超时（本次 13:32 曾踩）`,
      }
    },
  },

  /** 6. 打包产物：win-unpacked 与 asar 存在性 */
  'pack-artifacts': {
    describe: '打包产物（win-unpacked/app.asar）存在性',
    check() {
      const win = join(REPO, 'apps/desktop/staging/release/win-unpacked')
      const asar = join(win, 'resources/app.asar')
      const exe = join(win, 'DeepSeek Harness Desktop.exe')
      const missing = []
      if (!existsSync(win)) missing.push('win-unpacked')
      if (!existsSync(asar)) missing.push('app.asar')
      if (!existsSync(exe)) missing.push('exe')
      return {
        ok: missing.length === 0,
        evidence: missing.length === 0
          ? `win-unpacked 完整（asar ${Math.round(readFileSync(asar).length / 1048576)}MB）`
          : `缺失: ${missing.join(', ')}——需跑 package.mjs（--dir 阶段）`,
      }
    },
  },

  /** 7. 插件语法健康（2026-08-16 新增，可观测性第 3 层）：
   *  所有 ~/.dsh/plugins/*.mjs 过 node --check——语法错=插件静默失效 */
  'plugin-syntax': {
    describe: '所有本地插件 node --check 语法健康',
    check() {
      const dir = join(DSH_HOME, 'plugins')
      if (!existsSync(dir)) return { ok: false, evidence: `插件目录不存在: ${dir}` }
      const files = readdirSync(dir).filter(f => f.endsWith('.mjs'))
      const broken = []
      for (const f of files) {
        try {
          execFileSync('node', ['--check', join(dir, f)], { stdio: 'pipe' })
        } catch {
          broken.push(f)
        }
      }
      return {
        ok: broken.length === 0,
        evidence: broken.length === 0
          ? `${files.length} 个插件语法全部通过`
          : `语法错误: ${broken.join(', ')}——该插件已静默失效，必须修复`,
      }
    },
  },

  /** 8. 装配一致性（2026-08-16 新增）：主 patch + 两个子板 YAML 合法、无双加载、
   *  引用插件文件全部存在 */
  'board-consistency': {
    describe: '主 patch + discipline-board/tools-board 子板装配一致性（YAML/双加载/引用存在）',
    check() {
      const patchFile = join(DSH_HOME, 'cordis.patch.yml')
      const boardFiles = ['discipline-board.cordis.yml', 'tools-board.cordis.yml']
        .map(f => join(DSH_HOME, f))
        .filter(existsSync)
      const issues = []
      for (const [label, f] of [['patch', patchFile], ...boardFiles.map(f => [f.split('\\').pop(), f])]) {
        if (!existsSync(f)) { issues.push(`${label} 文件不存在`); continue }
        const text = readFileSync(f, 'utf8')
        // 检查引用的本地插件文件存在
        for (const m of text.matchAll(/name:\s*'file:\/\/\/([^']+)'/g)) {
          const p = m[1].replace(/\//g, '\\')
          if (!existsSync(p)) issues.push(`${label} 引用缺失: ${p}`)
        }
      }
      // 双加载检查（主 patch insert ∩ 各子板 = 空；子板之间也互查）
      const patchText = readFileSync(patchFile, 'utf8')
      const patchIds = new Set([...patchText.matchAll(/^\s*- id:\s*([\w-]+)/gm)].map(m => m[1]))
      for (const f of boardFiles) {
        const boardText = readFileSync(f, 'utf8')
        const boardIds = [...boardText.matchAll(/^\s*- id:\s*([\w-]+)/gm)].map(m => m[1])
        const dup = boardIds.filter(id => patchIds.has(id))
        if (dup.length > 0) issues.push(`${f.split('\\').pop()} 与主 patch 双加载: ${dup.join(', ')}`)
        // 子板间互查
        for (const f2 of boardFiles) {
          if (f2 === f) continue
          const ids2 = [...readFileSync(f2, 'utf8').matchAll(/^\s*- id:\s*([\w-]+)/gm)].map(m => m[1])
          const crossDup = boardIds.filter(id => ids2.includes(id))
          if (crossDup.length > 0) issues.push(`子板 ${f.split('\\').pop()} 与 ${f2.split('\\').pop()} 重复: ${crossDup.join(', ')}`)
        }
      }
      return {
        ok: issues.length === 0,
        evidence: issues.length === 0
          ? `patch+${boardFiles.map(f => f.split('\\').pop()).join('+')} 装配一致（patch ${patchIds.size} 项，子板 ${boardFiles.length} 个，引用齐全无双加载）`
          : issues.join(' | '),
      }
    },
  },

  /** 9. skills 合规（2026-08-16 新增）：frontmatter 必含 name+description */
  'skills-valid': {
    describe: '~/.dsh/skills/*.md frontmatter 合规（name+description）',
    check() {
      const dir = join(DSH_HOME, 'skills')
      if (!existsSync(dir)) return { ok: true, evidence: '无 skills 目录' }
      const files = readdirSync(dir).filter(f => f.endsWith('.md'))
      const bad = []
      for (const f of files) {
        const text = readFileSync(join(dir, f), 'utf8')
        if (!text.startsWith('---')) { bad.push(`${f}: 无 frontmatter`); continue }
        const fm = text.split('---')[1] || ''
        if (!/name:\s*\S+/.test(fm)) bad.push(`${f}: 缺 name`)
        if (!/description:\s*\S+/.test(fm)) bad.push(`${f}: 缺 description`)
      }
      return {
        ok: bad.length === 0,
        evidence: bad.length === 0
          ? `${files.length} 个 skill frontmatter 全部合规`
          : bad.join(' | '),
      }
    },
  },
}

// ── CLI ────────────────────────────────────────────────────────────────
const which = process.argv[2] || 'all'
const ids = Object.keys(CHECKS)
const targets = which === 'all' ? ids : which.split(',').filter(id => CHECKS[id])

if (targets.length === 0) {
  console.log(`未知检查项: ${which}\n可用: ${ids.join(', ')}`)
  process.exit(1)
}

let pass = 0
for (const id of targets) {
  const c = CHECKS[id]
  try {
    const r = c.check()
    console.log(`${r.ok ? '✅' : '❌'} [${id}] ${c.describe}`)
    console.log(`    ${r.evidence}`)
    if (r.ok) pass++
  } catch (e) {
    console.log(`⚠️  [${id}] ${c.describe} — 检查执行异常: ${String(e).slice(0, 120)}`)
  }
}
console.log(`\n${pass}/${targets.length} 通过`)
process.exit(pass === targets.length ? 0 : 1)
