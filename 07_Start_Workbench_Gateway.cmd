@echo off
setlocal
title 擎光绘影 - Workbench Gateway
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-WorkbenchGateway.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" echo Gateway URL: http://127.0.0.1:8090
if not "%EXIT_CODE%"=="0" echo Gateway startup failed. Check logs\gateway.stderr.log
echo.
pause
exit /b %EXIT_CODE%
