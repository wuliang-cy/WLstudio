# 反向验证：确认 gate 的五道闸都能拦住，不会退化成永远通过。
#
# 每个用例故意破坏一处，断言 gate 返回非零。最后一个用例保持原样，断言返回 0。

param(
    [string] $Gate = 'E:\AIoutput\WLstudio\script\asset-gate.ps1',
    [string] $Source = 'E:\AIoutput\WLstudio\packages\desktop\dist\win-unpacked'
)

$ErrorActionPreference = 'Stop'
$tmp = 'C:\Users\Administrator\AppData\Local\Temp\opencode\gate-negtest2'

function Run-Gate([string] $root) {
    $out = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Gate -Root $root 2>&1
    return @{ Code = $LASTEXITCODE; Output = ($out -join "`n") }
}

function Prep([string] $name) {
    $dest = Join-Path $tmp $name
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    $from = Join-Path $Source 'resources\seed'
    $to = Join-Path $dest 'resources\seed'
    if (Test-Path $from) {
        New-Item -ItemType Directory -Path (Split-Path $to -Parent) -Force | Out-Null
        robocopy.exe $from $to /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    }
    return $dest
}

$cases = @()

# A: 经验树出现真实条目
$r = Prep 'A-entry'
Set-Content (Join-Path $r 'resources\seed\ex-bags\CTF\CTF-001-真实经验.md') '# real entry' -Encoding UTF8
$cases += @{ Name = 'A 经验树出现真实条目'; Expect = 'FAIL'; R = (Run-Gate $r) }

# B: 额外偏好含本机路径
$r = Prep 'B-prefs'
Add-Content (Join-Path $r 'resources\seed\prefs\SE-AGENTS.md') "`n- 参考：C:\Users\Administrator\AppData" -Encoding UTF8
$cases += @{ Name = 'B 额外偏好含本机路径'; Expect = 'FAIL'; R = (Run-Gate $r) }

# C: 额外偏好被换成真实大文件
$r = Prep 'C-oversize'
$big = ('# real prefs' + "`n") * 3000
[IO.File]::WriteAllText((Join-Path $r 'resources\seed\prefs\SE-AGENTS.md'), $big, (New-Object Text.UTF8Encoding($false)))
$cases += @{ Name = 'C 额外偏好是真实大文件'; Expect = 'FAIL'; R = (Run-Gate $r) }

# D: 包内带数据库
$r = Prep 'D-db'
[IO.File]::WriteAllBytes((Join-Path $r 'wlstudio.db'), [byte[]](1..64))
$cases += @{ Name = 'D 包里带了数据库'; Expect = 'FAIL'; R = (Run-Gate $r) }

# E: 模板被改动但与基线不一致（关键：这一条正是之前漏掉的场景）
$r = Prep 'E-drift'
Add-Content (Join-Path $r 'resources\seed\prefs\AGENTS.md') "`n## 临时改动`n- 这一行不在基线里`n" -Encoding UTF8
$cases += @{ Name = 'E 模板偏离基线（内容本身无害）'; Expect = 'FAIL'; R = (Run-Gate $r) }

# F: 模板多出一个基线没有的文件
$r = Prep 'F-extra'
Set-Content (Join-Path $r 'resources\seed\prefs\EXTRA.md') '# not in baseline' -Encoding UTF8
$cases += @{ Name = 'F 模板多出基线外的文件'; Expect = 'FAIL'; R = (Run-Gate $r) }

# G: 对照，未改动应通过
$r = Prep 'G-control'
$cases += @{ Name = 'G 对照：未改动'; Expect = 'PASS'; R = (Run-Gate $r) }

Write-Host ''
Write-Host '=== 反向验证结果 ==='
$bad = 0
foreach ($c in $cases) {
    $got = if ($c.R.Code -eq 0) { 'PASS' } else { 'FAIL' }
    $ok = ($got -eq $c.Expect)
    if (-not $ok) { $bad++ }
    Write-Host ("  {0} {1,-32} expect={2} got={3} rc={4}" -f $(if ($ok) { 'OK  ' } else { 'BAD ' }), $c.Name, $c.Expect, $got, $c.R.Code)
    if (-not $ok) {
        Write-Host ("       output: {0}" -f ($c.R.Output -split "`n" | Select-Object -Last 4 | Out-String).Trim())
    }
}

Write-Host ''
if ($bad -gt 0) {
    Write-Host ("SELF-TEST FAILED: {0} unexpected" -f $bad)
    exit 1
}
Write-Host 'SELF-TEST PASSED: 6 种泄露/漂移全部拦住，未改动的放行'
exit 0
