[CmdletBinding()]
param(
    [string]$WorkspaceRoot = "C:\QingguangStudio",
    [string]$SharedModelRoot = "C:\QingguangModels",
    [string]$HfEndpoint = "https://huggingface.co",
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
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logPath = Join-Path $LogRoot ("download_hunyuanvideo_foley_xxl_hf_vpn_{0}.log" -f $timestamp)
$repository = "tencent/HunyuanVideo-Foley"
$files = Get-HunyuanVideoFoleyFiles

Assert-FoleyDownloadWorkspace -WorkspaceRoot $WorkspaceRoot
if ($SelfTest) {
    $uv = Get-FoleyDownloadUv
    if ($files -notcontains "hunyuanvideo_foley.pth" -or $files -contains "hunyuanvideo_foley_xl.pth") {
        throw "The Hugging Face file selection is not XXL-only."
    }
    Write-Host "VPN HunyuanVideo-Foley XXL downloader self-test passed." -ForegroundColor Green
    Write-Host "Repository: $repository"
    Write-Host "Endpoint: $HfEndpoint"
    Write-Host "Destination: $ModelRoot"
    Write-Host "Payload: 11.86 GiB (XXL checkpoint + VAE + Synchformer)"
    Write-Host "uv: $uv"
    return
}

foreach ($directory in @($ModelRoot, $LogRoot, $ManifestRoot)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
Confirm-HunyuanVideoFoleyLicense -WorkspaceRoot $WorkspaceRoot -AcceptLicense:$AcceptLicense
if (-not $SkipSpaceCheck) {
    Assert-FoleyDownloadFreeSpace -Path $SharedModelRoot -MinimumBytes 30GB
}

Start-Transcript -LiteralPath $logPath -Append | Out-Null
try {
    Write-FoleyDownloadStep "Preparing the official Hugging Face downloader"
    $uv = Get-FoleyDownloadUv
    $env:HF_ENDPOINT = $HfEndpoint
    $env:HF_HOME = Join-Path $SharedModelRoot "cache\huggingface"
    $env:HF_HUB_CACHE = Join-Path $env:HF_HOME "hub"
    $env:HF_XET_CACHE = Join-Path $env:HF_HOME "xet"
    $env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
    $toolPrefix = @("tool", "run", "--python", "3.12", "--from", "huggingface-hub", "hf")
    & $uv @toolPrefix "version"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to start the official hf CLI. Keep the VPN connected and rerun this launcher."
    }

    Write-FoleyDownloadStep "Downloading the official Tencent XXL quality package"
    $arguments = @("download", $repository)
    foreach ($file in $files) {
        $arguments += @("--include", $file)
    }
    $arguments += @("--local-dir", $ModelRoot, "--max-workers", "4")
    & $uv @toolPrefix @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Hugging Face download failed: $repository"
    }

    Write-FoleyDownloadStep "Validating official XXL file sizes and SHA256"
    Assert-HunyuanVideoFoleyPackage -ModelRoot $ModelRoot -SkipHashValidation:$SkipHashValidation
    $inventoryPath = Join-Path $ManifestRoot ("inventory_hunyuanvideo_foley_xxl_hf_vpn_{0}.csv" -f $timestamp)
    Export-HunyuanVideoFoleyInventory -ModelRoot $ModelRoot -OutputPath $inventoryPath
    Write-HunyuanVideoFoleyCompletionManifest -WorkspaceRoot $WorkspaceRoot -ModelRoot $ModelRoot -Source "Hugging Face official Tencent repository" -InventoryPath $inventoryPath

    Write-FoleyDownloadStep "HunyuanVideo-Foley XXL download completed"
    Write-Host "Weights are downloaded and verified. Runtime dependencies are intentionally not installed yet." -ForegroundColor Green
    Write-Host "Model root: $ModelRoot" -ForegroundColor Green
    Write-Host "Inventory:  $inventoryPath" -ForegroundColor Green
    Write-Host "Next: tell Codex that the download has completed so the isolated deployment can be finished." -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host ("DOWNLOAD FAILED: {0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host "Keep the VPN connected, review the log, then rerun this launcher to resume." -ForegroundColor Yellow
    Write-Host "Log: $logPath" -ForegroundColor Yellow
    throw
}
finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
