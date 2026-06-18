# 刷新健康检查与自愈

这个项目现在把“有没有更新”和“是不是缩水更新”分开检查，避免出现时间是新的、内容却不完整的假成功。

## 会检查什么

- 本地 `data/latest.json` 是否已经覆盖今天当前时段
- 本地 `latest.json` 里的新闻条数，是否和 `data/news.json` 明显不一致
- 公网 `https://chefkang.github.io/commodity-monitor/data.js` 是否已经覆盖今天当前时段
- 如果本地后来补修成功，公网是否已经追平本地最新 `generated_at`
- 当前是不是还处在“下一次计划刷新尚未开始”的正常等待窗口，避免把凌晨或下一时段开始前的上一版结果误判成故障
- `CommodityMonitor-Local-Refresh`、`CommodityMonitor-GitHub-Fallback`、`CommodityMonitor-Health-Check` 三条计划任务状态
- 本次刷新是否带有 `refresh_warnings`

## 发现异常时怎么处理

- 本地过期、新闻缩水、或本次刷新带警告：先补跑本地刷新
- 本地已新但公网还没新，或公网时间明显落后于本地：触发 GitHub Pages 补跑
- 检查结果会写到 `runtime/refresh_health.json`
- 检查日志会追加到 `runtime/refresh-health.log`
- 状态文件里会同时记录当前生效时段、下一次计划刷新时间，以及是否属于“今天首轮刷新前的正常等待窗口”

## 计划任务

- `CommodityMonitor-Local-Refresh`
  - `09:58`、`10:30`、`14:58`、`15:30`、`16:30`、`17:30`、`18:30`、`19:30`
- `CommodityMonitor-GitHub-Fallback`
  - `10:20`、`10:50`、`15:20`、`15:50`、`16:50`、`17:50`、`18:50`、`19:50`
- `CommodityMonitor-Health-Check`
  - `10:40`、`11:05`、`15:40`、`16:05`、`17:05`、`18:05`、`19:05`、`20:05`
- `CommodityMonitor-Login-Health-Check`
  - 每次登录 Windows 后触发一次；如果当天对应时段还没开始，只记状态不抢跑刷新

## 手动入口

- 双击 `检查今日刷新状态.cmd`
- 或直接运行 `scripts/check_refresh_health.ps1 -Repair`

## 现在的兜底逻辑

- 定时本地刷新不再只看时间，也会拦截“时间已更新但新闻被刷空”的缩水结果
- 打开本地日报/看板前，会先走完整健康检查，而不是只补时间戳
- 重新注册计划任务后，会立刻执行一次健康检查，不会等到第二天才第一次生效

如果页面顶部出现刷新提示条，说明这次刷新里有需要留意的降级信息，例如“新闻抓取失败，已沿用最近有效新闻”。
从 `2026-06-19` 起，如果当前时间还没到当天 `10:00` 首轮刷新，页面也会直接显示“当前还没到今天首轮刷新时段”；只有真的过了应刷新时间仍旧偏旧，才会提示需要关注。
从 `2026-06-19` 起，日报页和趋势页还会每分钟重算这条提示，并每 `5` 分钟后台检查一次 `data.js`；如果发现 `generated_at` 或数据条数已经变化，会自动重载页面，避免长时间挂着旧页签时跨天后误以为系统没更新。

## 2026-06-18 新增兜底

- `run_daily.ps1` 生成完本地数据后，会立刻核对 `data/latest.json` 和 `data/news.json`。如果出现“latest.json 新闻为 0，但缓存里还有新闻”的缩水结果，会自动重跑一次；若仍异常则直接报错，不再静默落盘。
- `run_daily.ps1` 在当前监测时段已经开始后，如果本机又刷出了更新的本地结果，会立刻再跑一轮 `check_refresh_health.ps1 -Repair`，必要时当场补发公网，而不是等到下一条兜底计划任务才追平。
- `scripts/commodity_monitor.py` 现在会先拿本地刷新锁；如果另一个刷新还在写文件，后来的刷新会先等待，避免两个过程交叉写出“latest.json 已更新但 news.json / 公网页面还是另一版”的错位状态。
- `check_refresh_health.ps1 -Repair` 在本地刚修好之后，会强制再次检查并补发公网，不再因为“今天这个时段已经成功跑过一次 workflow”就跳过。
- `trigger_github_update.ps1` 在触发 GitHub Pages 补发后，会继续等待公网 `generated_at` 追平本地，而不是只记录“已触发”就结束。
- `trigger_github_update.ps1` 现在会忽略那种“只有 `check` 成功、`build`/`deploy` 被跳过”的假成功记录，避免 GitHub 上看起来成功、实际没发新版页面时，把真正的补发挡住。
- `.github/workflows/daily-pages.yml` 里的定时任务去重逻辑现在只拦“同一时段还有运行中的任务”，不再把“前一条成功记录”当成必须跳过的理由，避免 GitHub 的迟到定时任务自己把补刷机会挡掉。
- 晚间 `16:30` 到 `20:05` 新增了一轮本地刷新、公网补发、健康检查的自愈窗口，避免下午时段之后本地又修出新数据但公网无人追平。
- 健康检查状态文件现在会记录 `lag_minutes`，并在触发公网补发后再次回读公网时间，避免状态还停留在补发前的旧结论。
