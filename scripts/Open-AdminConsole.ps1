[CmdletBinding()]
param(
    [int]$WaitSeconds = 90
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$baseUrl = "http://127.0.0.1:8090"
$adminUrl = "$baseUrl/v3/admin"

Write-Host "[1/2] Checking the workbench gateway..." -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "Start-WorkbenchGateway.ps1") -WaitSeconds $WaitSeconds

$health = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 10
if ($health.status -ne "ok") { throw "Workbench health check failed." }

Write-Host "[2/2] Opening the local administration console..." -ForegroundColor Cyan
Start-Process $adminUrl
Write-Host "Administration console ready: $adminUrl" -ForegroundColor Green
