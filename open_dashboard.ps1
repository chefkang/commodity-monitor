param()

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$OpenView = Join-Path $Root "open_monitor_view.ps1"

& "powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $OpenView -View dashboard
if ($LASTEXITCODE -ne 0) {
  throw "open_monitor_view.ps1 failed with exit code $LASTEXITCODE"
}
