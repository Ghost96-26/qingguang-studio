[CmdletBinding()]
param(
    [int]$WaitSeconds = 60,
    [switch]$Foreground
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot "config\gateway.json"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$python = Join-Path $projectRoot "runtime\python\cpython-3.12.13-windows-x86_64-none\python.exe"
$sitePackages = Join-Path $projectRoot "runtime\orchestrator\.venv\Lib\site-packages"
$appRoot = Join-Path $projectRoot "services\orchestrator"
$logRoot = Join-Path $projectRoot "logs"
$stdout = Join-Path $logRoot "gateway.stdout.log"
$stderr = Join-Path $logRoot "gateway.stderr.log"
$pidFile = Join-Path $logRoot "gateway.pid.json"
$baseUrl = "http://$($config.listen):$($config.port)"

& (Join-Path $PSScriptRoot "Initialize-GatewaySecrets.ps1")
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw "Gateway Python is missing: $python" }
if (-not (Test-Path -LiteralPath $sitePackages -PathType Container)) { throw "Gateway packages are missing: $sitePackages" }
try {
    $health = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 3
    if ($health.status -eq "ok") {
        Write-Host "Workbench gateway is already healthy: $baseUrl" -ForegroundColor Green
        exit 0
    }
} catch {}

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$env:H3_WORKBENCH_CONFIG = $configPath
$env:VIRTUAL_ENV = Join-Path $projectRoot "runtime\orchestrator\.venv"
$env:PYTHONPATH = if ($env:PYTHONPATH) { "$sitePackages;$($env:PYTHONPATH)" } else { $sitePackages }
$arguments = @(
    "-m", "uvicorn", "workbench.api:app",
    "--app-dir", $appRoot,
    "--host", [string]$config.listen,
    "--port", [string]$config.port,
    "--forwarded-allow-ips", "127.0.0.1",
    "--no-access-log"
)
if ($Foreground) {
    Push-Location $projectRoot
    try {
        & $python @arguments
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}

$process = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
@{
    pid = $process.Id
    started_utc = (Get-Date).ToUniversalTime().ToString("o")
    base_url = $baseUrl
} | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8

$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
    if ($process.HasExited) {
        $process.Refresh()
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        Get-Content -LiteralPath $stderr -Tail 100 -ErrorAction SilentlyContinue
        throw "Gateway exited with code $($process.ExitCode)"
    }
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 3
        if ($health.status -eq "ok") {
            Write-Host "Workbench gateway is ready: $baseUrl" -ForegroundColor Green
            Write-Host "PID: $($process.Id)"
            exit 0
        }
    } catch {}
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
throw "Timed out waiting for the workbench gateway. Check $stderr"
