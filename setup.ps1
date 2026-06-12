param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path $BundledPython)) {
  Write-Host "没有找到 Codex 内置 Python: $BundledPython"
  exit 1
}

if (-not (Test-Path $VenvPython)) {
  & $BundledPython -m venv (Join-Path $Root ".venv")
}

& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r (Join-Path $Root "requirements.txt")
