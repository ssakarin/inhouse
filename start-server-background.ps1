$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root "server\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/health" -TimeoutSec 2 | Out-Null
  exit 0
} catch {
  # Server is not running yet.
}

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
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Node.js is not installed or not in PATH.", "Inhouse Server") | Out-Null
  exit 1
}

# --- Secrets: change for production. Inherited by the server child process. ---
# $env:CLINIC_REQUIRE_LOGIN = "1"
# $env:CLINIC_PASSWORD = "your-login-password"
$env:CLINIC_DELETE_PASSWORD = "337758"
# $env:CLINIC_KEY_PATH = "C:\clinic-secret\key.bin"
# $env:SLACK_TOKEN = "xoxb-your-slack-bot-token"

Start-Process `
  -FilePath $nodeExe `
  -ArgumentList "server\server.js" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "server.out.log") `
  -RedirectStandardError (Join-Path $logDir "server.err.log")
