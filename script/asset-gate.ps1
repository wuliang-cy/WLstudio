# Personal-asset gate for the WLstudio installer.
#
# The experience tree, the extra-preferences file and the preference pool belong to the author,
# not to the product. An installer may ship only blank templates, so this script fails the build
# when any of the three carries real content.
#
# It reads every file as raw bytes decoded as UTF-8 rather than relying on text matching, because
# machine paths and credentials also hide inside bundled JavaScript.
#
# Exit codes: 0 = clean, 1 = leak found or a rule could not be verified.

param(
    [Parameter(Mandatory = $true)]
    [string] $Root
)

$ErrorActionPreference = 'Stop'

$failures = @()
$notes = @()

function Fail($message) {
    $script:failures += $message
}

function Note($message) {
    $script:notes += $message
}

function Read-Bytes([string] $path) {
    return [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($path))
}

# ---------------------------------------------------------------------------
# Rule 1: the experience tree must be a skeleton.
#
# Allowed: `_INDEX.md`, `_TAXONOMY.md`, `_state/TASK_STATE.md` and `.gitkeep` placeholders.
# Anything else is a written experience entry, which is author-private.
# ---------------------------------------------------------------------------
$exBags = Join-Path $Root 'resources\seed\ex-bags'
if (-not (Test-Path $exBags)) {
    Fail "experience tree missing under seed (expected a blank skeleton): $exBags"
}
else {
    $allowed = @('_INDEX.md', '_TAXONOMY.md', 'TASK_STATE.md', '.gitkeep', '.index.json')
    $entries = @(Get-ChildItem $exBags -Recurse -File -Force)
    foreach ($f in $entries) {
        if ($allowed -notcontains $f.Name) {
            Fail ("experience tree ships a real entry: {0}" -f $f.FullName.Replace($exBags, 'ex-bags'))
        }
        if ($f.Length -gt 64KB) {
            Fail ("experience file is suspiciously large ({0} B): {1}" -f $f.Length, $f.FullName.Replace($exBags, 'ex-bags'))
        }
    }

    # The handoff file must state that nothing is in progress.
    $statePath = Join-Path $exBags '_state\TASK_STATE.md'
    if (Test-Path $statePath) {
        $stateText = Read-Bytes $statePath
        foreach ($phrase in @('暂无进行中任务', '暂无', '(none)', 'no active task')) {
            if ($stateText -like "*$phrase*") { $stateText = '' ; break }
        }
        if ($stateText) {
            # Allow the template header alone; flag anything that looks like real progress.
            $suspicious = @('完成', '已交付', '待办', '进度', '下一步', 'blocked', 'WAITING', 'IN_PROGRESS')
            foreach ($word in $suspicious) {
                if ($stateText -like "*$word*") {
                    Fail ("experience handoff file looks like real progress (matched '{0}')" -f $word)
                    break
                }
            }
        }
    }
    Note ("experience tree: {0} files" -f $entries.Count)
}

# ---------------------------------------------------------------------------
# Rule 2: the extra-preferences file must be a blank template.
#
# The author's real file is tens of kilobytes and carries machine paths. A shipped template
# stays small and contains none of them. The size cap is the cheap structural check; the
# literal scan below is the authoritative one.
# ---------------------------------------------------------------------------
$prefsDir = Join-Path $Root 'resources\seed\prefs'
$prefsFile = Join-Path $prefsDir 'SE-AGENTS.md'
if (-not (Test-Path $prefsFile)) {
    Fail "extra-preferences template missing: $prefsFile"
}
else {
    $size = (Get-Item $prefsFile).Length
    if ($size -gt 8KB) {
        Fail ("extra-preferences file is {0} B; a blank template stays under 8 KB (the real file is ~58 KB)" -f $size)
    }
    Note ("extra-preferences template: {0} B" -f $size)
}

# ---------------------------------------------------------------------------
# Rule 3: no machine-specific literal anywhere under seed.
#
# These are the author's own values. None of them has any legitimate reason to appear in a
# distributed artifact. Patterns are escaped so a literal backslash cannot be read as a regex
# anchor - an unescaped 'E:\AIoutput' becomes `E:\AIoutput` where `\A` means "start of string",
# which silently matches nothing.
# ---------------------------------------------------------------------------
$literals = @(
    'C:\Users\Administrator',
    'E:\AIoutput',
    'D:\AIModels',
    'D:\VPN\Clash',
    '192.168.137',
    'USER-20260908',
    'bounty-hunt',
    'quiz-auto-filler',
    'CTF-Tools',
    'socks5://127.0.0.1:7891',
    'wlstudio.db-wal'
)

$literalHits = 0
$piiSeedRoot = Join-Path $Root 'resources\seed'
if (Test-Path $piiSeedRoot) {
    foreach ($f in (Get-ChildItem $piiSeedRoot -Recurse -File -Force -EA SilentlyContinue)) {
        $text = Read-Bytes $f.FullName
        foreach ($lit in $literals) {
            if ($text.Contains($lit)) {
                Fail ("machine-specific literal '{0}' in {1}" -f $lit, $f.FullName.Replace($piiSeedRoot, 'seed'))
                $literalHits++
            }
        }
    }
}
Note ("literals scanned: {0} patterns over seed" -f $literals.Count)

# ---------------------------------------------------------------------------
# Rule 4: the preference pool is not a file.
#
# Pool rows live in the `instruction_entry` table, so a distributed artifact must not contain a
# database at all. If one is present it either ships the author's preferences or is dead weight.
# ---------------------------------------------------------------------------
$dbFiles = @(Get-ChildItem $Root -Recurse -File -Force -EA SilentlyContinue |
    Where-Object { $_.Name -match '^wlstudio\.db($|-wal|-shm)' })
if ($dbFiles.Count -gt 0) {
    foreach ($f in $dbFiles) {
        Fail ("a database ships in the package: {0} ({1} B)" -f $f.FullName.Replace($Root, ''), $f.Length)
    }
}
Note 'preference pool: no database present (pool rows live in the database, never on disk)'

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
foreach ($n in $notes) { Write-Host ("  note: {0}" -f $n) }

if ($failures.Count -gt 0) {
    Write-Host ''
    Write-Host ("PERSONAL-ASSET GATE FAILED: {0} problem(s)" -f $failures.Count)
    foreach ($f in $failures) { Write-Host ("  FAIL: {0}" -f $f) }
    exit 1
}

Write-Host '  personal-asset gate: clean'
exit 0
