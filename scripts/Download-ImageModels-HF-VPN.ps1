[CmdletBinding()]
param(
    [string]$WorkspaceRoot = "C:\QingguangStudio",
    [string]$ModelRoot = "C:\QingguangModels",
    [string]$HfEndpoint = "https://huggingface.co",
    [switch]$AcceptLicenses,
    [switch]$SkipSpaceCheck,
    [switch]$SelfTest
)

. (Join-Path $PSScriptRoot "Common-ImageModelDownload.ps1")

$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)
$ModelRoot = [System.IO.Path]::GetFullPath($ModelRoot)
$ImageRoot = Join-Path $ModelRoot "image"
$EditLoraRoot = Join-Path $ImageRoot "krea2\loras\Krea2"
$LogRoot = Join-Path $WorkspaceRoot "logs"
$ManifestRoot = Join-Path $WorkspaceRoot "manifests"
$DownloadCache = Join-Path $WorkspaceRoot ".cache\image-extensions"
$CustomNodesRoot = [System.IO.Path]::GetFullPath((Join-Path $WorkspaceRoot "runtime\ComfyUI\custom_nodes"))
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logPath = Join-Path $LogRoot ("download_image_hf_vpn_{0}.log" -f $timestamp)

Assert-ImageDownloadWorkspace -WorkspaceRoot $WorkspaceRoot
if ($SelfTest) {
    $uv = Get-ImageDownloadUv
    Write-Host "VPN image-extension downloader self-test passed." -ForegroundColor Green
    Write-Host "Workspace: $WorkspaceRoot"
    Write-Host "Model root: $ModelRoot"
    Write-Host "uv: $uv"
    return
}
foreach ($directory in @($EditLoraRoot, $LogRoot, $ManifestRoot, $DownloadCache, $CustomNodesRoot)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
Confirm-ImageModelLicenses -WorkspaceRoot $WorkspaceRoot -AcceptLicenses:$AcceptLicenses
if (-not $SkipSpaceCheck) {
    Assert-ImageDownloadFreeSpace -Path $ModelRoot -MinimumBytes 5GB
}

Start-Transcript -LiteralPath $logPath -Append | Out-Null
try {
    Write-ImageDownloadStep "Preparing the official Hugging Face CLI"
    $uv = Get-ImageDownloadUv
    $env:HF_ENDPOINT = $HfEndpoint
    $env:HF_HOME = Join-Path $ModelRoot "cache\huggingface"
    $env:HF_HUB_CACHE = Join-Path $env:HF_HOME "hub"
    $env:HF_XET_CACHE = Join-Path $env:HF_HOME "xet"
    $env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
    $toolPrefix = @("tool", "run", "--python", "3.12", "--from", "huggingface-hub", "hf")
    & $uv @toolPrefix "version"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to start the official hf CLI. Keep the VPN connected and rerun this launcher."
    }

    Write-ImageDownloadStep "Downloading Krea 2 Identity Edit v1.2"
    & $uv @toolPrefix "download" "conradlocke/krea2-identity-edit" `
        "--include" "krea2_identity_edit_v1_2.safetensors" `
        "--local-dir" $EditLoraRoot `
        "--max-workers" "4"
    if ($LASTEXITCODE -ne 0) {
        throw "Hugging Face download failed: conradlocke/krea2-identity-edit"
    }
    $identityLora = Join-Path $EditLoraRoot "krea2_identity_edit_v1_2.safetensors"
    Assert-ImageModelFile -Path $identityLora -MinimumBytes 1GB

    Write-ImageDownloadStep "Installing the pinned Krea 2 Edit node pack"
    $nodeVersion = "1.2.5"
    $nodeTarget = [System.IO.Path]::GetFullPath((Join-Path $CustomNodesRoot "comfyui-krea2edit"))
    $allowedPrefix = $CustomNodesRoot.TrimEnd('\') + '\'
    if (-not $nodeTarget.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to install outside the expected ComfyUI custom_nodes directory: $nodeTarget"
    }

    $installedVersion = ""
    $installedProjectFile = Join-Path $nodeTarget "pyproject.toml"
    if (Test-Path -LiteralPath $installedProjectFile -PathType Leaf) {
        $versionMatch = Select-String -LiteralPath $installedProjectFile -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
        if ($versionMatch) {
            $installedVersion = $versionMatch.Matches[0].Groups[1].Value
        }
    }

    if ($installedVersion -eq $nodeVersion) {
        Write-Host "Krea 2 Edit node pack v$nodeVersion is already installed." -ForegroundColor Green
    }
    else {
        $zipPath = Join-Path $DownloadCache ("comfyui-krea2edit-v{0}.zip" -f $nodeVersion)
        $extractRoot = Join-Path $DownloadCache ("extract_{0}_{1}" -f $timestamp, [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
        Invoke-WebRequest `
            -Uri ("https://github.com/lbouaraba/comfyui-krea2edit/archive/refs/tags/v{0}.zip" -f $nodeVersion) `
            -OutFile $zipPath `
            -Headers @{ "User-Agent" = "CLSF-AI-Lab-Studio-Installer" }
        Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
        $extracted = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
        if (-not $extracted -or -not (Test-Path -LiteralPath (Join-Path $extracted.FullName "__init__.py") -PathType Leaf)) {
            throw "The downloaded Krea 2 Edit node archive is incomplete."
        }
        if (Test-Path -LiteralPath $nodeTarget -PathType Container) {
            $backupTarget = Join-Path $CustomNodesRoot ("comfyui-krea2edit.backup_{0}" -f $timestamp)
            Move-Item -LiteralPath $nodeTarget -Destination $backupTarget
            Write-Host "Previous node pack moved to: $backupTarget" -ForegroundColor Yellow
        }
        Move-Item -LiteralPath $extracted.FullName -Destination $nodeTarget
    }

    Set-ImageModelExtraPaths -WorkspaceRoot $WorkspaceRoot -ModelRoot $ModelRoot
    $inventoryPath = Join-Path $ManifestRoot ("inventory_image_hf_vpn_{0}.csv" -f $timestamp)
    Export-ImageModelInventory -Root $ImageRoot -OutputPath $inventoryPath
    $hash = (Get-FileHash -LiteralPath $identityLora -Algorithm SHA256).Hash.ToLowerInvariant()
    [ordered]@{
        completed_utc = [DateTime]::UtcNow.ToString("o")
        source = "Hugging Face and GitHub"
        identity_edit_lora = $identityLora
        identity_edit_sha256 = $hash
        custom_node = $nodeTarget
        custom_node_version = $nodeVersion
        inventory = $inventoryPath
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $ManifestRoot "image-hf-vpn-download-complete.json") -Encoding UTF8

    Write-ImageDownloadStep "VPN image extensions completed"
    Write-Host "Identity Edit v1.2 and node pack v$nodeVersion are ready." -ForegroundColor Green
    Write-Host "Restart the local runtime after the domestic model package is also complete." -ForegroundColor Green
    Write-Host "Inventory: $inventoryPath" -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host ("DOWNLOAD FAILED: {0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host "Keep the VPN connected and rerun this launcher to resume." -ForegroundColor Yellow
    Write-Host "Log: $logPath" -ForegroundColor Yellow
    throw
}
finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
