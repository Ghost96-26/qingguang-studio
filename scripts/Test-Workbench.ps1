[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$baseUrl = "http://127.0.0.1:8090"
$secretPath = Join-Path $projectRoot "config\gateway-secrets.json"

if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw "Workbench secret is missing. Run 07_Start_Workbench_Gateway.cmd first."
}
$secret = Get-Content -LiteralPath $secretPath -Raw | ConvertFrom-Json
$headers = @{ "X-Workbench-Key" = $secret.api_key }
$health = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 10
$capabilities = Invoke-RestMethod -Uri "$baseUrl/v1/capabilities" -Headers $headers -TimeoutSec 20

Write-Host "Workbench: $($health.status)  $baseUrl" -ForegroundColor Green
Write-Host "GPU policy: $($capabilities.scheduler.policy)"
foreach ($name in @("h3", "image", "tts", "music", "audio_tools", "agent")) {
    $provider = $capabilities.providers.$name
    $isPendingImage = $name -eq "image" -and -not $provider.ready
    $color = if ($provider.ready) { "Green" } elseif ($isPendingImage) { "Yellow" } else { "Red" }
    $status = if ($provider.ready) { "READY" } elseif ($isPendingImage) { "PENDING MODEL DOWNLOAD / ACCEPTANCE" } else { "NOT READY" }
    Write-Host ("{0,-11} {1}" -f $name.ToUpperInvariant(), $status) -ForegroundColor $color
}
if ($health.current_job) {
    Write-Host "Current job: $($health.current_job.type) / $($health.current_job.status)" -ForegroundColor Yellow
} else {
    Write-Host "GPU queue: idle" -ForegroundColor Green
}

$requiredProviderNames = @("h3", "tts", "music", "audio_tools", "agent")
$notReady = @($requiredProviderNames | Where-Object { -not $capabilities.providers.$_.ready })
if ($health.status -ne "ok" -or $notReady.Count -gt 0) { exit 1 }
exit 0
