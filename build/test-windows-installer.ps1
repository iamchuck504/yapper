# Exercises the exact release-candidate installer on a disposable Windows host.
# Nothing is published: the baseline reads the package version under test from
# a feed on 127.0.0.1.
param(
    [string]$SetupExe = '',
    [string]$BaselineVersion = '0.1.12'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

if ($env:OS -ne 'Windows_NT') {
    throw 'This installer lifecycle test must run on Windows.'
}

$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$targetVersion = $pkg.version
if (-not $SetupExe) { $SetupExe = "dist\Yapper-Setup-$targetVersion.exe" }
$setup = if ([IO.Path]::IsPathRooted($SetupExe)) { $SetupExe } else { Join-Path $root $SetupExe }
$baselineOut = Join-Path $root 'dist-upgrade-base'
$baselineSetup = Join-Path $baselineOut "Yapper-Setup-$BaselineVersion.exe"
$appDir = Join-Path $env:LOCALAPPDATA 'Programs\Yapper'
$exe = Join-Path $appDir 'Yapper.exe'
$uninstaller = Join-Path $appDir 'Uninstall Yapper.exe'
$settingsDir = Join-Path $env:APPDATA 'Yapper'
$settingsFile = Join-Path $settingsDir 'settings.json'
$documents = [Environment]::GetFolderPath('MyDocuments')
$meetingDir = Join-Path $documents 'Meetings\2099-01-02_0304'
$meetingMarker = Join-Path $meetingDir 'release-candidate-marker.txt'
$sentinel = 'windows-update-state-survived'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Yapper.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Yapper.lnk'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startupApprovedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
$loginValueName = 'com.yapper.meetingnotes'
$serverLog = Join-Path $env:TEMP "yapper-update-feed-$PID.log"
$serverErr = Join-Path $env:TEMP "yapper-update-feed-$PID.err.log"
$server = $null

function Step([string]$Message) {
    Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Confirm([bool]$Condition, [string]$Message, [string]$Detail = '') {
    if (-not $Condition) {
        if ($Detail) { throw "$Message -- $Detail" }
        throw $Message
    }
    Write-Host "ok    $Message" -ForegroundColor Green
}

function Stop-Yapper {
    $running = @(Get-Process Yapper -ErrorAction SilentlyContinue)
    foreach ($process in $running) {
        try { $process.CloseMainWindow() | Out-Null } catch {}
    }
    if ($running.Count) { Start-Sleep -Seconds 4 }
    Get-Process Yapper -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
}

function Installed-Version {
    if (-not (Test-Path -LiteralPath $exe)) { return '' }
    return (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
}

function Shortcut([string]$Path) {
    $shell = New-Object -ComObject WScript.Shell
    return $shell.CreateShortcut($Path)
}

function Registry-ValueExists([string]$Key, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Key)) { return $false }
    return (Get-Item -LiteralPath $Key).GetValueNames() -contains $Name
}

function Registry-Value([string]$Key, [string]$Name) {
    if (-not (Registry-ValueExists $Key $Name)) { return $null }
    return (Get-Item -LiteralPath $Key).GetValue($Name)
}

Push-Location $root
try {
    Step 'Preflight'
    Confirm (Test-Path -LiteralPath $setup) 'release-candidate installer exists' $setup
    Confirm (-not (Test-Path -LiteralPath $exe)) 'runner starts without an installed Yapper'
    Confirm ((Get-Item -LiteralPath $setup).Length -gt 50MB) 'candidate has a plausible installer size'

    Step "Build local-feed baseline $BaselineVersion"
    $env:UP_VERSION = $BaselineVersion
    $env:UP_OUT = $baselineOut
    & npx.cmd electron-builder --win --config build\e2e-update.config.js --publish never
    if ($LASTEXITCODE -ne 0) { throw "baseline build failed with exit code $LASTEXITCODE" }
    $env:UP_VERSION = $null
    $env:UP_OUT = $null
    Confirm (Test-Path -LiteralPath $baselineSetup) "baseline installer $BaselineVersion exists"

    Step "Install baseline $BaselineVersion as the current user"
    $install = Start-Process -FilePath $baselineSetup -ArgumentList '/S' -PassThru -Wait
    Confirm ($install.ExitCode -eq 0) 'silent NSIS install exits successfully' "exit $($install.ExitCode)"
    Confirm (Test-Path -LiteralPath $exe) 'NSIS installs under LOCALAPPDATA\Programs\Yapper'
    Confirm ((Installed-Version) -like "$BaselineVersion*") 'installed baseline has the expected ProductVersion' (Installed-Version)
    Confirm (Test-Path -LiteralPath (Join-Path $appDir 'resources\app.asar')) 'installed app.asar exists'
    Confirm (Test-Path -LiteralPath (Join-Path $appDir 'resources\app.asar.unpacked\build\calibration.wav')) 'calibration audio is unpacked'
    $baselineFeed = Get-Content -LiteralPath (Join-Path $appDir 'resources\app-update.yml') -Raw
    Confirm ($baselineFeed -match '127\.0\.0\.1:8123') 'baseline points only at the local update feed'
    Confirm (Test-Path -LiteralPath $startMenu) 'Start menu shortcut exists'
    Confirm (Test-Path -LiteralPath $desktop) 'desktop shortcut exists'
    Confirm ((Shortcut $startMenu).TargetPath -eq $exe) 'Start menu shortcut targets the installed executable'
    Confirm ((Shortcut $desktop).TargetPath -eq $exe) 'desktop shortcut targets the installed executable'

    Step 'Seed state that must survive update and uninstall'
    New-Item -ItemType Directory -Force -Path $settingsDir, $meetingDir | Out-Null
    $utf8 = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($settingsFile,
        (@{ theme = 'light'; sentinel = $sentinel } | ConvertTo-Json), $utf8)
    [IO.File]::WriteAllText($meetingMarker, $sentinel, $utf8)
    Confirm (Test-Path -LiteralPath $meetingMarker) 'meeting marker exists outside the app bundle'

    Step "Serve the exact $targetVersion candidate on 127.0.0.1"
    Remove-Item $serverLog, $serverErr -Force -ErrorAction SilentlyContinue
    $server = Start-Process -FilePath 'node.exe' -ArgumentList @('build\e2e-update-server.js', 'dist') `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr
    Start-Sleep -Seconds 2
    Confirm (-not $server.HasExited) 'isolated update server is running'

    Step "Launch $BaselineVersion and download $targetVersion"
    Start-Process -FilePath $exe | Out-Null
    $deadline = (Get-Date).AddSeconds(180)
    $downloaded = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $log = Get-Content $serverLog -Raw -ErrorAction SilentlyContinue
        if ($log -match "served .*Yapper-Setup-$([regex]::Escape($targetVersion))\.exe") {
            $downloaded = $true
            break
        }
    }
    Confirm $downloaded "the updater requested the exact $targetVersion installer" ((Get-Content $serverLog -Raw -ErrorAction SilentlyContinue))
    $settings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
    Confirm ($settings.sentinel -eq $sentinel -and $settings.theme -eq 'light') 'application startup preserves existing settings'
    Confirm ($settings.openAtLogin -eq $true) 'Start with Windows defaults on for a fresh profile'
    Confirm (Registry-ValueExists $runKey $loginValueName) 'the app ID is registered in the current-user Run key'
    Confirm ([string](Registry-Value $runKey $loginValueName) -match [regex]::Escape($exe)) 'the Run value targets the installed executable'

    Start-Sleep -Seconds 10
    Step "Quit and apply $targetVersion"
    Stop-Yapper
    $deadline = (Get-Date).AddSeconds(180)
    $updatedVersion = Installed-Version
    while ((Get-Date) -lt $deadline -and $updatedVersion -notlike "$targetVersion*") {
        Start-Sleep -Seconds 5
        $updatedVersion = Installed-Version
    }
    Confirm ($updatedVersion -like "$targetVersion*") "auto-update installed ProductVersion $targetVersion" $updatedVersion
    Confirm (Test-Path -LiteralPath $settingsFile) 'settings remain after the in-place update'
    $updatedSettings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
    Confirm ($updatedSettings.sentinel -eq $sentinel -and $updatedSettings.theme -eq 'light') 'settings content survives the in-place update'
    Confirm ((Get-Content -LiteralPath $meetingMarker -Raw).Trim() -eq $sentinel) 'meeting content survives the in-place update'

    $versionInfo = (Get-Item -LiteralPath $exe).VersionInfo
    Confirm ($versionInfo.ProductVersion -like "$targetVersion*") 'updated EXE ProductVersion is correct' $versionInfo.ProductVersion
    Confirm ($versionInfo.FileVersion -like "$targetVersion*") 'updated EXE FileVersion is correct' $versionInfo.FileVersion
    Confirm ($versionInfo.ProductName -eq 'Yapper') 'updated EXE ProductName is Yapper' $versionInfo.ProductName
    $releaseFeed = Get-Content -LiteralPath (Join-Path $appDir 'resources\app-update.yml') -Raw
    Confirm ($releaseFeed -match 'owner:\s*iamchuck504' -and $releaseFeed -match 'repo:\s*yapper-releases') 'updated app points back to the production GitHub feed'
    Confirm ((Shortcut $startMenu).TargetPath -eq $exe) 'Start menu shortcut still targets the updated executable'
    Confirm ((Shortcut $desktop).TargetPath -eq $exe) 'desktop shortcut still targets the updated executable'

    Step 'Launch the exact installed candidate'
    Start-Process -FilePath $exe | Out-Null
    Start-Sleep -Seconds 12
    $running = @(Get-Process Yapper -ErrorAction SilentlyContinue)
    Confirm ($running.Count -gt 0) "installed $targetVersion remains running after startup"
    Confirm (Registry-ValueExists $runKey $loginValueName) 'Start with Windows retains the app ID after update'
    Confirm ([string](Registry-Value $runKey $loginValueName) -match [regex]::Escape($exe)) 'Start with Windows still targets the updated executable'

    $uninstallEntry = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'Yapper*' -and $_.UninstallString -match [regex]::Escape($appDir) })
    Confirm ($uninstallEntry.Count -gt 0) 'Yapper is registered as a per-user installed application'
    Confirm (Test-Path -LiteralPath $uninstaller) 'NSIS uninstaller exists'

    Step 'Silent uninstall and preservation checks'
    Stop-Yapper
    $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
    Confirm ($remove.ExitCode -eq 0) 'silent NSIS uninstall exits successfully' "exit $($remove.ExitCode)"
    Start-Sleep -Seconds 4
    Confirm (-not (Test-Path -LiteralPath $exe)) 'installed executable is removed'
    Confirm (-not (Test-Path -LiteralPath $startMenu)) 'Start menu shortcut is removed'
    Confirm (-not (Test-Path -LiteralPath $desktop)) 'desktop shortcut is removed'
    Confirm (-not (Registry-ValueExists $runKey $loginValueName)) 'Start with Windows registration is removed'
    Confirm (-not (Registry-ValueExists $startupApprovedKey $loginValueName)) 'Start with Windows approval metadata is removed'
    Confirm (Test-Path -LiteralPath $settingsFile) 'settings are preserved by uninstall'
    Confirm ((Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json).sentinel -eq $sentinel) 'preserved settings retain their content'
    Confirm ((Get-Content -LiteralPath $meetingMarker -Raw).Trim() -eq $sentinel) 'meetings are preserved by uninstall'
    Confirm (Test-Path -LiteralPath $setup) 'release-candidate installer remains unchanged after the lifecycle'

    Write-Host "`nPASS  exact Windows installer/update/uninstall lifecycle" -ForegroundColor Green
} finally {
    $env:UP_VERSION = $null
    $env:UP_OUT = $null
    Stop-Yapper
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
    Pop-Location
}
