# Removes everything the install/update E2Es left on this machine and puts the
# development desktop shortcut back (the NSIS installer overwrites it).
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent

Get-Process Yapper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$un = "$env:LOCALAPPDATA\Programs\Yapper\Uninstall Yapper.exe"
if (Test-Path $un) {
    Start-Process -FilePath $un -ArgumentList '/S' -Wait
    Start-Sleep -Seconds 3
    Write-Host "ok    desinstalado"
}
foreach ($d in @("$env:LOCALAPPDATA\Programs\Yapper", "$env:LOCALAPPDATA\Yapper", "$env:APPDATA\Yapper")) {
    if (Test-Path $d) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Host "ok    no leftovers in LOCALAPPDATA/APPDATA"

# the dev shortcut, exactly as setup.ps1 writes it
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut("$env:USERPROFILE\Desktop\Yapper.lnk")
$s.TargetPath = "$repo\node_modules\electron\dist\electron.exe"
$s.Arguments = "`"$repo`""
$s.WorkingDirectory = $repo
$s.IconLocation = "$repo\build\yapper-icon.ico,0"
$s.Description = "Yapper - AI meeting notes"
$s.Save()
Write-Host "ok    development shortcut restored"
