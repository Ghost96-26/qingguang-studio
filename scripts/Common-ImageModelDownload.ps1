Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "Continue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

function Write-ImageDownloadStep {
    param([Parameter(Mandatory = $true)][string]$Message)

    Write-Host ""
    Write-Host ("==== {0} ====" -f $Message) -ForegroundColor Cyan
}

function Get-ImageDownloadUv {
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

function Assert-ImageDownloadWorkspace {
    param([Parameter(Mandatory = $true)][string]$WorkspaceRoot)

    $required = @(
        (Join-Path $WorkspaceRoot "runtime\ComfyUI\main.py"),
        (Join-Path $WorkspaceRoot "config\runtime.json")
    )
    foreach ($path in $required) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "The image-model launcher must use the existing workbench at C:\QingguangStudio. Missing: $path"
        }
    }
}

function Assert-ImageDownloadFreeSpace {
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

function Confirm-ImageModelLicenses {
    param(
        [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
        [switch]$AcceptLicenses
    )

    $recordPath = Join-Path $WorkspaceRoot "config\image-model-licenses.accepted.json"
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        return
    }

    Write-Host "Krea 2 uses the Krea 2 Community License." -ForegroundColor Yellow
    Write-Host "Ideogram 4 uses the Ideogram Non-Commercial Model Agreement." -ForegroundColor Yellow
    Write-Host "This installation is intended for the stated internal teaching and research use." -ForegroundColor Yellow
    Write-Host "Krea:     https://huggingface.co/krea/Krea-2-Turbo/blob/main/LICENSE.pdf"
    Write-Host "Ideogram: https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md"

    if (-not $AcceptLicenses) {
        $answer = Read-Host "Type ACCEPT to confirm that you have reviewed and accept both model licenses"
        if ($answer -cne "ACCEPT") {
            throw "Model license acceptance was not confirmed. No model download was started."
        }
    }

    [ordered]@{
        accepted_utc = [DateTime]::UtcNow.ToString("o")
        purpose = "internal_teaching_and_research"
        krea_2_community_license = $true
        ideogram_non_commercial_model_agreement = $true
    } | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
}

function Assert-ImageModelFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][long]$MinimumBytes
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required model file is missing: $Path"
    }
    $length = (Get-Item -LiteralPath $Path).Length
    if ($length -lt $MinimumBytes) {
        throw "Model file is unexpectedly small: $Path ($length bytes)"
    }
}

function Export-ImageModelInventory {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$OutputPath
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

function Set-ImageModelExtraPaths {
    param(
        [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
        [Parameter(Mandatory = $true)][string]$ModelRoot
    )

    $yamlRoot = $ModelRoot.Replace('\', '/')
    $content = @"
minimax_h3_local:
  base_path: $yamlRoot/video/minimax-h3
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
  loras: loras

krea2_bf16_local:
  base_path: $yamlRoot/image/krea2
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
  loras: loras

ideogram4_local:
  base_path: $yamlRoot/image/ideogram4
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
"@
    Set-Content -LiteralPath (Join-Path $WorkspaceRoot "config\extra_model_paths.yaml") -Value $content -Encoding UTF8
}
