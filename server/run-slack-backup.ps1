$ErrorActionPreference = "Stop"

$ServerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ServerDir
$LogDir = Join-Path $ServerDir "logs"
$LogFile = Join-Path $LogDir "slack-backup.log"
$BackupDir = "C:\backup\slack"
$ScriptPath = Join-Path $ServerDir "backup-slack.js"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$nodeCandidates = @(
  (Join-Path $env:ProgramFiles "nodejs\node.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
)

$nodeExe = $nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $nodeExe) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $nodeExe = $nodeCommand.Source
  }
}

if (-not $nodeExe) {
  throw "Node.js executable not found."
}

Set-Location -LiteralPath $Root
& $nodeExe $ScriptPath --backup-dir $BackupDir --retention-days 1095 >> $LogFile 2>&1
