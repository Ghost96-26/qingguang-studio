[CmdletBinding()]
param(
    [ValidateSet("h3", "image")]
    [string]$Family = "h3"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common-H3Runtime.ps1")

$startScript = Join-Path $PSScriptRoot "Start-H3Runtime.ps1"
$pidFile = Join-Path $script:ProjectRoot "logs\comfyui.pid.json"

foreach ($required in @($startScript, $script:RuntimeConfigPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required runtime script is missing: $required"
    }
}

if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    $state = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
    if ($process) {
        Stop-Process -Id $process.Id -Force
        $process.WaitForExit(15000) | Out-Null
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

& $startScript -Family $Family
exit $LASTEXITCODE
