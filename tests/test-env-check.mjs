/**
 * dsh-env-check.mjs 单元测试：9 项检查注册表 + CLI（黑盒，import 即执行）
 *
 * 策略：dsh-env-check.mjs 是 CLI 脚本（模块顶层直接跑检查），且硬 import
 * node:fs / node:os / node:child_process。用 node:module 的 registerHooks
 * mock 掉这三个模块（状态放 globalThis.__mockFs），每次场景用 cache-buster
 * （query 参数）重新 import，捕获 console.log + process.exit。
 *
 * 运行：node test-env-check.mjs
 */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// ── mock 状态 ──────────────────────────────────────────────────────────
globalThis.__mockFs = { exists: new Set(), files: new Map(), dirs: new Map(), execs: new Map() }

// 归一化路径（Windows 反斜杠 → 正斜杠 + 统一小写，Windows 路径不区分大小写）
// 注意：每次访问取 globalThis.__mockFs 当前对象（测试会整体替换该对象）
const mockSource = `
const S = () => globalThis.__mockFs
const norm = (p) => String(p).replace(/\\\\/g, '/').toLowerCase()
export function existsSync(p) { return S().exists.has(norm(p)) }
export function readFileSync(p) {
  const k = norm(p)
  if (S().files.has(k)) return S().files.get(k)
  throw new Error('ENOENT: no such file, open ' + p)
}
export function readdirSync(p) {
  const k = norm(p)
  if (S().dirs.has(k)) return S().dirs.get(k)
  throw new Error('ENOENT: no such file or directory, scandir ' + p)
}
`

const osSource = `
export default { homedir: () => globalThis.__mockHome || 'C:/fake-home' }
`

const cpSource = `
export function execFileSync(cmd, args, opts) {
  const f = String(args?.[1] || '')
  if (f.includes('__bad__')) throw new Error('syntax error in ' + f)
  return Buffer.from('ok')
}
`

registerHooks({
  load(specifier, context, nextLoad) {
    if (specifier === 'node:fs') return { format: 'module', shortCircuit: true, source: mockSource }
    if (specifier === 'node:os') return { format: 'module', shortCircuit: true, source: osSource }
    if (specifier === 'node:child_process') return { format: 'module', shortCircuit: true, source: cpSource }
    return nextLoad(specifier, context)
  },
})

const ENV_CHECK = join(process.cwd(), 'scripts', 'dsh-env-check.mjs')

// ── 测试基础设施 ────────────────────────────────────────────────────────
let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

class ExitSignal extends Error { constructor(code) { super('exit'); this.code = code } }

let scenarioCounter = 0
const savedEnv = {}

/** 运行一个场景：设置 mock fs + env + argv，重新 import CLI，捕获输出 */
async function runScenario({ fs, args = ['all'], dshHome, dshRepo, home = 'C:/fake-home' }) {
  globalThis.__mockFs = fs
  globalThis.__mockHome = home
  // env（注意：dshHome/dshRepo 默认 undefined = 删除该变量，走兜底逻辑）
  const saved = {}
  for (const k of ['DSH_HOME', 'DSH_REPO', 'ELECTRON_MIRROR', 'ELECTRON_BUILDER_BINARIES_MIRROR']) {
    saved[k] = process.env[k]
    if (k === 'DSH_HOME') { if (dshHome !== undefined) process.env.DSH_HOME = dshHome; else delete process.env.DSH_HOME }
    if (k === 'DSH_REPO') { if (dshRepo !== undefined) process.env.DSH_REPO = dshRepo; else delete process.env.DSH_REPO }
    if (k === 'ELECTRON_MIRROR') { if (fs.envMirror) process.env.ELECTRON_MIRROR = fs.envMirror; else delete process.env.ELECTRON_MIRROR }
    if (k === 'ELECTRON_BUILDER_BINARIES_MIRROR') { if (fs.envBuilderMirror) process.env.ELECTRON_BUILDER_BINARIES_MIRROR = fs.envBuilderMirror; else delete process.env.ELECTRON_BUILDER_BINARIES_MIRROR }
  }
  // argv + console + exit
  const savedArgv = process.argv
  const savedLog = console.log
  const savedExit = process.exit
  process.argv = ['node', 'dsh-env-check.mjs', ...args]
  const logs = []
  console.log = (...a) => logs.push(a.join(' '))
  let exitCode = null
  process.exit = (c) => { exitCode = c; throw new ExitSignal(c) }
  try {
    const url = pathToFileURL(ENV_CHECK).href + '?scenario=' + (++scenarioCounter)
    await import(url)
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e
  } finally {
    console.log = savedLog
    process.exit = savedExit
    process.argv = savedArgv
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
  return { logs, exitCode }
}

/** 快速构造 mock fs：paths 数组（存在）、files 字典、dirs 字典（目录也算存在） */
function mockFs({ paths = [], files = {}, dirs = {}, envMirror, envBuilderMirror } = {}) {
  const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase()
  return {
    exists: new Set([...paths, ...Object.keys(dirs)].map(norm)),
    files: new Map(Object.entries(files).map(([k, v]) => [norm(k), v])),
    dirs: new Map(Object.entries(dirs).map(([k, v]) => [norm(k), v])),
    envMirror,
    envBuilderMirror,
  }
}

const H = 'C:/fake-home/.dsh' // DSH_HOME
const R = 'C:/fake-repo' // DSH_REPO

// =========================================================================
console.log('\n=== 测试 1: CLI 基本流程 — 未知检查项 → exit 1 ===')
{
  const { logs, exitCode } = await runScenario({ fs: mockFs(), args: ['nonexistent-check'] })
  assert(exitCode === 1, `未知检查项 exit 1 (got ${exitCode})`)
  assert(logs.some(l => l.includes('未知检查项')), '输出未知提示')
  assert(logs.some(l => l.includes('dep-consistency')), '列出可用检查项')
}

// =========================================================================
console.log('\n=== 测试 2: CLI all — 空 DSH_HOME（无 patch/plugins/skills/profiles） ===')
{
  const fs = mockFs({ paths: [], dirs: {} })
  const { logs, exitCode } = await runScenario({ fs, args: ['all'], dshHome: H, dshRepo: R })
  assert(exitCode === 1, `空环境下部分项失败 → exit 1 (got ${exitCode})`)
  assert(logs.some(l => l.includes('❌ [dep-consistency]')), 'dep-consistency 运行且失败（无 patch）')
  assert(logs.some(l => l.includes('❌ [native-binaries]')), 'native-binaries 失败（缺平台包）')
  assert(logs.some(l => l.includes('✅ [profile-plugin-resolve]')), 'profile-plugin-resolve 无 profiles ✅')
  assert(logs.some(l => l.includes('✅ [skills-valid]')), 'skills-valid 无目录 ✅')
  assert(logs.some(l => l.includes('2/9')), `汇总 2/9 (${logs.find(l => l.includes('/9'))})`)
}

// =========================================================================
console.log('\n=== 测试 3: dep-consistency 各分支 ===')
{
  // patch 不存在
  let r = await runScenario({ fs: mockFs(), args: ['dep-consistency'], dshHome: H })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('cordis.patch.yml 不存在')), 'patch 不存在 → ❌ 带证据')
  // patch 存在，无本地引用
  r = await runScenario({
    fs: mockFs({ paths: [join(H, 'cordis.patch.yml')], files: { [join(H, 'cordis.patch.yml')]: '- insert:\n  - id: a\n    name: \'@deepseek-ai/x\'\n' } }),
    args: ['dep-consistency'], dshHome: H,
  })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('全部存在')), '无本地引用 → ✅')
  // 引用存在
  r = await runScenario({
    fs: mockFs({
      paths: [join(H, 'cordis.patch.yml'), join(H, 'plugins', 'anti-stuck.mjs')],
      files: { [join(H, 'cordis.patch.yml')]: `- insert:\n  - id: a\n    name: 'file:///${H}/plugins/anti-stuck.mjs'\n` },
    }),
    args: ['dep-consistency'], dshHome: H,
  })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('1 个本地插件')), '引用存在 → ✅ 计数')
  // 引用缺失
  r = await runScenario({
    fs: mockFs({ paths: [join(H, 'cordis.patch.yml')], files: { [join(H, 'cordis.patch.yml')]: `- insert:\n  - id: a\n    name: 'file:///${H}/plugins/ghost.mjs'\n` } }),
    args: ['dep-consistency'], dshHome: H,
  })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('缺失 1 个')), '引用缺失 → ❌')
}

// =========================================================================
console.log('\n=== 测试 4: native-binaries 各分支 ===')
{
  const good = ['node_modules/@img/sharp-win32-x64', 'node_modules/@img/sharp-libvips-win32-x64', 'node_modules/@koromix/koffi-win32-x64', 'node_modules/@vscode/ripgrep-win32-x64']
  const p = (name) => join(R, 'apps/desktop', name)
  // 全存在（apps/desktop 下）
  let r = await runScenario({ fs: mockFs({ paths: good.map(p) }), args: ['native-binaries'], dshHome: H, dshRepo: R })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('齐备')), '平台包齐全 → ✅')
  // sharp 缺失
  r = await runScenario({ fs: mockFs({ paths: good.slice(2).map(p) }), args: ['native-binaries'], dshHome: H, dshRepo: R })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('缺失平台包: sharp')), 'sharp 缺失 → ❌')
  // staging 兜底存在（apps/desktop 无但 staging 有）
  r = await runScenario({ fs: mockFs({ paths: good.map(n => join(R, 'apps/desktop/staging', n)) }), args: ['native-binaries'], dshHome: H, dshRepo: R })
  assert(r.exitCode === 0, 'staging 兜底 → ✅')
  // 全缺
  r = await runScenario({ fs: mockFs({}), args: ['native-binaries'], dshHome: H, dshRepo: R })
  assert(r.logs.some(l => l.includes('缺失平台包: sharp, koffi, ripgrep')), '全缺 → 列 3 项')
}

// =========================================================================
console.log('\n=== 测试 5: collector-mode 各分支 ===')
{
  const rootPkg = join(R, 'package.json')
  const stagingPkg = join(R, 'apps/desktop/staging/package.json')
  // staging 声明 npm + 根 pnpm → 覆盖警告
  let r = await runScenario({
    fs: mockFs({
      paths: [rootPkg, stagingPkg],
      files: {
        [rootPkg]: JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
        [stagingPkg]: JSON.stringify({ packageManager: 'npm@10.0.0' }),
      },
    }),
    args: ['collector-mode'], dshHome: H, dshRepo: R,
  })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('会被覆盖')), 'staging npm + 根 pnpm → 覆盖警告 ✅')
  // staging 无 packageManager → ok:false
  r = await runScenario({
    fs: mockFs({ paths: [stagingPkg], files: { [stagingPkg]: JSON.stringify({}) } }),
    args: ['collector-mode'], dshHome: H, dshRepo: R,
  })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('staging 未声明')), 'staging 无声明 → ❌')
  // staging 不存在 → ❌
  r = await runScenario({ fs: mockFs({}), args: ['collector-mode'], dshHome: H, dshRepo: R })
  assert(r.exitCode === 1, 'staging 不存在 → ❌')
  // 根 package.json 解析失败
  r = await runScenario({
    fs: mockFs({
      paths: [rootPkg, stagingPkg],
      files: { [rootPkg]: '{broken json', [stagingPkg]: JSON.stringify({ packageManager: 'npm@10' }) },
    }),
    args: ['collector-mode'], dshHome: H, dshRepo: R,
  })
  assert(r.logs.some(l => l.includes('解析失败')), '根 package.json 解析失败 → evidence 标注')
  // 根无 packageManager 字段
  r = await runScenario({
    fs: mockFs({
      paths: [rootPkg, stagingPkg],
      files: { [rootPkg]: '{}', [stagingPkg]: JSON.stringify({ packageManager: 'npm@10' }) },
    }),
    args: ['collector-mode'], dshHome: H, dshRepo: R,
  })
  assert(r.logs.some(l => l.includes('无 packageManager 字段')), '根无 packageManager → evidence 标注')
  // staging JSON 解析失败 → catch ignore → stagingPm null → ❌
  r = await runScenario({
    fs: mockFs({
      paths: [rootPkg, stagingPkg],
      files: { [rootPkg]: JSON.stringify({ packageManager: 'pnpm@9' }), [stagingPkg]: '{broken' },
    }),
    args: ['collector-mode'], dshHome: H, dshRepo: R,
  })
  assert(r.exitCode === 1, 'staging 解析失败 → 视为未声明 → ❌')
}

// =========================================================================
console.log('\n=== 测试 6: profile-plugin-resolve 各分支 ===')
{
  const profiles = join(H, 'profiles')
  // profiles 不存在 → ✅ 无 profiles 目录
  let r = await runScenario({ fs: mockFs({}), args: ['profile-plugin-resolve'], dshHome: H })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('无 profiles 目录')), '无 profiles → ✅')
  // patch 不存在 → ❌
  r = await runScenario({ fs: mockFs({ dirs: { [profiles]: [] } }), args: ['profile-plugin-resolve'], dshHome: H })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('cordis.patch.yml 不存在')), 'patch 不存在 → ❌')
  // profiles 有子目录但无 node_modules → continue → ✅
  r = await runScenario({
    fs: mockFs({
      paths: [join(H, 'cordis.patch.yml')],
      dirs: { [profiles]: ['desktop', 'headless'] },
      files: { [join(H, 'cordis.patch.yml')]: `- insert:\n  - id: a\n    name: '@deepseek-ai/dsh-tool-x'\n` },
    }),
    args: ['profile-plugin-resolve'], dshHome: H,
  })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('可解析')), '无 node_modules 子目录 → ✅')
  // 有 node_modules 且包存在 → ✅
  const nm = join(profiles, 'desktop', 'node_modules')
  r = await runScenario({
    fs: mockFs({
      paths: [join(H, 'cordis.patch.yml'), join(nm, '@deepseek-ai/dsh-tool-x')],
      dirs: { [profiles]: ['desktop'], [nm]: ['@deepseek-ai'] },
      files: { [join(H, 'cordis.patch.yml')]: `- insert:\n  - id: a\n    name: '@deepseek-ai/dsh-tool-x'\n` },
    }),
    args: ['profile-plugin-resolve'], dshHome: H,
  })
  assert(r.exitCode === 0, '包可解析 → ✅')
  // 包缺失 → ❌
  r = await runScenario({
    fs: mockFs({
      paths: [join(H, 'cordis.patch.yml')],
      dirs: { [profiles]: ['desktop'], [nm]: ['@deepseek-ai'] },
      files: { [join(H, 'cordis.patch.yml')]: `- insert:\n  - id: a\n    name: '@deepseek-ai/dsh-tool-missing'\n` },
    }),
    args: ['profile-plugin-resolve'], dshHome: H,
  })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('解析失败')), '包缺失 → ❌')
}

// =========================================================================
console.log('\n=== 测试 7: network-mirror 各分支 ===')
{
  // 都设置
  let r = await runScenario({ fs: mockFs({ envMirror: 'https://mirror', envBuilderMirror: 'https://builder' }), args: ['network-mirror'] })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('ELECTRON_MIRROR=https://mirror')), '都设置 → ✅ 显示值')
  // 都缺
  r = await runScenario({ fs: mockFs({}), args: ['network-mirror'] })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('未设置: ELECTRON_MIRROR, ELECTRON_BUILDER_BINARIES_MIRROR')), '都缺 → ❌ 列 2 项')
  // 只缺 builder
  r = await runScenario({ fs: mockFs({ envMirror: 'x' }), args: ['network-mirror'] })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('未设置: ELECTRON_BUILDER_BINARIES_MIRROR')), '只缺 builder → ❌')
  // 只缺 electron
  r = await runScenario({ fs: mockFs({ envBuilderMirror: 'x' }), args: ['network-mirror'] })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('未设置: ELECTRON_MIRROR')), '只缺 electron → ❌')
}

// =========================================================================
console.log('\n=== 测试 8: pack-artifacts 各分支 ===')
{
  const win = join(R, 'apps/desktop/staging/release/win-unpacked')
  const asar = join(win, 'resources/app.asar')
  const exe = join(win, 'DeepSeek Harness Desktop.exe')
  // 全存在
  let r = await runScenario({
    fs: mockFs({ paths: [win, asar, exe], files: { [asar]: 'x'.repeat(2 * 1024 * 1024) } }),
    args: ['pack-artifacts'], dshHome: H, dshRepo: R,
  })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('2MB')), '全存在 → ✅ 显示大小')
  // 全缺
  r = await runScenario({ fs: mockFs({}), args: ['pack-artifacts'], dshHome: H, dshRepo: R })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('缺失: win-unpacked, app.asar, exe')), '全缺 → ❌')
  // win 存在 asar/exe 缺
  r = await runScenario({ fs: mockFs({ paths: [win] }), args: ['pack-artifacts'], dshHome: H, dshRepo: R })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('缺失: app.asar, exe')), '部分缺 → ❌')
}

// =========================================================================
console.log('\n=== 测试 9: plugin-syntax 各分支 ===')
{
  const dir = join(H, 'plugins')
  // 目录不存在
  let r = await runScenario({ fs: mockFs({}), args: ['plugin-syntax'], dshHome: H })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('插件目录不存在')), '目录不存在 → ❌')
  // 无 .mjs 文件
  r = await runScenario({ fs: mockFs({ dirs: { [dir]: ['readme.txt'] } }), args: ['plugin-syntax'], dshHome: H })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('0 个插件语法全部通过')), '无插件 → ✅')
  // 全部通过（execFileSync mock 非 __bad__ 返回 ok）
  r = await runScenario({ fs: mockFs({ dirs: { [dir]: ['a.mjs', 'b.mjs'] } }), args: ['plugin-syntax'], dshHome: H })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('2 个插件语法全部通过')), '全部通过 → ✅')
  // 有坏文件
  r = await runScenario({ fs: mockFs({ dirs: { [dir]: ['a.mjs', '__bad__b.mjs'] } }), args: ['plugin-syntax'], dshHome: H })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('语法错误: __bad__b.mjs')), '坏文件 → ❌')
}

// =========================================================================
console.log('\n=== 测试 10: board-consistency 各分支 ===')
{
  const patch = join(H, 'cordis.patch.yml')
  const board = join(H, 'discipline-board.cordis.yml')
  const toolsBoard = join(H, 'tools-board.cordis.yml')
  const plugin = join(H, 'plugins', 'hub.mjs')
  // patch 不存在 → 216 行 readFileSync 无保护 → check 抛异常 → ⚠️ 容错（源码真实行为）
  let r = await runScenario({ fs: mockFs({}), args: ['board-consistency'], dshHome: H })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('⚠️')), 'patch 不存在 → check 异常走 ⚠️ 容错')
  // patch 存在、无子板、引用齐全 → ✅
  r = await runScenario({
    fs: mockFs({
      paths: [patch, plugin],
      files: {
        [patch]: `- insert:\n  - id: discipline-hub\n    name: 'file:///${H}/plugins/hub.mjs'\n`,
      },
    }),
    args: ['board-consistency'], dshHome: H,
  })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('装配一致')), '基本一致 → ✅')
  // 子板引用缺失
  r = await runScenario({
    fs: mockFs({
      paths: [patch, board],
      files: {
        [patch]: `- insert:\n  - id: hub\n    name: 'file:///${H}/plugins/hub.mjs'\n`,
        [board]: `- id: anti-stuck\n  name: 'file:///${H}/plugins/ghost.mjs'\n`,
      },
    }),
    args: ['board-consistency'], dshHome: H,
  })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('引用缺失')), '子板引用缺失 → ❌')
  // 双加载（board id 与 patch id 重复）
  r = await runScenario({
    fs: mockFs({
      paths: [patch, board, plugin],
      files: {
        [patch]: `- insert:\n  - id: hub\n    name: 'file:///${H}/plugins/hub.mjs'\n`,
        [board]: `- id: hub\n  name: 'file:///${H}/plugins/hub.mjs'\n`,
      },
    }),
    args: ['board-consistency'], dshHome: H,
  })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('双加载: hub')), 'board 与 patch 双加载 → ❌')
  // 子板间重复
  r = await runScenario({
    fs: mockFs({
      paths: [patch, board, toolsBoard],
      files: {
        [patch]: `- insert:\n  - id: hub\n    name: 'file:///${H}/plugins/hub.mjs'\n`,
        [board]: `- id: dup-x\n  name: 'file:///${H}/plugins/a.mjs'\n`,
        [toolsBoard]: `- id: dup-x\n  name: 'file:///${H}/plugins/b.mjs'\n`,
      },
    }),
    args: ['board-consistency'], dshHome: H,
  })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('重复: dup-x')), '子板间重复 → ❌')
}

// =========================================================================
console.log('\n=== 测试 11: skills-valid 各分支 ===')
{
  const dir = join(H, 'skills')
  // 无目录
  let r = await runScenario({ fs: mockFs({}), args: ['skills-valid'], dshHome: H })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('无 skills 目录')), '无目录 → ✅')
  // 全部合规
  r = await runScenario({
    fs: mockFs({
      dirs: { [dir]: ['a.md'] },
      files: { [join(dir, 'a.md')]: '---\nname: a\ndescription: d\n---\nbody' },
    }),
    args: ['skills-valid'], dshHome: H,
  })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('1 个 skill frontmatter 全部合规')), '合规 → ✅')
  // 无 frontmatter
  r = await runScenario({
    fs: mockFs({ dirs: { [dir]: ['a.md'] }, files: { [join(dir, 'a.md')]: 'no frontmatter' } }),
    args: ['skills-valid'], dshHome: H,
  })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('无 frontmatter')), '无 frontmatter → ❌')
  // 缺 name
  r = await runScenario({
    fs: mockFs({
      dirs: { [dir]: ['a.md'] },
      files: { [join(dir, 'a.md')]: '---\ndescription: d\n---\nbody' },
    }),
    args: ['skills-valid'], dshHome: H,
  })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('缺 name')), '缺 name → ❌')
  // 缺 description
  r = await runScenario({
    fs: mockFs({
      dirs: { [dir]: ['a.md'] },
      files: { [join(dir, 'a.md')]: '---\nname: a\n---\nbody' },
    }),
    args: ['skills-valid'], dshHome: H,
  })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('缺 description')), '缺 description → ❌')
}

// =========================================================================
console.log('\n=== 测试 12: resolveRepo 分支 ===')
{
  // DSH_REPO 优先
  let r = await runScenario({ fs: mockFs({}), args: ['native-binaries'], dshHome: H, dshRepo: 'C:/custom-repo' })
  assert(r.logs.length > 0, 'DSH_REPO 生效（不崩溃）')
  // 无 DSH_REPO → 探测候选命中（home 下有 deepseek-harness-master/apps/desktop/package.json）
  r = await runScenario({
    fs: mockFs({ paths: [join('C:/fake-home/deepseek-harness-master/apps/desktop/package.json')] }),
    args: ['collector-mode'], dshHome: H, dshRepo: undefined, home: 'C:/fake-home',
  })
  assert(r.logs.some(l => l.includes('仓库根')), '探测候选命中（根 package.json 被读到）')
  // 候选全 miss → 回退第一候选（自然报错）
  r = await runScenario({ fs: mockFs({}), args: ['collector-mode'], dshHome: H, dshRepo: undefined, home: 'C:/fake-home' })
  assert(r.logs.some(l => l.includes('仓库根')), '候选全 miss 回退第一候选')
}

// =========================================================================
console.log('\n=== 测试 13: 多选 + 异常容错 ===')
{
  // 逗号分隔多选（合法+非法）
  const { logs, exitCode } = await runScenario({ fs: mockFs({}), args: ['dep-consistency,skills-valid,not-exist'], dshHome: H })
  assert(exitCode === 1, `多选 exit 1 (got ${exitCode})`)
  assert(logs.filter(l => l.includes('[dep-consistency]')).length === 1, 'dep-consistency 跑 1 次')
  assert(logs.filter(l => l.includes('[skills-valid]')).length === 1, 'skills-valid 跑 1 次')
  // check 抛异常 → ⚠️ 容错：构造 dep-consistency 的 readFileSync 抛错（patch exists 但 files 无内容）
  const r2 = await runScenario({
    fs: mockFs({ paths: [join(H, 'cordis.patch.yml')] }), // patch exists 但 files 里没有 → readFileSync 抛 ENOENT
    args: ['dep-consistency'], dshHome: H,
  })
  assert(r2.logs.some(l => l.includes('⚠️') && l.includes('检查执行异常')), 'check 异常 → ⚠️ 容错')
  assert(r2.exitCode === 1, `异常场景 exit 1 (got ${r2.exitCode})`)
}

// =========================================================================
console.log('\n=== 测试 14: DSH_HOME 未设置 → 走 os.homedir 兜底 ===')
{
  const patchPath = join('C:/fake-home/.dsh', 'cordis.patch.yml')
  const r = await runScenario({
    fs: mockFs({ paths: [patchPath], files: { [patchPath]: '- insert:\n  - id: a\n    name: \'@deepseek-ai/x\'\n' } }),
    args: ['dep-consistency'], dshHome: undefined, home: 'C:/fake-home',
  })
  assert(r.exitCode === 0 && r.logs.some(l => l.includes('全部存在')), 'DSH_HOME 未设时用 homedir 兜底 → ✅')
}

// =========================================================================
console.log('\n=== 测试 15: frontmatter split 空段 → || \'\' 兜底 ===')
{
  const dir = join(H, 'skills')
  const r = await runScenario({
    fs: mockFs({ dirs: { [dir]: ['a.md'] }, files: { [join(dir, 'a.md')]: '---' } }),
    args: ['skills-valid'], dshHome: H,
  })
  assert(r.exitCode === 1 && r.logs.some(l => l.includes('缺 name')), '空 frontmatter 段 → 兜底判缺 name')
}

// =========================================================================
console.log('\n=== 测试 16: 无 CLI 参数 → 默认 all ===')
{
  const r = await runScenario({ fs: mockFs({}), args: [], dshHome: H, dshRepo: R })
  assert(r.logs.some(l => l.includes('[dep-consistency]')) && r.logs.some(l => l.includes('[skills-valid]')), '无参数跑全部检查')
  assert(r.logs.some(l => l.includes('/9')), `汇总 /9 (${r.logs.find(l => l.includes('/9'))})`)
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
