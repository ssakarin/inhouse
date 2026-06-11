@echo off
setlocal
cd /d "%~dp0"
set NODE_NO_WARNINGS=1
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not in PATH.
  echo Install Node.js on this PC, then run this file again.
  pause
  exit /b 1
)
node server\server.js
pause
