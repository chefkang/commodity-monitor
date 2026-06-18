# 刷新自愈补强说明（2026-06-18）

## 这次查到的根因

- 今天白天的公开监测并不是完全没跑。
- 本地数据在 `2026-06-18 19:10:20 +08:00` 已经刷新完成。
- 公网页面在 `2026-06-18 19:57:15 +08:00` 才追平本地。
- 计划任务记录显示，`CommodityMonitor-Local-Refresh` 和 `CommodityMonitor-GitHub-Fallback` 在下午 `15:30/15:50` 之后出现了多次 missed runs。
- 现有任务虽然开启了 `StartWhenAvailable`，但没有开启 `WakeToRun`，也没有“解锁后自动补查”这一层，所以机器一旦在下午或傍晚睡过去，就可能错过本该自动补跑的窗口。

## 已做的补强

- 三条主任务现在统一开启 `WakeToRun`：
  - `CommodityMonitor-Local-Refresh`
  - `CommodityMonitor-GitHub-Fallback`
  - `CommodityMonitor-Health-Check`
- 保留原有 `CommodityMonitor-Login-Health-Check`。
- 新增 `CommodityMonitor-Unlock-Health-Check`。
  - 触发时机：工作站解锁。
  - 动作：运行 `scripts/check_refresh_health.ps1 -Repair -SkipRepairBeforeSlot`。
  - 作用：如果电脑在监测窗口里睡眠或离开，回来解锁时会立即补查本地和公网状态，不用再等下一次人工打开或第二天定时。
- `scripts/check_refresh_health.ps1` 的状态输出现在会把 `CommodityMonitor-Unlock-Health-Check` 一起纳入任务状态，方便确认“解锁后补查”这层是否生效。

## 现在的自愈链路

1. 固定时段先跑本地刷新。
2. 随后检查 GitHub Pages 是否追平本地。
3. 如果公网还落后，自动重触发发布。
4. 如果机器睡眠导致错过窗口，任务可以尝试唤醒执行。
5. 如果机器没有被唤醒，用户回来解锁时也会立刻补跑一次健康检查。

## 后续看哪里

- 状态文件：`runtime/refresh_health.json`
- 健康检查日志：`runtime/refresh-health.log`
- GitHub 触发日志：`runtime/github-trigger.log`
- 本地刷新日志：`runtime/local-refresh.log`
