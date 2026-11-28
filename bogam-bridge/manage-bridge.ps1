param(
    [ValidateSet('Start','Stop','Restart','Status','EnableStartup','DisableStartup')]
    [string]$Action = 'Start',
    [string]$ConfigPath,
    [string]$StartupDirectory,
    [switch]$WaitForNetwork
)
$ErrorActionPreference = 'Stop'
$managedMutex = $null
$mutexAcquired = $false
try {
    if (-not $ConfigPath) {
        if ($env:BOGAM_BRIDGE_CONFIG) { $ConfigPath = $env:BOGAM_BRIDGE_CONFIG }
        else { $ConfigPath = Join-Path $env:LOCALAPPDATA 'InhouseBogamBridge\bridge.json' }
    }
    $ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'CONFIG_NOT_FOUND' }
    $bridgeEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'bridge.js'))
    if (-not (Test-Path -LiteralPath $bridgeEntry -PathType Leaf)) { throw 'BRIDGE_NOT_FOUND' }
    $config = [IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
    $listenPort = 0
    if (-not [int]::TryParse([string]$config.port, [ref]$listenPort) -or $listenPort -lt 1024 -or $listenPort -gt 65535) { throw 'INVALID_PORT' }
    $runtimeDirectory = Join-Path (Split-Path -Parent $ConfigPath) 'runtime'
    [void](New-Item -ItemType Directory -Force -Path $runtimeDirectory)
    $pidFile = Join-Path $runtimeDirectory 'bridge-process.json'
    $utf8 = New-Object Text.UTF8Encoding($false)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ConfigPath.ToLowerInvariant()))).Replace('-','') }
    finally { $sha.Dispose() }
    $managedMutex = New-Object Threading.Mutex($false, "Local\InhouseBogamBridge-$digest")
    try { $mutexAcquired = $managedMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $mutexAcquired = $true }
    if (-not $mutexAcquired) { throw 'ANOTHER_LIFECYCLE_ACTION_RUNNING' }

    function Get-ManagedBridge {
        if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return $null }
        try {
            $saved = [IO.File]::ReadAllText($pidFile) | ConvertFrom-Json
            if ([string]$saved.bridgePath -ne $bridgeEntry) { return $null }
            $managed = Get-Process -Id ([int]$saved.processId) -ErrorAction Stop
            if ($managed.ProcessName -ne 'node' -or [string]$managed.StartTime.ToUniversalTime().Ticks -ne [string]$saved.startedTicks) { return $null }
            $details = Get-CimInstance Win32_Process -Filter "ProcessId=$($managed.Id)" -ErrorAction Stop
            $entryPattern = '(?i)(?:^|\s)"?' + [regex]::Escape($bridgeEntry) + '"?(?:\s|$)'
            if ($details.CommandLine -notmatch $entryPattern) { return $null }
            return $managed
        } catch { return $null }
    }
    function Clear-ProcessFile {
        if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
    }
    function Stop-Bridge {
        $managed = Get-ManagedBridge
        if ($managed) {
            # Only this bridge's recorded PID + start time + exact script path.
            # Never stop all Node processes, Donguibogam or SQL Server.
            $queryEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'query.ps1'))
            $queryPattern = '(?i)(?:^|\s)"?' + [regex]::Escape($queryEntry) + '"?(?:\s|$)'
            Get-CimInstance Win32_Process -Filter "ParentProcessId=$($managed.Id)" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -match $queryPattern } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
            $managed.Kill()
            if (-not $managed.WaitForExit(5000)) { throw 'BRIDGE_STOP_TIMEOUT' }
            Clear-ProcessFile
            Write-Output 'BRIDGE_STOPPED'
        } else {
            Clear-ProcessFile
            Write-Output 'BRIDGE_NOT_MANAGED_OR_ALREADY_STOPPED'
        }
    }
    function Start-Bridge {
        $managed = Get-ManagedBridge
        if ($managed) { Write-Output 'BRIDGE_ALREADY_RUNNING'; return }
        Clear-ProcessFile
        if ($WaitForNetwork -and $config.listenHost -and $config.listenHost -notin @('127.0.0.1','0.0.0.0','::1','::')) {
            $addressReady = $false
            for ($attempt = 0; $attempt -lt 30; $attempt++) {
                if (Get-NetIPAddress -IPAddress $config.listenHost -ErrorAction SilentlyContinue) { $addressReady = $true; break }
                Start-Sleep -Seconds 1
            }
            if (-not $addressReady) { throw 'LOCAL_ADDRESS_NOT_READY' }
        }
        # A manually launched foreground copy must first be closed with Ctrl+C.
        # Do not guess process ownership from a port or kill another program.
        if (Get-NetTCPConnection -LocalPort $listenPort -State Listen -ErrorAction SilentlyContinue) { throw 'PORT_IN_USE_CLOSE_OLD_BRIDGE_WINDOW_WITH_CTRL_C' }
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $nodeCommand) { throw 'NODE_NOT_FOUND' }
        $env:BOGAM_BRIDGE_CONFIG = $ConfigPath
        $stdoutFile = Join-Path $runtimeDirectory 'bridge.out.log'
        $stderrFile = Join-Path $runtimeDirectory 'bridge.err.log'
        foreach ($logFile in @($stdoutFile,$stderrFile)) {
            if (Test-Path -LiteralPath $logFile) { Move-Item -LiteralPath $logFile -Destination ($logFile + '.previous') -Force }
        }
        $managed = Start-Process -FilePath $nodeCommand.Source -ArgumentList ('"' + $bridgeEntry + '"') -WorkingDirectory (Split-Path -Parent $PSScriptRoot) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        $saved = @{ processId=$managed.Id; startedTicks=[string]$managed.StartTime.ToUniversalTime().Ticks; bridgePath=$bridgeEntry }
        [IO.File]::WriteAllText($pidFile, (ConvertTo-Json $saved -Compress), $utf8)
        # Readiness checks inspect the local TCP listener, not an HTTP/SQL query.
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $managed.Refresh()
            if ($managed.HasExited) { Clear-ProcessFile; throw 'BRIDGE_START_FAILED_CHECK_RUNTIME_LOG' }
            $listener = Get-NetTCPConnection -LocalPort $listenPort -State Listen -ErrorAction SilentlyContinue
            if ($listener | Where-Object { $_.OwningProcess -eq $managed.Id }) { Write-Output 'BRIDGE_READY_NO_DATABASE_QUERY_EXECUTED'; return }
            Start-Sleep -Milliseconds 250
        }
        Stop-Bridge
        throw 'BRIDGE_START_TIMEOUT'
    }
    function Startup-LinkPath {
        if (-not $StartupDirectory) { $script:StartupDirectory = [Environment]::GetFolderPath('Startup') }
        if (-not $StartupDirectory -or -not (Test-Path -LiteralPath $StartupDirectory -PathType Container)) { throw 'STARTUP_FOLDER_NOT_FOUND' }
        return Join-Path $StartupDirectory 'InhouseBogamBridge.lnk'
    }
    function Open-OwnedShortcut($linkPath) {
        if (-not (Test-Path -LiteralPath $linkPath)) { return $null }
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($linkPath)
        if ($link.Description -ne 'Inhouse Bogam SELECT-only bridge' -or $link.Arguments.IndexOf($PSCommandPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'UNRELATED_STARTUP_SHORTCUT_NOT_CHANGED' }
        return $link
    }
    switch ($Action) {
        'Start' { Start-Bridge }
        'Stop' { Stop-Bridge }
        'Restart' { Stop-Bridge; Start-Bridge }
        'Status' {
            if (Get-ManagedBridge) { Write-Output 'BRIDGE_RUNNING' }
            else { Write-Output 'BRIDGE_STOPPED_OR_MANUALLY_STARTED' }
        }
        'EnableStartup' {
            $linkPath = Startup-LinkPath
            [void](Open-OwnedShortcut $linkPath)
            $shell = New-Object -ComObject WScript.Shell
            $link = $shell.CreateShortcut($linkPath)
            $link.TargetPath = Join-Path $PSHOME 'powershell.exe'
            $link.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + $PSCommandPath + '" -Action Start -WaitForNetwork -ConfigPath "' + $ConfigPath + '"'
            $link.WorkingDirectory = Split-Path -Parent $PSScriptRoot
            $link.WindowStyle = 7
            $link.Description = 'Inhouse Bogam SELECT-only bridge'
            $link.Save()
            Write-Output 'STARTUP_ENABLED_FOR_CURRENT_WINDOWS_USER_NO_DATABASE_QUERY'
        }
        'DisableStartup' {
            $linkPath = Startup-LinkPath
            if (Open-OwnedShortcut $linkPath) { Remove-Item -LiteralPath $linkPath -Force }
            Write-Output 'STARTUP_DISABLED_CURRENT_BRIDGE_NOT_STOPPED'
        }
    }
} catch {
    # Fixed lifecycle codes only; do not print config contents or credentials.
    $allowed = @('CONFIG_NOT_FOUND','BRIDGE_NOT_FOUND','INVALID_PORT','ANOTHER_LIFECYCLE_ACTION_RUNNING','BRIDGE_STOP_TIMEOUT','NODE_NOT_FOUND','PORT_IN_USE_CLOSE_OLD_BRIDGE_WINDOW_WITH_CTRL_C','BRIDGE_START_FAILED_CHECK_RUNTIME_LOG','BRIDGE_START_TIMEOUT','STARTUP_FOLDER_NOT_FOUND','UNRELATED_STARTUP_SHORTCUT_NOT_CHANGED','LOCAL_ADDRESS_NOT_READY')
    $code = $_.Exception.Message
    if ($allowed -notcontains $code) { $code = 'BRIDGE_LIFECYCLE_FAILED' }
    Write-Output $code
    exit 1
} finally {
    if ($mutexAcquired -and $managedMutex) { $managedMutex.ReleaseMutex() }
    if ($managedMutex) { $managedMutex.Dispose() }
}
