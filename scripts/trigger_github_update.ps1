param(
  [ValidateSet("auto", "morning", "afternoon")]
  [string]$Slot = "auto",
  [int]$StaleRunMinutes = 45
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Gh = Join-Path $RepoRoot "tools\gh\bin\gh.exe"
$WorkflowName = "Daily Commodity Monitor"
$WorkflowFile = "daily-pages.yml"
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

if (-not (Test-Path -LiteralPath $Gh)) {
  Write-Log "ERROR: GitHub CLI not found at $Gh"
  throw "GitHub CLI not found: $Gh"
}

$now = Get-Date
if ($Slot -eq "auto") {
  $Slot = if ($now.Hour -lt 12) { "morning" } else { "afternoon" }
}

$slotTime = if ($Slot -eq "morning") {
  Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 10 -Minute 0 -Second 0
} else {
  Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 15 -Minute 0 -Second 0
}

$slotUtc = $slotTime.ToUniversalTime()
Set-Location -LiteralPath $RepoRoot

$runsJson = & $Gh run list --workflow $WorkflowName --limit 20 --json databaseId,status,conclusion,createdAt,updatedAt,event,url
if ($LASTEXITCODE -ne 0) {
  Write-Log "ERROR: failed to query workflow runs."
  throw "Failed to query workflow runs."
}

$runs = @()
foreach ($run in ($runsJson | ConvertFrom-Json)) {
  $runs += $run
}
$slotRuns = @(
  $runs | Where-Object {
    ([DateTimeOffset]::Parse([string]$_.createdAt)).UtcDateTime -ge $slotUtc -and
    ($_.event -eq "schedule" -or $_.event -eq "workflow_dispatch")
  }
)

$success = $slotRuns | Where-Object { $_.status -eq "completed" -and $_.conclusion -eq "success" } | Select-Object -First 1
if ($success) {
  Write-Log "$Slot slot already has a successful run: $($success.databaseId) $($success.url)"
  exit 0
}

$active = $slotRuns | Where-Object { $_.status -ne "completed" } | Select-Object -First 1
if ($active) {
  $createdAt = [DateTimeOffset]::Parse([string]$active.createdAt)
  $ageMinutes = [math]::Round(($now.ToUniversalTime() - $createdAt.UtcDateTime).TotalMinutes, 1)
  if ($ageMinutes -lt $StaleRunMinutes) {
    Write-Log "$Slot slot already has an active run: $($active.databaseId) $($active.url) age=${ageMinutes}m"
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
