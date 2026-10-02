param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$encodedText = [Console]::ReadLine()
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedText))
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ko-KR' } | Select-Object -First 1
  if (!$voice) { throw 'Korean voice unavailable' }
  $synth.SelectVoice($voice.VoiceInfo.Name)
  $synth.Rate = -1
  $synth.Volume = 100
  $synth.SetOutputToWaveFile($OutputPath)
  $synth.Speak($text)
} finally { $synth.Dispose() }
