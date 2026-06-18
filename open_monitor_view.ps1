param(
  [ValidateSet("report", "dashboard")]
  [string]$View = "report"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$HealthCheck = Join-Path $Root "scripts\check_refresh_health.ps1"

function Get-CacheBustedFileUri {
  param([string]$Path)

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $uri = [System.Uri]$resolved
  return "$($uri.AbsoluteUri)?ts=$((Get-Date).ToString('yyyyMMddHHmmss'))"
}

function Get-CacheBustedWebUrl {
  param([string]$Url)

  $separator = if ($Url.Contains("?")) { "&" } else { "?" }
  return "${Url}${separator}ts=$((Get-Date).ToString('yyyyMMddHHmmss'))"
}

& "powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $HealthCheck -Slot auto -Repair -SkipRepairBeforeSlot
if ($LASTEXITCODE -ne 0) {
  throw "Refresh health check failed with exit code $LASTEXITCODE"
}

$targets = @{
  report = @{
    local = Join-Path $Root "dashboard\report.html"
    public = "https://chefkang.github.io/commodity-monitor/"
  }
  dashboard = @{
    local = Join-Path $Root "dashboard\index.html"
    public = "https://chefkang.github.io/commodity-monitor/trend.html"
  }
}

$targetSet = $targets[$View]
if (Test-Path -LiteralPath $targetSet.local) {
  Start-Process (Get-CacheBustedFileUri -Path $targetSet.local)
  return
}

Start-Process (Get-CacheBustedWebUrl -Url $targetSet.public)
