# Removes the WLstudio tuned Firefox Developer Edition and its dedicated profile.
#
# Called by the WLstudio uninstaller after the user answers "yes" to the removal question. It stops
# the browser first (a running install cannot be deleted), then removes the program directory and
# the isolated profile, then clears the registry records.
#
# The profile is only removed when it belongs to WLstudio. A profile path that resolves outside
# the expected %LOCALAPPDATA%\WLstudio tree is left alone: it may be a browsing profile the user
# has been using, and deleting it would destroy bookmarks and logins.

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Profile = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'SilentlyContinue'

function Say([string]$message) {
  Write-Output $message
}

if ([string]::IsNullOrWhiteSpace($Path)) {
  Say "no tuned Firefox path supplied, nothing to do"
  exit 0
}

$Path = $Path.TrimEnd('\')
if (!(Test-Path $Path)) {
  Say "path does not exist: $Path"
  Say "clearing registry record anyway"
  if (!$DryRun) {
    Remove-Item 'HKCU:\Software\WLstudio\TunedFirefox' -Recurse -Force
  }
  exit 0
}

# Refuse to delete anything outside the per-user WLstudio tree. This guards against a corrupted or
# hand-edited registry value pointing at a real Firefox installation.
$expectedRoot = Join-Path $env:LOCALAPPDATA 'WLstudio'
if (!($Path -like "$expectedRoot\*")) {
  Say "refusing to delete outside $expectedRoot : $Path"
  exit 1
}

Say "target: $Path"

# Stop the browser. Its process tree includes content and GPU children, so /T is required.
$procs = @(Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Path, [StringComparison]::OrdinalIgnoreCase) })

if ($procs.Count -gt 0) {
  Say "stopping $($procs.Count) firefox process(es) from this install"
  foreach ($p in $procs) {
    if ($DryRun) { Say "  would stop pid $($p.ProcessId)" ; continue }
    & taskkill.exe /F /T /PID $p.ProcessId 2>&1 | Out-Null
  }
  if (!$DryRun) { Start-Sleep -Milliseconds 800 }
} else {
  Say "no running process from this install"
}

if ($DryRun) {
  Say "dry-run: would remove program dir $Path"
  if ($Profile) { Say "dry-run: would consider profile $Profile" }
  exit 0
}

# Program directory.
try {
  Remove-Item $Path -Recurse -Force -ErrorAction Stop
  Say "removed program dir"
} catch {
  Say "failed to remove program dir: $($_.Exception.Message)"
}

# Dedicated profile, only if it lives under the WLstudio tree (never a browsing profile).
$profileRoot = Join-Path $expectedRoot 'firefox-profile'
if ($Profile -and ($Profile.TrimEnd('\') -like "$profileRoot*")) {
  if (Test-Path $Profile) {
    Remove-Item $Profile -Recurse -Force
    Say "removed profile: $Profile"
  } else {
    Say "profile already gone: $Profile"
  }
} elseif ($Profile) {
  Say "keeping profile outside WLstudio tree: $Profile"
}

# Shortcuts the installer may have created.
foreach ($lnk in @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Firefox Developer Edition 特调版.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Firefox Developer Edition 特调版.lnk')
  )) {
  if (Test-Path -LiteralPath $lnk) {
    Remove-Item -LiteralPath $lnk -Force
    Say "removed shortcut: $lnk"
  }
}

# Registry records.
Remove-Item 'HKCU:\Software\WLstudio\TunedFirefox' -Recurse -Force
Say "cleared registry record"

Say "done"
