param(
    [switch]$Package
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

if ($env:OS -ne 'Windows_NT') {
    throw 'This sanity check must run on Windows.'
}

$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logDir = Join-Path ([IO.Path]::GetTempPath()) "yapper-windows-sanity-$stamp-$PID"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Run-Console([string]$Label, [string]$File, [string[]]$Arguments) {
    Write-Host "`n=== $Label ===" -ForegroundColor Cyan
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

function Run-Electron([string]$Name) {
    $script = "build/$Name.js"
    $stdout = Join-Path $logDir "$Name.out.txt"
    $stderr = Join-Path $logDir "$Name.err.txt"
    Write-Host "`n=== $Name ===" -ForegroundColor Cyan

    $process = Start-Process -FilePath $electron -ArgumentList $script `
        -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
        -PassThru -Wait

    if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout -Encoding UTF8 }
    if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Encoding UTF8 }
    if ($process.ExitCode -ne 0) {
        throw "$Name failed with exit code $($process.ExitCode). Logs: $logDir"
    }
}

function Test-InstallerManifest {
    $pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $version = $pkg.version
    $installer = Join-Path $root "dist\Yapper-Setup-$version.exe"
    $blockmap = "$installer.blockmap"
    $manifestPath = Join-Path $root 'dist\latest.yml'
    if (-not (Test-Path -LiteralPath $installer) -or
        -not (Test-Path -LiteralPath $blockmap) -or
        -not (Test-Path -LiteralPath $manifestPath)) {
        throw 'The installer, blockmap, or latest.yml is missing.'
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw
    $manifestVersion = [regex]::Match($manifest, '(?m)^version:\s*(.+)$').Groups[1].Value.Trim()
    $manifestPathValue = [regex]::Match($manifest, '(?m)^path:\s*(.+)$').Groups[1].Value.Trim()
    $manifestSize = [int64][regex]::Match($manifest, '(?m)^\s+size:\s*(\d+)$').Groups[1].Value
    $manifestHash = [regex]::Match($manifest, '(?m)^sha512:\s*(.+)$').Groups[1].Value.Trim()
    $bytes = [IO.File]::ReadAllBytes($installer)
    $actualHash = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($bytes))

    if ($manifestVersion -ne $version -or
        $manifestPathValue -ne "Yapper-Setup-$version.exe" -or
        $manifestSize -ne $bytes.LongLength -or
        $manifestHash -ne $actualHash) {
        throw 'latest.yml does not match the generated Windows installer.'
    }
    Write-Host "ok    latest.yml matches Yapper-Setup-$version.exe byte for byte" -ForegroundColor Green
}

Push-Location $root
try {
    if (-not (Test-Path -LiteralPath $electron)) {
        $electronInstaller = Join-Path $root 'node_modules\electron\install.js'
        if (-not (Test-Path -LiteralPath $electronInstaller)) {
            throw 'Electron is missing. Run npm install first.'
        }
        Run-Console 'Install Electron runtime' 'node.exe' @($electronInstaller)
        if (-not (Test-Path -LiteralPath $electron)) {
            throw 'Electron runtime installation completed without producing electron.exe.'
        }
    }

    Run-Console 'Unit, security, and static parity suite' 'npm.cmd' @('test')
    Run-Console 'Dependency audit' 'npm.cmd' @('audit', '--audit-level=high')
    Run-Electron 'test-keystore'
    Run-Electron 'test-provider-keys'
    Run-Electron 'icon-verify'

    $electronTests = @(
        'test-app-menu',
        'test-tray',
        'test-theme',
        'test-options-ui',
        'test-home-ui',
        'test-smoke',
        'test-recording-signpost',
        'test-bubble-corner',
        'test-record-cycle',
        'test-record-recovery',
        'test-silence-warning',
        'test-two-track-app',
        'test-speakers-ui',
        'test-notes-cancel',
        'test-export',
        'test-import',
        'test-mic-permission-ui'
    )
    foreach ($test in $electronTests) { Run-Electron $test }

    if ($Package) {
        Run-Console 'Unpacked Windows build' 'npx.cmd' `
            @('electron-builder', '--win', '--dir', '--publish', 'never')
        Run-Console 'Packaged-app verification' 'node.exe' `
            @('build/verify-package.js', 'dist/win-unpacked')
        Run-Console 'Windows installer build' 'npm.cmd' `
            @('run', 'dist', '--', '--publish', 'never')
        Test-InstallerManifest
    }

    Write-Host "`nPASS  Windows automated sanity check" -ForegroundColor Green
    Write-Host "Logs: $logDir" -ForegroundColor DarkGray
    Write-Host 'Manual release gates remain: a real two-sided call, notification delivery, NSIS install/update/uninstall, shortcuts, and SmartScreen.' -ForegroundColor Yellow
} finally {
    Pop-Location
}
