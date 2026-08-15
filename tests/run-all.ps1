<#
  run-all.ps1 — 运行全部单测（426 项，v1.2）
  用法：pwsh -File tests/run-all.ps1
#>
$ErrorActionPreference = 'Stop'
$testDir = Split-Path $PSScriptRoot -Parent
Set-Location $testDir

$tests = Get-ChildItem "$testDir\tests\test-*.mjs" | Sort-Object Name
$total = 0; $fail = 0

foreach ($t in $tests) {
    Write-Host "`n=== $($t.Name) ===" -ForegroundColor Cyan
    $out = node $t.FullName 2>&1
    $out | Write-Host
    $last = ($out | Select-Object -Last 1) -join ''
    if ($last -match '(\d+) 通过.*?(\d+) 失败') {
        $total += [int]$Matches[1]; $fail += [int]$Matches[2]
    } elseif ($last -match '(\d+) passed.*?(\d+) failed') {
        $total += [int]$Matches[1]; $fail += [int]$Matches[2]
    } elseif ($LASTEXITCODE -ne 0) {
        $fail++
        Write-Host "  ❌ $($t.Name) 非零退出" -ForegroundColor Red
    } else {
        # 尝试从输出末尾解析
        $m = $out | Select-String -Pattern '(\d+) 通过, (\d+) 失败|(\d+) passed, (\d+) failed' | Select-Object -Last 1
        if ($m) {
            $nums = $m.Matches[0].Groups | Where-Object { $_.Index -gt 0 } | ForEach-Object { [int]$_.Value }
            $total += $nums[0]; $fail += $nums[1]
        }
    }
}

Write-Host "`n==========================================" -ForegroundColor Cyan
Write-Host "合计: $total 通过, $fail 失败" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
exit $(if ($fail -eq 0) { 0 } else { 1 })
