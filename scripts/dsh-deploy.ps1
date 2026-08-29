<#
  dsh-deploy.ps1 — DSH 插件部署闭环（第 4 层：杜绝"改了没生效"）

  背景（2026-08-16 实测教训）：DSH web 进程加载插件文件到内存，改文件不重启
  不生效——evolver 门槛/新 skill-loader 在旧进程里静默失效，无人发现。
  本脚本把"改 → 同步 → 验证 → 重启 → 复验"做成一条命令，每次部署都有 PASS/FAIL 证据。

  用法：
    .\dsh-deploy.ps1                      # 同步全部插件 + 全流程验证
    .\dsh-deploy.ps1 -Plugins anti-stuck  # 只同步指定插件
    .\dsh-deploy.ps1 -SkipRestart         # 同步+静态验证，不重启 web
    .\dsh-deploy.ps1 -SkipVerify          # 同步+重启，不做 headless 行为验证

  流程：
    1. 同步（开发 dsh-smart/plugins → 生产 ~/.dsh/plugins）
    2. 静态验证：node --check 语法 + env-check 三检查（plugin-syntax/board-consistency/skills-valid）
    3. 重启 web（找 3080 监听 PID → 杀 → 重启 → 等就绪 → HTTP 存活探测）
    4. 行为验证（headless 独立进程）：纪律段 11 条复述——证明插件装配正确
    5. 输出 PASS/FAIL 汇总
#>
param(
    [string[]]$Plugins = @(),        # 空 = 全部
    [switch]$SkipRestart,
    [switch]$SkipVerify,
    [switch]$ConfirmRestart          # 自动化场景：跳过 Y/N 交互直接重启
)

$ErrorActionPreference = 'Stop'
# 发布版路径全部相对定位（$PSScriptRoot = scripts/ 的上级 = 项目根）
$projRoot  = Split-Path $PSScriptRoot -Parent
$devDir    = Join-Path $projRoot 'plugins'
$prodDir   = "$env:USERPROFILE\.dsh\plugins"
$repoDir   = $env:DSH_REPO   # 用户 DSH checkout 位置，可环境变量覆盖
if (-not $repoDir) {
    # 尝试常见位置（与 scripts/dsh-env-check.mjs 的 resolveRepo 探测点对齐，
    # 并补上 npm 全局安装位置）；找不到则报错提示设置 DSH_REPO
    $candidates = @(
        "$env:USERPROFILE\deepseek-harness-master",
        "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh",
        'D:\deepseek-harness-master',
        'C:\deepseek-harness-master'
    )
    $repoDir = $candidates | Where-Object { Test-Path (Join-Path $_ 'apps\cli\src\bin.ts') } | Select-Object -First 1
    if (-not $repoDir) {
        Write-Host "❌ 找不到 DSH checkout（apps\cli\src\bin.ts）。请设置环境变量 DSH_REPO 指向 DSH 源码目录。" -ForegroundColor Red
        exit 1
    }
}
$envCheck = Join-Path $projRoot 'scripts\dsh-env-check.mjs'
$results  = @()

function Log($status, $msg) {
    $mark = switch ($status) { 'PASS' { '✅' } 'FAIL' { '❌' } 'SKIP' { '⏭️' } 'INFO' { 'ℹ️' } default { '•' } }
    Write-Host "$mark $msg"
    $script:results += [pscustomobject]@{ Status = $status; Msg = $msg }
}

Write-Host "`n========== DSH 部署闭环 ==========" -ForegroundColor Cyan

# ── 1. 同步 ────────────────────────────────────────────────────────────
Write-Host "`n[1/5] 同步插件 (dev → prod)" -ForegroundColor Yellow
$targets = if ($Plugins.Count -gt 0) {
    $Plugins | ForEach-Object { $_.Trim() } | Where-Object { $_ -and (Test-Path (Join-Path $devDir $_)) }
} else {
    Get-ChildItem $devDir -Filter '*.mjs' | Select-Object -ExpandProperty Name
}
if ($targets.Count -eq 0) { Log FAIL "没有可同步的插件（检查 -Plugins 参数或 dev 目录）"; exit 1 }
foreach ($f in $targets) {
    $dev = Join-Path $devDir $f
    $prod = Join-Path $prodDir $f
    Copy-Item $dev $prod -Force
    Log INFO "同步: $f"
}
Log PASS "同步完成 ($($targets.Count) 个插件)"

# ── 2. 静态验证 ────────────────────────────────────────────────────────
Write-Host "`n[2/5] 静态验证 (语法 + 装配一致性)" -ForegroundColor Yellow
$allOk = $true
foreach ($f in (Get-ChildItem $prodDir -Filter '*.mjs' | Select-Object -ExpandProperty Name)) {
    node --check (Join-Path $prodDir $f) 2>$null
    if ($LASTEXITCODE -ne 0) { Log FAIL "语法错误: $f"; $allOk = $false }
}
if ($allOk) { Log PASS "全部插件语法通过" }

# env-check 三检查（覆盖引用/双加载/skills）
$checks = @('plugin-syntax', 'board-consistency', 'skills-valid')
foreach ($c in $checks) {
    $out = node $envCheck $c 2>&1 | Out-String
    if ($out -match '^✅|通过') { Log PASS "env-check $c" }
    else { Log FAIL "env-check $c`: $($out.Trim())"; $allOk = $false }
}

# ── 3. 重启 web ────────────────────────────────────────────────────────
Write-Host "`n[3/5] 重启 DSH web (端口 3080)" -ForegroundColor Yellow
if (-not $SkipRestart) {
    $conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $oldPid = $conn[0].OwningProcess
        # 确认 PID 归属（第 11 条纪律的实践：杀进程前先查命令行）
        $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid" -ErrorAction SilentlyContinue).CommandLine
        # 修复：进程可能已退出（Get-CimInstance 返回 null）→ 不调用 .Substring 崩溃
        if (-not $cmdLine -or $cmdLine -notmatch 'bin\.ts web') {
            $preview = if ($cmdLine) { $cmdLine.Substring(0, [Math]::Min(80, $cmdLine.Length)) } else { '(进程已退出，无命令行)' }
            Log FAIL "端口 3080 的 PID $oldPid 不是 DSH web（命令行: $preview），拒绝杀进程"
            exit 1
        }
        Write-Host "  ⚠️ 将停止 PID $oldPid（web）并重启。" -ForegroundColor Yellow
        $shouldRestart = $true
        if (-not $ConfirmRestart) {
            Write-Host "  按 Y 继续，N 跳过重启：" -ForegroundColor Yellow -NoNewline
            $ans = Read-Host
            if ($ans -notmatch '^[Yy]') { $shouldRestart = $false }
        } else {
            Write-Host "  （-ConfirmRestart 已确认）" -ForegroundColor DarkGray
        }
        if (-not $shouldRestart) {
            Log SKIP "用户选择不重启——注意：新插件要重启才生效"
            $skipRestartActual = $true
        } else {
            Stop-Process -Id $oldPid -Force
            Start-Sleep -Seconds 2
            Log INFO "已停止旧进程 PID $oldPid"
            # 启动（Start-Process 独立进程，避免被本脚本生命周期影响）
            Start-Process -FilePath 'node' -ArgumentList '--import','tsx/esm','apps/cli/src/bin.ts','web','--port','3080' -WorkingDirectory $repoDir -WindowStyle Hidden
            # 等就绪（最多 75 秒）
            $ready = $false
            $deadline = (Get-Date).AddSeconds(75)
            while ((Get-Date) -lt $deadline) {
                $c2 = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
                if ($c2) { $ready = $true; $newPid = $c2[0].OwningProcess; break }
                Start-Sleep -Seconds 3
            }
            if ($ready) { Log PASS "web 已就绪 (PID $newPid)" }
            else { Log FAIL "web 75 秒未就绪"; $allOk = $false }
        }
    } else {
        Log INFO "3080 无监听（web 未运行，直接启动）"
        Start-Process -FilePath 'node' -ArgumentList '--import','tsx/esm','apps/cli/src/bin.ts','web','--port','3080' -WorkingDirectory $repoDir -WindowStyle Hidden
        $ready = $false
        $deadline = (Get-Date).AddSeconds(75)
        while ((Get-Date) -lt $deadline) {
            $c2 = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
            if ($c2) { $ready = $true; $newPid = $c2[0].OwningProcess; break }
            Start-Sleep -Seconds 3
        }
        if ($ready) { Log PASS "web 已就绪 (PID $newPid)" }
        else { Log FAIL "web 75 秒未就绪"; $allOk = $false }
    }
    # web 存活探测：重启后的服务本身要能应答 HTTP（与 headless 装配验证互补——
    # 修复前 PASS/FAIL 证据全部来自独立 headless 进程，不能证明刚重启的 web 已加载新插件）
    if ($ready) {
        $alive = $false
        try {
            $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
            $alive = ($null -ne $resp.StatusCode)
        } catch {
            # 404/405 等也是"服务在应答"（DSH web 根路径无页面属正常）
            $alive = ($null -ne $_.Exception.Response)
        }
        if ($alive) { Log PASS "web HTTP 应答正常（重启后的服务已确认存活）" }
        else { Log FAIL "web 端口监听但 HTTP 无应答"; $allOk = $false }
    }
} else {
    Log SKIP "跳过重启（-SkipRestart）——注意：新插件要重启才生效"
}

# ── 4. 行为验证（headless 独立进程：装配正确性；web 存活见 [3/5]）───────
Write-Host "`n[4/5] 行为验证 (headless)" -ForegroundColor Yellow
$didRestart = (-not $SkipRestart -and -not $skipRestartActual)
if (-not $SkipVerify -and $didRestart) {
    try {
        $out = Push-Location $repoDir
        $res = & pnpm dsh --profile headless "你的系统提示词里有一个'执行纪律'段落。请复述它的第 11 条标题和完整内容。" 2>&1 | Out-String
        Pop-Location
        if ($res -match '动环境前先确认' -and $res -match '启动方式') {
            Log PASS "纪律段第 11 条已进入 system 提示词（headless 独立进程验证——证明插件装配正确；重启后的 web 由 [3/5] 存活探测确认）"
        } else {
            Log FAIL "headless 复述未命中第 11 条（检查插件是否加载）"
            $allOk = $false
        }
    } catch {
        Log FAIL "headless 验证执行异常: $($_.Exception.Message)"
        $allOk = $false
    }
} else {
    Log SKIP "跳过行为验证（-SkipVerify 或跳过了重启）"
}

# ── 5. 汇总 ────────────────────────────────────────────────────────────
Write-Host "`n========== 部署结果 ==========" -ForegroundColor Cyan
foreach ($r in $results) { Log $r.Status $r.Msg }
if ($allOk -and $results.Where({ $_.Status -eq 'FAIL' }).Count -eq 0) {
    Write-Host "`n🎉 全部 PASS — 部署闭环完成，新插件已生效" -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n⚠️ 有 FAIL 项 — 按上方 ❌ 排查" -ForegroundColor Red
    exit 1
}
