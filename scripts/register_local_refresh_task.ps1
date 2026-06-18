param()

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$CurrentUserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function New-RepoTaskAction {
  param(
    [string]$ScriptPath,
    [string]$Arguments
  )

  return New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" $Arguments" `
    -WorkingDirectory $Root
}

function New-RepoTaskSettings {
  return New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -WakeToRun
}

function New-RepoTaskPrincipal {
  return New-ScheduledTaskPrincipal `
    -UserId $CurrentUserId `
    -LogonType Interactive `
    -RunLevel Limited
}

function New-TaskTriggers {
  param(
    [string[]]$Times = @(),
    [switch]$AtLogOn
  )

  $triggers = @()
  foreach ($time in $Times) {
    $triggers += New-ScheduledTaskTrigger -Daily -At ([DateTime]$time)
  }
  if ($AtLogOn) {
    $triggers += New-ScheduledTaskTrigger -AtLogOn -User $CurrentUserId
  }
  return $triggers
}

function New-UnlockTrigger {
  $class = Get-CimClass -Namespace root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskSessionStateChangeTrigger
  return New-CimInstance -ClientOnly -CimClass $class -Property @{
    Enabled = $true
    StartBoundary = ([DateTimeOffset](Get-Date)).ToString("s")
    StateChange = [uint32]8
    UserId = $CurrentUserId
  }
}

function Register-RepoTask {
  param(
    [string]$TaskName,
    [string]$Description,
    [string]$ScriptPath,
    [string]$Arguments,
    [string[]]$Times = @(),
    [switch]$AtLogOn,
    [Microsoft.Management.Infrastructure.CimInstance[]]$ExtraTriggers = @()
  )

  $action = New-RepoTaskAction -ScriptPath $ScriptPath -Arguments $Arguments
  $settings = New-RepoTaskSettings
  $principal = New-RepoTaskPrincipal
  $triggers = @()
  $triggers += New-TaskTriggers -Times $Times -AtLogOn:$AtLogOn
  $triggers += @($ExtraTriggers)

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Description $Description `
    -Action $action `
    -Trigger $triggers `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

  Write-Host "Registered task: $TaskName"
}

Register-RepoTask `
  -TaskName "CommodityMonitor-Local-Refresh" `
  -Description "Local commodity monitor refresh with retry and evening self-heal coverage after 10:00 and 15:00." `
  -ScriptPath (Join-Path $Root "scripts\ensure_local_refresh.ps1") `
  -Arguments "" `
  -Times @("09:58", "10:30", "14:58", "15:30", "16:30", "17:30", "18:30", "19:30")

Register-RepoTask `
  -TaskName "CommodityMonitor-GitHub-Fallback" `
  -Description "Fallback checker for GitHub Pages refresh, extended with evening catch-up retries." `
  -ScriptPath (Join-Path $Root "scripts\trigger_github_update.ps1") `
  -Arguments "" `
  -Times @("10:20", "10:50", "15:20", "15:50", "16:50", "17:50", "18:50", "19:50")

Register-RepoTask `
  -TaskName "CommodityMonitor-Health-Check" `
  -Description "Health check and self-heal for local/public commodity monitor freshness, including evening guard rails." `
  -ScriptPath (Join-Path $Root "scripts\check_refresh_health.ps1") `
  -Arguments "-Repair" `
  -Times @("10:40", "11:05", "15:40", "16:05", "17:05", "18:05", "19:05", "20:05")

Register-RepoTask `
  -TaskName "CommodityMonitor-Login-Health-Check" `
  -Description "Run a commodity monitor health check at user logon after the current monitoring slot has started." `
  -ScriptPath (Join-Path $Root "scripts\check_refresh_health.ps1") `
  -Arguments "-Repair -SkipRepairBeforeSlot" `
  -AtLogOn

Register-RepoTask `
  -TaskName "CommodityMonitor-Unlock-Health-Check" `
  -Description "Run a commodity monitor health check when the workstation is unlocked, so missed refresh windows are repaired after sleep or away time." `
  -ScriptPath (Join-Path $Root "scripts\check_refresh_health.ps1") `
  -Arguments "-Repair -SkipRepairBeforeSlot" `
  -ExtraTriggers @(New-UnlockTrigger)

$HealthScript = Join-Path $Root "scripts\check_refresh_health.ps1"
Write-Host "Running initial health check..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $HealthScript -Repair -SkipRepairBeforeSlot
if ($LASTEXITCODE -ne 0) {
  throw "Initial health check failed with exit code $LASTEXITCODE"
}
