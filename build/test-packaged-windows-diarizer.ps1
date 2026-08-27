param(
    [string]$AppPath = 'dist\win-unpacked'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$stdout = Join-Path ([IO.Path]::GetTempPath()) "yapper-packaged-diarizer-$PID.out.txt"
$stderr = Join-Path ([IO.Path]::GetTempPath()) "yapper-packaged-diarizer-$PID.err.txt"

Push-Location $root
try {
    $process = Start-Process -FilePath $electron `
        -ArgumentList @('build/test-windows-diarizer.js', $AppPath) `
        -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
        -PassThru -Wait
    if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout -Encoding UTF8 }
    if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Encoding UTF8 }
    if ($process.ExitCode -ne 0) {
        throw "Packaged Windows diarizer failed with exit code $($process.ExitCode)."
    }
} finally {
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
    Pop-Location
}
