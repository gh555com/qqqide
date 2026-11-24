# clean-c.ps1 - temp-domain scanner/cleaner for Windows (the ONLY safe path for "clean C drive")
#
# Default = SCAN ONLY (never deletes anything). Add -Apply to really delete,
# and only after the user has seen the scan list and explicitly approved it.
#
# Output (plain ASCII, no BOM needed):
#   MODE=SCAN|APPLY
#   ITEM|<key>|<dir>|<files>|<MB>|<skipped>|<deleted>
#   TOTAL|<MB>|<files>|<freedMB>
#
# Safety rules baked in (do NOT re-implement this in ad-hoc commands):
#   * whitelist only: user temp, system temp, crash dumps, web cache, error reports, update cache
#   * only files older than MinAgeMin minutes (files in use are locked anyway)
#   * never follows reparse points / junctions
#   * hard time budget (default 90s) so it can never hang the caller
#   * ASCII only + PS 2.0 syntax (Windows 7 baseline)
param(
    [switch]$Apply,
    [int]$BudgetSec = 90,
    [int]$MinAgeMin = 30
)

$ErrorActionPreference = 'SilentlyContinue'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$cut = (Get-Date).AddMinutes(-1 * $MinAgeMin)

$script:files = 0
$script:bytes = 0
$script:skipped = 0
$script:deleted = 0
$script:freed = 0
$script:totalFiles = 0
$script:totalBytes = 0
$script:totalFreed = 0

function Walk([string]$d, [int]$depth) {
    if ($depth -gt 14) { return }
    if ($sw.Elapsed.TotalSeconds -gt $BudgetSec) { return }
    $items = Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue
    if (-not $items) { return }
    foreach ($it in $items) {
        if ($sw.Elapsed.TotalSeconds -gt $BudgetSec) { return }
        if ($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $script:skipped++; continue }
        if ($it.PSIsContainer) { Walk $it.FullName ($depth + 1); continue }
        if ($it.LastWriteTime -gt $cut) { $script:skipped++; continue }
        $len = 0
        if ($it.Length) { $len = $it.Length }
        $script:files++
        $script:bytes = $script:bytes + $len
        if ($Apply) {
            Remove-Item -LiteralPath $it.FullName -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $it.FullName) { $script:skipped++ }
            else { $script:deleted++; $script:freed = $script:freed + $len }
        }
    }
}

$L = $env:LOCALAPPDATA
$S = $env:SystemRoot
$targets = @()
if ($L) { $targets += ('user-temp|' + (Join-Path $L 'Temp')) }
if ($S) { $targets += ('win-temp|' + (Join-Path $S 'Temp')) }
if ($L) { $targets += ('crash|' + (Join-Path $L 'CrashDumps')) }
if ($L) { $targets += ('inet|' + (Join-Path $L 'Microsoft\Windows\INetCache')) }
if ($L) { $targets += ('wer|' + (Join-Path $L 'Microsoft\Windows\WER')) }
if ($S) { $targets += ('winupdate|' + (Join-Path $S 'SoftwareDistribution\Download')) }

$rows = @()
foreach ($t in $targets) {
    $p = $t.Split('|')
    $key = $p[0]
    $dir = $p[1]
    $script:files = 0
    $script:bytes = 0
    $script:skipped = 0
    $script:deleted = 0
    $script:freed = 0
    if (Test-Path -LiteralPath $dir) { Walk $dir 0 }
    $mb = [math]::Round($script:bytes / 1MB, 1)
    $rows += ('ITEM|' + $key + '|' + $dir + '|' + $script:files + '|' + $mb + '|' + $script:skipped + '|' + $script:deleted)
    $script:totalFiles = $script:totalFiles + $script:files
    $script:totalBytes = $script:totalBytes + $script:bytes
    $script:totalFreed = $script:totalFreed + $script:freed
}

if ($Apply) { 'MODE=APPLY' } else { 'MODE=SCAN' }
foreach ($r in $rows) { $r }
'TOTAL|' + [math]::Round($script:totalBytes / 1MB, 1) + '|' + $script:totalFiles + '|' + [math]::Round($script:totalFreed / 1MB, 1)
