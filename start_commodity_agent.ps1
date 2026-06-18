param(
  [int]$Port = 8787,
  [switch]$Refresh
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root ".venv\Scripts\python.exe"
$Daily = Join-Path $Root "run_daily.ps1"
$ServerScript = Join-Path $Root "scripts\commodity_agent_server.py"
$Url = "http://127.0.0.1:$Port/"

if ($Refresh) {
  & $Daily -BackfillDays 180 | Out-Null
}

if (-not (Test-Path $Python)) {
  & (Join-Path $Root "setup.ps1") | Out-Null
}

$alreadyListening = $false
try {
  $alreadyListening = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
} catch {
  $alreadyListening = $false
}

if (-not $alreadyListening) {
  Start-Process -FilePath $Python `
    -ArgumentList @($ServerScript, "--port", "$Port") `
    -WorkingDirectory $Root `
    -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
}

Start-Process $Url
