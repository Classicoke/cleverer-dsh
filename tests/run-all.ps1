<#
  run-all.ps1 — 运行全部单测（v1.2）
  用法：pwsh -File tests/run-all.ps1
  判定以每个测试文件的退出码为准（node 测试在断言失败时 exit 1）；
  汇总数从输出行解析，仅用于展示——不再以解析文本代替退出码判定。
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
    if ($LASTEXITCODE -ne 0) {
        $fail++
        Write-Host "  ❌ $($t.Name) 非零退出（exit $LASTEXITCODE）" -ForegroundColor Red
        continue
    }
    # 退出码为 0：解析汇总数（仅统计展示；解析失败不影响判定）
    $last = ($out | Select-Object -Last 1) -join ''
    if ($last -match '(\d+) 通过.*?(\d+) 失败') {
        $total += [int]$Matches[1]; $fail += [int]$Matches[2]
    } elseif ($last -match '(\d+) passed.*?(\d+) failed') {
        $total += [int]$Matches[1]; $fail += [int]$Matches[2]
    } else {
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
