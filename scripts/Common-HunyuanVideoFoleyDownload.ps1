Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "Continue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

function Write-FoleyDownloadStep {
    param([Parameter(Mandatory = $true)][string]$Message)

    Write-Host ""
    Write-Host ("==== {0} ====" -f $Message) -ForegroundColor Cyan
}

function Get-FoleyDownloadUv {
    $command = Get-Command uv -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $fallbacks = @(
        (Join-Path $env:LOCALAPPDATA "hermes\bin\uv.exe"),
        (Join-Path $env:USERPROFILE ".local\bin\uv.exe")
    )
    foreach ($candidate in $fallbacks) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    throw "uv.exe was not found. Restore the existing runtime tools, then rerun this launcher."
}

function Assert-FoleyDownloadWorkspace {
    param([Parameter(Mandatory = $true)][string]$WorkspaceRoot)

    foreach ($path in @(
        (Join-Path $WorkspaceRoot "runtime\ComfyUI\main.py"),
        (Join-Path $WorkspaceRoot "config\runtime.json")
    )) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "The Foley downloader must use the existing workbench at C:\QingguangStudio. Missing: $path"
        }
    }
}

function Assert-FoleyDownloadFreeSpace {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][long]$MinimumBytes
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $driveName = [System.IO.Path]::GetPathRoot($fullPath).TrimEnd('\').TrimEnd(':')
    $drive = Get-PSDrive -Name $driveName -ErrorAction Stop
    if ($drive.Free -lt $MinimumBytes) {
        $freeGiB = [math]::Round($drive.Free / 1GB, 1)
        $requiredGiB = [math]::Round($MinimumBytes / 1GB, 1)
        throw "Drive $driveName`: has only $freeGiB GiB free; at least $requiredGiB GiB is required."
    }
}

function Confirm-HunyuanVideoFoleyLicense {
    param(
        [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
        [switch]$AcceptLicense
    )

    $recordPath = Join-Path $WorkspaceRoot "config\hunyuanvideo-foley-license.accepted.json"
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        return
    }

    Write-Host "HunyuanVideo-Foley uses the Tencent Hunyuan Community License Agreement." -ForegroundColor Yellow
    Write-Host "The license territory excludes the European Union, United Kingdom and South Korea." -ForegroundColor Yellow
    Write-Host "Review the current official license before using or exposing this model as a service:" -ForegroundColor Yellow
    Write-Host "https://github.com/Tencent-Hunyuan/HunyuanVideo-Foley/blob/main/LICENSE"
    if (-not $AcceptLicense) {
        $answer = Read-Host "Type ACCEPT to confirm that you have reviewed and accept the model license"
        if ($answer -cne "ACCEPT") {
            throw "Model license acceptance was not confirmed. No model download was started."
        }
    }

    [ordered]@{
        accepted_utc = [DateTime]::UtcNow.ToString("o")
        model = "Tencent HunyuanVideo-Foley XXL"
        license = "Tencent Hunyuan Community License Agreement"
        license_url = "https://github.com/Tencent-Hunyuan/HunyuanVideo-Foley/blob/main/LICENSE"
        territory_exclusions_acknowledged = @("European Union", "United Kingdom", "South Korea")
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $recordPath -Encoding UTF8
}

function Get-HunyuanVideoFoleyFiles {
    return @(
        "hunyuanvideo_foley.pth",
        "synchformer_state_dict.pth",
        "vae_128d_48k.pth",
        "config.yaml",
        "LICENSE",
        "NOTICE",
        "README.md"
    )
}

function Assert-HunyuanVideoFoleyPackage {
    param(
        [Parameter(Mandatory = $true)][string]$ModelRoot,
        [switch]$SkipHashValidation
    )

    $expected = @(
        @{ Name = "hunyuanvideo_foley.pth"; Bytes = 10301204679L; Sha256 = "2900021f8ee562a8175b2f1a3fafb06b9e9e848f11f4c6d4d5d72e126f7c0475" },
        @{ Name = "synchformer_state_dict.pth"; Bytes = 950058171L; Sha256 = "8aff082f2df5c3bc52759db0c865c7ee772ae6400b860d1b7e90413f2defb67c" },
        @{ Name = "vae_128d_48k.pth"; Bytes = 1486465965L; Sha256 = "07e6139ff33bd21ba8a7a7f40ed24aab13ac0d100cd686f8a9f3e03dc5251cb1" }
    )
    foreach ($item in $expected) {
        $path = Join-Path $ModelRoot $item.Name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Required XXL model file is missing: $path"
        }
        $actualBytes = (Get-Item -LiteralPath $path).Length
        if ($actualBytes -ne $item.Bytes) {
            throw "Model file size mismatch: $path (expected $($item.Bytes), got $actualBytes)"
        }
        if (-not $SkipHashValidation) {
            Write-Host ("Verifying SHA256: {0}" -f $item.Name) -ForegroundColor DarkCyan
            $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -cne $item.Sha256) {
                throw "Model file SHA256 mismatch: $path"
            }
        }
    }

    $smallFiles = @{
        "config.yaml" = 1000L
        "LICENSE" = 15000L
        "NOTICE" = 2000L
        "README.md" = 15000L
    }
    foreach ($name in $smallFiles.Keys) {
        $path = Join-Path $ModelRoot $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -lt $smallFiles[$name]) {
            throw "Required repository metadata is missing or incomplete: $path"
        }
    }
}

function Export-HunyuanVideoFoleyInventory {
    param(
        [Parameter(Mandatory = $true)][string]$ModelRoot,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($ModelRoot).TrimEnd('\')
    Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse |
        Where-Object { $_.FullName -notlike "*\.cache\*" } |
        ForEach-Object {
            [pscustomobject]@{
                RelativePath = $_.FullName.Substring($resolvedRoot.Length).TrimStart('\')
                Bytes = $_.Length
                Sha256 = if ($_.Length -lt 20MB) { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } else { "validated-against-official-manifest" }
                ModifiedUtc = $_.LastWriteTimeUtc.ToString("o")
            }
        } |
        Sort-Object RelativePath |
        Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8
}

function Write-HunyuanVideoFoleyCompletionManifest {
    param(
        [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
        [Parameter(Mandatory = $true)][string]$ModelRoot,
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$InventoryPath
    )

    [ordered]@{
        completed_utc = [DateTime]::UtcNow.ToString("o")
        source = $Source
        repository = "Tencent-Hunyuan/HunyuanVideo-Foley"
        official_huggingface_repository = "tencent/HunyuanVideo-Foley"
        profile = "XXL BF16 quality"
        model_root = $ModelRoot
        expected_runtime_vram_gb = 20
        expected_offload_vram_gb = 12
        audio_sample_rate_hz = 48000
        inventory = $InventoryPath
        deployment_status = "weights_downloaded_not_installed"
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $WorkspaceRoot "manifests\hunyuanvideo-foley-xxl-download-complete.json") -Encoding UTF8
}
