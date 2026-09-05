[CmdletBinding()]
param(
    [int]$WaitSeconds = 180,
    [switch]$Legacy
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$workbenchUrl = "http://127.0.0.1:8090"
$canvasUrl = if ($Legacy) { $workbenchUrl } else { "$workbenchUrl/v3" }

Write-Host "[1/3] Checking the H3 model runtime..." -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "Start-H3Runtime.ps1") -WaitSeconds $WaitSeconds

Write-Host "[2/3] Checking the authenticated workbench gateway..." -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "Start-WorkbenchGateway.ps1") -WaitSeconds ([Math]::Min($WaitSeconds, 90))

$health = Invoke-RestMethod -Uri "$workbenchUrl/health" -TimeoutSec 10
if ($health.status -ne "ok") { throw "Workbench health check failed." }

Write-Host "[3/3] Opening the local canvas..." -ForegroundColor Cyan
Start-Process $canvasUrl
Write-Host "Workbench ready: $canvasUrl" -ForegroundColor Green
