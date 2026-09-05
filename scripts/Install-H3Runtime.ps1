[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot "runtime"
$pythonInstall = Join-Path $runtimeRoot "python"
$venv = Join-Path $runtimeRoot ".venv"
$comfy = Join-Path $runtimeRoot "ComfyUI"
$env:UV_CACHE_DIR = Join-Path $projectRoot ".cache\uv"
$env:UV_PYTHON_INSTALL_DIR = $pythonInstall

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv is required but was not found."
}

uv python install 3.12
if (-not (Test-Path -LiteralPath (Join-Path $venv "Scripts\python.exe"))) {
    uv venv $venv --python 3.12 --seed
}

$python = Join-Path $venv "Scripts\python.exe"
uv pip install --python $python torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu130

if (-not (Test-Path -LiteralPath (Join-Path $comfy "requirements.txt"))) {
    throw "ComfyUI source is missing at $comfy. Restore the pinned source before installing dependencies."
}
uv pip install --python $python -r (Join-Path $comfy "requirements.txt") --extra-index-url https://download.pytorch.org/whl/cu130

Write-Host "Runtime dependencies installed. Run 03_H3_Runtime_Doctor.cmd next." -ForegroundColor Green

