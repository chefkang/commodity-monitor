$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) {
  $Python = "python"
}

$LogDir = Join-Path $Root "runtime\internal"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogPath = Join-Path $LogDir "procurement_refresh.log"
$StatusPath = Join-Path $LogDir "procurement_refresh_status.txt"

function Add-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value $line
}

function Run-Step {
  param(
    [string]$Name,
    [string]$RelativeScript
  )
  Add-Log "start: $Name"
  $scriptPath = Join-Path $Root $RelativeScript
  & $Python $scriptPath *>&1 | ForEach-Object { Add-Log "  $_" }
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
  Add-Log "done: $Name"
}

try {
  Add-Log "internal procurement refresh started"
  Run-Step "import_h3_exports" "scripts\import_mtn_h3_exports.py"
  Run-Step "build_stock_forecast" "scripts\build_internal_stock_forecast.py"
  Run-Step "build_procurement_dashboard" "scripts\build_internal_procurement_dashboard.py"
  $status = "OK: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') refreshed internal procurement dashboard and rolling forecast."
  Set-Content -LiteralPath $StatusPath -Encoding UTF8 -Value $status
  Add-Log $status
  exit 0
} catch {
  $status = "FAILED: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $($_.Exception.Message)"
  Set-Content -LiteralPath $StatusPath -Encoding UTF8 -Value $status
  Add-Log $status
  exit 1
}
