param(
  [ValidateSet("auto", "morning", "afternoon")]
  [string]$Slot = "auto",
  [string]$SlotTimeIso = "",
  [int]$StaleRunMinutes = 45,
  [int]$PublishLagToleranceMinutes = 3,
  [switch]$ForceDispatch,
  [int]$WaitForPublicSyncMinutes = 8,
  [int]$PollIntervalSeconds = 20
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Gh = Join-Path $RepoRoot "tools\gh\bin\gh.exe"
$WorkflowName = "Daily Commodity Monitor"
$WorkflowFile = "daily-pages.yml"
$LatestJson = Join-Path $RepoRoot "data\latest.json"
$PublicDataUrl = "https://chefkang.github.io/commodity-monitor/data.js"
$LogDir = Join-Path $RepoRoot "runtime"
$LogFile = Join-Path $LogDir "github-trigger.log"

function Write-Log {
  param([string]$Message)
  if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
  }
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value "[$stamp] $Message"
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

function Resolve-SlotReferenceTime {
  param(
    [datetime]$Now,
    [string]$ResolvedSlot,
    [string]$ExplicitSlotTimeIso
  )

  if ($ExplicitSlotTimeIso) {
    $parsed = Parse-DateValue $ExplicitSlotTimeIso
    if (-not $parsed) {
      throw "Failed to parse SlotTimeIso: $ExplicitSlotTimeIso"
    }
    return $parsed.ToLocalTime().DateTime
  }

  $candidate = if ($ResolvedSlot -eq "morning") {
    Get-Date -Year $Now.Year -Month $Now.Month -Day $Now.Day -Hour 10 -Minute 0 -Second 0
  } else {
    Get-Date -Year $Now.Year -Month $Now.Month -Day $Now.Day -Hour 15 -Minute 0 -Second 0
  }

  if ($Now -lt $candidate) {
    return $candidate.AddDays(-1)
  }

  return $candidate
}

function Get-LocalGeneratedAt {
  if (-not (Test-Path -LiteralPath $LatestJson)) {
    return $null
  }

  try {
    $payload = Get-Content -LiteralPath $LatestJson -Raw -Encoding UTF8 | ConvertFrom-Json
    return Parse-DateValue $payload.generated_at
  } catch {
    Write-Log "WARN: failed to parse local latest.json generated_at: $($_.Exception.Message)"
    return $null
  }
}

function Get-PublicGeneratedAt {
  try {
    $stamp = Get-Date -Format "yyyyMMddHHmmss"
    $response = Invoke-WebRequest -Uri "${PublicDataUrl}?ts=$stamp" -UseBasicParsing -TimeoutSec 30
    $match = [regex]::Match($response.Content, "(?s)window\.COMMODITY_MONITOR_DATA\s*=\s*(\{.*\})\s*;")
    if (-not $match.Success) {
      return $null
    }
    $payload = $match.Groups[1].Value | ConvertFrom-Json
    return Parse-DateValue $payload.generated_at
  } catch {
    Write-Log "WARN: failed to read public generated_at: $($_.Exception.Message)"
    return $null
  }
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

function Get-SlotRuns {
  param([datetime]$SlotUtc)

  $runsJson = & $Gh run list --workflow $WorkflowName --limit 20 --json databaseId,status,conclusion,createdAt,updatedAt,event,url
  if ($LASTEXITCODE -ne 0) {
    Write-Log "ERROR: failed to query workflow runs."
    throw "Failed to query workflow runs."
  }

  $runs = @()
  foreach ($run in ($runsJson | ConvertFrom-Json)) {
    $runs += $run
  }

  return @(
    $runs | Where-Object {
      ([DateTimeOffset]::Parse([string]$_.createdAt)).UtcDateTime -ge $SlotUtc -and
      ($_.event -eq "schedule" -or $_.event -eq "workflow_dispatch")
    }
  )
}

function Get-RunDetails {
  param([long]$RunId)

  $runJson = & $Gh run view $RunId --json databaseId,status,conclusion,createdAt,updatedAt,event,url,jobs
  if ($LASTEXITCODE -ne 0) {
    Write-Log "WARN: failed to inspect workflow run $RunId."
    return $null
  }

  try {
    return $runJson | ConvertFrom-Json
  } catch {
    Write-Log "WARN: failed to parse workflow run details for ${RunId}: $($_.Exception.Message)"
    return $null
  }
}

function Get-RunPublishState {
  param($Run)

  $jobs = @($Run.jobs)
  $build = $jobs | Where-Object { $_.name -eq "build" } | Select-Object -First 1
  $deploy = $jobs | Where-Object { $_.name -eq "deploy" } | Select-Object -First 1

  $buildSuccess = [bool]($build -and $build.status -eq "completed" -and $build.conclusion -eq "success")
  $deploySuccess = [bool]($deploy -and $deploy.status -eq "completed" -and $deploy.conclusion -eq "success")

  return [pscustomobject]@{
    build_status = if ($build) { "$($build.status)/$($build.conclusion)" } else { "missing" }
    deploy_status = if ($deploy) { "$($deploy.status)/$($deploy.conclusion)" } else { "missing" }
    published_success = ($buildSuccess -and $deploySuccess)
  }
}

function Wait-ForPublicCatchUp {
  param(
    $LocalGeneratedAt,
    [int]$TimeoutMinutes,
    [int]$PollSeconds
  )

  if (-not $LocalGeneratedAt -or $TimeoutMinutes -le 0) {
    return $false
  }

  Write-Log "Waiting up to ${TimeoutMinutes}m for public generated_at to catch up with local generated_at $LocalGeneratedAt."
  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)

  do {
    Start-Sleep -Seconds $PollSeconds
    $publicGeneratedAt = Get-PublicGeneratedAt
    if (-not (Test-PublicBehindLocal -LocalGeneratedAt $LocalGeneratedAt -PublicGeneratedAt $publicGeneratedAt -ToleranceMinutes $PublishLagToleranceMinutes)) {
      Write-Log "Public generated_at caught up: $publicGeneratedAt"
      return $true
    }
  } while ((Get-Date) -lt $deadline)

  $latestPublicGeneratedAt = Get-PublicGeneratedAt
  Write-Log "WARN: public generated_at is still behind local after waiting ${TimeoutMinutes}m. public=$latestPublicGeneratedAt local=$LocalGeneratedAt"
  return $false
}

if (-not (Test-Path -LiteralPath $Gh)) {
  Write-Log "ERROR: GitHub CLI not found at $Gh"
  throw "GitHub CLI not found: $Gh"
}

$now = Get-Date
if ($Slot -eq "auto") {
  $Slot = if ($now.Hour -lt 12) { "morning" } else { "afternoon" }
}

$slotTime = Resolve-SlotReferenceTime -Now $now -ResolvedSlot $Slot -ExplicitSlotTimeIso $SlotTimeIso

$slotUtc = $slotTime.ToUniversalTime()
Set-Location -LiteralPath $RepoRoot

$localGeneratedAt = Get-LocalGeneratedAt
$publicGeneratedAt = Get-PublicGeneratedAt
$publicBehindLocal = Test-PublicBehindLocal -LocalGeneratedAt $localGeneratedAt -PublicGeneratedAt $publicGeneratedAt -ToleranceMinutes $PublishLagToleranceMinutes

$slotRuns = Get-SlotRuns -SlotUtc $slotUtc
Write-Log "$Slot slot check: force_dispatch=$ForceDispatch local_generated_at=$localGeneratedAt public_generated_at=$publicGeneratedAt public_behind_local=$publicBehindLocal slot_runs=$(@($slotRuns).Count)"

$success = $null
$nonPublishingSuccess = $null
$completedSuccessRuns = @(
  $slotRuns |
    Where-Object { $_.status -eq "completed" -and $_.conclusion -eq "success" } |
    Sort-Object { [DateTimeOffset]::Parse([string]$_.createdAt) } -Descending
)

foreach ($candidate in $completedSuccessRuns) {
  $details = Get-RunDetails -RunId ([long]$candidate.databaseId)
  if (-not $details) {
    continue
  }

  $publishState = Get-RunPublishState -Run $details
  if ($publishState.published_success) {
    $success = [pscustomobject]@{
      run = $details
      publish_state = $publishState
    }
    break
  }

  if (-not $nonPublishingSuccess) {
    $nonPublishingSuccess = [pscustomobject]@{
      run = $details
      publish_state = $publishState
    }
  }
}

if ($nonPublishingSuccess) {
  Write-Log "$Slot slot found a completed success record $($nonPublishingSuccess.run.databaseId), but publish jobs were not successful (build=$($nonPublishingSuccess.publish_state.build_status), deploy=$($nonPublishingSuccess.publish_state.deploy_status)). Ignoring it."
}

if ($success) {
  if (-not $publicBehindLocal -and -not $ForceDispatch) {
    Write-Log "$Slot slot already has a successful publish run: $($success.run.databaseId) $($success.run.url)"
    exit 0
  }

  if ($ForceDispatch) {
    Write-Log "$Slot slot already has a successful run, but a local repair just completed. Forcing a publish retry."
  } else {
    Write-Log "$Slot slot already has a successful run, but public generated_at ($publicGeneratedAt) is still behind local generated_at ($localGeneratedAt). Retrying publish."
  }
}

$active = $slotRuns | Where-Object { $_.status -ne "completed" } | Select-Object -First 1
if ($active) {
  $createdAt = [DateTimeOffset]::Parse([string]$active.createdAt)
  $ageMinutes = [math]::Round(($now.ToUniversalTime() - $createdAt.UtcDateTime).TotalMinutes, 1)
  if ($ageMinutes -lt $StaleRunMinutes) {
    Write-Log "$Slot slot already has an active run: $($active.databaseId) $($active.url) age=${ageMinutes}m"
    if ($publicBehindLocal -and (Wait-ForPublicCatchUp -LocalGeneratedAt $localGeneratedAt -TimeoutMinutes $WaitForPublicSyncMinutes -PollSeconds $PollIntervalSeconds)) {
      exit 0
    }
    exit 0
  }

  Write-Log "$Slot slot has a stale active run older than ${StaleRunMinutes}m: $($active.databaseId) $($active.url). Requesting cancellation."
  & $Gh run cancel $($active.databaseId)
  if ($LASTEXITCODE -ne 0) {
    Write-Log "ERROR: failed to cancel stale run $($active.databaseId)."
    throw "Failed to cancel stale run $($active.databaseId)."
  }

  $cancelled = $false
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    Start-Sleep -Seconds 10
    $stateJson = & $Gh run view $($active.databaseId) --json status,conclusion
    if ($LASTEXITCODE -ne 0) {
      Write-Log "WARN: failed to re-check stale run $($active.databaseId) after cancel request."
      continue
    }
    $state = $stateJson | ConvertFrom-Json
    if ($state.status -eq "completed") {
      $cancelled = $true
      break
    }
  }

  if (-not $cancelled) {
    Write-Log "WARN: stale run $($active.databaseId) is still active after cancel request; skip retrigger for now."
    exit 0
  }

  Write-Log "Stale run $($active.databaseId) finished after cancellation; continuing with retrigger."
}

Write-Log "$Slot slot has no successful or active run since $($slotTime.ToString('yyyy-MM-dd HH:mm:ss')); triggering $WorkflowFile."
& $Gh workflow run $WorkflowFile --ref main
if ($LASTEXITCODE -ne 0) {
  Write-Log "ERROR: failed to trigger $WorkflowFile."
  throw "Failed to trigger $WorkflowFile."
}
Write-Log "$Slot slot trigger submitted."

if ($publicBehindLocal) {
  Wait-ForPublicCatchUp -LocalGeneratedAt $localGeneratedAt -TimeoutMinutes $WaitForPublicSyncMinutes -PollSeconds $PollIntervalSeconds | Out-Null
}
