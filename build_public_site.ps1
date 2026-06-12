param(
  [switch]$Refresh
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Public = Join-Path $Root "public"

if ($Refresh) {
  & (Join-Path $Root "run_daily.ps1") -BackfillDays 180 | Out-Null
}

if (Test-Path $Public) {
  Remove-Item -LiteralPath $Public -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $Public | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Public "briefs") | Out-Null

$dashboard = Join-Path $Root "dashboard"

Copy-Item -LiteralPath (Join-Path $dashboard "report.css") -Destination (Join-Path $Public "report.css")
Copy-Item -LiteralPath (Join-Path $dashboard "report.js") -Destination (Join-Path $Public "report.js")
Copy-Item -LiteralPath (Join-Path $dashboard "styles.css") -Destination (Join-Path $Public "styles.css")
Copy-Item -LiteralPath (Join-Path $dashboard "app.js") -Destination (Join-Path $Public "app.js")
Copy-Item -LiteralPath (Join-Path $dashboard "data.js") -Destination (Join-Path $Public "data.js")

$reportHtml = Get-Content -LiteralPath (Join-Path $dashboard "report.html") -Raw -Encoding UTF8
$reportHtml = $reportHtml.Replace('<link rel="stylesheet" href="./report.css" />', '<link rel="stylesheet" href="./report.css" />')
$reportHtml = $reportHtml.Replace('<script src="./data.js"></script>', '<script src="./data.js"></script>')
$reportHtml = $reportHtml.Replace('<script src="./report.js"></script>', '<script src="./report.js"></script>')
$reportHtml = $reportHtml.Replace('href="./index.html"', 'href="./trend.html"')
Set-Content -LiteralPath (Join-Path $Public "index.html") -Value $reportHtml -Encoding UTF8

$trendHtml = Get-Content -LiteralPath (Join-Path $dashboard "index.html") -Raw -Encoding UTF8
$trendHtml = $trendHtml.Replace('href="../briefs/"', 'href="./briefs/"')
$trendHtml = $trendHtml.Replace('`../briefs/${today}.md`', '`./briefs/${today}.md`')
Set-Content -LiteralPath (Join-Path $Public "trend.html") -Value $trendHtml -Encoding UTF8

Copy-Item -Path (Join-Path $Root "briefs\*.md") -Destination (Join-Path $Public "briefs") -ErrorAction SilentlyContinue

@"
# 大宗商品价格日报在线版

这个目录可以直接发布到 GitHub Pages、Cloudflare Pages、Vercel、Netlify 或任意静态网站服务器。

入口文件：
- `index.html`: 汇报式日报
- `trend.html`: 完整趋势看板

数据文件：
- `data.js`: 最新价格、趋势、新闻和风险判断
- `briefs/`: 每日简报

生成时间：$(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
"@ | Set-Content -LiteralPath (Join-Path $Public "README.md") -Encoding UTF8

@"
/*
  Cache lightly so daily price updates appear quickly.
*/
/*.html
  Cache-Control: public, max-age=300
/data.js
  Cache-Control: public, max-age=300
/*.css
  Cache-Control: public, max-age=86400
/*.js
  Cache-Control: public, max-age=86400
"@ | Set-Content -LiteralPath (Join-Path $Public "_headers") -Encoding UTF8

Write-Host "在线发布目录已生成: $Public"
