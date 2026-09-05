$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:RuntimeConfigPath = Join-Path $script:ProjectRoot "config\runtime.json"

function Get-H3RuntimeConfig {
    if (-not (Test-Path -LiteralPath $script:RuntimeConfigPath -PathType Leaf)) {
        throw "Runtime config not found: $script:RuntimeConfigPath"
    }
    return Get-Content -LiteralPath $script:RuntimeConfigPath -Raw | ConvertFrom-Json
}

function Set-H3OfflineEnvironment {
    param([Parameter(Mandatory = $true)]$Config)

    $env:HF_HOME = Join-Path $Config.model_root "cache\huggingface"
    $env:HF_HUB_CACHE = Join-Path $env:HF_HOME "hub"
    $env:HF_XET_CACHE = Join-Path $env:HF_HOME "xet"
    $env:HF_HUB_OFFLINE = "1"
    $env:TRANSFORMERS_OFFLINE = "1"
    $env:COMFY_KITCHEN_BACKEND = "cuda"
    Remove-Item Env:PYTORCH_CUDA_ALLOC_CONF -ErrorAction SilentlyContinue
    $env:H3_LOCAL_MODEL_ROOT = $Config.model_root
    $env:H3_COMFYUI_ROOT = $Config.comfyui_root

    # Windows Application Control can reject the small, unsigned launcher that
    # uv places in .venv\Scripts.  Run the full CPython executable and expose
    # the already-installed venv packages explicitly instead of reinstalling.
    if ($Config.PSObject.Properties.Name -contains "python_site_packages") {
        $sitePackages = [string]$Config.python_site_packages
        if (-not (Test-Path -LiteralPath $sitePackages -PathType Container)) {
            throw "Runtime site-packages directory is missing: $sitePackages"
        }
        $env:VIRTUAL_ENV = Split-Path -Parent (Split-Path -Parent $sitePackages)
        $env:PYTHONPATH = if ($env:PYTHONPATH) {
            "$sitePackages;$($env:PYTHONPATH)"
        } else {
            $sitePackages
        }
    }
}

function Get-H3BaseUrl {
    param([Parameter(Mandatory = $true)]$Config)
    return "http://$($Config.listen):$($Config.port)"
}

function Test-H3ComfyEndpoint {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [int]$TimeoutSeconds = 3
    )
    try {
        $null = Invoke-RestMethod -Uri "$BaseUrl/system_stats" -TimeoutSec $TimeoutSeconds
        return $true
    }
    catch {
        return $false
    }
}
