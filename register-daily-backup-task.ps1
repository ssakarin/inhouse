param(
  [string]$TaskName = "Inhouse Patient DB Daily Backup",
  [string]$At = "13:30",
  [string]$BackupDir = "",
  [string]$NodeExe = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ScriptPath = Join-Path $Root "server\backup-patients.js"
$LogDir = Join-Path $Root "server\logs"
$LogFile = Join-Path $LogDir "scheduled-backup.log"

if (-not (Test-Path -LiteralPath $ScriptPath)) {
  throw "Backup script not found: $ScriptPath"
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

$time = [datetime]::ParseExact($At, "HH:mm", $null)
$trigger = New-ScheduledTaskTrigger -Daily -At $time

$backupArgs = @("`"$ScriptPath`"")
if ($BackupDir) {
  $backupArgs += "--backup-dir"
  $backupArgs += "`"$BackupDir`""
}

$command = "& `"$NodeExe`" $($backupArgs -join ' ') >> `"$LogFile`" 2>&1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -Command $command" -WorkingDirectory $Root

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

Register-ScheduledTask `
  -TaskName $TaskName `
  -Trigger $trigger `
  -Action $action `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Write-Host "Registered task: $TaskName"
Write-Host "Schedule: daily at $At"
Write-Host "Node: $NodeExe"
Write-Host "Script: $ScriptPath"
Write-Host "BackupDir: $(if ($BackupDir) { $BackupDir } else { Join-Path $Root 'server\backups' })"
Write-Host "Log: $LogFile"
