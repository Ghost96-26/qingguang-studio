@echo off
if /I "%~1"=="--self-test" start "CLSF Krea2 BF16 CN Self Test" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "C:\QingguangStudio\scripts\Download-ImageModels-CN-BF16.ps1" -SelfTest
if /I "%~1"=="--self-test" exit /b 0
start "CLSF Krea2 BF16 CN Download" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "C:\QingguangStudio\scripts\Download-ImageModels-CN-BF16.ps1"
exit /b 0
