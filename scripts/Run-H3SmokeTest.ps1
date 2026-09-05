[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common-H3Runtime.ps1")
$config = Get-H3RuntimeConfig
$baseUrl = Get-H3BaseUrl -Config $config
if (-not (Test-H3ComfyEndpoint -BaseUrl $baseUrl -TimeoutSeconds 5)) {
    throw "H3 runtime is not running. Start it before the smoke test."
}
Set-H3OfflineEnvironment -Config $config
& ([string]$config.python_executable) (Join-Path $script:ProjectRoot "tools\h3_smoke_t2v.py")
exit $LASTEXITCODE

