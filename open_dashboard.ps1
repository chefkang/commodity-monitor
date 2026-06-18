param()

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$HealthCheck = Join-Path $Root "scripts\check_refresh_health.ps1"
$Dashboard = Join-Path $Root "dashboard\index.html"

function Get-CacheBustedFileUri {
  param([string]$Path)

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $uri = [System.Uri]$resolved
  return "$($uri.AbsoluteUri)?ts=$((Get-Date).ToString('yyyyMMddHHmmss'))"
}

& "powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $HealthCheck -Slot auto -Repair
if ($LASTEXITCODE -ne 0) {
  throw "Refresh health check failed with exit code $LASTEXITCODE"
}

Start-Process (Get-CacheBustedFileUri -Path $Dashboard)
