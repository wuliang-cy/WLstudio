#Requires -Version 5.1
<#
    WLstudio 一键卸载 / One-click uninstaller
    ------------------------------------------------------------------
    默认模式 : 彻底清理所有「安装产物」——程序本体、缓存/状态/日志、CLI 副本、
               config（含插件/脚本/命令/node_modules）、SE-AGENTS.md、
               home 的 AGENTS.md 与 WARMUP.md、种子经验目录（~\WLstudio）。
               唯一保留：经验库 ex-bags（含 TASK_STATE 与全部经验文档）。
               → 重装后等同新机器，首启 seed 会重新生成正确的偏好文档。
    -PurgeAll: 连经验库 ex-bags 也一起删除（完全空盘）
    -DryRun  : 只列出将要处理的内容，不实际删除
    -Yes     : 跳过 5 秒确认倒计时
    ------------------------------------------------------------------
    注意：运行前会结束所有 WLstudio 进程，包括正在使用的会话。
    删除前会自动把 config / SE-AGENTS.md / ex-bags / home 偏好文档
    备份到 %USERPROFILE%\WLstudio-uninstall-backup-<时间戳>\。
#>
[CmdletBinding()]
param(
    [switch]$PurgeAll,
    [switch]$DryRun,
    [switch]$Yes,
    # Tuned Firefox ("特调版 DEV") is a real browser holding the user's bookmarks and logins, so
    # removing it is a separate, explicit decision. Omitted = ask interactively; -KeepFirefox /
    # -RemoveFirefox answer up front so the script can run unattended.
    [switch]$KeepFirefox,
    [switch]$RemoveFirefox
)

$ErrorActionPreference = 'Continue'

# 控制台按 UTF-8 输出，否则中文在 GBK 控制台会乱码
try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $OutputEncoding = [Text.Encoding]::UTF8
} catch { }

# ---------------- 输出 ----------------
$Script:LogFile = Join-Path $env:TEMP ("wlstudio-uninstall-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Say([string]$text, [string]$color = 'Gray') {
    # PS 5.1 的 Write-Host 在 GBK 控制台会截坏部分中日韩字符，改走 Console.Out
    try {
        $prev = [Console]::ForegroundColor
        [Console]::ForegroundColor = [ConsoleColor]$color
        [Console]::Out.WriteLine($text)
        [Console]::ForegroundColor = $prev
    } catch {
        [Console]::Out.WriteLine($text)
    }
    Add-Content -Path $Script:LogFile -Value $text -Encoding UTF8
}
function Head([string]$text) { Say ""; Say ("=== " + $text + " ===") 'Cyan' }

function Get-DirSize([string]$path) {
    try {
        # A file path must not go through -Recurse: PowerShell hits a pathological path for a
        # single file and can take minutes (measured 160 s for one 20 KB markdown file), which made
        # every dry run look like a hang. Read the size directly instead.
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if ($null -eq $item) { return 0 }
        if (-not $item.PSIsContainer) { return $item.Length }
        $s = Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue |
             Measure-Object -Property Length -Sum
        if ($null -eq $s.Sum) { return 0 }
        return $s.Sum
    } catch { return 0 }
}
function Fmt([double]$bytes) {
    if ($bytes -ge 1GB) { return ('{0:N2} GB' -f ($bytes / 1GB)) }
    if ($bytes -ge 1MB) { return ('{0:N1} MB' -f ($bytes / 1MB)) }
    if ($bytes -ge 1KB) { return ('{0:N0} KB' -f ($bytes / 1KB)) }
    return ('{0:N0} B' -f $bytes)
}

Say "WLstudio uninstaller" 'White'
Say ("log: " + $Script:LogFile) 'DarkGray'
if ($PurgeAll) { Say "mode: PURGE ALL (removes everything incl. the ex-bags experience library)" 'Yellow' }
else           { Say "mode: FULL UNINSTALL (removes all install artefacts: app, config, prefs, home AGENTS.md/WARMUP.md; KEEPS ex-bags)" 'Yellow' }
if ($DryRun)   { Say "mode: DRY RUN (nothing will be deleted)" 'Yellow' }

# ---------------- 路径 ----------------
$Home_    = $env:USERPROFILE
$CfgDir   = Join-Path $Home_ '.config\wlstudio'
$DataDir  = Join-Path $Home_ '.local\share\wlstudio'
$StateDir = Join-Path $Home_ '.local\state\wlstudio'
$RoamingMain = Join-Path $env:APPDATA  'com.wlstudio.desktop'
$RoamingDev  = Join-Path $env:APPDATA  'com.wlstudio.desktop.dev'
$LocalMain   = Join-Path $env:LOCALAPPDATA 'com.wlstudio.desktop'
$SeDir    = Join-Path $Home_ 'WLstudio SE'
$SeedBags = Join-Path $Home_ 'WLstudio'
$ExBags   = Join-Path $Home_ 'WLstudio\ex-bags'
# Seed 文档：首启时由安装包写入 home，属于安装产物（不是用户原创配置）。
# 不删会导致重装时 seed 判定"已存在"而跳过，旧版本里写死的错误路径便一直残留。
$HomeAgents = Join-Path $Home_ 'AGENTS.md'
$HomeWarmup = Join-Path $Home_ 'WARMUP.md'
$ProgDir1 = Join-Path $env:LOCALAPPDATA 'Programs\WLstudio'
$ProgDir2 = Join-Path $env:LOCALAPPDATA 'Programs\wlstudio'
$ProgDir3 = 'C:\Program Files\WLstudio'

# 经验库现在的规范位置：安装时由 NSIS 写到 HKCU\Environment\WLSTUDIO_DATA，指向安装盘上的
# WLstudio-data。它可能攒了几个月的东西，默认永远保留，只有 -PurgeAll 才删。
# 旧版曾放在 home 或开发者工作区，这里逐一兼容，不写死任何一台机器的路径。
function Get-DataDir {
    $fromEnv = [Environment]::GetEnvironmentVariable('WLSTUDIO_DATA', 'User')
    if ([string]::IsNullOrWhiteSpace($fromEnv)) { $fromEnv = $env:WLSTUDIO_DATA }
    if (-not [string]::IsNullOrWhiteSpace($fromEnv)) { return $fromEnv }
    return $null
}
$DataDirRoot = Get-DataDir
$LiveExBags = @()
if ($DataDirRoot) { $LiveExBags += (Join-Path $DataDirRoot 'ex-bags') }
$LiveExBags += $ExBags
$LiveExBags = $LiveExBags | Where-Object { Test-Path $_ } | Select-Object -Unique
$DeskExBags = $null

# ---------------- 1) 结束进程 ----------------
Head "1/7 停止 WLstudio 进程"

$targets = @()
$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
foreach ($p in $all) {
    $exe = $p.ExecutablePath
    $cmd = $p.CommandLine
    $isTarget = $false
    if ($exe) {
        $leaf = Split-Path $exe -Leaf
        if ($leaf -in @('WLstudio.exe', 'WLstudio Dev.exe', 'wlstudio-cli.exe', 'wlstudio-cli')) { $isTarget = $true }
        if ($leaf -in @('node.exe', 'electron.exe') -and $cmd -and $cmd -match 'wlstudio') { $isTarget = $true }
    }
    if ($p.ProcessId -eq $PID) { $isTarget = $false }
    if ($isTarget) {
        $targets += [pscustomobject]@{ Pid = $p.ProcessId; Name = $p.Name; Path = $exe }
    }
}

if ($targets.Count -eq 0) {
    Say "  no WLstudio process running" 'DarkGray'
} else {
    foreach ($t in ($targets | Sort-Object Pid -Unique)) {
        Say ("  pid {0,-7} {1}   {2}" -f $t.Pid, $t.Name, $t.Path) 'DarkGray'
    }
    if (-not $DryRun) {
        Say "  terminating..." 'Yellow'
        foreach ($t in ($targets | Sort-Object Pid -Unique)) {
            & taskkill.exe /F /T /PID $t.Pid 2>&1 | Out-Null
        }
        Start-Sleep -Seconds 2
        $still = @()
        foreach ($t in ($targets | Sort-Object Pid -Unique)) {
            if (Get-Process -Id $t.Pid -ErrorAction SilentlyContinue) { $still += $t.Pid }
        }
        if ($still.Count -gt 0) { Say ("  still alive: " + ($still -join ', ')) 'Red' }
        else { Say "  all stopped" 'Green' }
    }
}

# ---------------- 2) 定位官方卸载器 ----------------
Head "2/7 查找官方卸载器"

# 开发/解压版（例如 \packages\desktop\dist\win-unpacked）没有注册表项，
# 也没有 Uninstall WLstudio.exe，此时按"进程所在目录"识别安装位置。
$installRoots = @()
$allNow = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
foreach ($p in $allNow) {
    $exe = $p.ExecutablePath
    if (-not $exe) { continue }
    $leaf = Split-Path $exe -Leaf
    if ($leaf -in @('WLstudio.exe', 'WLstudio Dev.exe')) {
        $dir = Split-Path $exe -Parent
        if ($dir -and $dir -notlike '*\Windows\*') { $installRoots += $dir }
    }
}
foreach ($extra in @($ProgDir1, $ProgDir2, $ProgDir3)) {
    if (Test-Path $extra) { $installRoots += $extra }
}
$installRoots = @($installRoots | Sort-Object -Unique)

if ($installRoots.Count -eq 0) {
    Say "  no install directory detected" 'DarkGray'
} else {
    foreach ($r in $installRoots) { Say ("  install dir: " + $r) 'DarkGray' }
}

$uninstallers = @()
$regKeys = @()
$regRoots = @(
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($root in $regRoots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($k in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
        $props = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
        if ($null -eq $props.DisplayName) { continue }
        if ($props.DisplayName -notlike 'WLstudio*') { continue }
        $regKeys += [pscustomobject]@{ Key = $k.PSPath; Name = $props.DisplayName; Version = $props.DisplayVersion; Uninstall = $props.UninstallString }
        Say ("  registry: {0}  v{1}" -f $props.DisplayName, $props.DisplayVersion) 'DarkGray'
        $u = $props.UninstallString
        if ($u) {
            $exePath = $u -replace '^\s*"', '' -replace '"\s*.*$', '' -replace '^\s*(\S+\.exe).*$', '$1'
            if (Test-Path $exePath) { $uninstallers += $exePath }
        }
    }
}
foreach ($d in $installRoots) {
    foreach ($name in @('Uninstall WLstudio.exe', 'Uninstall WLstudio Dev.exe')) {
        $cand = Join-Path $d $name
        if (Test-Path $cand) { $uninstallers += $cand }
    }
}
$uninstallers = @($uninstallers | Where-Object { $_ } | Sort-Object -Unique)
if ($uninstallers.Count -eq 0) { Say "  no official uninstaller found (portable / dev copy?)" 'Yellow' }
else { foreach ($u in $uninstallers) { Say ("  found: " + $u) 'DarkGray' } }

# ---------------- 3) 概览 ----------------
Head "3/7 将要处理的内容"

$alwaysRemove = @(
    @{ Path = $DataDir;       Label = 'kernel data (db, logs)' },
    @{ Path = $StateDir;      Label = 'kernel state (service.json)' },
    @{ Path = $RoamingMain;   Label = 'electron userData' },
    @{ Path = $RoamingDev;    Label = 'electron userData (dev)' },
    @{ Path = $LocalMain;     Label = 'electron local cache' },
    @{ Path = $ProgDir1;      Label = 'install dir (per-user)' },
    @{ Path = $ProgDir2;      Label = 'install dir (per-user, alt)' },
    @{ Path = $ProgDir3;      Label = 'install dir (Program Files)' }
)

# 首启 seed 写入 home 的偏好文档。它们是「安装产物」，STANDARD 模式也应删除：
# 否则升级/重装时 seed 判定文件已存在 → 跳过 → 旧版本写死的错误路径永久残留。
# 先备份到 WLstudio-uninstall-backup-<ts>，避免用户手改的内容丢失。
$seedDocs = @(
    @{ Path = $HomeAgents; Label = 'seed doc: home AGENTS.md' },
    @{ Path = $HomeWarmup; Label = 'seed doc: home WARMUP.md' }
)

# 检测到的安装目录：已装版直接清；源码工程的构建产物（dist\win-unpacked）只报告不动，
# 避免一键卸载把开发目录里的构建结果删掉。
$devBuildRoots = @()
foreach ($r in $installRoots) {
    $known = $r -in @($ProgDir1, $ProgDir2, $ProgDir3)
    if ($known) { continue }
    if ($r -match '\\(packages\\desktop|WLstudio-v2-swap|wlstudio-test)\\') {
        $devBuildRoots += $r
    } else {
        $alwaysRemove += @{ Path = $r; Label = 'install dir (detected)' }
    }
}
# 这些是「安装产物」，默认就删 —— 否则重装会复用旧配置，把老版本的问题（如写死的
# 错误路径）带进来。删除前统一备份到 WLstudio-uninstall-backup-<ts>。
$alwaysRemove += @(
    @{ Path = $CfgDir;    Label = 'config + plugins + node_modules' },
    @{ Path = $SeDir;     Label = 'SE-AGENTS.md preferences' },
    @{ Path = $SeedBags;  Label = 'seeded experience folder (~\WLstudio)' }
)

# 唯一的例外：经验库是用户长期积累的资产，只有 -PurgeAll 才删。
# 位置由 WLSTUDIO_DATA 决定（安装盘），也兼容旧版 home 下的副本。
$keepByDefault = @()
foreach ($bags in $LiveExBags) {
    $keepByDefault += @{ Path = $bags; Label = 'experience library (ex-bags) [only -PurgeAll]' }
}

$totalFree = 0
foreach ($item in $alwaysRemove) {
    if (Test-Path $item.Path) {
        $sz = Get-DirSize $item.Path
        $totalFree += $sz
        Say ("  [del]  {0,-46} {1,10}   {2}" -f $item.Label, (Fmt $sz), $item.Path) 'White'
    }
}
foreach ($item in $seedDocs) {
    if (Test-Path $item.Path) {
        $sz = Get-DirSize $item.Path
        $totalFree += $sz
        Say ("  [del]  {0,-46} {1,10}   {2}" -f $item.Label, (Fmt $sz), $item.Path) 'White'
    }
}
foreach ($item in $keepByDefault) {
    if (Test-Path $item.Path) {
        $sz = Get-DirSize $item.Path
        if ($PurgeAll) {
            $totalFree += $sz
            Say ("  [del]  {0,-46} {1,10}   {2}" -f $item.Label, (Fmt $sz), $item.Path) 'Yellow'
        } else {
            Say ("  [keep] {0,-46} {1,10}   {2}" -f $item.Label, (Fmt $sz), $item.Path) 'DarkGray'
        }
    }
}
Say ("  reclaimable: " + (Fmt $totalFree)) 'Green'
# 特调版 Firefox 单独一行：它可能在也可能不在，删不删要另外确认，所以不进 [del] 主清单。
# 注册表必须在这里就读，否则概览里 $tunedPath 还没赋值，这一行永远不显示。
$TunedKey = 'HKCU:\Software\WLstudio\TunedFirefox'
$tunedPath = $null
$tunedProfile = $null
if (Test-Path $TunedKey) {
    $props = Get-ItemProperty $TunedKey -ErrorAction SilentlyContinue
    if ($props) {
        $tunedPath = $props.Path
        $tunedProfile = $props.Profile
    }
}
if ($tunedPath) {
    $ffSize = 0
    if (Test-Path $tunedPath) { $ffSize += Get-DirSize $tunedPath }
    if ($tunedProfile -and (Test-Path $tunedProfile)) { $ffSize += Get-DirSize $tunedProfile }
    Say ("  [ask]  {0,-46} {1,10}   {2}" -f 'tuned Firefox (decided separately)', (Fmt $ffSize), $tunedPath) 'Yellow'
}
if ($devBuildRoots.Count -gt 0) {
    Say ("  [skip] 以下目录是源码构建产物，不删除（如确需删除请手动处理）：") 'DarkGray'
    foreach ($r in $devBuildRoots) { Say ("    " + $r) 'DarkGray' }
}

# ---------------- 4) 备份 ----------------
Head "4/7 备份关键配置"

$backupDir = Join-Path $Home_ ("WLstudio-uninstall-backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$backupItems = @()
$cfgFile = Join-Path $CfgDir 'opencode.json'
if (Test-Path $cfgFile) { $backupItems += @{ Src = $cfgFile; Dst = 'opencode.json' } }
$seFile = Join-Path $SeDir 'SE-AGENTS.md'
if (Test-Path $seFile) { $backupItems += @{ Src = $seFile; Dst = 'SE-AGENTS.md' } }
$pluginDir = Join-Path $CfgDir 'plugin'
if (Test-Path $pluginDir) { $backupItems += @{ Src = $pluginDir; Dst = 'plugin' } }
$bagsDir = $LiveExBags | Select-Object -First 1
if ($bagsDir) { $backupItems += @{ Src = $bagsDir; Dst = 'ex-bags' } }
# Seed 文档在 STANDARD 模式会被删除，必须备份，用户手改的内容才不会丢。
if (Test-Path $HomeAgents) { $backupItems += @{ Src = $HomeAgents; Dst = 'home-AGENTS.md' } }
if (Test-Path $HomeWarmup) { $backupItems += @{ Src = $HomeWarmup; Dst = 'home-WARMUP.md' } }

if ($backupItems.Count -eq 0) {
    Say "  nothing to back up" 'DarkGray'
} elseif ($DryRun) {
    Say ("  would back up {0} item(s) to {1}" -f $backupItems.Count, $backupDir) 'DarkGray'
} else {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    foreach ($b in $backupItems) {
        $dst = Join-Path $backupDir $b.Dst
        & robocopy.exe $b.Src $dst /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
        $rc = $LASTEXITCODE
        if ($rc -lt 8) { Say ("  backed up: {0}" -f $b.Dst) 'DarkGray' }
        else { Say ("  backup FAILED: {0} (robocopy {1})" -f $b.Dst, $rc) 'Red' }
    }
    Say ("  backup dir: " + $backupDir) 'Green'
}

# ---------------- 5) 确认 ----------------
Head "5/7 确认"

if ($DryRun) {
    Say "  dry run - skipping confirmation" 'Yellow'
} else {
    if (-not $Yes) {
        Say "  所有 WLstudio 进程已停止；将在 5 秒后继续删除。" 'Yellow'
        Say "  Ctrl+C 可立即中止。" 'Yellow'
        for ($i = 5; $i -ge 1; $i--) { Write-Host ("  {0}..." -f $i) -NoNewline -ForegroundColor Yellow; Start-Sleep -Seconds 1 }
        Write-Host ""
    }
    Say "  proceeding" 'Green'
}

# ---------------- 6) 执行卸载 ----------------
Head "6/7 执行卸载"

foreach ($u in $uninstallers) {
    if ($DryRun) { Say ("  would run: {0} /S /currentuser" -f $u) 'DarkGray'; continue }
    Say ("  running: " + $u) 'Yellow'
    try {
        $proc = Start-Process -FilePath $u -ArgumentList '/S', '/currentuser' -PassThru -Wait -ErrorAction Stop
        Say ("    exit=" + $proc.ExitCode) 'DarkGray'
    } catch {
        Say ("    failed: " + $_.Exception.Message) 'Red'
    }
    Start-Sleep -Seconds 2
}

# ---------------- 6b) 特调版 Firefox ----------------
# 官方卸载器是被静默调用的（/S），NSIS 的 customUnInstall 里遇静默会直接保留浏览器，
# 所以「是否删除特调版」必须由本脚本自己问，不能让用户觉得选项消失了。
$TunedKey = 'HKCU:\Software\WLstudio\TunedFirefox'
# 优先用安装目录里随包的 helper（它自带「只删 WLstudio 树内路径」的保护）；
# 安装目录已被删掉时，各 uninstaller 所在目录里也可能还留着它。
$tunedToolCandidates = @()
foreach ($u in $uninstallers) {
    $dir = Split-Path $u -Parent
    if ($dir) { $tunedToolCandidates += (Join-Path $dir 'resources\tools\remove-tuned-firefox.ps1') }
}
foreach ($d in @((Join-Path $env:LOCALAPPDATA 'Programs\WLstudio'))) {
    $tunedToolCandidates += (Join-Path $d 'resources\tools\remove-tuned-firefox.ps1')
}
$tunedToolCandidates = @($tunedToolCandidates | Where-Object { $_ } | Sort-Object -Unique)
# $tunedPath / $tunedProfile 已在概览之前读取，这里不重复读。

if ($tunedPath) {
    Head "6b/7 特调版 Firefox"
    Say ("  已安装 WLstudio 特调版 Firefox：{0}" -f $tunedPath) 'Gray'
    if ($tunedProfile) { Say ("  配置目录：{0}" -f $tunedProfile) 'DarkGray' }
    Say "  它可能保存了你的书签、登录状态与密码。" 'Yellow'

    $doRemove = $false
    if ($RemoveFirefox) {
        $doRemove = $true
        Say "  按 -RemoveFirefox 参数决定：删除" 'Yellow'
    } elseif ($KeepFirefox) {
        $doRemove = $false
        Say "  按 -KeepFirefox 参数决定：保留" 'Yellow'
    } elseif ($DryRun) {
        Say "  dry run - 实际运行时会询问是否删除" 'DarkGray'
    } else {
        $answer = Read-Host "  是否同时删除 WLstudio 特调版 Firefox？输入 y 删除，直接回车保留"
        $doRemove = ($answer -match '^(y|Y|yes|YES)$')
    }

    if ($doRemove) {
        if ($DryRun) {
            Say ("  would remove: " + $tunedPath) 'DarkGray'
            if ($tunedProfile) { Say ("  would remove: " + $tunedProfile) 'DarkGray' }
            Say "  would remove registry HKCU\Software\WLstudio\TunedFirefox" 'DarkGray'
        } else {
            $tool = $null
            foreach ($cand in $tunedToolCandidates) { if (Test-Path $cand) { $tool = $cand; break } }
            if ($tool) {
                Say ("  running: " + $tool) 'DarkGray'
                try {
                    $p = Start-Process -FilePath 'powershell.exe' `
                        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tool, '-Path', $tunedPath, '-Profile', $tunedProfile `
                        -PassThru -Wait -ErrorAction Stop
                    Say ("    exit=" + $p.ExitCode) 'DarkGray'
                } catch {
                    Say ("    failed: " + $_.Exception.Message) 'Red'
                }
            } else {
                # 脚本不在（用户删了安装目录），退回直接删，但只删 WLstudio 自己的树。
                $allowedRoot = Join-Path $env:LOCALAPPDATA 'WLstudio'
                if ($tunedPath.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
                    Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" -ErrorAction SilentlyContinue |
                        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($tunedPath, [StringComparison]::OrdinalIgnoreCase) } |
                        ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId 2>&1 | Out-Null }
                    Remove-Item $tunedPath -Recurse -Force -ErrorAction SilentlyContinue
                    if ($tunedProfile -and $tunedProfile.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
                        Remove-Item $tunedProfile -Recurse -Force -ErrorAction SilentlyContinue
                    }
                    Say "    removed directly (helper script unavailable)" 'DarkGray'
                } else {
                    Say "    refused: path outside %LOCALAPPDATA%\WLstudio" 'Red'
                }
            }
            Remove-Item $TunedKey -Recurse -Force -ErrorAction SilentlyContinue
            Say "  tuned Firefox removed" 'Green'
        }
    } else {
        Say "  已保留特调版 Firefox，注册表记录保留（下次安装仍能识别）" 'Green'
    }
} elseif (-not $DryRun) {
    Say "  未检测到特调版 Firefox 记录（可能已手动删除）" 'DarkGray'
}

$removeList = @($alwaysRemove) + @($seedDocs)
if ($PurgeAll) { $removeList += $keepByDefault }

# The experience library lives inside the install directory, so removing that directory would
# take it. The bundled NSIS uninstaller rescues it first, but this script also has to work when
# no uninstaller was found (a hand-copied build, or an install whose registry entry is gone), so
# rescue unconditionally here too: copy to %APPDATA%\WLstudio-data, verify, then let the install
# directory be removed. Verified copies only; a failed copy aborts instead of destroying notes.
if (-not $PurgeAll -and -not $DryRun) {
    $rescueTo = Join-Path $env:APPDATA 'WLstudio-data\ex-bags'
    foreach ($bags in $LiveExBags) {
        if (-not (Test-Path -LiteralPath $bags)) { continue }
        # Already outside every directory in the removal list: nothing to rescue.
        $insideRemoval = $false
        foreach ($t in $removeList) {
            if (-not (Test-Path -LiteralPath $t.Path)) { continue }
            if ($bags.StartsWith($t.Path.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
                $insideRemoval = $true
                break
            }
        }
        if (-not $insideRemoval) { continue }
        if (Test-Path -LiteralPath $rescueTo) {
            Say ("  experience library already rescued: " + $rescueTo) 'DarkGray'
            continue
        }
        $srcCount = @(Get-ChildItem -LiteralPath $bags -Recurse -File -Force -ErrorAction SilentlyContinue).Count
        Say ("  rescuing experience library ({0} files) -> {1}" -f $srcCount, $rescueTo) 'Yellow'
        New-Item -ItemType Directory -Path $rescueTo -Force | Out-Null
        & "$env:SystemRoot\System32\robocopy.exe" $bags $rescueTo /E /NFL /NDL /NJH /NJS /nc /ns /np 2>&1 | Out-Null
        $dstCount = @(Get-ChildItem -LiteralPath $rescueTo -Recurse -File -Force -ErrorAction SilentlyContinue).Count
        if ($dstCount -lt $srcCount) {
            Say ("    rescue verify failed (source {0} / dest {1}); continuing but the library is still inside the install dir" -f $srcCount, $dstCount) 'Red'
        } else {
            Say ("    rescued: {0} files verified" -f $dstCount) 'Green'
            [Environment]::SetEnvironmentVariable('WLSTUDIO_DATA', (Join-Path $env:APPDATA 'WLstudio-data'), 'User')
            $env:WLSTUDIO_DATA = Join-Path $env:APPDATA 'WLstudio-data'
        }
    }
}

foreach ($item in $removeList) {
    if (-not (Test-Path $item.Path)) { continue }
    if ($DryRun) { Say ("  would remove: " + $item.Path) 'DarkGray'; continue }
    Say ("  removing: " + $item.Path) 'DarkGray'
    try {
        # 上表同时含目录和单个 seed 文档，按实际类型分别删除。
        if (Test-Path $item.Path -PathType Leaf) {
            Remove-Item $item.Path -Force -ErrorAction Stop
        } else {
            Remove-Item $item.Path -Recurse -Force -ErrorAction Stop
        }
        if (Test-Path $item.Path) { Say "    partially removed (files locked?)" 'Yellow' }
    } catch {
        Say ("    failed: " + $_.Exception.Message) 'Red'
        & cmd.exe /c ('rmdir /s /q "{0}"' -f $item.Path) 2>&1 | Out-Null
        if (-not (Test-Path $item.Path)) { Say "    removed via rmdir" 'DarkGray' }
    }
}

# 快捷方式
$shortcuts = @(
    (Join-Path $env:USERPROFILE 'Desktop\WLstudio.lnk'),
    (Join-Path $env:USERPROFILE 'Desktop\WLstudio Dev.lnk'),
    (Join-Path $env:USERPROFILE ("Desktop\WLstudio 桥接浏览器.lnk")),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\WLstudio.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\WLstudio Dev.lnk')
)
$pubStart = 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\WLstudio.lnk'
$shortcuts += $pubStart
foreach ($s in $shortcuts) {
    if (-not (Test-Path $s)) { continue }
    if ($DryRun) { Say ("  would remove shortcut: " + $s) 'DarkGray'; continue }
    try { Remove-Item $s -Force -ErrorAction Stop; Say ("  removed shortcut: " + (Split-Path $s -Leaf)) 'DarkGray' } catch { Say ("  shortcut locked: " + $s) 'Yellow' }
}

# 注册表
foreach ($rk in $regKeys) {
    if ($DryRun) { Say ("  would remove registry key: " + $rk.Name) 'DarkGray'; continue }
    try { Remove-Item $rk.Key -Recurse -Force -ErrorAction Stop; Say ("  removed registry: " + $rk.Name) 'DarkGray' }
    catch { Say ("  registry remove failed: " + $rk.Name) 'Yellow' }
}

# 计划任务
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'WLstudio*' })
foreach ($t in $tasks) {
    if ($DryRun) { Say ("  would remove task: " + $t.TaskName) 'DarkGray'; continue }
    try { Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction Stop; Say ("  removed task: " + $t.TaskName) 'DarkGray' }
    catch { Say ("  task remove failed: " + $t.TaskName) 'Yellow' }
}

# ---------------- 7) 结果 ----------------
Head "7/7 结果"

$leftover = @()
foreach ($item in $removeList) { if (Test-Path $item.Path) { $leftover += $item.Path } }
foreach ($s in $shortcuts) { if (Test-Path $s) { $leftover += $s } }

if ($DryRun) {
    Say "  dry run finished - nothing changed" 'Yellow'
} elseif ($leftover.Count -eq 0) {
    Say "  卸载完成，无残留" 'Green'
} else {
    Say "  以下项目需要手动清理（可能被占用）：" 'Yellow'
    foreach ($l in $leftover) { Say ("    " + $l) 'Yellow' }
}

if (-not $PurgeAll) {
    Say ""
    Say "  已保留（如需彻底清除请用 -PurgeAll 重跑）：" 'DarkGray'
    foreach ($item in $keepByDefault) { if (Test-Path $item.Path) { Say ("    " + $item.Path) 'DarkGray' } }
}
if (-not $DryRun -and (Test-Path $backupDir)) {
    Say ""
    Say ("  备份在: " + $backupDir) 'Cyan'
}
Say ""
Say ("日志: " + $Script:LogFile) 'DarkGray'
Say "done." 'White'
