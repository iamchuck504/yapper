# Runs a list of Electron suites one at a time and prints one line each.
# Usage: run-battery.ps1 -Tests test-theme,test-smoke
param([string[]]$Tests)

# powershell -File passes "a,b,c" as one literal string; split it back
$Tests = $Tests -split ','

$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$exe = "node_modules\electron\dist\electron.exe"

foreach ($t in $Tests) {
    $out = "$env:TEMP\bat-$t.txt"
    Remove-Item $out -Force -ErrorAction SilentlyContinue
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $exe -ArgumentList "build\$t.js" -RedirectStandardOutput $out -PassThru
    if (-not $p.WaitForExit(420000)) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        Write-Host ("HANG  {0}  ({1:N0}s)" -f $t, $sw.Elapsed.TotalSeconds)
        continue
    }
    $tail = (Get-Content $out -ErrorAction SilentlyContinue | Where-Object { $_ -match 'PASS|fall|failure|skip' } | Select-Object -Last 1)
    $fails = (Get-Content $out -ErrorAction SilentlyContinue | Select-String -Pattern '^FAIL' | Measure-Object).Count
    $verdict = if ($tail -match 'PASS') { 'PASS' } elseif ($tail -match 'skip') { 'SKIP' } else { "FALLO($fails)" }
    Write-Host ("{0,-10} {1}  ({2:N0}s)  {3}" -f $verdict, $t, $sw.Elapsed.TotalSeconds, $(if ($verdict -ne 'PASS') { "-> $out" } else { '' }))
}
