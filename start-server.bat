@echo off
setlocal
cd /d "%~dp0"
set NODE_NO_WARNINGS=1

rem --- Secrets: change these for production. Leave unset to use defaults. ---
rem set "CLINIC_REQUIRE_LOGIN=1"
rem set "CLINIC_PASSWORD=your-login-password"
set "CLINIC_DELETE_PASSWORD=337758"
rem set "CLINIC_KEY_PATH=C:\clinic-secret\key.bin"
rem set "SLACK_TOKEN=xoxb-your-slack-bot-token"

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    set "NODE_EXE="
  ) else (
    set "NODE_EXE=node"
  )
)

if "%NODE_EXE%"=="" (
  echo Node.js is not installed or not in PATH.
  echo Install Node.js on this PC, then run this file again.
  pause
  exit /b 1
)
"%NODE_EXE%" server\server.js
pause
