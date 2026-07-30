# The whole auto-update loop, proven locally: install v0.1.0 whose feed is a
# local server, put v0.1.1 on that server, launch, let electron-updater find
# and download it, quit the app, and check that what is installed afterwards
# is v0.1.1. No network beyond 127.0.0.1, nothing published.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

Step "building v0.1.0 and v0.1.1 (local feed)"
$env:UP_VERSION = '0.1.0'; $env:UP_OUT = 'dist-up-a'
npx electron-builder --win --config build\e2e-update.config.js | Out-Null
$env:UP_VERSION = '0.1.1'; $env:UP_OUT = 'dist-up-b'
npx electron-builder --win --config build\e2e-update.config.js | Out-Null
$env:UP_VERSION = $null; $env:UP_OUT = $null
if (-not (Test-Path 'dist-up-a\Yapper-Setup-0.1.0.exe')) { Write-Host 'FAIL sin build A'; exit 1 }
if (-not (Test-Path 'dist-up-b\Yapper-Setup-0.1.1.exe')) { Write-Host 'FAIL sin build B'; exit 1 }
Write-Host 'ok    ambos builds listos'

Step "instalando v0.1.0"
Get-Process Yapper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process -FilePath 'dist-up-a\Yapper-Setup-0.1.0.exe' -ArgumentList '/S' -Wait
$exe = "$env:LOCALAPPDATA\Programs\Yapper\Yapper.exe"
$v0 = (Get-Item $exe).VersionInfo.ProductVersion
Write-Host "ok    instalado: $v0"
if ($v0 -notmatch '^0\.1\.0') { Write-Host 'FAIL the baseline is not 0.1.0'; exit 1 }

Step "serving v0.1.1 on 127.0.0.1:8123"
$server = Start-Process -FilePath 'node' -ArgumentList 'build\e2e-update-server.js', 'dist-up-b' -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\upfeed.txt"
Start-Sleep -Seconds 2

Step "launching the app; the updater should find and download v0.1.1"
Start-Process -FilePath $exe
$deadline = (Get-Date).AddSeconds(90)
$downloaded = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  $log = Get-Content "$env:TEMP\upfeed.txt" -Raw -ErrorAction SilentlyContinue
  if ($log -match 'served .*\.exe') { $downloaded = $true; break }
}
$feedLog = (Get-Content "$env:TEMP\upfeed.txt" -ErrorAction SilentlyContinue) -join ' | '
Write-Host "      feed: $feedLog"
Write-Host ("{0}    the updater requested the new installer" -f ($(if ($downloaded) { 'ok  ' } else { 'FAIL' })))
Start-Sleep -Seconds 8   # let the download land and update-downloaded fire

Step "closing the app (autoInstallOnAppQuit does the rest)"
Get-Process Yapper -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
$deadline = (Get-Date).AddSeconds(120)
$v1 = $v0
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 5
  $alive = Get-Process Yapper -ErrorAction SilentlyContinue
  try { $v1 = (Get-Item $exe -ErrorAction Stop).VersionInfo.ProductVersion } catch { continue }
  if (-not $alive -and $v1 -match '^0\.1\.1') { break }
}
Write-Host ("{0}    version instalada tras cerrar: {1}" -f ($(if ($v1 -match '^0\.1\.1') { 'ok  ' } else { 'FAIL' })), $v1)

Step "limpieza"
Get-Process Yapper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
if ($downloaded -and $v1 -match '^0\.1\.1') { Write-Host "`nPASS"; exit 0 } else { Write-Host "`nFALLO"; exit 1 }
