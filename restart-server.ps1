$ErrorActionPreference = "SilentlyContinue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8787

# --- Stop the running server -------------------------------------------------
$targets = @()

# Processes listening on the server port.
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conns) { $targets += $conns.OwningProcess }

# Fallback: node processes whose command line runs this project's server.js.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*server\server.js*' } |
  ForEach-Object { $targets += $_.ProcessId }

foreach ($procId in ($targets | Sort-Object -Unique)) {
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}

# Wait (up to ~5s) for the port to be released before restarting.
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 250
  if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
}

# --- Start it again ----------------------------------------------------------
# start-server-background.ps1 sets the env vars (passwords) and launches node;
# its built-in "already running" guard is now a no-op because we just stopped it.
& (Join-Path $root "start-server-background.ps1")
