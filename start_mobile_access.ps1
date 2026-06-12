param(
  [int]$Port = 8765,
  [switch]$Refresh
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root ".venv\Scripts\python.exe"
$Daily = Join-Path $Root "run_daily.ps1"

if ($Refresh) {
  & $Daily -BackfillDays 180 | Out-Null
}

if (-not (Test-Path $Python)) {
  & (Join-Path $Root "setup.ps1") | Out-Null
}

function Get-LocalIPv4 {
  $primary = Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
    Select-Object -First 1

  if ($primary -and $primary.IPv4Address.IPAddress) {
    return $primary.IPv4Address.IPAddress
  }

  $fallback = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.IPAddress -ne "127.0.0.1" -and
      $_.IPAddress -notlike "169.254*" -and
      $_.PrefixOrigin -ne "WellKnown"
    } |
    Select-Object -First 1

  if ($fallback) {
    return $fallback.IPAddress
  }

  return "127.0.0.1"
}

$ip = Get-LocalIPv4
$url = "http://$ip`:$Port/dashboard/report.html"
$localPreview = "http://127.0.0.1:$Port/dashboard/report.html"

$alreadyListening = $false
try {
  $alreadyListening = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
} catch {
  $alreadyListening = $false
}

if (-not $alreadyListening) {
  Start-Process -FilePath $Python `
    -ArgumentList @("-m", "http.server", "$Port", "--bind", "0.0.0.0") `
    -WorkingDirectory $Root `
    -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
}

try {
  Set-Clipboard -Value $url
} catch {
}

$templatePath = Join-Path $Root "mobile_access_template.html"
$helpPath = Join-Path $Root "mobile_access.html"
$html = Get-Content -Path $templatePath -Raw -Encoding UTF8
$html = $html.Replace("__MOBILE_URL__", $url).Replace("__LOCAL_PREVIEW__", $localPreview)
Set-Content -Path $helpPath -Value $html -Encoding UTF8
Start-Process $helpPath
