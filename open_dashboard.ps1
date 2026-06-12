param()

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dashboard = Join-Path $Root "dashboard\index.html"
Start-Process $Dashboard
