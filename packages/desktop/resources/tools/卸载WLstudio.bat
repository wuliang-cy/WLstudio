@echo off
setlocal
chcp 65001 >nul 2>&1
title WLstudio Uninstaller

set "SCRIPT=%~dp0uninstall-wlstudio.ps1"

if not exist "%SCRIPT%" (
  echo [ERROR] uninstall-wlstudio.ps1 not found next to this file.
  echo         Expected: %SCRIPT%
  pause
  exit /b 1
)

where pwsh >nul 2>&1
if %errorlevel%==0 (
  set "PS=pwsh"
) else (
  set "PS=powershell"
)

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "RC=%errorlevel%"

echo.
echo [uninstaller exited with code %RC%]
if "%1"=="" if "%2"=="" pause
exit /b %RC%
