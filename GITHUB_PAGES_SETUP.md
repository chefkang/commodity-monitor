# 长期公网网址与每日自动更新

本项目已经配置好 GitHub Pages 自动发布。

## 自动更新规则

- 每个工作日北京时间 10:00 自动运行。
- 自动抓取原材料行情和新闻。
- 自动生成 `public/index.html` 日报和 `public/trend.html` 趋势看板。
- 自动发布到 GitHub Pages 固定网址。

## 发布后的网址

通常是：

`https://chefkang.github.io/commodity-monitor/`

完整趋势看板：

`https://chefkang.github.io/commodity-monitor/trend.html`

如果仓库名不是 `commodity-monitor`，网址里的最后一段会换成实际仓库名。

## 需要做的一次性设置

1. 创建一个公开 GitHub 仓库，例如 `commodity-monitor`。
2. 把本项目推送到该仓库。
3. 在仓库 `Settings` → `Pages`，把 Source 设为 `GitHub Actions`。
4. 进入 `Actions`，运行 `Daily Commodity Monitor`。

运行成功后，GitHub 会给出固定访问网址。
