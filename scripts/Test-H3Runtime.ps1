[CmdletBinding()]
param([switch]$Json)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common-H3Runtime.ps1")

$config = Get-H3RuntimeConfig
$baseUrl = Get-H3BaseUrl -Config $config
$doctor = Join-Path $script:ProjectRoot "tools\h3_runtime_doctor.py"
$arguments = @($doctor, "--require-server")
if ($Json) { $arguments += "--json" }

Set-H3OfflineEnvironment -Config $config
& ([string]$config.python_executable) @arguments
exit $LASTEXITCODE

