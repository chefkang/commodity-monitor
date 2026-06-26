param(
  [ValidateSet("auto", "morning", "afternoon")]
  [string]$Slot = "auto",
  [switch]$Repair,
  [switch]$SkipRepairBeforeSlot,
  [int]$BackfillDays = 180,
  [int]$PublishLagToleranceMinutes = 3
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RuntimeDir = Join-Path $Root "runtime"
$StatusPath = Join-Path $RuntimeDir "refresh_health.json"
$LogPath = Join-Path $RuntimeDir "refresh-health.log"
$BriefsDir = Join-Path $Root "briefs"
$LocalDashboardData = Join-Path $Root "dashboard\data.js"
$LatestJson = Join-Path $Root "data\latest.json"
$NewsJson = Join-Path $Root "data\news.json"
$EnsureRefresh = Join-Path $Root "scripts\ensure_local_refresh.ps1"
$RunDaily = Join-Path $Root "run_daily.ps1"
$RegisterTasks = Join-Path $Root "scripts\register_local_refresh_task.ps1"
$TriggerGithub = Join-Path $Root "scripts\trigger_github_update.ps1"
$PublicDataUrl = "https://chefkang.github.io/commodity-monitor/data.js"
$StatusBriefMarker = "<!-- refresh-status-brief -->"
$TaskNames = @(
  "CommodityMonitor-Local-Refresh",
  "CommodityMonitor-GitHub-Fallback",
  "CommodityMonitor-Health-Check",
  "CommodityMonitor-Login-Health-Check",
  "CommodityMonitor-Unlock-Health-Check"
)

function Write-Log {
  param([string]$Message)

  if (-not (Test-Path -LiteralPath $RuntimeDir)) {
    New-Item -ItemType Directory -Path $RuntimeDir | Out-Null
  }

  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "[$stamp] $Message"
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

function Parse-DateValue {
  param($Value)

  if (-not $Value) {
    return $null
  }
  try {
    return [DateTimeOffset]::Parse([string]$Value)
  } catch {
    return $null
  }
}

function Get-TradeDateCoverage {
  param($Payload)

  if (-not $Payload) {
    return [pscustomobject]@{
      latest_trade_date = $null
      latest_trade_date_count = 0
      dominant_trade_date = $null
      dominant_trade_date_count = 0
      latest_item_count = 0
      mixed_trade_dates = $false
      trade_date_distribution = @()
    }
  }

  $declaredLatestTradeDate = ""
  if ($Payload.PSObject.Properties.Name -contains "latest_trade_date") {
    $declaredLatestTradeDate = [string]$Payload.latest_trade_date
  }
  if (-not [string]::IsNullOrWhiteSpace($declaredLatestTradeDate)) {
    $declaredLatestTradeDate = $declaredLatestTradeDate.Trim()
  }

  $dates = @()
  foreach ($item in @($Payload.latest)) {
    $dateText = [string]$item.date
    if (-not [string]::IsNullOrWhiteSpace($dateText)) {
      $dates += $dateText.Trim()
    }
  }

  $latestTradeDate = $null
  if ($declaredLatestTradeDate) {
    $latestTradeDate = $declaredLatestTradeDate
  } elseif ($dates) {
    $latestTradeDate = ($dates | Sort-Object -Descending | Select-Object -First 1)
  }

  $groups = @(
    $dates |
      Group-Object |
      Sort-Object @{ Expression = "Count"; Descending = $true }, @{ Expression = "Name"; Descending = $true }
  )

  $latestTradeDateCount = if ($latestTradeDate) {
    @($dates | Where-Object { $_ -eq $latestTradeDate }).Count
  } else {
    0
  }
  $dominantTradeDate = if ($groups) { [string]$groups[0].Name } else { $latestTradeDate }
  $dominantTradeDateCount = if ($groups) { [int]$groups[0].Count } else { $latestTradeDateCount }
  $distribution = @(
    foreach ($group in $groups) {
      [ordered]@{
        date = [string]$group.Name
        count = [int]$group.Count
      }
    }
  )

  return [pscustomobject]@{
    latest_trade_date = $latestTradeDate
    latest_trade_date_count = $latestTradeDateCount
    dominant_trade_date = $dominantTradeDate
    dominant_trade_date_count = $dominantTradeDateCount
    latest_item_count = $dates.Count
    mixed_trade_dates = ($groups.Count -gt 1)
    trade_date_distribution = $distribution
  }
}

function Get-LatestTradeDate {
  param($Payload)

  return (Get-TradeDateCoverage -Payload $Payload).latest_trade_date
}

function Get-LocalState {
  $latest = Read-JsonFile -Path $LatestJson
  $news = Read-JsonFile -Path $NewsJson
  $tradeDateCoverage = Get-TradeDateCoverage -Payload $latest
  $warnings = @()
  if ($latest -and $latest.summary -and $latest.summary.refresh_warnings) {
    foreach ($warning in $latest.summary.refresh_warnings) {
      $warnings += [string]$warning
    }
  }

  return [pscustomobject]@{
    generated_at = Parse-DateValue $latest.generated_at
    latest_trade_date = $tradeDateCoverage.latest_trade_date
    latest_trade_date_count = $tradeDateCoverage.latest_trade_date_count
    dominant_trade_date = $tradeDateCoverage.dominant_trade_date
    dominant_trade_date_count = $tradeDateCoverage.dominant_trade_date_count
    latest_item_count = $tradeDateCoverage.latest_item_count
    mixed_trade_dates = $tradeDateCoverage.mixed_trade_dates
    trade_date_distribution = @($tradeDateCoverage.trade_date_distribution)
    latest_news_count = @($latest.news).Count
    cache_news_count = @($news).Count
    refresh_warning_count = $warnings.Count
    refresh_warnings = $warnings
  }
}

function Get-PublicState {
  try {
    $stamp = Get-Date -Format "yyyyMMddHHmmss"
    $response = Invoke-WebRequest -Uri "${PublicDataUrl}?ts=$stamp" -UseBasicParsing -TimeoutSec 30
    $match = [regex]::Match($response.Content, "(?s)window\.COMMODITY_MONITOR_DATA\s*=\s*(\{.*\})\s*;")
    if (-not $match.Success) {
      throw "public data payload not found"
    }
    $payload = $match.Groups[1].Value | ConvertFrom-Json
    $tradeDateCoverage = Get-TradeDateCoverage -Payload $payload
    return [pscustomobject]@{
      ok = $true
      generated_at = Parse-DateValue $payload.generated_at
      latest_trade_date = $tradeDateCoverage.latest_trade_date
      latest_trade_date_count = $tradeDateCoverage.latest_trade_date_count
      dominant_trade_date = $tradeDateCoverage.dominant_trade_date
      dominant_trade_date_count = $tradeDateCoverage.dominant_trade_date_count
      latest_item_count = $tradeDateCoverage.latest_item_count
      mixed_trade_dates = $tradeDateCoverage.mixed_trade_dates
      trade_date_distribution = @($tradeDateCoverage.trade_date_distribution)
      news_count = @($payload.news).Count
      content = [string]$response.Content
      error = $null
    }
  } catch {
    return [pscustomobject]@{
      ok = $false
      generated_at = $null
      latest_trade_date = $null
      latest_trade_date_count = 0
      dominant_trade_date = $null
      dominant_trade_date_count = 0
      latest_item_count = 0
      mixed_trade_dates = $false
      trade_date_distribution = @()
      news_count = $null
      content = ""
      error = $_.Exception.Message
    }
  }
}

function Sync-LocalDashboardData {
  param(
    [string]$Content,
    [string]$TargetPath
  )

  if (-not $Content -or -not $TargetPath) {
    return $false
  }

  $existingContent = ""
  if (Test-Path -LiteralPath $TargetPath) {
    try {
      $existingContent = Get-Content -LiteralPath $TargetPath -Raw -Encoding UTF8
    } catch {
      $existingContent = ""
    }
  }

  if ($existingContent -eq $Content) {
    return $false
  }

  $targetDir = Split-Path -Parent $TargetPath
  if (-not (Test-Path -LiteralPath $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  }

  [System.IO.File]::WriteAllText($TargetPath, $Content, [System.Text.UTF8Encoding]::new($false))
  return $true
}

function Get-TaskState {
  param([string]$TaskName)

  try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $task.TaskPath
    return [ordered]@{
      state = [string]$task.State
      last_run_time = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { ([DateTimeOffset]$info.LastRunTime).ToString("o") } else { $null }
      next_run_time = if ($info.NextRunTime -and $info.NextRunTime.Year -gt 2000) { ([DateTimeOffset]$info.NextRunTime).ToString("o") } else { $null }
      last_task_result = $info.LastTaskResult
    }
  } catch {
    return [ordered]@{
      state = "Missing"
      last_run_time = $null
      next_run_time = $null
      last_task_result = $null
    }
  }
}

function Get-TaskStates {
  $taskStates = [ordered]@{}
  foreach ($taskName in $TaskNames) {
    $taskStates[$taskName] = Get-TaskState -TaskName $taskName
  }
  return $taskStates
}

function Get-TaskIssues {
  param($TaskStates)

  $issues = New-Object System.Collections.Generic.List[string]
  if (-not $TaskStates) {
    return @($issues)
  }

  foreach ($entry in $TaskStates.GetEnumerator()) {
    $taskName = [string]$entry.Key
    $task = if ($entry.Value -is [System.Collections.IDictionary]) { $entry.Value } else { @{} }
    $state = [string]$task.state

    if ($state -eq "Missing") {
      $issues.Add("$taskName missing.")
      continue
    }

    if ($state -eq "Disabled") {
      $issues.Add("$taskName disabled.")
      continue
    }

    $lastTaskResult = $task.last_task_result
    $lastTaskResultNumber = $null
    if ($null -ne $lastTaskResult -and [string]$lastTaskResult -ne "") {
      try {
        $lastTaskResultNumber = [int64]$lastTaskResult
      } catch {
        $lastTaskResultNumber = $null
      }
    }

    if ($state -eq "Running") {
      continue
    }

    if ($null -ne $lastTaskResultNumber -and $lastTaskResultNumber -ne 0 -and $task.last_run_time) {
      $issues.Add("${taskName} last result=$lastTaskResultNumber.")
    }
  }

  return @($issues)
}

function Get-SlotContext {
  $now = Get-Date
  $todayMorning = Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 10 -Minute 0 -Second 0
  $todayAfternoon = Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 15 -Minute 0 -Second 0

  if ($Slot -ne "auto") {
    $resolvedSlot = $Slot
    $slotTime = if ($resolvedSlot -eq "morning") { $todayMorning } else { $todayAfternoon }
    $slotStarted = $now -ge $slotTime
    $nextSlot = if ($resolvedSlot -eq "morning") {
      if ($slotStarted) { "afternoon" } else { "morning" }
    } else {
      if ($slotStarted) { "morning" } else { "afternoon" }
    }
    $nextSlotTime = if ($resolvedSlot -eq "morning") {
      if ($slotStarted) { $todayAfternoon } else { $todayMorning }
    } else {
      if ($slotStarted) { $todayMorning.AddDays(1) } else { $todayAfternoon }
    }

    return [pscustomobject]@{
      slot = $resolvedSlot
      slot_time = [DateTimeOffset]$slotTime
      next_slot = $nextSlot
      next_slot_time = [DateTimeOffset]$nextSlotTime
      waiting_for_next_slot = ($nextSlotTime -gt $now)
      before_first_refresh_of_day = $false
      now = [DateTimeOffset]$now
    }
  }

  if ($now -lt $todayMorning) {
    $resolvedSlot = "afternoon"
    $slotTime = $todayAfternoon.AddDays(-1)
    $nextSlot = "morning"
    $nextSlotTime = $todayMorning
    $beforeFirstRefreshOfDay = $true
  } elseif ($now -lt $todayAfternoon) {
    $resolvedSlot = "morning"
    $slotTime = $todayMorning
    $nextSlot = "afternoon"
    $nextSlotTime = $todayAfternoon
    $beforeFirstRefreshOfDay = $false
  } else {
    $resolvedSlot = "afternoon"
    $slotTime = $todayAfternoon
    $nextSlot = "morning"
    $nextSlotTime = $todayMorning.AddDays(1)
    $beforeFirstRefreshOfDay = $false
  }

  return [pscustomobject]@{
    slot = $resolvedSlot
    slot_time = [DateTimeOffset]$slotTime
    next_slot = $nextSlot
    next_slot_time = [DateTimeOffset]$nextSlotTime
    waiting_for_next_slot = ($nextSlotTime -gt $now)
    before_first_refresh_of_day = $beforeFirstRefreshOfDay
    now = [DateTimeOffset]$now
  }
}

function Get-EarlyMorningTradeDateTarget {
  param(
    [string]$Slot,
    $SlotTime,
    $Schedule
  )

  if ($Slot -eq "morning" -and $SlotTime) {
    return $SlotTime.ToLocalTime().ToString("yyyy-MM-dd")
  }

  if ($Schedule -and [bool]$Schedule.before_first_refresh_of_day) {
    try {
      $nextSlotTime = [DateTimeOffset]::Parse([string]$Schedule.next_slot_time).ToLocalTime()
      if ([string]$Schedule.next_slot -eq "morning") {
        return $nextSlotTime.ToString("yyyy-MM-dd")
      }
    } catch {
      return $null
    }
  }

  return $null
}

function Test-EarlyMorningTradeDateFresh {
  param(
    $GeneratedAt,
    [string]$LatestTradeDate,
    [string]$Slot,
    $SlotTime,
    $Schedule
  )

  if (-not $GeneratedAt) {
    return $false
  }

  $expectedTradeDate = Get-EarlyMorningTradeDateTarget -Slot $Slot -SlotTime $SlotTime -Schedule $Schedule
  if ([string]::IsNullOrWhiteSpace($expectedTradeDate) -or [string]::IsNullOrWhiteSpace($LatestTradeDate)) {
    return $false
  }

  return (
    $LatestTradeDate -eq $expectedTradeDate -and
    $GeneratedAt.ToLocalTime().ToString("yyyy-MM-dd") -eq $expectedTradeDate
  )
}

function Test-FreshForSlot {
  param(
    $GeneratedAt,
    $SlotTime,
    [string]$LatestTradeDate = "",
    [string]$Slot = "",
    $Schedule = $null
  )

  if (-not $GeneratedAt) {
    return $false
  }

  if ($GeneratedAt.ToLocalTime().DateTime -ge $SlotTime.ToLocalTime().DateTime) {
    return $true
  }

  $nowForSlot = $null
  if ($Schedule -and $Schedule.PSObject.Properties.Name -contains "now") {
    try {
      $nowForSlot = [DateTimeOffset]::Parse([string]$Schedule.now)
    } catch {
      $nowForSlot = $null
    }
  }
  if ($nowForSlot -and $nowForSlot.ToLocalTime().DateTime -ge $SlotTime.ToLocalTime().DateTime) {
    return $false
  }

  return Test-EarlyMorningTradeDateFresh `
    -GeneratedAt $GeneratedAt `
    -LatestTradeDate $LatestTradeDate `
    -Slot $Slot `
    -SlotTime $SlotTime `
    -Schedule $Schedule
}

function Test-PublicBehindLocal {
  param(
    $LocalGeneratedAt,
    $PublicGeneratedAt,
    [int]$ToleranceMinutes
  )

  if (-not $LocalGeneratedAt) {
    return $false
  }

  if (-not $PublicGeneratedAt) {
    return $true
  }

  return $PublicGeneratedAt.UtcDateTime -lt $LocalGeneratedAt.UtcDateTime.AddMinutes(-$ToleranceMinutes)
}

function Test-LocalBehindPublic {
  param(
    $LocalGeneratedAt,
    $PublicGeneratedAt,
    [int]$ToleranceMinutes
  )

  if (-not $PublicGeneratedAt) {
    return $false
  }

  if (-not $LocalGeneratedAt) {
    return $true
  }

  return $LocalGeneratedAt.UtcDateTime -lt $PublicGeneratedAt.UtcDateTime.AddMinutes(-$ToleranceMinutes)
}

function Get-PublicLagMinutes {
  param(
    $LocalGeneratedAt,
    $PublicGeneratedAt
  )

  if (-not $LocalGeneratedAt -or -not $PublicGeneratedAt) {
    return $null
  }

  $lagMinutes = [math]::Round(($LocalGeneratedAt.UtcDateTime - $PublicGeneratedAt.UtcDateTime).TotalMinutes, 1)
  return [math]::Max($lagMinutes, 0)
}

function Get-LocalLagMinutes {
  param(
    $LocalGeneratedAt,
    $PublicGeneratedAt
  )

  if (-not $LocalGeneratedAt -or -not $PublicGeneratedAt) {
    return $null
  }

  $lagMinutes = [math]::Round(($PublicGeneratedAt.UtcDateTime - $LocalGeneratedAt.UtcDateTime).TotalMinutes, 1)
  return [math]::Max($lagMinutes, 0)
}

function Get-ScheduleNote {
  param(
    $SlotContext,
    $LocalGeneratedAt,
    [string]$LocalLatestTradeDate
  )

  if (-not $SlotContext.before_first_refresh_of_day) {
    return $null
  }

  $nowText = $SlotContext.now.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss K")
  $nextText = $SlotContext.next_slot_time.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss K")
  $localText = if ($LocalGeneratedAt) {
    $LocalGeneratedAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss K")
  } else {
    "暂无本地刷新时间"
  }

  $targetTradeDate = $SlotContext.next_slot_time.ToLocalTime().ToString("yyyy-MM-dd")
  if (
    Test-EarlyMorningTradeDateFresh `
      -GeneratedAt $LocalGeneratedAt `
      -LatestTradeDate $LocalLatestTradeDate `
      -Slot $SlotContext.slot `
      -SlotTime $SlotContext.slot_time `
      -Schedule @{
        before_first_refresh_of_day = $true
        next_slot = $SlotContext.next_slot
        next_slot_time = $SlotContext.next_slot_time.ToString("o")
      }
  ) {
    return "当前时间 $nowText 虽然还没到今天首轮刷新窗口，但今天的首轮数据已在 $localText 提前落地，最新交易日已更新为 $LocalLatestTradeDate；下一次计划刷新时间为 $nextText。"
  }

  return "当前时间 $nowText 仍在今天首轮刷新前的正常等待窗口；上一监测时段最新结果时间为 $localText，下一次计划刷新时间为 $nextText。"
}

function Get-TradeDateCoverageNote {
  param($State)

  if (-not $State) {
    return $null
  }

  $totalCount = [int]$State.latest_item_count
  $latestTradeDate = [string]$State.latest_trade_date
  $latestTradeDateCount = [int]$State.latest_trade_date_count
  $dominantTradeDate = [string]$State.dominant_trade_date
  $dominantTradeDateCount = [int]$State.dominant_trade_date_count
  $olderCount = [math]::Max($totalCount - $latestTradeDateCount, 0)

  if (
    $totalCount -le 0 -or
    [string]::IsNullOrWhiteSpace($latestTradeDate) -or
    -not [bool]$State.mixed_trade_dates -or
    $olderCount -le 0
  ) {
    return $null
  }

  if (-not [string]::IsNullOrWhiteSpace($dominantTradeDate) -and $dominantTradeDate -ne $latestTradeDate) {
    return "当前 $totalCount 个跟踪品类里，只有 $latestTradeDateCount 个已经切到 $latestTradeDate，仍有 $olderCount 个停留在 $dominantTradeDate；这说明今天脚本已经执行，但多数上游价格源尚未全面换日。"
  }

  return "当前 $totalCount 个跟踪品类里，最新交易日 $latestTradeDate 仅覆盖了 $latestTradeDateCount 个，其余 $olderCount 个仍停留在更早交易日；这说明今天脚本已经执行，但不同上游价格源的换日节奏并不一致。"
}

function Get-OpenPreference {
  param(
    $LocalGeneratedAt,
    [string]$LocalLatestTradeDate,
    $PublicState,
    [int]$ToleranceMinutes
  )

  $publicAheadLocal = Test-LocalBehindPublic -LocalGeneratedAt $LocalGeneratedAt -PublicGeneratedAt $PublicState.generated_at -ToleranceMinutes $ToleranceMinutes
  $publicLeadMinutes = Get-LocalLagMinutes -LocalGeneratedAt $LocalGeneratedAt -PublicGeneratedAt $PublicState.generated_at

  if ($PublicState.ok -and $publicAheadLocal) {
    $sameTradeDate = (
      -not [string]::IsNullOrWhiteSpace($LocalLatestTradeDate) -and
      -not [string]::IsNullOrWhiteSpace([string]$PublicState.latest_trade_date) -and
      $LocalLatestTradeDate -eq [string]$PublicState.latest_trade_date
    )
    $reason = if ($publicLeadMinutes -ne $null -and $sameTradeDate) {
      "公网页面生成时间比本地新 $publicLeadMinutes 分钟，但两边最新交易日同为 $LocalLatestTradeDate；页面将优先加载公网实时数据。"
    } elseif ($publicLeadMinutes -ne $null) {
      "公网结果比本地新 $publicLeadMinutes 分钟，页面将优先加载公网实时数据。"
    } else {
      "当前本地没有可用刷新时间，而公网已可访问，页面将优先加载公网实时数据。"
    }

    return [ordered]@{
      preferred_source = "public"
      public_ahead_local = $true
      local_lag_minutes = $publicLeadMinutes
      reason = $reason
    }
  }

  $reason = if (-not $PublicState.ok) {
    "当前公网不可达，页面将优先使用本地副本数据。"
  } else {
    "本地副本已不落后于公网，页面将优先使用本地副本数据。"
  }

  return [ordered]@{
    preferred_source = "local"
    public_ahead_local = $false
    local_lag_minutes = $publicLeadMinutes
    reason = $reason
  }
}

function Format-StatusDateTime {
  param($Value)

  if (-not $Value) {
    return "暂无"
  }

  try {
    return ([DateTimeOffset]::Parse([string]$Value)).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss K")
  } catch {
    return [string]$Value
  }
}

function Get-StatusBriefHeadline {
  param($Status)

  if ($Status.schedule.before_first_refresh_of_day) {
    if (
      Test-EarlyMorningTradeDateFresh `
        -GeneratedAt $Status.local.generated_at `
        -LatestTradeDate ([string]$Status.local.latest_trade_date) `
        -Slot ([string]$Status.slot) `
        -SlotTime ([DateTimeOffset]::Parse([string]$Status.slot_time)) `
        -Schedule $Status.schedule
    ) {
      return "今日首轮已提前刷新"
    }
    return "今天首轮刷新前，当前属于正常等待"
  }

  switch ([string]$Status.verdict) {
    "healthy" { return "当前刷新链路正常" }
    "trade_date_mixed" { return "今天已刷新，但行情日期混合" }
    "local_needs_attention" { return "本地刷新待关注" }
    "public_needs_attention" { return "公网同步待关注" }
    "public_unreachable" { return "公网暂时不可达" }
    "warning" { return "当前有预警，但主链路仍可用" }
    default { return "当前刷新状态待核对" }
  }
}

function Get-StatusBriefCutoff {
  param($Status)

  if ($Status.schedule.before_first_refresh_of_day) {
    if (
      Test-EarlyMorningTradeDateFresh `
        -GeneratedAt $Status.local.generated_at `
        -LatestTradeDate ([string]$Status.local.latest_trade_date) `
        -Slot ([string]$Status.slot) `
        -SlotTime ([DateTimeOffset]::Parse([string]$Status.slot_time)) `
        -Schedule $Status.schedule
    ) {
      return "15:20"
    }
    return "10:20"
  }

  if ([string]$Status.schedule.next_slot -eq "afternoon" -or [string]$Status.slot -eq "morning") {
    return "15:20"
  }

  return "10:20"
}

function Write-RefreshStatusBrief {
  param($Status)

  if (-not $Status) {
    return $null
  }

  if (-not (Test-Path -LiteralPath $BriefsDir)) {
    New-Item -ItemType Directory -Path $BriefsDir -Force | Out-Null
  }

  $checkedAt = Format-StatusDateTime $Status.checked_at
  $briefDate = try {
    ([DateTimeOffset]::Parse([string]$Status.checked_at)).ToLocalTime().ToString("yyyy-MM-dd")
  } catch {
    (Get-Date).ToString("yyyy-MM-dd")
  }
  $briefPath = Join-Path $BriefsDir "${briefDate}.md"
  $existingContent = ""
  if (Test-Path -LiteralPath $briefPath) {
    $existingContent = Get-Content -LiteralPath $briefPath -Raw -Encoding UTF8
    if ($existingContent -notmatch [regex]::Escape($StatusBriefMarker)) {
      return $null
    }
  }

  $tradeDate = if ($Status.local.latest_trade_date) { [string]$Status.local.latest_trade_date } else { "暂无" }
  $localGeneratedAt = Format-StatusDateTime $Status.local.generated_at
  $publicGeneratedAt = if ($Status.public.reachable) {
    Format-StatusDateTime $Status.public.generated_at
  } else {
    "当前不可达"
  }
  $nextSlotAt = Format-StatusDateTime $Status.schedule.next_slot_time
  $headline = Get-StatusBriefHeadline -Status $Status
  $cutoff = Get-StatusBriefCutoff -Status $Status
  $taskSummary = if ($Status.task_issue_count -gt 0) {
    (@($Status.task_issues) -join "；")
  } else {
    "全部计划任务状态正常。"
  }
  $repairSummary = if (@($Status.repair_actions).Count -gt 0) {
    @($Status.repair_actions) -join "；"
  } else {
    "本次未执行额外修复动作。"
  }

  $lines = @(
    $StatusBriefMarker,
    "# 大宗商品价格监测状态说明 $briefDate",
    "",
    "## 当前结论",
    "- 结论: $headline",
    "- 现在时间: $checkedAt",
    "- 最新交易日: $tradeDate",
    "- 本地最近生成时间: $localGeneratedAt",
    "- 公网最近生成时间: $publicGeneratedAt",
    "- 下次计划刷新: $nextSlotAt",
    "",
    "## 为什么现在看起来像没更新",
    "- $(if ($Status.note) { [string]$Status.note } else { '当前没有额外的时段说明。' })",
    "- 最新交易日代表行情覆盖日期，不等于页面或简报文件的生成时间。",
    "- 过了 $cutoff 仍没有变化，再按异常处理；在这之前优先按当前说明判断。",
    "",
    "## 当前页面应以哪份数据为准",
    "- $([string]$Status.open_preference.reason)",
    "",
    "## 计划任务与修复动作",
    "- 计划任务: $taskSummary",
    "- 修复动作: $repairSummary",
    "",
    "## 手动入口",
    "- 双击 `检查今日刷新状态.cmd` 会重跑这套检查，并重新打开今天这份状态说明或真实简报。",
    "- 双击 `打开大宗商品价格看板.cmd` 或 `打开大宗商品价格日报.cmd` 时，也会先做这套健康检查。",
    ""
  )

  $lines | Set-Content -LiteralPath $briefPath -Encoding UTF8
  return $briefPath
}

$slotContext = Get-SlotContext
$repairActions = New-Object System.Collections.Generic.List[string]
$local = Get-LocalState
$public = Get-PublicState
$repairAllowed = $Repair

if (
  $Repair -and
  $SkipRepairBeforeSlot -and
  (
    $slotContext.before_first_refresh_of_day -or
    $slotContext.now.UtcDateTime -lt $slotContext.slot_time.UtcDateTime
  )
) {
  $repairAllowed = $false
  if ($slotContext.before_first_refresh_of_day) {
    Write-Log "Repair skipped because current time is still before today's first refresh window."
  } else {
    Write-Log "Repair skipped because current time is before the $($slotContext.slot) slot boundary."
  }
}

$localFresh = Test-FreshForSlot -GeneratedAt $local.generated_at -SlotTime $slotContext.slot_time -LatestTradeDate ([string]$local.latest_trade_date) -Slot $slotContext.slot -Schedule $slotContext
$publicFresh = Test-FreshForSlot -GeneratedAt $public.generated_at -SlotTime $slotContext.slot_time -LatestTradeDate ([string]$public.latest_trade_date) -Slot $slotContext.slot -Schedule $slotContext
$publicBehindLocal = Test-PublicBehindLocal -LocalGeneratedAt $local.generated_at -PublicGeneratedAt $public.generated_at -ToleranceMinutes $PublishLagToleranceMinutes
$publicAheadLocal = Test-LocalBehindPublic -LocalGeneratedAt $local.generated_at -PublicGeneratedAt $public.generated_at -ToleranceMinutes $PublishLagToleranceMinutes
$publicLagMinutes = Get-PublicLagMinutes -LocalGeneratedAt $local.generated_at -PublicGeneratedAt $public.generated_at
$localLagMinutes = Get-LocalLagMinutes -LocalGeneratedAt $local.generated_at -PublicGeneratedAt $public.generated_at
$localMismatch = ($local.latest_news_count -eq 0 -and $local.cache_news_count -gt 0)
$localNeedsRebuild = ($localMismatch -or $local.refresh_warning_count -gt 0)
$localRepaired = $false

if ($repairAllowed -and (-not $localFresh -or $localNeedsRebuild)) {
  if (-not $localFresh) {
    Write-Log "Repair: running ensure_local_refresh.ps1 for slot $($slotContext.slot)."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $EnsureRefresh -Slot $slotContext.slot -BackfillDays $BackfillDays -SkipPostRefreshHealthCheck
    if ($LASTEXITCODE -ne 0) {
      throw "ensure_local_refresh.ps1 exited with code $LASTEXITCODE"
    }
    $repairActions.Add("Ran local refresh repair.")
  } else {
    Write-Log "Repair: running run_daily.ps1 to rebuild a degraded local payload."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RunDaily -BackfillDays $BackfillDays -SkipPostRefreshHealthCheck
    if ($LASTEXITCODE -ne 0) {
      throw "run_daily.ps1 exited with code $LASTEXITCODE"
    }
    $repairActions.Add("Rebuilt local data because the latest payload was degraded.")
  }
  $localRepaired = $true
  $local = Get-LocalState
  $localFresh = Test-FreshForSlot -GeneratedAt $local.generated_at -SlotTime $slotContext.slot_time -LatestTradeDate ([string]$local.latest_trade_date) -Slot $slotContext.slot -Schedule $slotContext
  $localMismatch = ($local.latest_news_count -eq 0 -and $local.cache_news_count -gt 0)
  $localNeedsRebuild = ($localMismatch -or $local.refresh_warning_count -gt 0)
  $public = Get-PublicState
  $publicFresh = Test-FreshForSlot -GeneratedAt $public.generated_at -SlotTime $slotContext.slot_time -LatestTradeDate ([string]$public.latest_trade_date) -Slot $slotContext.slot -Schedule $slotContext
  $publicBehindLocal = Test-PublicBehindLocal -LocalGeneratedAt $local.generated_at -PublicGeneratedAt $public.generated_at -ToleranceMinutes $PublishLagToleranceMinutes
  $publicAheadLocal = Test-LocalBehindPublic -LocalGeneratedAt $local.generated_at -PublicGeneratedAt $public.generated_at -ToleranceMinutes $PublishLagToleranceMinutes
  $publicLagMinutes = Get-PublicLagMinutes -LocalGeneratedAt $local.generated_at -PublicGeneratedAt $public.generated_at
  $localLagMinutes = Get-LocalLagMinutes -LocalGeneratedAt $local.generated_at -PublicGeneratedAt $public.generated_at
}

if ($repairAllowed -and $localFresh -and ($localRepaired -or -not $public.ok -or -not $publicFresh -or $publicBehindLocal)) {
  Write-Log "Repair: running trigger_github_update.ps1 for slot $($slotContext.slot)."
  $triggerArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $TriggerGithub,
    "-Slot", $slotContext.slot,
    "-SlotTimeIso", $slotContext.slot_time.ToString("o")
  )
  if ($localRepaired) {
    $triggerArgs += "-ForceDispatch"
  }
  & powershell.exe @triggerArgs
  if ($LASTEXITCODE -ne 0) {
    throw "trigger_github_update.ps1 exited with code $LASTEXITCODE"
  }
  $repairActions.Add("Triggered public site refresh.")

  $public = Get-PublicState
  $publicFresh = Test-FreshForSlot -GeneratedAt $public.generated_at -SlotTime $slotContext.slot_time -LatestTradeDate ([string]$public.latest_trade_date) -Slot $slotContext.slot -Schedule $slotContext
  $publicBehindLocal = Test-PublicBehindLocal -LocalGeneratedAt $local.generated_at -PublicGeneratedAt $public.generated_at -ToleranceMinutes $PublishLagToleranceMinutes
  $publicAheadLocal = Test-LocalBehindPublic -LocalGeneratedAt $local.generated_at -PublicGeneratedAt $public.generated_at -ToleranceMinutes $PublishLagToleranceMinutes
  $publicLagMinutes = Get-PublicLagMinutes -LocalGeneratedAt $local.generated_at -PublicGeneratedAt $public.generated_at
  $localLagMinutes = Get-LocalLagMinutes -LocalGeneratedAt $local.generated_at -PublicGeneratedAt $public.generated_at
}

if ($public.ok -and $publicAheadLocal -and $public.content) {
  if (Sync-LocalDashboardData -Content $public.content -TargetPath $LocalDashboardData) {
    Write-Log "Repair: synced dashboard\\data.js from the fresher public payload."
    $repairActions.Add("Synced local dashboard data.js from the fresher public page.")
  }
}

$taskStates = Get-TaskStates
$taskIssues = Get-TaskIssues -TaskStates $taskStates

if ($Repair -and $taskIssues.Count -gt 0 -and (Test-Path -LiteralPath $RegisterTasks)) {
  Write-Log "Repair: re-registering refresh scheduled tasks because issues were detected: $((@($taskIssues) -join ' '))"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RegisterTasks -SkipInitialHealthCheck
  if ($LASTEXITCODE -ne 0) {
    throw "register_local_refresh_task.ps1 exited with code $LASTEXITCODE"
  }
  $repairActions.Add("Re-registered refresh scheduled tasks.")
  $taskStates = Get-TaskStates
  $taskIssues = Get-TaskIssues -TaskStates $taskStates
}

$verdict = "healthy"
if (-not $localFresh -or $localMismatch) {
  $verdict = "local_needs_attention"
} elseif (-not $public.ok) {
  $verdict = "public_unreachable"
} elseif (-not $publicFresh -or $publicBehindLocal) {
  $verdict = "public_needs_attention"
} elseif ($local.mixed_trade_dates -and $local.latest_trade_date_count -lt $local.latest_item_count) {
  $verdict = "trade_date_mixed"
} elseif ($local.refresh_warning_count -gt 0 -or $taskIssues.Count -gt 0) {
  $verdict = "warning"
}

$scheduleNote = Get-ScheduleNote -SlotContext $slotContext -LocalGeneratedAt $local.generated_at -LocalLatestTradeDate ([string]$local.latest_trade_date)
$tradeDateNote = Get-TradeDateCoverageNote -State $local
$combinedNoteParts = @()
if (-not [string]::IsNullOrWhiteSpace([string]$scheduleNote)) {
  $combinedNoteParts += [string]$scheduleNote
}
if (-not [string]::IsNullOrWhiteSpace([string]$tradeDateNote)) {
  $combinedNoteParts += [string]$tradeDateNote
}
$combinedNote = if ($combinedNoteParts.Count -gt 0) { $combinedNoteParts -join " " } else { $null }
$openPreference = Get-OpenPreference -LocalGeneratedAt $local.generated_at -LocalLatestTradeDate $local.latest_trade_date -PublicState $public -ToleranceMinutes $PublishLagToleranceMinutes

$status = [ordered]@{
  checked_at = ([DateTimeOffset](Get-Date)).ToString("o")
  slot = $slotContext.slot
  slot_time = $slotContext.slot_time.ToString("o")
  schedule = [ordered]@{
    current_time = $slotContext.now.ToString("o")
    active_slot = $slotContext.slot
    active_slot_time = $slotContext.slot_time.ToString("o")
    next_slot = $slotContext.next_slot
    next_slot_time = $slotContext.next_slot_time.ToString("o")
    waiting_for_next_slot = $slotContext.waiting_for_next_slot
    before_first_refresh_of_day = $slotContext.before_first_refresh_of_day
  }
  verdict = $verdict
  note = $combinedNote
  schedule_note = $scheduleNote
  trade_date_note = $tradeDateNote
  local = [ordered]@{
    generated_at = if ($local.generated_at) { $local.generated_at.ToString("o") } else { $null }
    latest_trade_date = $local.latest_trade_date
    latest_trade_date_count = $local.latest_trade_date_count
    dominant_trade_date = $local.dominant_trade_date
    dominant_trade_date_count = $local.dominant_trade_date_count
    latest_item_count = $local.latest_item_count
    mixed_trade_dates = $local.mixed_trade_dates
    trade_date_distribution = @($local.trade_date_distribution)
    latest_news_count = $local.latest_news_count
    cache_news_count = $local.cache_news_count
    refresh_warning_count = $local.refresh_warning_count
    refresh_warnings = @($local.refresh_warnings)
    fresh_for_slot = $localFresh
    mismatch = $localMismatch
    behind_public = $publicAheadLocal
    lag_minutes = $localLagMinutes
  }
  public = [ordered]@{
    reachable = $public.ok
    generated_at = if ($public.generated_at) { $public.generated_at.ToString("o") } else { $null }
    latest_trade_date = $public.latest_trade_date
    latest_trade_date_count = $public.latest_trade_date_count
    dominant_trade_date = $public.dominant_trade_date
    dominant_trade_date_count = $public.dominant_trade_date_count
    latest_item_count = $public.latest_item_count
    mixed_trade_dates = $public.mixed_trade_dates
    trade_date_distribution = @($public.trade_date_distribution)
    news_count = $public.news_count
    fresh_for_slot = $publicFresh
    lagging_local = $publicBehindLocal
    lag_minutes = $publicLagMinutes
    error = $public.error
  }
  open_preference = $openPreference
  tasks = $taskStates
  task_issue_count = $taskIssues.Count
  task_issues = @($taskIssues)
  repair_actions = @($repairActions)
}

if (-not (Test-Path -LiteralPath $RuntimeDir)) {
  New-Item -ItemType Directory -Path $RuntimeDir | Out-Null
}
$status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $StatusPath -Encoding UTF8
$statusBriefPath = Write-RefreshStatusBrief -Status $status

$summary = @(
  "刷新健康检查: $verdict",
  "本地更新时间: $($status.local.generated_at); 最新交易日: $($status.local.latest_trade_date)",
  "本地新闻: latest=$($status.local.latest_news_count), cache=$($status.local.cache_news_count), warnings=$($status.local.refresh_warning_count)",
  "公网更新时间: $($status.public.generated_at); 最新交易日: $($status.public.latest_trade_date); 落后本地分钟: $($status.public.lag_minutes)",
  "数据来源: 优先使用$($status.open_preference.preferred_source)；$($status.open_preference.reason)",
  "状态说明: $combinedNote",
  "计划任务: $(if ($taskIssues.Count -gt 0) { @($taskIssues) -join ' ' } else { '全部任务状态正常。' })",
  "修复动作: $((@($repairActions) -join '; '))",
  "状态文件: $StatusPath"
)

$summary[0] = "刷新健康检查: $verdict"
$summary[1] = "本地更新时间: $($status.local.generated_at); 最新交易日: $($status.local.latest_trade_date)"
$summary[2] = "本地新闻: latest=$($status.local.latest_news_count), cache=$($status.local.cache_news_count), warnings=$($status.local.refresh_warning_count)"
$summary[3] = "公网更新时间: $($status.public.generated_at); 最新交易日: $($status.public.latest_trade_date); 落后本地分钟: $($status.public.lag_minutes)"
$summary[4] = "数据来源: 优先使用$($status.open_preference.preferred_source)；$($status.open_preference.reason)"
$summary[5] = "状态说明: $combinedNote"
$summary[6] = "计划任务: $(if ($taskIssues.Count -gt 0) { @($taskIssues) -join ' ' } else { '全部任务状态正常。' })"
$summary[7] = "修复动作: $((@($repairActions) -join '; '))"
$summary[8] = "状态文件: $StatusPath"
if ($statusBriefPath) {
  $summary += "今日状态说明: $statusBriefPath"
}

foreach ($line in $summary) {
  Write-Host $line
  Write-Log $line
}
