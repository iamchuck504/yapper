# Yapper - one-time setup for a new PC
# Run from the app folder:  powershell -ExecutionPolicy Bypass -File setup.ps1
#
# Everything Yapper needs to transcribe is downloaded here: the whisper.cpp
# binaries for this machine and the models they load. There is no Python and no
# native Node module, so nothing has to be compiled on the user's PC.

$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads far slower

Write-Host "=== Yapper setup ===" -ForegroundColor Cyan

$WHISPER_TAG = 'v1.9.1'
$REL = "https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_TAG"
$MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

function Get-File($url, $dest) {
    if (Test-Path $dest) { return $true }
    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
        return $true
    } catch {
        Write-Host "[X] Download failed: $url" -ForegroundColor Red
        Write-Host "    $($_.Exception.Message)"
        if (Test-Path $dest) { Remove-Item $dest -Force }
        return $false
    }
}

# --- 1. Transcription engine (whisper.cpp) ---
# The CPU build always goes in; it is small and it is the fallback. The CUDA
# build is added on top only when there is an NVIDIA GPU to use it, because it
# is 646 MB of libraries that would sit unused otherwise.
$binCpu = Join-Path $here 'bin\win-x64'
$binGpu = Join-Path $here 'bin\win-x64-gpu'
$tmp = Join-Path $env:TEMP 'yapper-setup'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

if (-not (Test-Path "$binCpu\whisper-server.exe")) {
    Write-Host "Downloading the transcription engine (8 MB)..." -ForegroundColor Yellow
    $zip = Join-Path $tmp 'whisper-bin-x64.zip'
    if (Get-File "$REL/whisper-bin-x64.zip" $zip) {
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        New-Item -ItemType Directory -Force -Path $binCpu | Out-Null
        # the zip nests the files under Release\
        $src = Get-ChildItem $tmp -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
        if ($src) { Copy-Item "$($src.DirectoryName)\*" $binCpu -Force }
    }
}
if (Test-Path "$binCpu\whisper-server.exe") {
    Write-Host "[OK] Transcription engine ready"
} else {
    Write-Host "[X] Could not install the transcription engine" -ForegroundColor Red
    exit 1
}

$gpu = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($gpu -and -not (Test-Path "$binGpu\whisper-server.exe")) {
    Write-Host "NVIDIA GPU detected - downloading the CUDA build (646 MB, one time)..." -ForegroundColor Yellow
    $zip = Join-Path $tmp 'whisper-cublas.zip'
    if (Get-File "$REL/whisper-cublas-12.4.0-bin-x64.zip" $zip) {
        $out = Join-Path $tmp 'cublas'
        Expand-Archive -Path $zip -DestinationPath $out -Force
        New-Item -ItemType Directory -Force -Path $binGpu | Out-Null
        $src = Get-ChildItem $out -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
        if ($src) { Copy-Item "$($src.DirectoryName)\*" $binGpu -Force }
    }
}
if (Test-Path "$binGpu\whisper-server.exe") {
    Write-Host "[OK] GPU acceleration ready"
} elseif (-not $gpu) {
    Write-Host "[--] No NVIDIA GPU - transcription will run on the CPU (slower, but it works)"
}

# --- 2. Models ---
# Only two, on every machine: `small` writes the final transcript and the live
# text where there is a GPU, `base` is what the calibration measures with and
# what slower machines run live. `medium` is deliberately not downloaded - it
# loops on real meeting audio, so it would be 1.5 GB of worse transcripts.
$models = Join-Path $here 'models'
New-Item -ItemType Directory -Force -Path $models | Out-Null

$wanted = @(
    @{ name = 'base';  mb = 142 },
    @{ name = 'small'; mb = 466 }
)

foreach ($m in $wanted) {
    $dest = Join-Path $models "ggml-$($m.name).bin"
    if (Test-Path $dest) { Write-Host "[OK] $($m.name) model already here"; continue }
    Write-Host "Downloading the $($m.name) model ($($m.mb) MB, one time)..." -ForegroundColor Yellow
    if (Get-File "$MODEL_URL/ggml-$($m.name).bin" $dest) {
        Write-Host "[OK] $($m.name) model ready"
    }
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

# --- 3. Node modules / Electron ---
if (-not (Test-Path "$here\node_modules\electron\dist\electron.exe")) {
    Write-Host "Installing Electron..." -ForegroundColor Yellow
    npm install --prefix $here
    if (-not (Test-Path "$here\node_modules\electron\dist\electron.exe")) {
        # postinstall sometimes leaves the zip unextracted; do it manually
        node "$here\node_modules\electron\install.js"
    }
    if (-not (Test-Path "$here\node_modules\electron\dist\electron.exe")) {
        $zip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter *.zip -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($zip) {
            Expand-Archive -Path $zip.FullName -DestinationPath "$here\node_modules\electron\dist" -Force
            Set-Content -Path "$here\node_modules\electron\path.txt" -Value "electron.exe" -NoNewline -Encoding ascii
        }
    }
}
if (Test-Path "$here\node_modules\electron\dist\electron.exe") {
    Write-Host "[OK] Electron ready"
} else {
    Write-Host "[X] Electron could not be installed - check that Node.js is installed (winget install OpenJS.NodeJS.LTS)" -ForegroundColor Red
    exit 1
}

# --- 4. Who writes the notes ---
# Transcription is entirely local and needs nothing else. The notes need a
# model, and there is more than one way to pay for one, so this only reports
# what it finds - the choice lives in the app's settings.
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude -and -not (Test-Path "$env:USERPROFILE\.local\bin\claude.exe")) {
    Write-Host "[--] Claude Code CLI not found. Recording and transcription work without it."
    Write-Host "     For notes, either install it from https://claude.com/code and sign in,"
    Write-Host "     or open Yapper's settings and paste an API key (Anthropic, OpenRouter,"
    Write-Host "     or any OpenAI-compatible endpoint)."
} else {
    Write-Host "[OK] Claude Code CLI found - notes will use it unless you pick otherwise"
}

# --- 5. Desktop shortcut ---
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut("$env:USERPROFILE\Desktop\Yapper.lnk")
$s.TargetPath = "$here\node_modules\electron\dist\electron.exe"
$s.Arguments = "`"$here`""
$s.WorkingDirectory = $here
$s.IconLocation = "$here\build\yapper-mark.ico,0"
$s.Description = "Yapper - AI meeting notes"
$s.Save()
Write-Host "[OK] Desktop shortcut created"

Write-Host ""
Write-Host "Yapper measures this machine the first time it starts, and picks how" -ForegroundColor Gray
Write-Host "big a model the live transcript can afford from what it finds." -ForegroundColor Gray
Write-Host ""
Write-Host "=== Setup complete - launch Yapper from the desktop shortcut ===" -ForegroundColor Green
