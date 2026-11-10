# Regenerate `resources/seed` from the reviewed baseline in `templates/installer-assets`.
#
# The baseline is the only source of the personal-asset files that ship inside the installer.
# Editing `resources/seed` directly is what let the author's own rules leak into five releases:
# the seed directory is a copy, so it looked maintained while actually carrying whatever was in
# the author's file at the time it was copied.
#
# Direction matters and is enforced here:
#
#   templates/installer-assets  ->  resources/seed        (this script)
#   resources/seed              -x-> templates/...        (never; the baseline is hand-reviewed)
#
# Exit codes: 0 = seed matches the baseline, 1 = something could not be synced.

[CmdletBinding()]
param(
    [switch] $Check
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$baseline = Join-Path $repoRoot 'templates\installer-assets'
$seed = Join-Path $repoRoot 'packages\desktop\resources\seed'

function Fail($message) {
    Write-Host ("  FAIL: {0}" -f $message)
    exit 1
}

if (-not (Test-Path $baseline)) { Fail "baseline missing: $baseline" }
if (-not (Test-Path $seed)) { Fail "seed directory missing: $seed" }

# Only these two subtrees are template-owned. `seed/config` carries plugins and scripts that are
# product code, not templates, so it is left alone.
$owned = @('prefs', 'ex-bags')

Write-Host '=== sync seed from baseline ==='
Write-Host ("  baseline: {0}" -f $baseline)
Write-Host ("  seed:     {0}" -f $seed)

foreach ($sub in $owned) {
    $from = Join-Path $baseline $sub
    $to = Join-Path $seed $sub
    if (-not (Test-Path $from)) { Fail ("baseline subtree missing: {0}" -f $sub) }

    if ($Check) {
        # Compare rather than copy: report drift without touching the tree.
        $fromFiles = @(Get-ChildItem $from -Recurse -File -Force | ForEach-Object { $_.FullName.Replace($from, '') })
        $toFiles = @(Get-ChildItem $to -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Replace($to, '') })
        $drift = 0
        foreach ($rel in $fromFiles) {
            $a = Join-Path $from $rel
            $b = Join-Path $to $rel
            if (-not (Test-Path $b)) { Write-Host ("  DRIFT missing in seed: {0}/{1}" -f $sub, $rel); $drift++; continue }
            $ha = (Get-FileHash $a -Algorithm SHA256).Hash
            $hb = (Get-FileHash $b -Algorithm SHA256).Hash
            if ($ha -ne $hb) { Write-Host ("  DRIFT differs: {0}/{1}" -f $sub, $rel); $drift++ }
        }
        foreach ($rel in $toFiles) {
            if ($fromFiles -notcontains $rel) {
                Write-Host ("  DRIFT extra in seed: {0}/{1}" -f $sub, $rel)
                $drift++
            }
        }
        if ($drift -gt 0) { Write-Host ("  {0} drift(s) found" -f $drift); exit 1 }
        Write-Host ("  {0}: identical to baseline" -f $sub)
    }
    else {
        # /MIR makes the baseline authoritative: files removed from the baseline disappear here too,
        # so a stale entry cannot survive by being present only in the seed copy.
        & robocopy.exe $from $to /MIR /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
        $rc = $LASTEXITCODE
        if ($rc -ge 8) { Fail ("robocopy failed for {0} (rc={1})" -f $sub, $rc) }
        $count = @(Get-ChildItem $to -Recurse -File -Force).Count
        Write-Host ("  {0}: synced ({1} files)" -f $sub, $count)
    }
}

if ($Check) {
    Write-Host ''
    Write-Host 'seed matches the baseline'
    exit 0
}

Write-Host ''
Write-Host 'next: script/asset-gate.ps1 validates the content, then packaging may run'
exit 0
