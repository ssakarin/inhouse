param(
  [string]$TaskName = "Inhouse Slack Quarterly Backup",
  [string]$At = "13:30",
  [int]$DayOfMonth = 1,
  [int]$MonthInterval = 3,
  [string]$BackupDir = "",
  [string]$NodeExe = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ScriptPath = Join-Path $Root "server\backup-slack.js"
$LogDir = Join-Path $Root "server\logs"
$LogFile = Join-Path $LogDir "slack-backup.log"

if (-not (Test-Path -LiteralPath $ScriptPath)) {
  throw "Slack backup script not found: $ScriptPath"
}

if ($DayOfMonth -lt 1 -or $DayOfMonth -gt 31) {
  throw "DayOfMonth must be between 1 and 31."
}

if ($MonthInterval -lt 1 -or $MonthInterval -gt 12) {
  throw "MonthInterval must be between 1 and 12."
}

if (-not $NodeExe) {
  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
  )
  $NodeExe = ($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1)
  if (-not $NodeExe) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $NodeExe = $cmd.Source }
  }
}

if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe)) {
  throw "Node.js executable not found. Install Node.js or pass -NodeExe."
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if (-not $BackupDir) {
  $BackupDir = Join-Path $Root "slack_backups"
}
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$escapedRoot = $Root.Replace("'", "''")
$escapedNodeExe = $NodeExe.Replace("'", "''")
$escapedScriptPath = $ScriptPath.Replace("'", "''")
$escapedBackupDir = $BackupDir.Replace("'", "''")
$escapedLogFile = $LogFile.Replace("'", "''")
$command = "Set-Location -LiteralPath '$escapedRoot'; & '$escapedNodeExe' '$escapedScriptPath' --backup-dir '$escapedBackupDir' --retention-days 1095 >> '$escapedLogFile' 2>&1"
$taskRun = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `"$command`""

$schtasksArgs = @(
  "/Create",
  "/TN", $TaskName,
  "/SC", "MONTHLY",
  "/MO", $MonthInterval,
  "/D", $DayOfMonth,
  "/ST", $At,
  "/TR", $taskRun,
  "/RL", "HIGHEST",
  "/F"
)

& schtasks.exe @schtasksArgs | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to register scheduled task with schtasks.exe (exit code $LASTEXITCODE)."
}

Write-Host "Registered task: $TaskName"
Write-Host "Schedule: every $MonthInterval month(s) on day $DayOfMonth at $At"
Write-Host "Node: $NodeExe"
Write-Host "Script: $ScriptPath"
Write-Host "BackupDir: $BackupDir"
Write-Host "Retention: delete slack text backups older than 1095 days"
Write-Host "Log: $LogFile"
Write-Host "Requires SLACK_TOKEN user or system environment variable."
