[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common-H3Runtime.ps1")

$config = Get-H3RuntimeConfig
$baseUrl = Get-H3BaseUrl -Config $config
$pidFile = Join-Path $script:ProjectRoot "logs\comfyui.pid.json"

if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
    Write-Host "No managed H3 runtime PID file was found." -ForegroundColor Yellow
    exit 0
}

$state = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
if (-not $process) {
    Write-Host "The recorded process is no longer running." -ForegroundColor Yellow
    Remove-Item -LiteralPath $pidFile -Force
    exit 0
}

if (-not $Force) {
    try {
        $queue = Invoke-RestMethod -Uri "$baseUrl/queue" -TimeoutSec 5
        $running = @($queue.queue_running).Count
        $pending = @($queue.queue_pending).Count
        if (($running + $pending) -gt 0) {
            throw "Refusing to stop: queue has $running running and $pending pending item(s)."
        }
    }
    catch {
        throw "Safe stop check failed: $($_.Exception.Message) Use -Force only after confirming no render is active."
    }
}

Stop-Process -Id $process.Id -Force:$Force
$process.WaitForExit(15000) | Out-Null
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "H3 runtime stopped." -ForegroundColor Green
