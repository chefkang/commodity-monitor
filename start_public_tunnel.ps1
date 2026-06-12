param(
  [switch]$Refresh
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Public = Join-Path $Root "public"
$Runtime = Join-Path $Root "runtime"
$Tools = Join-Path $Root "tools"
$Python = Join-Path $Root ".venv\Scripts\python.exe"
$Port = 8877
$LocalUrl = "http://127.0.0.1:$Port"

New-Item -ItemType Directory -Force -Path $Runtime, $Tools | Out-Null

& (Join-Path $Root "build_public_site.ps1") -Refresh:$Refresh | Out-Null

if (-not (Test-Path $Python)) {
  & (Join-Path $Root "setup.ps1") | Out-Null
}

$serverListening = $false
try {
  $serverListening = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
} catch {
  $serverListening = $false
}

if (-not $serverListening) {
  Start-Process -FilePath $Python `
    -ArgumentList @("-m", "http.server", "$Port", "--bind", "127.0.0.1") `
    -WorkingDirectory $Public `
    -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
}

$cloudflared = Join-Path $Tools "cloudflared.exe"
if (-not (Test-Path $cloudflared)) {
  $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  Invoke-WebRequest -Uri $downloadUrl -OutFile $cloudflared
}

$log = Join-Path $Runtime "cloudflared.log"
$err = Join-Path $Runtime "cloudflared.err.log"
Remove-Item -LiteralPath $log, $err -Force -ErrorAction SilentlyContinue

$existingTunnel = Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*cloudflared* tunnel *$LocalUrl*" } |
  Select-Object -First 1

if (-not $existingTunnel) {
  Start-Process -FilePath $cloudflared `
    -ArgumentList @("tunnel", "--url", $LocalUrl, "--no-autoupdate") `
    -RedirectStandardOutput $log `
    -RedirectStandardError $err `
    -WindowStyle Hidden | Out-Null
}

$publicUrl = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 1
  $content = ""
  if (Test-Path $log) {
    $content += Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
  }
  if (Test-Path $err) {
    $content += "`n" + (Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue)
  }
  $match = [regex]::Match($content, "https://[a-zA-Z0-9-]+\.trycloudflare\.com")
  if ($match.Success) {
    $publicUrl = $match.Value
    break
  }
}

if (-not $publicUrl) {
  Write-Host "公网链接暂时没有生成成功，请稍后重试或查看 runtime\cloudflared.err.log"
  exit 1
}

$reportUrl = "$publicUrl/index.html"
$trendUrl = "$publicUrl/trend.html"
Set-Content -LiteralPath (Join-Path $Runtime "public_url.txt") -Value $reportUrl -Encoding UTF8
try {
  Set-Clipboard -Value $reportUrl
} catch {
}

$html = @"
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>大宗商品价格日报公网链接</title>
  <style>
    body { margin: 0; font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", Arial, sans-serif; background: #f5f1e9; color: #171513; }
    main { max-width: 900px; margin: 42px auto; padding: 28px; }
    .card { background: #fffdf8; border: 1px solid #ded5c8; border-radius: 10px; box-shadow: 0 18px 50px rgba(36,29,18,.08); padding: 30px; }
    h1 { margin: 0 0 12px; font-size: clamp(30px, 6vw, 50px); }
    p { color: #6b6359; line-height: 1.7; }
    .url { margin: 22px 0; padding: 18px; background: #25211c; color: #fff; border-radius: 8px; font-size: clamp(18px, 3vw, 25px); font-weight: 800; word-break: break-all; }
    .buttons { display: flex; flex-wrap: wrap; gap: 10px; }
    a { display: inline-flex; min-height: 44px; align-items: center; padding: 10px 16px; background: #087c7a; color: #fff; text-decoration: none; border-radius: 7px; font-weight: 800; }
    a.secondary { background: #25211c; }
    .note { margin-top: 18px; padding: 14px; background: #f9f6ef; border: 1px solid #ded5c8; border-radius: 8px; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>公网链接已生成</h1>
      <p>把下面这个网址发给同事或客户，他们就能直接查看大宗商品价格日报。</p>
      <div class="url">$reportUrl</div>
      <p>网址已复制到剪贴板。</p>
      <div class="buttons">
        <a href="$reportUrl" target="_blank">打开公网日报</a>
        <a class="secondary" href="$trendUrl" target="_blank">打开公网趋势看板</a>
      </div>
      <div class="note">
        这个临时公网链接依赖当前电脑和后台服务运行。要长期固定网址，建议发布 `public` 文件夹到 Cloudflare Pages、Vercel 或公司服务器。
      </div>
    </section>
  </main>
</body>
</html>
"@

$help = Join-Path $Runtime "public_url.html"
Set-Content -LiteralPath $help -Value $html -Encoding UTF8
Start-Process $help
Write-Host $reportUrl
