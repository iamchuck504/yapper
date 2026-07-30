# Installs the built Yapper-Setup exe silently, seeds the engine with
# junctions to the repo's bin/models (so nothing re-downloads), launches the
# installed app, and reports what a fresh user would get. Cleans up with
# e2e-uninstall.ps1.
param([string]$SetupExe = "dist\Yapper-Setup-0.1.0.exe")

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$setup = Join-Path $repo $SetupExe

if (-not (Test-Path $setup)) { Write-Host "FAIL no existe $setup"; exit 1 }
Write-Host ("instalador: {0}  {1:N1} MB" -f (Split-Path $setup -Leaf), ((Get-Item $setup).Length / 1MB))

# 1. silent install (per-user, no admin)
Start-Process -FilePath $setup -ArgumentList '/S' -Wait
$appDir = "$env:LOCALAPPDATA\Programs\Yapper"
$exe = "$appDir\Yapper.exe"
if (-not (Test-Path $exe)) { Write-Host "FAIL did not install into $appDir"; exit 1 }
Write-Host "ok    installed into $appDir"

# 2. what did it install?
$asar = "$appDir\resources\app.asar"
Write-Host ("ok    app.asar {0:N1} MB" -f ((Get-Item $asar).Length / 1MB))
$unpackedWav = "$appDir\resources\app.asar.unpacked\build\calibration.wav"
if (Test-Path $unpackedWav) { Write-Host "ok    calibration.wav left unpacked (the server can read it)" }
else { Write-Host "FAIL calibration.wav is not unpacked"; exit 1 }
if (Test-Path "$appDir\resources\app-update.yml") {
  $feed = (Get-Content "$appDir\resources\app-update.yml" -Raw)
  Write-Host "ok    app-update.yml present (the updater knows where to look)"
  Write-Host ("      " + (($feed -split "`n" | Select-Object -First 3) -join ' | '))
} else { Write-Host "FAIL no app-update.yml - the updater would have no feed"; exit 1 }

# 3. shortcuts
$sm = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Yapper.lnk"
$dk = "$env:USERPROFILE\Desktop\Yapper.lnk"
Write-Host ("{0}    Start menu shortcut" -f ($(if (Test-Path $sm) { 'ok  ' } else { 'FAIL' })))
Write-Host ("{0}    Desktop shortcut" -f ($(if (Test-Path $dk) { 'ok  ' } else { 'FAIL' })))

# 4. seed the engine: junctions into the repo copies (instant, no downloads)
$engineHome = "$env:LOCALAPPDATA\Yapper\engine"
New-Item -ItemType Directory -Force -Path $engineHome | Out-Null
foreach ($d in @('bin', 'models')) {
  $link = Join-Path $engineHome $d
  if (-not (Test-Path $link)) {
    New-Item -ItemType Junction -Path $link -Target (Join-Path $repo $d) | Out-Null
  }
}
Write-Host "ok    engine seeded by junction (nothing downloaded)"

# 5. launch the installed app; calibration writes settings when the engine works
$settings = "$env:APPDATA\Yapper\settings.json"
if (Test-Path $settings) { Remove-Item $settings -Force }
Start-Process -FilePath $exe
$deadline = (Get-Date).AddSeconds(75)
$tier = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (Test-Path $settings) {
    try { $tier = (Get-Content $settings -Raw | ConvertFrom-Json).tier } catch {}
    if ($tier) { break }
  }
}
$proc = Get-Process Yapper -ErrorAction SilentlyContinue
Write-Host ("{0}    the installed app is running ({1} processes)" -f ($(if ($proc) { 'ok  ' } else { 'FAIL' })), (@($proc).Count))
if ($tier) { Write-Host "ok    found the engine and calibrated: tier '$tier'" }
else { Write-Host "FAIL  never wrote settings with a tier (engine not found, or the app is broken)" }

if ($proc -and $tier) { Write-Host "`nPASS" } else { Write-Host "`nFALLO"; exit 1 }
