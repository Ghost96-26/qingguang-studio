@echo off
setlocal
title 擎光绘影 - 本地管理后台
cd /d "%~dp0"
echo Opening the local administration console...
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Open-AdminConsole.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo Admin URL: http://127.0.0.1:8090/v3/admin
  echo The browser should now be open. This window may be closed.
) else (
  echo Admin console startup failed with exit code %EXIT_CODE%.
  echo Check logs\gateway.stderr.log.
)
echo.
pause
exit /b %EXIT_CODE%
