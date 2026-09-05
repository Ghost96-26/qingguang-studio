@echo off
setlocal
title 擎光绘影 - Runtime Doctor
cd /d "%~dp0"
echo Checking the local H3 runtime...
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Test-H3Runtime.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo H3 runtime check passed.
) else (
  echo H3 runtime check failed with exit code %EXIT_CODE%.
  echo See %~dp0manifests\runtime-doctor-latest.json
)
echo.
pause
exit /b %EXIT_CODE%
