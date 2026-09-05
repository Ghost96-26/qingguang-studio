@echo off
setlocal
title 擎光绘影 - Stop Runtime
cd /d "%~dp0"
echo Safely stopping the local H3 runtime...
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Stop-H3Runtime.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%
