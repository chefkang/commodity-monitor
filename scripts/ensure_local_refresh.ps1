param(
  [ValidateSet("auto", "morning", "afternoon")]
  [string]$Slot = "auto",
  [int]$BackfillDays = 180,
  [switch]$SkipPostRefreshHealthCheck
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir = Join-Path $Root "runtime"
$LogFile = Join-Path $LogDir "local-refresh.log"
$LatestJson = Join-Path $Root "data\latest.json"
$NewsJson = Join-Path $Root "data\news.json"
$RunDaily = Join-Path $Root "run_daily.ps1"
$MutexName = "Global\CommodityMonitorLocalRefresh"

function Write-Log {
  param([string]$Message)

  if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
  }

  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value "[$stamp] $Message"
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

function Get-LatestTradeDate {
  param($Payload)

  if (-not $Payload) {
    return $null
  }

  $declaredLatestTradeDate = ""
  if ($Payload.PSObject.Properties.Name -contains "latest_trade_date") {
    $declaredLatestTradeDate = [string]$Payload.latest_trade_date
  }
  if (-not [string]::IsNullOrWhiteSpace($declaredLatestTradeDate)) {
    return $declaredLatestTradeDate.Trim()
  }

  $dates = @()
  foreach ($item in @($Payload.latest)) {
    $dateText = [string]$item.date
    if (-not [string]::IsNullOrWhiteSpace($dateText)) {
      $dates += $dateText.Trim()
    }
  }

  if (-not $dates) {
    return $null
  }

  return ($dates | Sort-Object -Descending | Select-Object -First 1)
}

function Get-TradeDateCoverage {
  param($Payload)

  $dates = @()
  if (-not $Payload) {
    return [pscustomobject]@{
      latest_trade_date = $null
      latest_trade_date_count = 0
      dominant_trade_date = $null
      dominant_trade_date_count = 0
      latest_item_count = 0
      mixed_trade_dates = $false
    }
  }

  foreach ($item in @($Payload.latest)) {
    $dateText = [string]$item.date
    if (-not [string]::IsNullOrWhiteSpace($dateText)) {
      $dates += $dateText.Trim()
    }
  }

  if (-not $dates) {
    return [pscustomobject]@{
      latest_trade_date = $null
      latest_trade_date_count = 0
      dominant_trade_date = $null
      dominant_trade_date_count = 0
      latest_item_count = 0
      mixed_trade_dates = $false
    }
  }

  $latestTradeDate = Get-LatestTradeDate -Payload $Payload
  $groups = @($dates | Group-Object | Sort-Object @{ Expression = "Count"; Descending = $true }, @{ Expression = "Name"; Descending = $true })
  $dominantTradeDate = if ($groups) { [string]$groups[0].Name } else { $latestTradeDate }
  $dominantTradeDateCount = if ($groups) { [int]$groups[0].Count } else { 0 }

  return [pscustomobject]@{
    latest_trade_date = $latestTradeDate
    latest_trade_date_count = @($dates | Where-Object { $_ -eq $latestTradeDate }).Count
    dominant_trade_date = $dominantTradeDate
    dominant_trade_date_count = $dominantTradeDateCount
    latest_item_count = $dates.Count
    mixed_trade_dates = ($groups.Count -gt 1)
  }
}

function Get-LocalState {
  $latest = Read-JsonFile -Path $LatestJson
  $news = Read-JsonFile -Path $NewsJson
  $coverage = Get-TradeDateCoverage -Payload $latest

  $generatedAt = $null
  if ($latest -and $latest.generated_at) {
    try {
      $generatedAt = [DateTimeOffset]::Parse([string]$latest.generated_at).ToLocalTime().DateTime
    } catch {
      Write-Log "WARN: failed to parse data\\latest.json generated_at: $($_.Exception.Message)"
    }
  }

  $latestNewsCount = if ($latest) { @($latest.news).Count } else { 0 }
  $cacheNewsCount = if ($news) { @($news).Count } else { 0 }

  return [pscustomobject]@{
    generated_at = $generatedAt
    latest_trade_date = $coverage.latest_trade_date
    latest_trade_date_count = $coverage.latest_trade_date_count
    dominant_trade_date = $coverage.dominant_trade_date
    dominant_trade_date_count = $coverage.dominant_trade_date_count
    latest_item_count = $coverage.latest_item_count
    mixed_trade_dates = $coverage.mixed_trade_dates
    latest_news_count = $latestNewsCount
    cache_news_count = $cacheNewsCount
    mismatch = ($latestNewsCount -eq 0 -and $cacheNewsCount -gt 0)
  }
}

function Test-MorningTradeDateReady {
  param(
    $State,
    [datetime]$SlotTime
  )

  if (-not $State -or -not $State.generated_at) {
    return $false
  }

  $latestTradeDate = [string]$State.latest_trade_date
  if ([string]::IsNullOrWhiteSpace($latestTradeDate)) {
    return $false
  }

  return (
    $latestTradeDate -eq $SlotTime.ToString("yyyy-MM-dd") -and
    $State.generated_at.Date -eq $SlotTime.Date
  )
}

function Test-LocalPayloadHealthy {
  param(
    $State,
    [datetime]$SlotTime,
    [string]$Slot,
    [datetime]$Now = (Get-Date)
  )

  if (-not $State -or -not $State.generated_at) {
    return $false
  }

  if ($State.mismatch) {
    return $false
  }

  if ($State.generated_at -ge $SlotTime) {
    if (
      $State.mixed_trade_dates -and
      $State.latest_item_count -gt 0 -and
      $State.latest_trade_date_count -lt $State.latest_item_count -and
      ((New-TimeSpan -Start $State.generated_at -End $Now).TotalMinutes -ge 45)
    ) {
      return $false
    }
    return $true
  }

  if ($Slot -eq "morning" -and $Now -lt $SlotTime -and (Test-MorningTradeDateReady -State $State -SlotTime $SlotTime)) {
    return $true
  }

  return $false
}

$mutex = New-Object System.Threading.Mutex($false, $MutexName)
$hasHandle = $false

try {
  $hasHandle = $mutex.WaitOne(0, $false)
  if (-not $hasHandle) {
    Write-Log "Skip local refresh because another refresh process is already running."
    exit 0
  }

  $now = Get-Date
  if ($Slot -eq "auto") {
    $Slot = if ($now.Hour -lt 13) { "morning" } else { "afternoon" }
  }

  $slotTime = if ($Slot -eq "morning") {
    Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 10 -Minute 0 -Second 0
  } else {
    Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 15 -Minute 0 -Second 0
  }

  $state = Get-LocalState
  if (Test-LocalPayloadHealthy -State $state -SlotTime $slotTime -Slot $Slot -Now $now) {
    Write-Log "$Slot slot already refreshed locally at $($state.generated_at.ToString('yyyy-MM-dd HH:mm:ss'))."
    exit 0
  }

  if ($state.generated_at -and $state.generated_at -ge $slotTime -and $state.mismatch) {
    Write-Log "$Slot slot local payload is degraded (latest news=$($state.latest_news_count), cache news=$($state.cache_news_count)). Rebuilding."
  } else {
    Write-Log "$Slot slot is stale locally. Starting run_daily.ps1."
  }

  for ($attempt = 1; $attempt -le 2; $attempt++) {
    if ($attempt -gt 1) {
      Write-Log "$Slot slot retrying local refresh after degraded output. Attempt $attempt of 2."
    }

    $runDailyArgs = @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", $RunDaily,
      "-BackfillDays", "$BackfillDays"
    )
    if ($SkipPostRefreshHealthCheck) {
      $runDailyArgs += "-SkipPostRefreshHealthCheck"
    }

    & powershell.exe @runDailyArgs
    if ($LASTEXITCODE -ne 0) {
      throw "run_daily.ps1 exited with code $LASTEXITCODE"
    }

    $state = Get-LocalState
    if (Test-LocalPayloadHealthy -State $state -SlotTime $slotTime -Slot $Slot -Now (Get-Date)) {
      Write-Log "$Slot slot local refresh completed at $($state.generated_at.ToString('yyyy-MM-dd HH:mm:ss'))."
      exit 0
    }
  }

  $finalNow = Get-Date
  if ($Slot -eq "morning" -and $finalNow -lt $slotTime) {
    $tradeDateText = if ($state -and $state.latest_trade_date) { [string]$state.latest_trade_date } else { "unknown" }
    Write-Log "$Slot slot ran before the official window. Latest trade date is still $tradeDateText, so the next retry window will continue waiting for today's data."
    exit 0
  }

  if ($state -and $state.generated_at) {
    throw "Local refresh finished at $($state.generated_at.ToString('yyyy-MM-dd HH:mm:ss')) but payload is still degraded (latest news=$($state.latest_news_count), cache news=$($state.cache_news_count))."
  }

  throw "Local refresh finished, but generated_at could not be read."
} finally {
  if ($hasHandle) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
