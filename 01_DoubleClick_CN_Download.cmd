@echo off
setlocal
chcp 65001 >nul
title MiniMax H3 - China Download

set "DOWNLOAD_SCRIPT=C:\QingguangStudio\01_MiniMax_H3_CN_Download.ps1"

if not exist "%DOWNLOAD_SCRIPT%" (
    echo.
    echo ERROR: The download script was not found:
    echo %DOWNLOAD_SCRIPT%
    echo.
    pause
    exit /b 1
)

if /i "%~1"=="--check" (
    echo Launcher check passed: %DOWNLOAD_SCRIPT%
    exit /b 0
)

echo Starting the China download script...
echo Model files will be stored in C:\QingguangModels by default.
echo This window will remain open when the script finishes or fails.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%DOWNLOAD_SCRIPT%"
set "DOWNLOAD_EXIT_CODE=%ERRORLEVEL%"

echo.
if "%DOWNLOAD_EXIT_CODE%"=="0" (
    echo The China download script finished.
) else (
    echo The China download script stopped with exit code %DOWNLOAD_EXIT_CODE%.
    echo Read the error above or check C:\QingguangStudio\logs.
    echo You can rerun this launcher to resume downloads.
)
echo.
pause
exit /b %DOWNLOAD_EXIT_CODE%
