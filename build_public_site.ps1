param(
  [switch]$Refresh
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root ".venv\Scripts\python.exe"
$BuildScript = Join-Path $Root "scripts\build_public_site.py"

if (-not (Test-Path -LiteralPath $Python)) {
  throw "未找到项目 Python 环境，请先运行 setup.ps1。"
}

if ($Refresh) {
  & (Join-Path $Root "run_daily.ps1") -BackfillDays 180 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "行情刷新失败，未继续打包。"
  }
}

# Use the same public-only builder as daily refreshes and GitHub Pages.
& $Python $BuildScript
if ($LASTEXITCODE -ne 0) {
  throw "公开网页构建失败，退出码：$LASTEXITCODE"
}
Write-Host "在线发布目录已生成: $(Join-Path $Root 'public')"
