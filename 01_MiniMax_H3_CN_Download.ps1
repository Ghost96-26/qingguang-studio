[CmdletBinding()]
param(
    [string]$WorkspaceRoot = "C:\QingguangStudio",
    [string]$ModelRoot = "C:\QingguangModels",
    [switch]$SkipMusic,
    [switch]$SkipAgent,
    [switch]$SkipSpaceCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "Continue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$DomesticPythonIndex = "https://mirrors.aliyun.com/pypi/simple"
$RequiredFreeBytes = 200GB

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

function Invoke-ModelScopeDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Destination,
        [string[]]$Files = @()
    )

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $arguments = @("download", "--model", $Repository)
    if ($Files.Count -gt 0) {
        $arguments += $Files
    }
    $arguments += @("--local_dir", $Destination, "--max-workers", "4")

    Write-Host ("ModelScope: {0}" -f $Repository) -ForegroundColor Yellow
    & $script:UvExecutable @script:ModelScopeToolPrefix @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "ModelScope download failed: $Repository"
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

function Assert-DirectoryMinimumSize {
    param(
        [string]$Path,
        [long]$MinimumBytes
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Required directory is missing: $Path"
    }
    $total = (Get-ChildItem -LiteralPath $Path -File -Recurse -ErrorAction Stop |
        Measure-Object -Property Length -Sum).Sum
    if ($null -eq $total -or $total -lt $MinimumBytes) {
        throw "Directory is unexpectedly small: $Path ($total bytes)"
    }
}

function Export-Inventory {
    param(
        [string]$Root,
        [string]$OutputPath
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse |
        ForEach-Object {
            [pscustomobject]@{
                RelativePath = $_.FullName.Substring($resolvedRoot.Length).TrimStart('\')
                Bytes = $_.Length
                ModifiedUtc = $_.LastWriteTimeUtc.ToString("o")
            }
        } |
        Sort-Object RelativePath |
        Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8
}

$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)
$ModelRoot = [System.IO.Path]::GetFullPath($ModelRoot)
$ConfigRoot = Join-Path $WorkspaceRoot "config"
$LogRoot = Join-Path $WorkspaceRoot "logs"
$ManifestRoot = Join-Path $WorkspaceRoot "manifests"
$H3Root = Join-Path $ModelRoot "video\minimax-h3"
$TtsRoot = Join-Path $ModelRoot "audio\tts\IndexTTS-2.5"
$TtsCache = Join-Path $TtsRoot "hf_cache"
$MusicRoot = Join-Path $ModelRoot "audio\music\MiniMax-Music3"
$AgentRoot = Join-Path $ModelRoot "llm\Qwen3.6-27B-GGUF"
$ModelScopeCache = Join-Path $ModelRoot "cache\modelscope"

foreach ($directory in @(
    $WorkspaceRoot, $ConfigRoot, $LogRoot, $ManifestRoot,
    $H3Root, $TtsRoot, $TtsCache, $ModelScopeCache
)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

if (-not $SkipSpaceCheck) {
    Assert-FreeSpace -Path $ModelRoot -MinimumBytes $RequiredFreeBytes
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logPath = Join-Path $LogRoot ("download_cn_{0}.log" -f $timestamp)
Start-Transcript -LiteralPath $logPath -Append | Out-Null

try {
    Write-Step "Preparing download tools and paths"
    $script:UvExecutable = Get-UvExecutable
    $env:UV_DEFAULT_INDEX = $DomesticPythonIndex
    $env:UV_CACHE_DIR = Join-Path $ModelRoot "cache\uv"
    $env:MODELSCOPE_CACHE = $ModelScopeCache
    $env:MODELSCOPE_DOMAIN = "www.modelscope.cn"

    $script:ModelScopeToolPrefix = @(
        "tool", "run",
        "--from", "modelscope",
        "--default-index", $DomesticPythonIndex,
        "modelscope"
    )

    & $script:UvExecutable @script:ModelScopeToolPrefix "download" "--help" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "ModelScope did not start with the system Python. Retrying with uv-managed Python 3.12."
        $script:ModelScopeToolPrefix = @(
            "tool", "run",
            "--python", "3.12",
            "--from", "modelscope",
            "--default-index", $DomesticPythonIndex,
            "modelscope"
        )
        & $script:UvExecutable @script:ModelScopeToolPrefix "download" "--help" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to start the ModelScope CLI. See the transcript for details."
        }
    }

    Set-Content -LiteralPath (Join-Path $ConfigRoot "model-root.txt") -Value $ModelRoot -Encoding UTF8

    $yamlModelRoot = $ModelRoot.Replace('\', '/')
    $extraPaths = @"
minimax_h3_local:
  base_path: $yamlModelRoot/h3
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
  loras: loras
"@
    Set-Content -LiteralPath (Join-Path $ConfigRoot "extra_model_paths.yaml") -Value $extraPaths -Encoding UTF8

    Write-Step "Downloading MiniMax H3 production weights from ModelScope"
    $h3Files = @(
        "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        "text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
        "vae/minimax_h3_video_vae_fp16.safetensors",
        "vae/minimax_h3_audio_vae_fp32.safetensors"
    )
    Invoke-ModelScopeDownload -Repository "Comfy-Org/MiniMax-H3" -Destination $H3Root -Files $h3Files

    Write-Step "Downloading IndexTTS-2.5 main weights"
    Invoke-ModelScopeDownload -Repository "IndexTeam/IndexTTS-2.5" -Destination $TtsRoot

    Write-Step "Downloading IndexTTS auxiliary files available in China"
    Invoke-ModelScopeDownload `
        -Repository "amphion/MaskGCT" `
        -Destination $TtsCache `
        -Files @("semantic_codec/model.safetensors")

    $semanticSource = Join-Path $TtsCache "semantic_codec\model.safetensors"
    $semanticTarget = Join-Path $TtsCache "semantic_codec_model.safetensors"
    if (Test-Path -LiteralPath $semanticSource) {
        Copy-Item -LiteralPath $semanticSource -Destination $semanticTarget -Force
    }

    Invoke-ModelScopeDownload `
        -Repository "shoujiekeji/campplus" `
        -Destination $TtsCache `
        -Files @("campplus_cn_common.bin")

    if (-not $SkipMusic) {
        Write-Step "Downloading MiniMax Music3"
        Invoke-ModelScopeDownload -Repository "MiniMax/MiniMax-Music3" -Destination $MusicRoot
    }

    if (-not $SkipAgent) {
        Write-Step "Downloading the local offline agent"
        Invoke-ModelScopeDownload `
            -Repository "lmstudio-community/Qwen3.6-27B-GGUF" `
            -Destination $AgentRoot `
            -Files @("Qwen3.6-27B-Q4_K_M.gguf", "mmproj-Qwen3.6-27B-BF16.gguf")
    }

    Write-Step "Validating required domestic downloads"
    Assert-FileMinimumSize `
        -Path (Join-Path $H3Root "diffusion_models\minimax_h3_fl2va_pruned_int8_convrot.safetensors") `
        -MinimumBytes 18GB
    Assert-FileMinimumSize `
        -Path (Join-Path $H3Root "diffusion_models\minimax_h3_ref2va_pruned_int8_convrot.safetensors") `
        -MinimumBytes 18GB
    Assert-FileMinimumSize `
        -Path (Join-Path $H3Root "text_encoders\qwen3vl_32b_minimax_h3_int8_convrot.safetensors") `
        -MinimumBytes 24GB
    Assert-FileMinimumSize `
        -Path (Join-Path $H3Root "vae\minimax_h3_video_vae_fp16.safetensors") `
        -MinimumBytes 4GB
    Assert-FileMinimumSize `
        -Path (Join-Path $H3Root "vae\minimax_h3_audio_vae_fp32.safetensors") `
        -MinimumBytes 500MB
    Assert-DirectoryMinimumSize -Path $TtsRoot -MinimumBytes 5GB
    Assert-FileMinimumSize -Path $semanticTarget -MinimumBytes 150MB
    Assert-FileMinimumSize -Path (Join-Path $TtsCache "campplus_cn_common.bin") -MinimumBytes 20MB

    if (-not $SkipMusic) {
        Assert-DirectoryMinimumSize -Path $MusicRoot -MinimumBytes 50GB
    }
    if (-not $SkipAgent) {
        Assert-FileMinimumSize -Path (Join-Path $AgentRoot "Qwen3.6-27B-Q4_K_M.gguf") -MinimumBytes 15GB
        Assert-FileMinimumSize -Path (Join-Path $AgentRoot "mmproj-Qwen3.6-27B-BF16.gguf") -MinimumBytes 800MB
    }

    $inventoryPath = Join-Path $ManifestRoot ("inventory_cn_{0}.csv" -f $timestamp)
    Export-Inventory -Root $ModelRoot -OutputPath $inventoryPath

    $completion = [ordered]@{
        completed_utc = [DateTime]::UtcNow.ToString("o")
        source = "ModelScope"
        workspace_root = $WorkspaceRoot
        model_root = $ModelRoot
        music_downloaded = (-not $SkipMusic)
        agent_downloaded = (-not $SkipAgent)
        inventory = $inventoryPath
        next_script = "02_MiniMax_H3_HF_VPN_Download.ps1"
    }
    $completion | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $ManifestRoot "domestic-download-complete.json") -Encoding UTF8

    Write-Step "Domestic download completed"
    Write-Host "Model root: $ModelRoot" -ForegroundColor Green
    Write-Host "Inventory:  $inventoryPath" -ForegroundColor Green
    Write-Host "Log:        $logPath" -ForegroundColor Green
    Write-Host "After VPN is connected, run 02_MiniMax_H3_HF_VPN_Download.ps1." -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host ("DOWNLOAD FAILED: {0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host "Rerun the same script to resume completed and partial downloads." -ForegroundColor Yellow
    Write-Host "Log: $logPath" -ForegroundColor Yellow
    throw
}
finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
