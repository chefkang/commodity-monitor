# 迈瑟伦原材料价格监测

这是 MAXCELLENT 迈瑟伦的原材料价格监测与采购预警项目，用于跟踪应急启动电源相关的电池、PCBA、线材夹子、充气泵、塑料外壳、包装等核心成本项。

## 公网入口

- 日报首页：https://chefkang.github.io/commodity-monitor/
- 趋势看板：https://chefkang.github.io/commodity-monitor/trend.html
- GitHub 仓库：https://github.com/chefkang/commodity-monitor

GitHub Actions 每天北京时间 10:00 和 15:00 自动刷新数据、发布网页，并发送邮件通知更新状态。

## 主要入口

- `打开大宗商品价格日报.cmd`：打开汇报式日报。
- `打开大宗商品价格看板.cmd`：打开趋势看板。
- `刷新数据并打开看板.cmd`：刷新数据并打开看板。
- `run_daily.ps1`：本地自动刷新脚本。

## 数据文件

- `data/prices.csv`：每日价格趋势表。
- `data/latest.json`：看板使用的最新汇总数据。
- `briefs/YYYY-MM-DD.md`：每天生成的简报。
- `data/manual_prices_template.csv`：供应商报价补录模板。

## 采购计划模型

下一阶段目标是把价格监测升级为采购计划和备货计划工具：

- `docs/PROCUREMENT_MODEL.md`：采购计划与备货计划模型蓝图。
- `docs/PROCUREMENT_FORMULAS.md`：库存天数、补货点、建议采购量等公式口径。
- `docs/INTERNAL_DATA_DICTIONARY.md`：钉钉、进销存、BOM、采购、供应商等内部数据字段清单。
- `docs/MTN_H3_DATA_SOURCE.md`：美途能进销存系统作为最高可信源的接入说明。
- `templates/internal-data/`：内部数据导入模板。

## 数据安全

公网看板只展示公开行情、代理指标和风险提示。BOM、供应商报价、库存、采购价、销售数据、图纸等内部资料只允许进入本地或权限受控的内部看板，不上传到公网 GitHub Pages。

已忽略的本地内部目录：

- `.private/`
- `data/internal/`
- `outputs/internal/`
- `runtime/internal/`

## 当前监测范围

铜、锡、铝、碳酸锂、ABS、PP、PVC、PC、LLDPE、环氧树脂、双酚A、环氧氯丙烷、有机硅DMC、工业硅、天然橡胶、瓦楞纸、废纸、纸浆，以及铜箔、玻纤布、焊锡、电解液、磷酸铁锂正极材料等代理指标。
