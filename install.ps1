<#
  install.ps1 — cleverer-dsh 一键安装到 DSH
  用法：pwsh -File install.ps1 [-DryRun] [-DSHHome <路径>]
  - DryRun: 只预览要做的操作，不实际执行
  步骤：
    1. 检测 DSH 环境（~/.dsh 存在性、cordis.patch.yml 现状）
    2. 备份现有 cordis.patch.yml（时间戳后缀）
    3. 复制 plugins/*.mjs → <DSHHome>/plugins/
    4. 复制 skills/*.md → <DSHHome>/skills/（跳过同内容文件）
    5. 生成两个子板（boards/*.cordis.yml 模板 → <DSHHome>/，路径替换为本机）
    6. 合并 cordis.patch.yml：加 include 行（幂等：已有 id 不重复加）
    7. 报告 PASS/FAIL
#>
param(
    [switch]$DryRun,
    [string]$DSHHome = ""
)

$ErrorActionPreference = 'Stop'
# install.ps1 位于项目根目录 → PSScriptRoot 即项目根（与 deploy 不同：deploy 在 scripts/ 下）
$projRoot  = $PSScriptRoot
if (-not $DSHHome) { $DSHHome = Join-Path $env:USERPROFILE '.dsh' }
$pluginDir = Join-Path $DSHHome 'plugins'
$skillDir  = Join-Path $DSHHome 'skills'
$patchFile = Join-Path $DSHHome 'cordis.patch.yml'
$boardDir  = Join-Path $projRoot 'boards'

function Step($msg) { Write-Host "`n== $msg ==" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  ✅ $msg" }
function Warn($msg) { Write-Host "  ⚠️  $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  ❌ $msg" -ForegroundColor Red }

$failCount = 0

# ── 0. 前置检查 ────────────────────────────────────────────────────────
Step "0. 环境检测"
if (-not (Test-Path $DSHHome)) {
    Warn "DSH home 不存在: $DSHHome —— 将自动创建（若 DSH 未安装，后续需手动把插件挂进其配置）"
    if (-not $DryRun) { New-Item $DSHHome -ItemType Directory -Force | Out-Null }
}
Ok "DSH home: $DSHHome"
$patchExists = Test-Path $patchFile
if ($patchExists) { Warn "cordis.patch.yml 已存在——将备份后合并（保留你现有的官方包行）" }
else { Warn "cordis.patch.yml 不存在——将新建（仅含 cleverer-dsh 的 include 行）" }

# ── 1. 备份 ────────────────────────────────────────────────────────────
Step "1. 备份"
if ($patchExists -and -not $DryRun) {
    $bak = "$patchFile.bak-cleverer-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $patchFile $bak
    Ok "已备份到 $bak"
} elseif ($patchExists) {
    Warn "[DryRun] 将备份 cordis.patch.yml"
}

# ── 2. 复制插件 ────────────────────────────────────────────────────────
Step "2. 安装插件 (12 个文件: 11 插件 + _shared.mjs 公共模块)"
New-Item $pluginDir -ItemType Directory -Force | Out-Null
$pluginCount = 0
foreach ($f in (Get-ChildItem (Join-Path $projRoot 'plugins') -Filter '*.mjs')) {
    if ($DryRun) { Warn "[DryRun] 将安装 $($f.Name)" }
    else { Copy-Item $f.FullName (Join-Path $pluginDir $f.Name) -Force; $pluginCount++ }
}
if ($DryRun) { Warn "[DryRun] 预览 12 个文件（_shared.mjs 是相对导入依赖，必须随插件全量复制）" } else { Ok "安装 $pluginCount 个文件" }

# ── 2.5 复制 env-check 脚本（env_check 工具的单一事实源）─────────────
Step "2.5 安装 env-check 脚本"
$scriptDir = Join-Path $DSHHome 'scripts'
$envCheckSrc = Join-Path $projRoot 'scripts\dsh-env-check.mjs'
if (-not (Test-Path $envCheckSrc)) { Fail "env-check 脚本缺失: $envCheckSrc"; $failCount++ }
else {
    if ($DryRun) { Warn "[DryRun] 将安装 scripts/dsh-env-check.mjs（env_check 工具依赖，必装）" }
    else {
        New-Item $scriptDir -ItemType Directory -Force | Out-Null
        Copy-Item $envCheckSrc (Join-Path $scriptDir 'dsh-env-check.mjs') -Force
        Ok "已安装 $scriptDir\dsh-env-check.mjs"
    }
}

# ── 3. 复制 skills ─────────────────────────────────────────────────────
$skillFiles = @(Get-ChildItem (Join-Path $projRoot 'skills') -Filter '*.md')
Step "3. 安装 skills ($($skillFiles.Count) 个)"
New-Item $skillDir -ItemType Directory -Force | Out-Null
$skillCount = 0
foreach ($f in $skillFiles) {
    $target = Join-Path $skillDir $f.Name
    $skip = $false
    if ((Test-Path $target) -and -not $DryRun) {
        # 内容相同则跳过（保留用户可能的手改）
        $h1 = (Get-FileHash $f.FullName).Hash; $h2 = (Get-FileHash $target).Hash
        if ($h1 -eq $h2) { $skip = $true }
    }
    if ($DryRun) { Warn "[DryRun] 将安装 $($f.Name)" }
    elseif ($skip) { Warn "跳过 $($f.Name)（内容相同）" }
    else { Copy-Item $f.FullName $target -Force; $skillCount++ }
}
if ($DryRun) { Warn "[DryRun] 预览 $($skillFiles.Count) 个 skills" } else { Ok "安装 $skillCount 个 skills（跳过相同 $($skillFiles.Count - $skillCount) 个）" }

# ── 4. 生成子板（替换 file:// 路径为本机）────────────────────────────
Step "4. 生成子板"
foreach ($board in @('discipline-board.cordis.yml', 'tools-board.cordis.yml')) {
    $src = Join-Path $boardDir $board
    if (-not (Test-Path $src)) { Fail "模板缺失: $src"; $failCount++; continue }
    $content = Get-Content $src -Raw
    # 模板占位符 {{DSH_HOME}} → 本机路径（纯正斜杠；模板内 file:/// 前缀保留在模板侧）
    $plainHome = $DSHHome -replace '\\', '/'
    $content = $content -replace '\{\{DSH_HOME\}\}', $plainHome
    if ($DryRun) { Warn "[DryRun] 将生成 $board（含本机路径 $plainHome）" }
    else { Set-Content (Join-Path $DSHHome $board) $content -Encoding UTF8; Ok "生成 $board" }
}

# ── 5. 合并 cordis.patch.yml ──────────────────────────────────────────
Step "5. 合并 cordis.patch.yml（幂等）"
if (-not $DryRun) {
    $newPatch = $null
    if ($patchExists) { $newPatch = Get-Content $patchFile -Raw } else { $newPatch = '' }

    # 已存在的 include id 集合（防重复加）。只统计顶层 insert 列表里的 - id:
    # （排除注释行：`# - id:` 前缀是井号）
    $existingIds = [regex]::Matches($newPatch, '(?m)^\s*- id:\s*([\w-]+)') | ForEach-Object { $_.Groups[1].Value }
    $boardFileUrl = 'file:///' + (($DSHHome -replace '\\', '/') + '/')

    $inserts = @()
    if ('discipline-hub' -notin $existingIds) {
        $inserts += "    # discipline-hub 协作中枢（必须最先加载）`n    - id: discipline-hub`n      name: '${boardFileUrl}plugins/discipline-hub.mjs'`n"
    }
    if ('discipline-board' -notin $existingIds) {
        $inserts += "    # 纪律插件子板（8 个）`n    - id: discipline-board`n      name: 'cordis:include'`n      config:`n        path: '${boardFileUrl}discipline-board.cordis.yml'`n        enableLogs: true`n"
    }
    if ('tools-board' -notin $existingIds) {
        $inserts += "    # 功能层子板（fast_locate / env_check）`n    - id: tools-board`n      name: 'cordis:include'`n      config:`n        path: '${boardFileUrl}tools-board.cordis.yml'`n        enableLogs: true`n"
    }

    if ($inserts.Count -eq 0) {
        Ok "patch 已含全部 cleverer-dsh 挂载（幂等跳过）"
    } else {
        # 找第一个 - insert: 块（多行模式，patch 顶部可能有注释），把条目插到该块列表头部
        $m = [regex]::Match($newPatch, '(?m)^\s*-\s*insert:\s*\r?\n')
        if ($m.Success) {
            $pos = $m.Index + $m.Length
            $newPatch = $newPatch.Substring(0, $pos) + ($inserts -join '') + $newPatch.Substring($pos)
        } else {
            # 无 insert 块：新建
            $newPatch = "- insert:`n" + ($inserts -join '') + "`n" + $newPatch
        }
        Set-Content $patchFile $newPatch -Encoding UTF8
        Ok "已合并 $($inserts.Count) 个挂载项到 cordis.patch.yml"
    }
} else {
    Warn "[DryRun] 将合并 discipline-hub / discipline-board / tools-board 挂载"
}

# ── 6. 验证 ────────────────────────────────────────────────────────────
Step "6. 验证"
if (-not $DryRun) {
    # 插件语法
    $synErr = 0
    foreach ($f in (Get-ChildItem $pluginDir -Filter '*.mjs')) {
        node --check $f.FullName 2>$null
        if ($LASTEXITCODE -ne 0) { Fail "语法错误: $($f.Name)"; $synErr++ }
    }
    if ($synErr -eq 0) { Ok "插件语法全部通过" }
    # YAML 合法性（若 python+yaml 可用）：patch + 两个生成的子板
    try {
        $py = "import yaml, sys`nok = True`nfor f in [r'$DSHHome\cordis.patch.yml', r'$DSHHome\discipline-board.cordis.yml', r'$DSHHome\tools-board.cordis.yml']:`n    try:`n        yaml.safe_load(open(f, encoding='utf-8'))`n    except Exception as e:`n        ok = False`n        print('FAIL', f, e)`nprint('OK' if ok else 'BAD')"
        $r = python -c $py 2>&1
        if ($r -match 'OK') { Ok "patch + 2 个子板 YAML 合法" }
        else { Fail "YAML 解析失败: $($r -join ' ')" }
    } catch { Warn "跳过 YAML 校验（python/yaml 不可用）" }
}

Write-Host "`n========================================" -ForegroundColor Cyan
if ($DryRun) {
    Write-Host "DryRun 完成——以上为将执行的操作，无实际改动" -ForegroundColor Yellow
} elseif ($failCount -eq 0) {
    Write-Host "🎉 安装完成！重启 DSH（或运行 scripts/dsh-deploy.ps1 -ConfirmRestart）后生效" -ForegroundColor Green
} else {
    Write-Host "⚠️ 有 $failCount 项失败，请按 ❌ 排查" -ForegroundColor Red
    exit 1
}
