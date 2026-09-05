[CmdletBinding()]
param(
    [string]$WorkspaceRoot = "C:\QingguangStudio",
    [string]$ModelRoot = "C:\QingguangModels",
    [switch]$AcceptLicenses,
    [switch]$SkipSpaceCheck,
    [switch]$SelfTest
)

. (Join-Path $PSScriptRoot "Common-ImageModelDownload.ps1")

$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)
$ModelRoot = [System.IO.Path]::GetFullPath($ModelRoot)
$ImageRoot = Join-Path $ModelRoot "image"
$KreaRoot = Join-Path $ImageRoot "krea2"
$IdeogramRoot = Join-Path $ImageRoot "ideogram4"
$LogRoot = Join-Path $WorkspaceRoot "logs"
$ManifestRoot = Join-Path $WorkspaceRoot "manifests"
$ModelScopeCache = Join-Path $ModelRoot "cache\modelscope"
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logPath = Join-Path $LogRoot ("download_image_cn_bf16_{0}.log" -f $timestamp)

Assert-ImageDownloadWorkspace -WorkspaceRoot $WorkspaceRoot
if ($SelfTest) {
    $uv = Get-ImageDownloadUv
    Write-Host "Domestic image downloader self-test passed." -ForegroundColor Green
    Write-Host "Workspace: $WorkspaceRoot"
    Write-Host "Model root: $ModelRoot"
    Write-Host "uv: $uv"
    return
}
foreach ($directory in @($ImageRoot, $KreaRoot, $IdeogramRoot, $LogRoot, $ManifestRoot, $ModelScopeCache)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
Confirm-ImageModelLicenses -WorkspaceRoot $WorkspaceRoot -AcceptLicenses:$AcceptLicenses
if (-not $SkipSpaceCheck) {
    Assert-ImageDownloadFreeSpace -Path $ModelRoot -MinimumBytes 120GB
}

Start-Transcript -LiteralPath $logPath -Append | Out-Null
try {
    Write-ImageDownloadStep "Preparing the domestic ModelScope downloader"
    $uv = Get-ImageDownloadUv
    $domesticIndex = "https://mirrors.aliyun.com/pypi/simple"
    $env:UV_DEFAULT_INDEX = $domesticIndex
    $env:UV_CACHE_DIR = Join-Path $ModelRoot "cache\uv"
    $env:MODELSCOPE_CACHE = $ModelScopeCache
    $env:MODELSCOPE_DOMAIN = "www.modelscope.cn"
    $toolPrefix = @("tool", "run", "--python", "3.12", "--from", "modelscope", "--default-index", $domesticIndex, "modelscope")

    & $uv @toolPrefix "download" "--help" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to start the ModelScope CLI. Read the log and rerun this launcher."
    }

    function Invoke-SelectiveModelScopeDownload {
        param(
            [Parameter(Mandatory = $true)][string]$Repository,
            [Parameter(Mandatory = $true)][string]$Destination,
            [Parameter(Mandatory = $true)][string[]]$Files
        )

        Write-Host ("ModelScope: {0}" -f $Repository) -ForegroundColor Yellow
        # ModelScope 1.x uses the repository id as a positional argument.
        # Keep --local-dir (not a shared cache argument) so the files land in
        # ComfyUI's registered model tree and reruns can resume in place.
        $arguments = @("download", $Repository) + $Files + @("--local-dir", $Destination, "--max-workers", "4")
        & $uv @toolPrefix @arguments
        if ($LASTEXITCODE -ne 0) {
            throw "ModelScope download failed: $Repository"
        }
    }

    Write-ImageDownloadStep "Downloading Krea 2 BF16 quality models"
    $kreaFiles = @(
        "diffusion_models/krea2_turbo_bf16.safetensors",
        "diffusion_models/krea2_raw_bf16.safetensors",
        "text_encoders/qwen3vl_4b_bf16.safetensors",
        "vae/qwen_image_vae.safetensors",
        "loras/krea2_darkbrush.safetensors",
        "loras/krea2_dotmatrix.safetensors",
        "loras/krea2_kidsdrawing.safetensors",
        "loras/krea2_neondrip.safetensors",
        "loras/krea2_rainywindow.safetensors",
        "loras/krea2_retroanime.safetensors",
        "loras/krea2_softwatercolor.safetensors",
        "loras/krea2_sunsetblur.safetensors",
        "loras/krea2_vintagetarot.safetensors",
        "loras/krea2_style_reference.safetensors"
    )
    Invoke-SelectiveModelScopeDownload -Repository "Comfy-Org/Krea-2" -Destination $KreaRoot -Files $kreaFiles

    Write-ImageDownloadStep "Downloading Ideogram 4 FP8 quality models"
    $ideogramFiles = @(
        "diffusion_models/ideogram4_fp8_scaled.safetensors",
        "diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors",
        "text_encoders/qwen3vl_8b_fp8_scaled.safetensors",
        "vae/flux2-vae.safetensors"
    )
    Invoke-SelectiveModelScopeDownload -Repository "Comfy-Org/Ideogram-4" -Destination $IdeogramRoot -Files $ideogramFiles

    Write-ImageDownloadStep "Validating the high-quality image package"
    Assert-ImageModelFile -Path (Join-Path $KreaRoot "diffusion_models\krea2_turbo_bf16.safetensors") -MinimumBytes 24GB
    Assert-ImageModelFile -Path (Join-Path $KreaRoot "diffusion_models\krea2_raw_bf16.safetensors") -MinimumBytes 24GB
    Assert-ImageModelFile -Path (Join-Path $KreaRoot "text_encoders\qwen3vl_4b_bf16.safetensors") -MinimumBytes 8GB
    Assert-ImageModelFile -Path (Join-Path $KreaRoot "vae\qwen_image_vae.safetensors") -MinimumBytes 200MB
    foreach ($relative in $kreaFiles | Where-Object { $_ -like "loras/*" }) {
        Assert-ImageModelFile -Path (Join-Path $KreaRoot $relative.Replace('/', '\')) -MinimumBytes 400MB
    }
    Assert-ImageModelFile -Path (Join-Path $IdeogramRoot "diffusion_models\ideogram4_fp8_scaled.safetensors") -MinimumBytes 8GB
    Assert-ImageModelFile -Path (Join-Path $IdeogramRoot "diffusion_models\ideogram4_unconditional_fp8_scaled.safetensors") -MinimumBytes 8GB
    Assert-ImageModelFile -Path (Join-Path $IdeogramRoot "text_encoders\qwen3vl_8b_fp8_scaled.safetensors") -MinimumBytes 9GB
    Assert-ImageModelFile -Path (Join-Path $IdeogramRoot "vae\flux2-vae.safetensors") -MinimumBytes 300MB

    Set-ImageModelExtraPaths -WorkspaceRoot $WorkspaceRoot -ModelRoot $ModelRoot
    $inventoryPath = Join-Path $ManifestRoot ("inventory_image_cn_bf16_{0}.csv" -f $timestamp)
    Export-ImageModelInventory -Root $ImageRoot -OutputPath $inventoryPath
    [ordered]@{
        completed_utc = [DateTime]::UtcNow.ToString("o")
        source = "ModelScope"
        profile = "krea2_bf16_quality_plus_ideogram4_fp8"
        workspace_root = $WorkspaceRoot
        model_root = $ModelRoot
        inventory = $inventoryPath
        next_launcher = "12_DoubleClick_HF_VPN_Image_Extensions.cmd"
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $ManifestRoot "image-cn-bf16-download-complete.json") -Encoding UTF8

    Write-ImageDownloadStep "Domestic high-quality image package completed"
    Write-Host "Krea 2 BF16 and Ideogram 4 FP8 files are ready." -ForegroundColor Green
    Write-Host "Model root: $ImageRoot" -ForegroundColor Green
    Write-Host "Inventory:  $inventoryPath" -ForegroundColor Green
    Write-Host "Next: connect the VPN and run the VPN image-extension launcher." -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host ("DOWNLOAD FAILED: {0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host "Rerun this launcher to resume completed and partial files." -ForegroundColor Yellow
    Write-Host "Log: $logPath" -ForegroundColor Yellow
    throw
}
finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
