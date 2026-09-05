[CmdletBinding()]
param(
    [string]$Listen = "",
    [int]$Port = 0,
    [int]$WaitSeconds = 0,
    [ValidateSet("h3", "image")]
    [string]$Family = "h3",
    [switch]$Foreground
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common-H3Runtime.ps1")

$config = Get-H3RuntimeConfig
if ($Listen) { $config.listen = $Listen }
if ($Port -gt 0) { $config.port = $Port }
if ($WaitSeconds -le 0) { $WaitSeconds = [int]$config.startup_timeout_seconds }

$python = [string]$config.python_executable
$comfyRoot = [string]$config.comfyui_root
$mainPy = Join-Path $comfyRoot "main.py"
$extraPaths = [string]$config.extra_model_paths
$baseUrl = Get-H3BaseUrl -Config $config
$logRoot = Join-Path $script:ProjectRoot "logs"
$stdoutLog = Join-Path $logRoot "comfyui.stdout.log"
$stderrLog = Join-Path $logRoot "comfyui.stderr.log"
$pidFile = Join-Path $logRoot "comfyui.pid.json"

foreach ($required in @($python, $mainPy, $extraPaths)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required runtime file is missing: $required"
    }
}
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
Set-H3OfflineEnvironment -Config $config

if (Test-H3ComfyEndpoint -BaseUrl $baseUrl) {
    Write-Host "ComfyUI is already healthy: $baseUrl" -ForegroundColor Green
    exit 0
}

$arguments = @(
    $mainPy,
    "--listen", [string]$config.listen,
    "--port", [string]$config.port,
    "--extra-model-paths-config", $extraPaths,
    "--disable-auto-launch",
    "--preview-method", "none"
)
if ($config.disable_async_offload) {
    # Two-stream direct file reads can intermittently exhaust Windows I/O
    # resources (error 1450) with the 32B encoder. Serial offload is a little
    # slower but is substantially more reliable for image/reference workflows.
    $arguments += "--disable-async-offload"
}
if ($Family -eq "h3" -and $config.h3_dynamic_vram) {
    # H3's quantized backbone plus BF16 Turbo LoRA briefly needs to materialize
    # patched weights.  ComfyUI's legacy estimated loader can over-commit at
    # this point and its OOM cleanup has triggered native Windows crashes.
    # DynamicVRAM keeps cold blocks off GPU and leaves headroom for the desktop
    # compositor / remote-control encoder.
    $arguments += "--enable-dynamic-vram"
    if ($config.h3_fast_disk) { $arguments += "--fast-disk" }
    $headroom = [double]$config.h3_vram_headroom_gb
    if ($headroom -gt 0) { $arguments += @("--vram-headroom", [string]$headroom) }
}
elseif ($config.disable_dynamic_vram) {
    # DynamicVRAM's direct file reader is fast at 1024 but can fail on large
    # BF16 Krea latents on Windows. Legacy estimated offload is slower and is
    # the stable default for the workstation's 32 GB VRAM / 64 GB RAM profile.
    $arguments += "--disable-dynamic-vram"
}
if ($Family -eq "image" -and $config.low_vram) {
    $arguments += "--lowvram"
}

Write-Host "Starting local H3 runtime at $baseUrl ..." -ForegroundColor Cyan
if ($Foreground) {
    Push-Location $comfyRoot
    try {
        & $python @arguments
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}

$process = Start-Process -FilePath $python `
    -ArgumentList $arguments `
    -WorkingDirectory $comfyRoot `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -WindowStyle Hidden `
    -PassThru

@{
    pid = $process.Id
    started_utc = (Get-Date).ToUniversalTime().ToString("o")
    base_url = $baseUrl
    family = $Family
    dynamic_vram = [bool]($Family -eq "h3" -and $config.h3_dynamic_vram)
    python = $python
    comfyui_root = $comfyRoot
} | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8

$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
    if ($process.HasExited) {
        $process.Refresh()
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        Write-Host "ComfyUI exited during startup with code $($process.ExitCode)." -ForegroundColor Red
        if (Test-Path -LiteralPath $stderrLog) {
            $tail = Get-Content -LiteralPath $stderrLog -Tail 100
            $tail
            $sacState = (Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy" -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
            if (($tail -join "`n") -match "应用程序控制策略|Smart App Control|code integrity policy" -or (($tail -join "`n") -match "DLL load failed while importing frame" -and $sacState -eq 1)) {
                Write-Host "Windows Smart App Control blocked an unsigned local Python/PyAV module." -ForegroundColor Yellow
                Write-Host "The workbench did not change this security setting. Review Windows Security > App & browser control > Smart App Control." -ForegroundColor Yellow
            }
        }
        exit 1
    }
    if (Test-H3ComfyEndpoint -BaseUrl $baseUrl -TimeoutSeconds 3) {
        Write-Host "H3 runtime is ready: $baseUrl" -ForegroundColor Green
        Write-Host "PID: $($process.Id)"
        Write-Host "Logs: $stdoutLog and $stderrLog"
        exit 0
    }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

Write-Host "Timed out waiting for ComfyUI. The process was left running for inspection." -ForegroundColor Red
Write-Host "Check: $stderrLog"
exit 2
