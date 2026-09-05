[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot "logs\gateway.pid.json"
$config = Get-Content -LiteralPath (Join-Path $projectRoot "config\gateway.json") -Raw | ConvertFrom-Json
$baseUrl = "http://$($config.listen):$($config.port)"
if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
    Write-Host "No managed gateway PID file was found." -ForegroundColor Yellow
    exit 0
}
$state = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
if (-not $process) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Host "Recorded gateway process is no longer running." -ForegroundColor Yellow
    exit 0
}
if (-not $Force) {
    $health = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 5
    if ($health.current_job) { throw "Gateway has a running job. Wait for it to finish or explicitly use -Force." }
}
Stop-Process -Id $process.Id -Force:$Force
$process.WaitForExit(10000) | Out-Null
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Workbench gateway stopped." -ForegroundColor Green

