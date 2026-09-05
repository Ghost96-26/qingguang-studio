@echo off
setlocal
title 擎光绘影 - H3 Smoke Test
cd /d "%~dp0"
echo Running a 5-second, 608x352, 8-step local H3 smoke test.
echo This loads the real H3 models and can take several minutes.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Run-H3SmokeTest.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo H3 model smoke test passed.
) else (
  echo H3 model smoke test failed with exit code %EXIT_CODE%.
  echo Check %~dp0logs\comfyui.stderr.log
)
echo.
pause
exit /b %EXIT_CODE%
