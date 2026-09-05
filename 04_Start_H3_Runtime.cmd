@echo off
setlocal
title 擎光绘影 - Local H3 Runtime
cd /d "%~dp0"
echo Starting the local H3 runtime. The first startup can take several minutes.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-H3Runtime.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo Runtime URL: http://127.0.0.1:8188
  echo This window may now be closed.
) else (
  echo Startup failed with exit code %EXIT_CODE%.
  echo See %~dp0logs\comfyui.stderr.log
)
echo.
pause
exit /b %EXIT_CODE%
