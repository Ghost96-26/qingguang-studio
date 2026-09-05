[CmdletBinding()]
param(
    [string]$WorkspaceRoot = "C:\QingguangStudio",
    [string]$ModelRoot = "",
    [string]$HfEndpoint = "https://huggingface.co",
    [switch]$RefreshAllTtsAuxFromHf,
    [switch]$SkipDraftLora,
    [switch]$SkipSpaceCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "Continue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$RequiredFreeBytes = 20GB

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host ("==== {0} ====" -f $Message) -ForegroundColor Cyan
}

function Get-UvExecutable {
    $command = Get-Command uv -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $fallbacks = @(
        (Join-Path $env:LOCALAPPDATA "hermes\bin\uv.exe"),
        (Join-Path $env:USERPROFILE ".local\bin\uv.exe")
    )
    foreach ($candidate in $fallbacks) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    throw "uv.exe was not found. Install uv first, then rerun this script."
}

function Assert-FreeSpace {
    param(
        [string]$Path,
        [long]$MinimumBytes
    )

    $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
    $driveName = $root.TrimEnd('\').TrimEnd(':')
    $drive = Get-PSDrive -Name $driveName -ErrorAction Stop
    if ($drive.Free -lt $MinimumBytes) {
        $freeGb = [math]::Round($drive.Free / 1GB, 1)
        $neededGb = [math]::Round($MinimumBytes / 1GB, 1)
        throw "Drive $root has only $freeGb GiB free; at least $neededGb GiB is required."
    }
}

function Invoke-HfDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string[]]$Includes
    )

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $arguments = @("download", $Repository)
    foreach ($pattern in $Includes) {
        $arguments += @("--include", $pattern)
    }
    $arguments += @(
        "--local-dir", $Destination,
        "--max-workers", "4"
    )

    Write-Host ("Hugging Face: {0}" -f $Repository) -ForegroundColor Yellow
    & $script:UvExecutable @script:HfToolPrefix @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Hugging Face download failed: $Repository"
    }
}

function Assert-FileMinimumSize {
    param(
        [string]$Path,
        [long]$MinimumBytes
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file is missing: $Path"
    }
    $length = (Get-Item -LiteralPath $Path).Length
    if ($length -lt $MinimumBytes) {
        throw "File is unexpectedly small: $Path ($length bytes)"
    }
}

function Export-HfInventory {
    param(
        [string[]]$Paths,
        [string]$OutputPath
    )

    $rows = foreach ($path in $Paths) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $item = Get-Item -LiteralPath $path
            $hash = Get-FileHash -LiteralPath $path -Algorithm SHA256
            [pscustomobject]@{
                FullPath = $item.FullName
                Bytes = $item.Length
                SHA256 = $hash.Hash.ToLowerInvariant()
                ModifiedUtc = $item.LastWriteTimeUtc.ToString("o")
            }
        }
    }
    $rows | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8
}

$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)
$ConfigRoot = Join-Path $WorkspaceRoot "config"
$LogRoot = Join-Path $WorkspaceRoot "logs"
$ManifestRoot = Join-Path $WorkspaceRoot "manifests"

if ([string]::IsNullOrWhiteSpace($ModelRoot)) {
    $modelRootFile = Join-Path $ConfigRoot "model-root.txt"
    if (Test-Path -LiteralPath $modelRootFile) {
        $ModelRoot = (Get-Content -Raw -LiteralPath $modelRootFile).Trim()
    }
    else {
        $ModelRoot = "C:\QingguangModels"
    }
}

$ModelRoot = [System.IO.Path]::GetFullPath($ModelRoot)
$H3LoraRoot = Join-Path $ModelRoot "video\minimax-h3\loras"
$TtsRoot = Join-Path $ModelRoot "audio\tts\IndexTTS-2.5"
$TtsCache = Join-Path $TtsRoot "hf_cache"
$script:HfHubCache = Join-Path $ModelRoot "cache\huggingface\hub"
$HfXetCache = Join-Path $ModelRoot "cache\huggingface\xet"

foreach ($directory in @(
    $WorkspaceRoot, $ConfigRoot, $LogRoot, $ManifestRoot,
    $H3LoraRoot, $TtsRoot, $TtsCache, $script:HfHubCache, $HfXetCache
)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

if (-not $SkipSpaceCheck) {
    Assert-FreeSpace -Path $ModelRoot -MinimumBytes $RequiredFreeBytes
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logPath = Join-Path $LogRoot ("download_hf_vpn_{0}.log" -f $timestamp)
Start-Transcript -LiteralPath $logPath -Append | Out-Null

try {
    Write-Step "Preparing the official Hugging Face downloader"
    $script:UvExecutable = Get-UvExecutable
    $env:HF_ENDPOINT = $HfEndpoint
    $env:HF_HOME = Join-Path $ModelRoot "cache\huggingface"
    $env:HF_HUB_CACHE = $script:HfHubCache
    $env:HF_XET_CACHE = $HfXetCache
    $env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"

    $script:HfToolPrefix = @(
        "tool", "run",
        "--from", "huggingface-hub",
        "hf"
    )
    & $script:UvExecutable @script:HfToolPrefix "version"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to start the official hf CLI. See the transcript for details."
    }

    Write-Step "Downloading official LightX2V Turbo LoRAs"
    $loraFiles = @(
        "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
        "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"
    )
    if (-not $SkipDraftLora) {
        $loraFiles += "minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors"
    }
    Invoke-HfDownload `
        -Repository "lightx2v/Minimax-h3-Turbo" `
        -Destination $H3LoraRoot `
        -Includes $loraFiles

    Write-Step "Downloading IndexTTS W2V-BERT"
    $w2vRoot = Join-Path $TtsCache "w2v-bert-2.0"
    Invoke-HfDownload `
        -Repository "facebook/w2v-bert-2.0" `
        -Destination $w2vRoot `
        -Includes @("config.json", "preprocessor_config.json", "model.safetensors")

    Write-Step "Downloading IndexTTS BigVGAN"
    $bigVganRoot = Join-Path $TtsCache "bigvgan"
    Invoke-HfDownload `
        -Repository "nvidia/bigvgan_v2_22khz_80band_256x" `
        -Destination $bigVganRoot `
        -Includes @("config.json", "bigvgan_generator.pt")

    if ($RefreshAllTtsAuxFromHf) {
        Write-Step "Refreshing MaskGCT and CAMPPlus from their Hugging Face upstream repositories"
        $maskSourceRoot = Join-Path $TtsCache "maskgct_upstream"
        Invoke-HfDownload `
            -Repository "amphion/MaskGCT" `
            -Destination $maskSourceRoot `
            -Includes @("semantic_codec/model.safetensors")
        Copy-Item `
            -LiteralPath (Join-Path $maskSourceRoot "semantic_codec\model.safetensors") `
            -Destination (Join-Path $TtsCache "semantic_codec_model.safetensors") `
            -Force

        $campSourceRoot = Join-Path $TtsCache "campplus_upstream"
        Invoke-HfDownload `
            -Repository "funasr/campplus" `
            -Destination $campSourceRoot `
            -Includes @("campplus_cn_common.bin")
        Copy-Item `
            -LiteralPath (Join-Path $campSourceRoot "campplus_cn_common.bin") `
            -Destination (Join-Path $TtsCache "campplus_cn_common.bin") `
            -Force
    }

    Write-Step "Validating VPN-only downloads"
    $requiredFiles = @(
        (Join-Path $H3LoraRoot "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"),
        (Join-Path $H3LoraRoot "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"),
        (Join-Path $w2vRoot "model.safetensors"),
        (Join-Path $bigVganRoot "bigvgan_generator.pt")
    )
    if (-not $SkipDraftLora) {
        $requiredFiles += Join-Path $H3LoraRoot "minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors"
    }

    Assert-FileMinimumSize -Path $requiredFiles[0] -MinimumBytes 1GB
    Assert-FileMinimumSize -Path $requiredFiles[1] -MinimumBytes 1GB
    Assert-FileMinimumSize -Path (Join-Path $w2vRoot "model.safetensors") -MinimumBytes 2GB
    Assert-FileMinimumSize -Path (Join-Path $bigVganRoot "bigvgan_generator.pt") -MinimumBytes 400MB
    if (-not $SkipDraftLora) {
        Assert-FileMinimumSize -Path $requiredFiles[4] -MinimumBytes 1GB
    }
    Assert-FileMinimumSize -Path (Join-Path $TtsCache "semantic_codec_model.safetensors") -MinimumBytes 150MB
    Assert-FileMinimumSize -Path (Join-Path $TtsCache "campplus_cn_common.bin") -MinimumBytes 20MB

    Write-Step "Calculating SHA-256 for VPN-downloaded model files"
    $inventoryPath = Join-Path $ManifestRoot ("inventory_hf_vpn_{0}.csv" -f $timestamp)
    Export-HfInventory -Paths $requiredFiles -OutputPath $inventoryPath

    $offlineEnvironment = @"
HF_HOME=$($env:HF_HOME)
HF_HUB_CACHE=$script:HfHubCache
HF_XET_CACHE=$HfXetCache
HF_HUB_OFFLINE=1
TRANSFORMERS_OFFLINE=1
"@
    Set-Content `
        -LiteralPath (Join-Path $ConfigRoot "offline-model-environment.env") `
        -Value $offlineEnvironment `
        -Encoding UTF8

    $completion = [ordered]@{
        completed_utc = [DateTime]::UtcNow.ToString("o")
        source = $HfEndpoint
        workspace_root = $WorkspaceRoot
        model_root = $ModelRoot
        draft_lora_downloaded = (-not $SkipDraftLora)
        all_tts_aux_refreshed_from_hf = [bool]$RefreshAllTtsAuxFromHf
        inventory = $inventoryPath
    }
    $completion | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $ManifestRoot "hf-vpn-download-complete.json") -Encoding UTF8

    Write-Step "VPN download completed"
    Write-Host "Model root: $ModelRoot" -ForegroundColor Green
    Write-Host "Inventory:  $inventoryPath" -ForegroundColor Green
    Write-Host "Log:        $logPath" -ForegroundColor Green
    Write-Host "The required model set is now ready for offline runtime setup." -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host ("DOWNLOAD FAILED: {0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host "Keep the VPN connected and rerun this script to resume." -ForegroundColor Yellow
    Write-Host "Log: $logPath" -ForegroundColor Yellow
    throw
}
finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
