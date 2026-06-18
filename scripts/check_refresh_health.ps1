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
$LocalDashboardData = Join-Path $Root "dashboard\data.js"
$LatestJson = Join-Path $Root "data\latest.json"
$NewsJson = Join-Path $Root "data\news.json"
$EnsureRefresh = Join-Path $Root "scripts\ensure_local_refresh.ps1"
$RunDaily = Join-Path $Root "run_daily.ps1"
$TriggerGithub = Join-Path $Root "scripts\trigger_github_update.ps1"
$PublicDataUrl = "https://chefkang.github.io/commodity-monitor/data.js"
$TaskNames = @(
  "CommodityMonitor-Local-Refresh",
  "CommodityMonitor-GitHub-Fallback",
  "CommodityMonitor-Health-Check",
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

function Get-LocalState {
  $latest = Read-JsonFile -Path $LatestJson
  $news = Read-JsonFile -Path $NewsJson
  $warnings = @()
  if ($latest -and $latest.summary -and $latest.summary.refresh_warnings) {
    foreach ($warning in $latest.summary.refresh_warnings) {
      $warnings += [string]$warning
    }
  }

  return [pscustomobject]@{
    generated_at = Parse-DateValue $latest.generated_at
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
    return [pscustomobject]@{
      ok = $true
      generated_at = Parse-DateValue $payload.generated_at
      news_count = @($payload.news).Count
      content = [string]$response.Content
      error = $null
    }
  } catch {
    return [pscustomobject]@{
      ok = $false
      generated_at = $null
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

function Test-FreshForSlot {
  param($GeneratedAt, $SlotTime)

  if (-not $GeneratedAt) {
    return $false
  }
  return $GeneratedAt.ToLocalTime().DateTime -ge $SlotTime.ToLocalTime().DateTime
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
    $LocalGeneratedAt
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

  return "当前时间 $nowText 仍在今天首轮刷新前的正常等待窗口；上一监测时段最新结果时间为 $localText，下一次计划刷新时间为 $nextText。"
}

function Get-OpenPreference {
  param(
    $LocalGeneratedAt,
    $PublicState,
    [int]$ToleranceMinutes
  )

  $publicAheadLocal = Test-LocalBehindPublic -LocalGeneratedAt $LocalGeneratedAt -PublicGeneratedAt $PublicState.generated_at -ToleranceMinutes $ToleranceMinutes
  $publicLeadMinutes = Get-LocalLagMinutes -LocalGeneratedAt $LocalGeneratedAt -PublicGeneratedAt $PublicState.generated_at

  if ($PublicState.ok -and $publicAheadLocal) {
    $reason = if ($publicLeadMinutes -ne $null) {
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

$localFresh = Test-FreshForSlot -GeneratedAt $local.generated_at -SlotTime $slotContext.slot_time
$publicFresh = Test-FreshForSlot -GeneratedAt $public.generated_at -SlotTime $slotContext.slot_time
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
  $localFresh = Test-FreshForSlot -GeneratedAt $local.generated_at -SlotTime $slotContext.slot_time
  $localMismatch = ($local.latest_news_count -eq 0 -and $local.cache_news_count -gt 0)
  $localNeedsRebuild = ($localMismatch -or $local.refresh_warning_count -gt 0)
  $public = Get-PublicState
  $publicFresh = Test-FreshForSlot -GeneratedAt $public.generated_at -SlotTime $slotContext.slot_time
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
  $publicFresh = Test-FreshForSlot -GeneratedAt $public.generated_at -SlotTime $slotContext.slot_time
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

$taskStates = [ordered]@{}
foreach ($taskName in $TaskNames) {
  $taskStates[$taskName] = Get-TaskState -TaskName $taskName
}

$verdict = "healthy"
if (-not $localFresh -or $localMismatch) {
  $verdict = "local_needs_attention"
} elseif (-not $public.ok) {
  $verdict = "public_unreachable"
} elseif (-not $publicFresh -or $publicBehindLocal) {
  $verdict = "public_needs_attention"
} elseif ($local.refresh_warning_count -gt 0) {
  $verdict = "warning"
}

$scheduleNote = Get-ScheduleNote -SlotContext $slotContext -LocalGeneratedAt $local.generated_at
$openPreference = Get-OpenPreference -LocalGeneratedAt $local.generated_at -PublicState $public -ToleranceMinutes $PublishLagToleranceMinutes

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
  note = $scheduleNote
  local = [ordered]@{
    generated_at = if ($local.generated_at) { $local.generated_at.ToString("o") } else { $null }
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
    news_count = $public.news_count
    fresh_for_slot = $publicFresh
    lagging_local = $publicBehindLocal
    lag_minutes = $publicLagMinutes
    error = $public.error
  }
  open_preference = $openPreference
  tasks = $taskStates
  repair_actions = @($repairActions)
}

if (-not (Test-Path -LiteralPath $RuntimeDir)) {
  New-Item -ItemType Directory -Path $RuntimeDir | Out-Null
}
$status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $StatusPath -Encoding UTF8

$summary = @(
  "刷新健康检查: $verdict",
  "本地更新时间: $($status.local.generated_at)",
  "本地新闻: latest=$($status.local.latest_news_count), cache=$($status.local.cache_news_count), warnings=$($status.local.refresh_warning_count)",
  "公网更新时间: $($status.public.generated_at); 落后本地分钟: $($status.public.lag_minutes)",
  "数据来源: 优先使用$($status.open_preference.preferred_source)；$($status.open_preference.reason)",
  "时段说明: $scheduleNote",
  "修复动作: $((@($repairActions) -join '; '))",
  "状态文件: $StatusPath"
)

$summary[0] = "刷新健康检查: $verdict"
$summary[1] = "本地更新时间: $($status.local.generated_at)"
$summary[2] = "本地新闻: latest=$($status.local.latest_news_count), cache=$($status.local.cache_news_count), warnings=$($status.local.refresh_warning_count)"
$summary[3] = "公网更新时间: $($status.public.generated_at); 落后本地分钟: $($status.public.lag_minutes)"
$summary[4] = "数据来源: 优先使用$($status.open_preference.preferred_source)；$($status.open_preference.reason)"
$summary[5] = "时段说明: $scheduleNote"
$summary[6] = "修复动作: $((@($repairActions) -join '; '))"
$summary[7] = "状态文件: $StatusPath"

foreach ($line in $summary) {
  Write-Host $line
  Write-Log $line
}
