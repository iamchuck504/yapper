# Yapper - one-time setup for a new PC
# Run from the app folder:  powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
Write-Host "=== Yapper setup ===" -ForegroundColor Cyan

# --- 1. Python ---
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Host "[X] Python not found. Install it first:" -ForegroundColor Red
    Write-Host "    winget install Python.Python.3.12"
    Write-Host "    then re-run this script."
    exit 1
}
Write-Host "[OK] Python: $((python --version) 2>&1)"

# --- 2. faster-whisper ---
python -c "import faster_whisper" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing faster-whisper (one time)..." -ForegroundColor Yellow
    python -m pip install faster-whisper
}
Write-Host "[OK] faster-whisper installed"

# --- 3. GPU acceleration (optional, NVIDIA only) ---
$gpu = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($gpu) {
    python -c "import nvidia" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "NVIDIA GPU detected - installing CUDA libraries (~1.2 GB, one time)..." -ForegroundColor Yellow
        python -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 --no-cache-dir
    }
    Write-Host "[OK] GPU acceleration ready"
} else {
    Write-Host "[--] No NVIDIA GPU detected - transcription will run on CPU (slower but works)"
}

# --- 4. Whisper model (pre-download so the first meeting is not slow) ---
Write-Host "Downloading Whisper model (~460 MB, one time)..." -ForegroundColor Yellow
python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"
Write-Host "[OK] Whisper model ready"

# --- 5. Node modules / Electron ---
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

# --- 6. Claude Code CLI (for note generation) ---
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude -and -not (Test-Path "$env:USERPROFILE\.local\bin\claude.exe")) {
    Write-Host "[!] Claude Code CLI not found. Transcription works without it, but" -ForegroundColor Yellow
    Write-Host "    note generation needs it: install from https://claude.com/code and sign in."
} else {
    Write-Host "[OK] Claude Code CLI found"
}

# --- 7. Desktop shortcut ---
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut("$env:USERPROFILE\Desktop\Yapper.lnk")
$s.TargetPath = "$here\node_modules\electron\dist\electron.exe"
$s.Arguments = "`"$here`""
$s.WorkingDirectory = $here
$s.IconLocation = "$here\build\yapper-icon.ico,0"
$s.Description = "Yapper - AI meeting notes"
$s.Save()
Write-Host "[OK] Desktop shortcut created"

Write-Host ""
Write-Host "=== Setup complete - launch Yapper from the desktop shortcut ===" -ForegroundColor Green
