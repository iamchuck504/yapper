# electron-builder's winCodeSign archive contains two macOS dylib symlinks that
# Windows refuses to create without special privileges, which kills the whole
# extraction. The Windows tools inside (rcedit, signtool) extract fine. This
# finishes the job by hand: extract each downloaded archive into its cache slot
# with electron-builder's own 7za, accept the two symlink failures, and verify
# the tools that actually matter are there.
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$sevenZa = Join-Path $repo 'node_modules\7zip-bin\win\x64\7za.exe'
$cache = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"

if (-not (Test-Path $sevenZa)) { Write-Host "FAIL no 7za at $sevenZa"; exit 1 }

$archives = Get-ChildItem $cache -Filter '*.7z'
if (-not $archives) { Write-Host "FAIL no .7z files in $cache"; exit 1 }

foreach ($a in $archives) {
    $slot = Join-Path $cache ([IO.Path]::GetFileNameWithoutExtension($a.Name))
    Write-Host ("extrayendo {0} -> {1}" -f $a.Name, (Split-Path $slot -Leaf))
    & $sevenZa x $a.FullName "-o$slot" -y -bso0 -bsp0 2>$null
    Write-Host ("  exit {0} (2 = only the macOS symlinks failed)" -f $LASTEXITCODE)
    $rcedit = Get-ChildItem $slot -Recurse -Filter 'rcedit-x64.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($rcedit) { Write-Host "  ok  rcedit-x64.exe presente" }
    else { Write-Host "  FAIL no rcedit in $slot" }
}
Write-Host "listo"
