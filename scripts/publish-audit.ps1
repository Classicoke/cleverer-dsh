<#
  publish-audit.ps1 — 发布前个人信息审计（铁律的机器执行）
  铁律：GitHub 发布绝不携带真实个人信息（姓名/拼音邮箱/本机路径/ID/生日/单位）。
  用法：pwsh -File scripts/publish-audit.ps1 [-Fix]
  - Fix: 自动把命中的问题文件改中性（git 历史需手动 filter-branch，本脚本只报不自动改写）
  扫描：仓库工作区文件 + git 历史作者/提交者 + 远程配置

  个人特征库：位于 scripts/audit-signatures.local.ps1（gitignored，不入库）——
  发布仓库本身不含任何个人特征，审计能力由本机本地文件提供。
#>
param([switch]$Fix)
$ErrorActionPreference = 'Stop'
$projRoot = Split-Path $PSScriptRoot -Parent
Set-Location $projRoot

# ⚠️ 通用特征（不含任何个人标识，可安全入库）
# 注意：'deepseek-harness-master' 是 DSH 官方仓库名（非个人信息），deploy/env-check
# 需用它探测 checkout 位置，故不在特征库内。
$patterns = @(
    'C:[/\\]Users[/\\][^\s]+',              # Windows 用户目录路径（正斜杠/反斜杠）
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'  # 邮箱（发布版应只用 noreply 匿名邮箱）
)
# noreply.github.com 是 GitHub 官方匿名邮箱机制，不算个人信息——匹配后豁免
function Is-AnonymousEmail($addr) {
    return $addr -match '@(users\.)?noreply\.github\.com$'
}

# ── 本地个人特征库（可选，gitignored）：每行一个正则 ─────────────────
$sigFile = Join-Path $PSScriptRoot 'audit-signatures.local.ps1'
if (Test-Path $sigFile) {
    $localPatterns = @()
    Get-Content $sigFile | Where-Object { $_ -and -not $_.StartsWith('#') } | ForEach-Object { $localPatterns += $_.Trim() }
    if ($localPatterns.Count -gt 0) {
        Write-Host "  ℹ️ 加载本地个人特征库: $sigFile（$($localPatterns.Count) 条）" -ForegroundColor DarkGray
        $patterns += $localPatterns
    }
} else {
    Write-Host "  ℹ️ 未找到本地特征库 $sigFile——仅扫描通用模式（真名/ID/生日等需自行维护该文件）" -ForegroundColor DarkGray
}
$exclude = @('scripts\publish-audit.ps1')    # 审计脚本自身含特征库，豁免

$issues = @()
# ── 1. 工作区文件扫描 ─────────────────────────────────────────────────
Write-Host "== 1. 工作区文件扫描 ==" -ForegroundColor Cyan
$files = Get-ChildItem . -Recurse -File | Where-Object { $_.FullName -notmatch '\.git' }
foreach ($f in $files) {
    $rel = $f.FullName.Replace("$projRoot\", '')
    if ($rel -in $exclude) { continue }    # 豁免审计脚本自身
    $content = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $content) { continue }
    foreach ($p in $patterns) {
        $m = [regex]::Matches($content, $p)
        foreach ($match in $m) {
            # 邮箱模式命中 noreply 匿名邮箱 → 豁免（GitHub 官方匿名机制）
            if ($p -match '@\[A-Za-z' -and (Is-AnonymousEmail $match.Value)) { continue }
            $issues += [pscustomobject]@{ 文件 = $rel; 特征 = $p; 示例 = $match.Value }
        }
    }
}
if ($issues.Count -eq 0) { Write-Host "  ✅ 工作区无个人信息" -ForegroundColor Green }

# ── 2. git 历史作者/提交者 ────────────────────────────────────────────
Write-Host "`n== 2. git 历史作者 ==" -ForegroundColor Cyan
$authors = git log --format="%an <%ae>" | Sort-Object -Unique
# 匿名判定：作者邮箱必须是 noreply.github.com（GitHub 官方匿名机制）；
# 任何真实邮箱（gmail/qq/163/公司域等）都视为泄露风险
$badAuthor = $authors | Where-Object { $_ -notmatch '@(users\.)?noreply\.github\.com>' }
if ($badAuthor) { $issues += $badAuthor | ForEach-Object { [pscustomobject]@{ 文件 = 'git历史'; 特征 = '非匿名邮箱作者'; 示例 = $_ } } }
elseif ($authors.Count -eq 0) { Write-Host "  ⚠️ 无提交记录" -ForegroundColor Yellow }
else { Write-Host "  ✅ git 历史作者匿名（$($authors.Count) 个唯一作者，全部 noreply 邮箱）" -ForegroundColor Green }

# ── 3. git remote（推送目标）──────────────────────────────────────────
Write-Host "`n== 3. git remote ==" -ForegroundColor Cyan
$remote = git remote -v
if ($remote) { $remote | ForEach-Object { Write-Host "  ⚠️ 已配置 remote: $_" -ForegroundColor Yellow } }
else { Write-Host "  ✅ 无 remote（尚未推送）" -ForegroundColor Green }

# ── 汇总 ──────────────────────────────────────────────────────────────
Write-Host "`n==========================================" -ForegroundColor Cyan
if ($issues.Count -eq 0) {
    Write-Host "🎉 审计通过 — 可安全发布" -ForegroundColor Green
    exit 0
} else {
    Write-Host "🚫 审计发现 $($issues.Count) 处个人信息（发布前必须清零）:" -ForegroundColor Red
    $issues | Format-Table -AutoSize
    if ($Fix) {
        Write-Host "  ℹ️ 文件内问题请手动改为中性（'cleverer-dsh contributors'）；git 历史用 filter-branch 改写（参考 README 发布节）"
    }
    exit 1
}
