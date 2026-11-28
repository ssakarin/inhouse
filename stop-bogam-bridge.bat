@echo off
setlocal
set "BOGAM_LAUNCHER_DIR=%~dp0"
cd /d "%~dp0"
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -Command "$ErrorActionPreference='Stop'; $manager=Join-Path $env:BOGAM_LAUNCHER_DIR 'bogam-bridge\manage-bridge.ps1'; Unblock-File -LiteralPath $manager; Unblock-File -LiteralPath (Join-Path $env:BOGAM_LAUNCHER_DIR 'bogam-bridge\query.ps1'); & $manager -Action Stop; if ($LASTEXITCODE) { exit $LASTEXITCODE }"
set "BRIDGE_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%BRIDGE_EXIT_CODE%"=="0" echo Please check the message above. Do not restart Donguibogam or SQL Server.
pause
exit /b %BRIDGE_EXIT_CODE%
