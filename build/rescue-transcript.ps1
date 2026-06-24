# Transcribe a meeting folder from the command line and save transcript.txt
param([string]$Folder)

$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$audio = Get-ChildItem $Folder -Filter 'recording.*' | Select-Object -First 1
if (-not $audio) { Write-Error "no recording in $Folder"; exit 1 }

$out = & python "$PSScriptRoot\..\transcribe.py" $audio.FullName
if ($LASTEXITCODE -ne 0) { Write-Error "transcription failed"; exit 1 }

$text = ($out -join "`n").Trim()
[System.IO.File]::WriteAllText((Join-Path $Folder 'transcript.txt'), $text, (New-Object System.Text.UTF8Encoding $false))
Write-Output "transcript saved: $(($out | Measure-Object).Count) lines"
