# 迈瑟伦原材料价格监测

这是 MAXCELLENT 迈瑟伦的原材料价格监测与采购预警项目，用于跟踪应急启动电源相关的电池、PCBA、线材夹子、充气泵、塑料外壳、包装等核心成本项。

## 公网入口

- 日报首页：https://chefkang.github.io/commodity-monitor/
- 趋势看板：https://chefkang.github.io/commodity-monitor/trend.html
- GitHub 仓库：https://github.com/chefkang/commodity-monitor

GitHub Actions 每天北京时间 10:00 和 15:00 自动刷新数据、发布网页，并发送邮件通知更新状态；周末和节假日也必须推送。另有 10:20 和 15:20 的兜底检查，若对应时段未成功发布，会自动补跑。

本地执行 `run_daily.ps1` 时也会同步重建 `public/` 目录，避免本机直接打开本地公网页面时长期停留在旧版本。公网页面改为运行时主动加载最新 `data.js`，减少浏览器缓存导致的“明明已发布却还显示旧数据”。

## 主要入口

- `打开大宗商品价格日报.cmd`：打开汇报式日报。
- `打开大宗商品价格看板.cmd`：打开趋势看板。
- `刷新数据并打开看板.cmd`：刷新数据并打开看板。
- `run_daily.ps1`：本地自动刷新脚本。
- `打开大宗商品智能分析助手.cmd`：打开本地-only 大模型联网分析助手。

## 本地智能分析助手

新增了一个本地-only 的大模型联网智能体入口：

- 页面入口：`打开大宗商品智能分析助手.cmd`
- Key 配置：`配置大宗商品智能分析助手Key.cmd`
- 后端脚本：`scripts/commodity_agent_server.py`
- 使用说明：`docs/AI_AGENT_LOCAL.md`

这个助手会优先读取本地公开监测结果 `data/latest.json` 和最近简报，再按需要通过 OpenAI Responses API 的 `web_search` 联网补充当天外部信息。它不会把 API key 暴露到 GitHub Pages，也不会读取 `.private/`、`data/internal/`、`runtime/internal/`。

现在页面启动后会先显示“今日快照”，把本地最新刷新时间、成本压力指数、重点盯盘品种、涨幅靠前品种和建议动作先摆出来；即使还没配置 key，也能先看本地监测概览，再决定要不要继续做联网分析。

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

公网看板只展示公开行情、明确标注的上游代理指标和风险提示。BOM、供应商报价、库存、采购价、销售数据、图纸等内部资料只允许进入本地或权限受控的内部看板，不上传到公网 GitHub Pages。

价格口径必须区分：

- `真实行情`：公开市场可取得的现货、期货或基准价。
- `上游代理指标`：使用真实上游价格监控趋势，但不是该材料的直接报价，不能当成该材料真实成交价。
- `供应商报价`：公司内部或供应商人工补录价格，只在本地内部看板使用。

已忽略的本地内部目录：

- `.private/`
- `data/internal/`
- `outputs/internal/`
- `runtime/internal/`

## 当前监测范围

铜、锡、铝、碳酸锂、ABS、PP、PVC、PC、LLDPE、环氧树脂、双酚A、环氧氯丙烷、有机硅DMC、工业硅、天然橡胶、瓦楞纸、废纸、纸浆，以及铜箔、玻纤布、焊锡、电解液、磷酸铁锂正极材料等代理指标。
