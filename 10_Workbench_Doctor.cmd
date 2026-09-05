@echo off
setlocal
title 擎光绘影 - Workbench Doctor
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Test-Workbench.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" echo All workbench providers are ready.
if not "%EXIT_CODE%"=="0" echo Workbench check failed. Read the messages above.
echo.
pause
exit /b %EXIT_CODE%
