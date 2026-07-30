# The real-world chain, once: install the shipped installer, seed the engine
# (junctions, no downloads), launch, and read what the updater says against the
# LIVE public feed. Expected on a current version: a clean check, no update.
# Cleans up after itself and puts the dev shortcut back.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

Get-Process Yapper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process -FilePath 'dist\Yapper-Setup-0.1.0.exe' -ArgumentList '/S' -Wait
$exe = "$env:LOCALAPPDATA\Programs\Yapper\Yapper.exe"
Write-Host "ok    instalado $((Get-Item $exe).VersionInfo.ProductVersion)"

$engineHome = "$env:LOCALAPPDATA\Yapper\engine"
New-Item -ItemType Directory -Force -Path $engineHome | Out-Null
foreach ($d in @('bin', 'models')) {
    $link = Join-Path $engineHome $d
    if (-not (Test-Path $link)) { New-Item -ItemType Junction -Path $link -Target (Join-Path $repo $d) | Out-Null }
}

$out = "$env:TEMP\yap-live.txt"
Remove-Item $out -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $exe -RedirectStandardOutput $out
Start-Sleep -Seconds 25
$log = Get-Content $out -Raw -ErrorAction SilentlyContinue
Get-Process Yapper -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
Start-Sleep -Seconds 3
Get-Process Yapper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "--- what the updater said ---"
($log -split "`n") | Where-Object { $_ -match 'update|Checking|available' } | Select-Object -First 5
if ($log -match 'Update for version 0\.1\.0 is not available' -or $log -match 'not available') {
    Write-Host "`nok    the public feed responds and the app knows it is up to date"
} elseif ($log -match '\[update\] check failed') {
    Write-Host "`nFAIL  the check against the real feed failed"
} else {
    Write-Host "`n??    check the full log at $out"
}

powershell -NoProfile -ExecutionPolicy Bypass -File build\e2e-uninstall.ps1
