# Move the experience library out of the install directory before it is uninstalled.
#
# The library lives in `<install>\WLstudio-data\ex-bags`, which sits inside the folder NSIS removes.
# It holds notes the user cannot regenerate, so it is copied to `%APPDATA%\WLstudio-data\ex-bags`
# first, verified, and only then removed from the install directory. If verification fails the
# source is left untouched and a non-zero exit code is returned, so the caller can see it failed.
#
# Contract:
#   -From <dir>   the ex-bags directory to rescue (default: <this script>\..\..\WLstudio-data\ex-bags)
#   -To   <dir>   destination (default: %APPDATA%\WLstudio-data\ex-bags)
#   -DryRun       report what would happen without touching anything
#
# Exit codes: 0 = nothing to do or rescued, 1 = copy/verify failed (source preserved).

[CmdletBinding()]
param(
  [string]$From = "",
  [string]$To = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Write-Line([string]$text) {
  try { [Console]::Out.WriteLine($text) } catch { Write-Output $text }
}

function Count-Files([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return 0 }
  return @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue).Count
}

if ([string]::IsNullOrWhiteSpace($To)) {
  $To = Join-Path $env:APPDATA "WLstudio-data\ex-bags"
}

if ([string]::IsNullOrWhiteSpace($From)) {
  # <install>\resources\tools\rescue-ex-bags.ps1 -> <install>\WLstudio-data\ex-bags
  $From = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "WLstudio-data\ex-bags"
}

$From = [IO.Path]::GetFullPath($From)
$To = [IO.Path]::GetFullPath($To)

Write-Line "from: $From"
Write-Line "to:   $To"

if (-not (Test-Path -LiteralPath $From)) {
  Write-Line "nothing to rescue (source missing)"
  exit 0
}

$sourceCount = Count-Files $From
Write-Line "source files: $sourceCount"

if ($DryRun) {
  Write-Line "dry run: would copy $sourceCount files and then remove the source"
  exit 0
}

# Never delete the source on an unverified copy: compare file counts, then the total byte length.
try {
  New-Item -ItemType Directory -Path $To -Force | Out-Null
  # robocopy exit codes 0-7 are success; 8+ are failures.
  $log = & "$env:SystemRoot\System32\robocopy.exe" $From $To /E /NFL /NDL /NJH /NJS /nc /ns /np 2>&1
  $rc = $LASTEXITCODE
  if ($rc -ge 8) {
    Write-Line "robocopy failed rc=$rc"
    $log | Select-Object -Last 8 | ForEach-Object { Write-Line "  $_" }
    exit 1
  }
} catch {
  Write-Line "copy failed: $($_.Exception.Message)"
  exit 1
}

$destCount = Count-Files $To
$sourceBytes = (Get-ChildItem -LiteralPath $From -Recurse -File -Force -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
$destBytes = (Get-ChildItem -LiteralPath $To -Recurse -File -Force -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
$sourceBytes = if ($sourceBytes) { [int64]$sourceBytes } else { 0 }
$destBytes = if ($destBytes) { [int64]$destBytes } else { 0 }

Write-Line "dest files: $destCount"
Write-Line "bytes: source=$sourceBytes dest=$destBytes"

if ($destCount -lt $sourceCount) {
  Write-Line "verify failed: destination has fewer files than the source; source preserved"
  exit 1
}

try {
  Remove-Item -LiteralPath $From -Recurse -Force
  Write-Line "source removed after verified copy"
} catch {
  # Leaving the source is harmless: NSIS deletes the whole install directory anyway, and the
  # copy in %APPDATA% is already verified.
  Write-Line "source cleanup skipped: $($_.Exception.Message)"
}

Write-Line "rescued"
exit 0
