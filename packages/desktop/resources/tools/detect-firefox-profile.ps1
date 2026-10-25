# Reports the Firefox profile the user actually browses with, so a replacement binary can open the
# same bookmarks, history and logins instead of starting from an empty profile.
#
# Usage: powershell -File detect-firefox-profile.ps1 -OutFile <path>
# Writes the profile directory to <path>, or an empty file when none is found.

param([Parameter(Mandatory = $true)][string]$OutFile)

$ErrorActionPreference = 'SilentlyContinue'

function Write-Result([string]$value) {
  try {
    [IO.File]::WriteAllText($OutFile, $value, (New-Object Text.UTF8Encoding($false)))
  } catch {
    # Nothing useful to do: the installer treats a missing file as "no profile detected".
  }
}

$root = Join-Path $env:APPDATA 'Mozilla\Firefox'
$ini = Join-Path $root 'profiles.ini'
if (!(Test-Path $ini)) { Write-Result ''; exit 0 }

$candidates = New-Object System.Collections.Generic.List[string]
foreach ($line in Get-Content $ini) {
  # Path= entries are relative to the Mozilla\Firefox root; Default= entries are too in practice.
  if ($line -match '^\s*(?:Path|Default)\s*=\s*(.+?)\s*$') {
    $value = $Matches[1]
    if ([IO.Path]::IsPathRooted($value)) { $candidates.Add($value) }
    else { $candidates.Add((Join-Path $root ($value -replace '/', '\'))) }
  }
}

# Rank: a Developer Edition profile first (that is the build being replaced), then the largest
# places.sqlite, which is the one the user has actually been browsing in.
$best = $null
$bestScore = -1
foreach ($dir in ($candidates | Select-Object -Unique)) {
  if (!(Test-Path (Join-Path $dir 'prefs.js'))) { continue }
  $score = 0
  $places = Join-Path $dir 'places.sqlite'
  if (Test-Path $places) { $score = (Get-Item $places).Length }
  if ($dir -match 'dev-edition|dev_edition') { $score += 1000000000 }
  if ($score -gt $bestScore) { $bestScore = $score; $best = $dir }
}

Write-Result ($(if ($best) { $best } else { '' }))
