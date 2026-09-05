[CmdletBinding()]
param(
    [string]$WorkspaceRoot = "C:\QingguangStudio",
    [string]$SharedModelRoot = "C:\QingguangModels",
    [switch]$AcceptLicense,
    [switch]$SkipSpaceCheck,
    [switch]$SkipHashValidation,
    [switch]$SelfTest
)

. (Join-Path $PSScriptRoot "Common-HunyuanVideoFoleyDownload.ps1")

$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)
$SharedModelRoot = [System.IO.Path]::GetFullPath($SharedModelRoot)
$ModelRoot = Join-Path $SharedModelRoot "audio\foley\HunyuanVideo-Foley-XXL"
$LogRoot = Join-Path $WorkspaceRoot "logs"
$ManifestRoot = Join-Path $WorkspaceRoot "manifests"
$ModelScopeCache = Join-Path $SharedModelRoot "cache\modelscope"
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logPath = Join-Path $LogRoot ("download_hunyuanvideo_foley_xxl_cn_{0}.log" -f $timestamp)
$repository = "Tencent-Hunyuan/HunyuanVideo-Foley"
$files = Get-HunyuanVideoFoleyFiles

Assert-FoleyDownloadWorkspace -WorkspaceRoot $WorkspaceRoot
if ($SelfTest) {
    $uv = Get-FoleyDownloadUv
    if ($files -notcontains "hunyuanvideo_foley.pth" -or $files -contains "hunyuanvideo_foley_xl.pth") {
        throw "The domestic file selection is not XXL-only."
    }
    Write-Host "Domestic HunyuanVideo-Foley XXL downloader self-test passed." -ForegroundColor Green
    Write-Host "Repository: $repository"
    Write-Host "Destination: $ModelRoot"
    Write-Host "Payload: 11.86 GiB (XXL checkpoint + VAE + Synchformer)"
    Write-Host "uv: $uv"
    return
}

foreach ($directory in @($ModelRoot, $LogRoot, $ManifestRoot, $ModelScopeCache)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
Confirm-HunyuanVideoFoleyLicense -WorkspaceRoot $WorkspaceRoot -AcceptLicense:$AcceptLicense
if (-not $SkipSpaceCheck) {
    Assert-FoleyDownloadFreeSpace -Path $SharedModelRoot -MinimumBytes 30GB
}

Start-Transcript -LiteralPath $logPath -Append | Out-Null
try {
    Write-FoleyDownloadStep "Preparing the domestic ModelScope downloader"
    $uv = Get-FoleyDownloadUv
    $domesticIndex = "https://mirrors.aliyun.com/pypi/simple"
    $env:UV_DEFAULT_INDEX = $domesticIndex
    $env:UV_CACHE_DIR = Join-Path $SharedModelRoot "cache\uv"
    $env:MODELSCOPE_CACHE = $ModelScopeCache
    $env:MODELSCOPE_DOMAIN = "www.modelscope.cn"
    $toolPrefix = @("tool", "run", "--python", "3.12", "--from", "modelscope", "--default-index", $domesticIndex, "modelscope")
    & $uv @toolPrefix "download" "--help" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to start the ModelScope CLI. Read the log and rerun this launcher."
    }

    Write-FoleyDownloadStep "Downloading the official Tencent XXL quality package"
    $arguments = @("download", $repository) + $files + @("--local-dir", $ModelRoot, "--max-workers", "4")
    & $uv @toolPrefix @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "ModelScope download failed: $repository"
    }

    Write-FoleyDownloadStep "Validating official XXL file sizes and SHA256"
    Assert-HunyuanVideoFoleyPackage -ModelRoot $ModelRoot -SkipHashValidation:$SkipHashValidation
    $inventoryPath = Join-Path $ManifestRoot ("inventory_hunyuanvideo_foley_xxl_cn_{0}.csv" -f $timestamp)
    Export-HunyuanVideoFoleyInventory -ModelRoot $ModelRoot -OutputPath $inventoryPath
    Write-HunyuanVideoFoleyCompletionManifest -WorkspaceRoot $WorkspaceRoot -ModelRoot $ModelRoot -Source "ModelScope official Tencent-Hunyuan mirror" -InventoryPath $inventoryPath

    Write-FoleyDownloadStep "HunyuanVideo-Foley XXL download completed"
    Write-Host "Weights are downloaded and verified. Runtime dependencies are intentionally not installed yet." -ForegroundColor Green
    Write-Host "Model root: $ModelRoot" -ForegroundColor Green
    Write-Host "Inventory:  $inventoryPath" -ForegroundColor Green
    Write-Host "Next: tell Codex that the download has completed so the isolated deployment can be finished." -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host ("DOWNLOAD FAILED: {0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host "Keep the window open, review the log, then rerun this launcher to resume." -ForegroundColor Yellow
    Write-Host "Log: $logPath" -ForegroundColor Yellow
    throw
}
finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
