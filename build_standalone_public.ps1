param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dashboard = Join-Path $Root "dashboard"
$Public = Join-Path $Root "public"

New-Item -ItemType Directory -Force -Path $Public | Out-Null

$html = Get-Content -LiteralPath (Join-Path $Dashboard "report.html") -Raw -Encoding UTF8
$css = Get-Content -LiteralPath (Join-Path $Dashboard "report.css") -Raw -Encoding UTF8
$data = Get-Content -LiteralPath (Join-Path $Dashboard "data.js") -Raw -Encoding UTF8
$js = Get-Content -LiteralPath (Join-Path $Dashboard "report.js") -Raw -Encoding UTF8
$logoPath = Join-Path $Dashboard "assets\maxcellent-logo.png"
$logoBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($logoPath))
$logoDataUri = "data:image/png;base64,$logoBase64"

$html = $html -replace '<link rel="stylesheet" href="\./report\.css"\s*/>', "<style>`n$css`n</style>"
$html = $html -replace '<a href="\./index\.html">进入趋势看板</a>', ''
$html = $html.Replace('./assets/maxcellent-logo.png', $logoDataUri)
$html = $html -replace '<script src="\./data\.js"></script>', "<script>`n$data`n</script>"
$html = $html -replace '<script src="\./report\.js"></script>', "<script>`n$js`n</script>"

$out = Join-Path $Public "commodity-report-standalone.html"
Set-Content -LiteralPath $out -Value $html -Encoding UTF8
Write-Host $out
