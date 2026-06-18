# 本地大宗商品智能分析助手

## 1. 这是什么

这是这个项目里的本地-only 大模型联网智能体入口，用来把下面三类信息放进同一轮分析：

1. 本地公开监测结果：`data/latest.json`、`briefs/`
2. 本地累计历史：`data/latest.json.history`
3. 当天外部信息：通过 OpenAI Responses API 的 `web_search` 工具联网补充

它适合回答：

- 今天哪些原材料最值得盯盘，为什么
- 某个价格到底是真实公开行情，还是上游代理指标
- 结合今天新闻，未来几天成本压力会不会抬升
- 把今天的行情结论整理成老板汇报或采购动作

## 2. 数据边界

这个助手只允许读取公开监测链路里的本地产物，不允许读取内部目录：

- 允许：`data/latest.json`
- 允许：`briefs/*.md`
- 不允许：`.private/`
- 不允许：`data/internal/`
- 不允许：`runtime/internal/`

回答时必须区分口径：

- `akshare_basis` / `sunsirs_vane`：公开行情或公开基准价
- `derived_from`：上游代理指标，只能代表趋势，不能说成该材料真实成交价
- `manual`：人工补录报价，只有在上下文中明确出现时才能说明是本地补录

## 3. 启动方式

### 双击启动

直接双击：

- `打开大宗商品智能分析助手.cmd`
- `配置大宗商品智能分析助手Key.cmd`：写入本地 secret 配置

### PowerShell 启动

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start_commodity_agent.ps1
```

如果希望启动前先刷新当天数据：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start_commodity_agent.ps1 -Refresh
```

默认地址：

- `http://127.0.0.1:8787/`

## 4. API Key 配置

这个本地智能体不会复用 Codex 聊天里的平台权限；它走的是你自己机器上的 OpenAI API key。

至少需要设置：

```powershell
setx OPENAI_API_KEY "你的key"
```

或者直接双击：

- `配置大宗商品智能分析助手Key.cmd`

它会把 key 写到：

- `config/commodity_agent.secret.json`

这个文件已被 `.gitignore` 排除，不会被提交到仓库。

可选环境变量：

```powershell
setx COMMODITY_AGENT_MODEL "gpt-5.5"
setx COMMODITY_AGENT_RESEARCH_MODEL "o4-mini-deep-research"
setx COMMODITY_AGENT_PORT "8787"
```

如果已经打开了新的 PowerShell 窗口，再重新双击启动即可。

## 5. 运行方式

网页里有两个模式：

- `快速判断`：适合日常盯盘和简洁结论
- `联网研究`：适合做更完整的原因追踪、行情归因和经营汇报

同一会话里的追问会延续上一轮回答上下文；点 `新会话` 会重置本地会话状态。

页面加载后会先显示一块“今日快照”，直接给出：

- 本地最新刷新时间
- 成本压力指数、高风险数量、今日上涨数量
- 风险排序靠前的品种
- 涨幅靠前的品种
- 今日简报动作建议

左侧“今日可直接追问”会按当天快照动态生成，不再只是固定示例问题。

## 6. 当前实现结构

- 后端：`scripts/commodity_agent_server.py`
- 启动脚本：`start_commodity_agent.ps1`
- 配置脚本：`configure_commodity_agent_key.ps1`
- 双击入口：`打开大宗商品智能分析助手.cmd`
- Key 配置入口：`配置大宗商品智能分析助手Key.cmd`
- 本地页面：`agent_ui/`

## 7. 当前限制

- 没有配置 `OPENAI_API_KEY` 时，页面仍可展示本地快照，但不能真实发起联网分析
- 这是本地服务，不会发布到 GitHub Pages
- 当前版本优先把“本地上下文 + 联网分析 + 可追问会话”打通，还没有接入更细粒度的应用侧函数工具
