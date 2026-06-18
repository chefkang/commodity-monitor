param(
  [int]$BackfillDays = 180,
  [switch]$OpenDashboard,
  [switch]$NoNews,
  [switch]$SkipPostRefreshHealthCheck
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
$BuildPublicSite = Join-Path $Root "scripts\build_public_site.py"
$HealthCheck = Join-Path $Root "scripts\check_refresh_health.ps1"
$LatestJson = Join-Path $Root "data\latest.json"
$NewsJson = Join-Path $Root "data\news.json"

function Get-CacheBustedFileUri {
  param([string]$Path)

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $uri = [System.Uri]$resolved
  return "$($uri.AbsoluteUri)?ts=$((Get-Date).ToString('yyyyMMddHHmmss'))"
}

function Read-JsonFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-RefreshOutputState {
  $latest = Read-JsonFile -Path $LatestJson
  $news = Read-JsonFile -Path $NewsJson
  $warnings = @()

  if ($latest -and $latest.summary -and $latest.summary.refresh_warnings) {
    foreach ($warning in $latest.summary.refresh_warnings) {
      $warnings += [string]$warning
    }
  }

  $latestNewsCount = if ($latest) { @($latest.news).Count } else { 0 }
  $cacheNewsCount = if ($news) { @($news).Count } else { 0 }

  return [pscustomobject]@{
    latest_news_count = $latestNewsCount
    cache_news_count = $cacheNewsCount
    warning_count = $warnings.Count
    mismatch = ($latestNewsCount -eq 0 -and $cacheNewsCount -gt 0)
  }
}

function Get-RefreshSlotContext {
  $now = Get-Date
  $morningSlot = Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 10 -Minute 0 -Second 0
  $afternoonSlot = Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 15 -Minute 0 -Second 0

  if ($now -lt $morningSlot) {
    return [pscustomobject]@{
      slot = "morning"
      repair_allowed = $false
    }
  }

  if ($now.Hour -lt 13) {
    return [pscustomobject]@{
      slot = "morning"
      repair_allowed = $true
    }
  }

  if ($now -lt $afternoonSlot) {
    return [pscustomobject]@{
      slot = "afternoon"
      repair_allowed = $false
    }
  }

  return [pscustomobject]@{
    slot = "afternoon"
    repair_allowed = $true
  }
}

function Invoke-PostRefreshHealthCheck {
  if ($SkipPostRefreshHealthCheck) {
    return
  }

  if ($env:GITHUB_ACTIONS -eq "true" -or $env:CI -eq "true") {
    return
  }

  if (-not (Test-Path -LiteralPath $HealthCheck)) {
    Write-Warning "Post-refresh health check script not found: $HealthCheck"
    return
  }

  $slotContext = Get-RefreshSlotContext
  if (-not $slotContext.repair_allowed) {
    Write-Host "Skipping post-refresh public sync because the current monitoring slot has not started yet."
    return
  }

  Write-Host "Running post-refresh health check to keep the public dashboard aligned with the latest local refresh..."
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $HealthCheck -Slot $slotContext.slot -Repair -SkipRepairBeforeSlot
  if ($LASTEXITCODE -ne 0) {
    throw "Post-refresh health check failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path $VenvPython)) {
  & (Join-Path $Root "setup.ps1")
}

$MonitorArgs = @((Join-Path $Root "scripts\commodity_monitor.py"), "--backfill-days", "$BackfillDays")
if ($NoNews) {
  $MonitorArgs += "--no-news"
}

for ($attempt = 1; $attempt -le 2; $attempt++) {
  if ($attempt -gt 1) {
    Write-Host "Detected degraded local payload; retrying commodity refresh (attempt $attempt of 2)..."
  }

  & $VenvPython @MonitorArgs
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  $refreshState = Get-RefreshOutputState
  if (-not $refreshState.mismatch) {
    break
  }
}

if (-not $refreshState -or $refreshState.mismatch) {
  Write-Error "Commodity refresh produced a degraded payload: latest.json has $($refreshState.latest_news_count) news items while news.json cache still has $($refreshState.cache_news_count)."
  exit 3
}

& $VenvPython $BuildPublicSite
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Invoke-PostRefreshHealthCheck

if ($OpenDashboard) {
  Start-Process (Get-CacheBustedFileUri -Path (Join-Path $Root "dashboard\index.html"))
}
