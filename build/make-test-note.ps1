Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1
if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }
$out = Join-Path $env:USERPROFILE 'Downloads\test-voice-note.wav'
$synth.SetOutputToWaveFile($out)
$synth.Speak("Reminder for tomorrow. Call the bank about the credit card, finish the dashboard demo for the client, and buy groceries on the way home. Also, ask Troy about the design framework he mentioned.")
$synth.Dispose()
Write-Output "voice note: $out"
