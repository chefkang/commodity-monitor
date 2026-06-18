param(
  [int]$BackfillDays = 180,
  [switch]$OpenDashboard,
  [switch]$NoNews
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
$BuildPublicSite = Join-Path $Root "scripts\build_public_site.py"

if (-not (Test-Path $VenvPython)) {
  & (Join-Path $Root "setup.ps1")
}

$MonitorArgs = @((Join-Path $Root "scripts\commodity_monitor.py"), "--backfill-days", "$BackfillDays")
if ($NoNews) {
  $MonitorArgs += "--no-news"
}

& $VenvPython @MonitorArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

& $VenvPython $BuildPublicSite
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if ($OpenDashboard) {
  Start-Process (Join-Path $Root "dashboard\index.html")
}
