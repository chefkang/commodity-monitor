param()

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = Join-Path $Root "config\commodity_agent.secret.json"

Write-Host "配置本地大宗商品智能分析助手 Key" -ForegroundColor Cyan
$apiKey = Read-Host "请输入 OpenAI API Key"
if (-not $apiKey.Trim()) {
  throw "API Key 不能为空。"
}

$baseUrl = Read-Host "OpenAI Base URL（直接回车使用默认 https://api.openai.com/v1）"
$project = Read-Host "OpenAI Project（可直接回车留空）"
$quickModel = Read-Host "快速模式模型（直接回车使用 gpt-5.5）"
$researchModel = Read-Host "研究模式模型（直接回车使用 o4-mini-deep-research）"

$payload = [ordered]@{
  openai_api_key = $apiKey.Trim()
  openai_base_url = if ($baseUrl.Trim()) { $baseUrl.Trim() } else { "https://api.openai.com/v1" }
  openai_project = $project.Trim()
  commodity_agent_model = if ($quickModel.Trim()) { $quickModel.Trim() } else { "gpt-5.5" }
  commodity_agent_research_model = if ($researchModel.Trim()) { $researchModel.Trim() } else { "o4-mini-deep-research" }
}

$json = $payload | ConvertTo-Json -Depth 4
Set-Content -Path $Target -Value $json -Encoding UTF8

Write-Host ""
Write-Host "已写入: $Target" -ForegroundColor Green
Write-Host "现在可以双击 打开大宗商品智能分析助手.cmd 直接启动。" -ForegroundColor Green
