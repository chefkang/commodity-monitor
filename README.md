# 大宗商品价格监测

这是一个本地价格监测看板，用于每天跟踪电池、硅胶线、电路板、塑料件、纸箱相关原材料。

## 长期公网地址

- 日报首页: https://chefkang.github.io/commodity-monitor/
- 趋势看板: https://chefkang.github.io/commodity-monitor/trend.html
- GitHub 仓库: https://github.com/chefkang/commodity-monitor

GitHub Actions 会在每个工作日上午 10 点自动刷新行情并发布网页。

## 主要入口

- `打开大宗商品价格日报.cmd`: 后台刷新数据并打开汇报式可视化日报。
- `手机查看大宗商品日报.cmd`: 后台刷新数据并开启局域网访问，手机同 Wi-Fi 可查看。
- `打包在线版网站.cmd`: 生成可上传到公网托管平台的 `public` 静态网站目录。
- `生成公网查看链接.cmd`: 生成一个可转发给外部人员查看的临时公网链接。
- `打开大宗商品价格看板.cmd`: 打开趋势看板。
- `刷新数据并打开看板.cmd`: 后台刷新数据并打开汇报式可视化日报。
- `run_daily.ps1`: 自动化每天运行的刷新脚本。

## 数据文件

- `data/prices.csv`: 每日价格趋势表。
- `data/latest.json`: 看板使用的最新汇总数据。
- `briefs/YYYY-MM-DD.md`: 每天生成的简报。
- `data/manual_prices_template.csv`: 铜箔、玻纤布、覆铜板等供应商报价补录模板。

## 供应商报价补录

把 `data/manual_prices_template.csv` 复制为 `data/manual_prices.csv`，填入实际采购报价后保存；下次刷新会自动并入趋势表和看板。

## 当前监测范围

铜、锡、铝、碳酸锂、ABS、PP、PVC、PC、LLDPE、环氧树脂、双酚A、环氧氯丙烷、有机硅DMC、工业硅、天然橡胶、瓦楞原纸、废纸、纸浆、玻璃/玻纤替代指标、苯乙烯。
