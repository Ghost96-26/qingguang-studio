[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$secretPath = Join-Path $projectRoot "config\gateway-secrets.json"
if (Test-Path -LiteralPath $secretPath -PathType Leaf) {
    Write-Host "Gateway secret already exists." -ForegroundColor Green
    exit 0
}
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$key = -join ($bytes | ForEach-Object { $_.ToString("x2") })
@{
    created_utc = (Get-Date).ToUniversalTime().ToString("o")
    api_key = $key
} | ConvertTo-Json | Set-Content -LiteralPath $secretPath -Encoding UTF8
Write-Host "Gateway secret created: $secretPath" -ForegroundColor Green

