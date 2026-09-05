@echo off
setlocal
title 擎光绘影 - CLSF AI. Lab Studio
cd /d "%~dp0"
echo Starting the local H3 production workbench...
echo The first startup after a reboot may take several minutes.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Open-H3Workbench.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo Workbench URL: http://127.0.0.1:8090
  echo The browser should now be open. This window may be closed.
) else (
  echo Workbench startup failed with exit code %EXIT_CODE%.
  echo Check logs\comfyui.stderr.log and logs\gateway.stderr.log.
)
echo.
pause
exit /b %EXIT_CODE%
