param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Daily = Join-Path $Root "run_daily.ps1"
$Report = Join-Path $Root "dashboard\report.html"

Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  $Daily,
  "-BackfillDays",
  "180"
)

Start-Sleep -Seconds 1
Start-Process $Report
