param(
  [switch]$Refresh
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runtime = Join-Path $Root "runtime"
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null

if ($Refresh) {
  & (Join-Path $Root "run_daily.ps1") -BackfillDays 180 | Out-Null
}

& (Join-Path $Root "build_standalone_public.ps1") | Out-Null

$file = Join-Path $Root "public\commodity-report-standalone.html"
$upload = & curl.exe -s `
  -F "reqtype=fileupload" `
  -F "time=72h" `
  -F "fileToUpload=@$file" `
  "https://litterbox.catbox.moe/resources/internals/api.php"

if ($LASTEXITCODE -ne 0 -or $upload -notmatch '^https://') {
  Write-Host "公网发布失败: $upload"
  exit 1
}

$url = $upload.Trim()
Set-Content -LiteralPath (Join-Path $Runtime "temporary_public_url.txt") -Value $url -Encoding UTF8
try {
  Set-Clipboard -Value $url
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
    main { max-width: 860px; margin: 40px auto; padding: 28px; }
    .card { background: #fffdf8; border: 1px solid #ded5c8; border-radius: 10px; box-shadow: 0 18px 50px rgba(36,29,18,.08); padding: 28px; }
    h1 { margin: 0 0 12px; font-size: clamp(28px, 6vw, 48px); }
    p { color: #6b6359; line-height: 1.7; }
    .url { margin: 22px 0; padding: 18px; background: #25211c; color: #fff; border-radius: 8px; font-size: clamp(18px, 3vw, 26px); font-weight: 800; word-break: break-all; }
    a { display: inline-flex; min-height: 44px; align-items: center; padding: 10px 16px; background: #087c7a; color: #fff; text-decoration: none; border-radius: 7px; font-weight: 800; }
    .note { margin-top: 18px; padding: 14px; background: #f9f6ef; border: 1px solid #ded5c8; border-radius: 8px; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>公网链接已生成</h1>
      <p>把下面这个网址发给别人即可查看大宗商品价格日报。</p>
      <div class="url">$url</div>
      <p>网址已复制到剪贴板。</p>
      <a href="$url" target="_blank">打开公网日报</a>
      <div class="note">这是临时公网链接，有效期约 72 小时。长期固定网址需要发布到 Cloudflare Pages、Vercel 或公司服务器。</div>
    </section>
  </main>
</body>
</html>
"@

$help = Join-Path $Runtime "temporary_public_url.html"
Set-Content -LiteralPath $help -Value $html -Encoding UTF8
Start-Process $help
Write-Host $url
