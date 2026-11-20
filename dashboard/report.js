(function () {
  const data = window.COMMODITY_MONITOR_DATA || {
    latest: [],
    history: [],
    index_history: [],
    news: [],
    summary: {},
    brief: {},
  };
  const byId = new Map(data.latest.map((item) => [item.material_id, item]));
  const runtimeMeta = window.COMMODITY_MONITOR_RUNTIME || {};
  const dataSourceLabel = String(runtimeMeta.data_source_label || "").trim();
  const dataSourceReason = String(runtimeMeta.data_source_reason || "").trim();
  const publicDataCheckEnabled = Boolean(runtimeMeta.check_public_data);
  const publicDataUrl = String(
    runtimeMeta.public_data_url ||
      "https://chefkang.github.io/commodity-monitor/data.js",
  );
  const publicLagToleranceMs = Number(
    runtimeMeta.public_lag_tolerance_ms || 3 * 60 * 1000,
  );
  const NOTICE_REFRESH_INTERVAL_MS = 60 * 1000;
  const BACKGROUND_DATA_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  let backgroundDataCheckInFlight = false;

  const coreOrder = [
    "lithium_carbonate",
    "lfp_cathode_proxy",
    "battery_copper_foil_proxy",
    "battery_aluminum_foil_proxy",
    "copper",
    "copper_foil_proxy",
    "tin",
    "solder_tin_proxy",
    "aluminum",
    "steel_hc",
    "nickel",
    "zinc",
    "abs",
    "pc",
    "pvc",
    "epoxy_resin",
    "fiberglass_cloth_proxy",
    "organic_silicon_dmc",
    "corrugated_paper",
    "paper_pulp",
    "waste_paper",
  ];

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function refreshWarnings() {
    if (!data.summary || !Array.isArray(data.summary.refresh_warnings)) {
      return [];
    }
    return data.summary.refresh_warnings.filter((warning) =>
      String(warning || "").trim(),
    );
  }

  function dateText(value) {
    if (!value) return "待生成";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value || "";
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Shanghai",
    });
  }

  function parseGeneratedAtMs(payload) {
    const value =
      payload && payload.generated_at
        ? Date.parse(payload.generated_at)
        : Number.NaN;
    return Number.isFinite(value) ? value : null;
  }

  function latestCount(payload) {
    return payload && Array.isArray(payload.latest) ? payload.latest.length : 0;
  }

  function shouldPromoteCandidatePayload(basePayload, candidatePayload) {
    const baseGeneratedAt = parseGeneratedAtMs(basePayload);
    const candidateGeneratedAt = parseGeneratedAtMs(candidatePayload);

    if (candidateGeneratedAt !== null && baseGeneratedAt === null) {
      return true;
    }

    if (
      candidateGeneratedAt !== null &&
      baseGeneratedAt !== null &&
      candidateGeneratedAt > baseGeneratedAt + publicLagToleranceMs
    ) {
      return true;
    }

    if (latestCount(candidatePayload) !== latestCount(basePayload)) {
      if (candidateGeneratedAt === null) {
        return baseGeneratedAt === null;
      }
      return (
        baseGeneratedAt === null || candidateGeneratedAt >= baseGeneratedAt
      );
    }

    return false;
  }

  const beijingFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  function beijingParts(value = new Date()) {
    const parts = {};
    beijingFormatter.formatToParts(value).forEach((part) => {
      if (part.type !== "literal") {
        parts[part.type] = part.value;
      }
    });
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second),
    };
  }

  function beijingSlotTime(parts, hour) {
    return new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day, hour - 8, 0, 0),
    );
  }

  function beijingClockLabel(value) {
    const parts = beijingParts(value);
    return `${String(parts.month).padStart(2, "0")}/${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  }

  function declaredLatestTradingDateValue() {
    return String(data.latest_trade_date || "").trim();
  }

  function latestItemDateValue() {
    const dates = data.latest
      .map((item) => String(item && item.date ? item.date : "").trim())
      .filter(Boolean)
      .sort();
    return dates.length ? dates[dates.length - 1] : "";
  }

  function latestTradingDateValue() {
    return declaredLatestTradingDateValue() || latestItemDateValue();
  }

  function todayBeijingDateValue(value = new Date()) {
    const parts = beijingParts(value);
    return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  }

  function latestTradingDateLabel() {
    return latestTradingDateValue() || "等待数据";
  }

  function tradeDateDistribution() {
    if (
      Array.isArray(data.trade_date_distribution) &&
      data.trade_date_distribution.length
    ) {
      return data.trade_date_distribution
        .map((entry) => ({
          date: String(entry && entry.date ? entry.date : "").trim(),
          count: Number(entry && entry.count ? entry.count : 0),
        }))
        .filter(
          (entry) =>
            entry.date && Number.isFinite(entry.count) && entry.count > 0,
        )
        .sort(
          (left, right) =>
            right.count - left.count || right.date.localeCompare(left.date),
        );
    }

    const counts = new Map();
    data.latest.forEach((item) => {
      const tradeDate = String(item && item.date ? item.date : "").trim();
      if (!tradeDate) {
        return;
      }
      counts.set(tradeDate, (counts.get(tradeDate) || 0) + 1);
    });
    return Array.from(counts.entries())
      .map(([tradeDate, count]) => ({ date: tradeDate, count }))
      .sort(
        (left, right) =>
          right.count - left.count || right.date.localeCompare(left.date),
      );
  }

  function tradeDateCoverageSummary() {
    const distribution = tradeDateDistribution();
    if (!distribution.length) {
      return null;
    }
    const latestTradeDate = latestTradingDateValue();
    const latestEntry =
      distribution.find((entry) => entry.date === latestTradeDate) || null;
    const totalCount = distribution.reduce(
      (sum, entry) => sum + entry.count,
      0,
    );
    const dominantEntry = distribution[0] || null;
    return {
      distribution,
      totalCount,
      latestTradeDate,
      latestTradeDateCount: latestEntry ? latestEntry.count : 0,
      dominantTradeDate: dominantEntry ? dominantEntry.date : "",
      dominantTradeDateCount: dominantEntry ? dominantEntry.count : 0,
      mixedTradeDates: distribution.length > 1,
      laggingCount: Math.max(
        totalCount - (latestEntry ? latestEntry.count : 0),
        0,
      ),
    };
  }

  function tradeDateCoverageNote() {
    const coverage = tradeDateCoverageSummary();
    if (
      !coverage ||
      !coverage.mixedTradeDates ||
      !coverage.latestTradeDate ||
      !coverage.laggingCount
    ) {
      return "";
    }
    if (
      coverage.dominantTradeDate &&
      coverage.dominantTradeDate !== coverage.latestTradeDate
    ) {
      return `当前 ${coverage.totalCount} 个跟踪品类里，只有 ${coverage.latestTradeDateCount} 个已经切到 ${coverage.latestTradeDate}，仍有 ${coverage.laggingCount} 个日期较早（其中 ${coverage.dominantTradeDateCount} 个为 ${coverage.dominantTradeDate}）；这说明今天脚本已经执行，但多数上游价格源尚未全面换日。`;
    }
    return `当前 ${coverage.totalCount} 个跟踪品类里，最新交易日 ${coverage.latestTradeDate} 仅覆盖了 ${coverage.latestTradeDateCount} 个，其余 ${coverage.laggingCount} 个仍停留在更早交易日；这说明今天脚本已经执行，但不同上游价格源的换日节奏并不一致。`;
  }

  function mixedCoverageStateLabel(coverage) {
    if (!coverage || !coverage.mixedTradeDates || !coverage.laggingCount) {
      return "";
    }
    if (
      coverage.dominantTradeDate &&
      coverage.dominantTradeDate !== coverage.latestTradeDate
    ) {
      return "部分更新，主行情仍是上一交易日";
    }
    return "今天已刷新，但行情日期混合";
  }

  function coverageHeaderSuffix(coverage) {
    if (
      !coverage ||
      !coverage.mixedTradeDates ||
      !coverage.latestTradeDate ||
      !coverage.laggingCount
    ) {
      return "";
    }
    if (
      coverage.dominantTradeDate &&
      coverage.dominantTradeDate !== coverage.latestTradeDate
    ) {
      return `，${coverage.latestTradeDateCount}/${coverage.totalCount} 品类到 ${coverage.latestTradeDate}，${coverage.laggingCount} 项日期较早`;
    }
    return `，${coverage.latestTradeDateCount}/${coverage.totalCount} 品类到 ${coverage.latestTradeDate}，${coverage.laggingCount} 项日期较早`;
  }

  function latestTradingDateMismatchNote() {
    const declaredDate = declaredLatestTradingDateValue();
    const itemDate = latestItemDateValue();
    if (declaredDate && itemDate && declaredDate !== itemDate) {
      return `系统最新交易日按刷新状态显示为 ${declaredDate}；单项价格明细里的日期当前仍多为 ${itemDate}，这是明细口径，不等于页面未刷新。`;
    }
    return "";
  }

  function nextPlannedRefresh() {
    const now = new Date();
    const parts = beijingParts(now);
    const currentMinutes = parts.hour * 60 + parts.minute;
    if (currentMinutes < 10 * 60) {
      const nextTime = beijingSlotTime(parts, 10);
      return {
        slot: "morning",
        label: beijingClockLabel(nextTime),
        time: nextTime,
      };
    }
    if (currentMinutes < 15 * 60) {
      const nextTime = beijingSlotTime(parts, 15);
      return {
        slot: "afternoon",
        label: beijingClockLabel(nextTime),
        time: nextTime,
      };
    }
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowParts = beijingParts(tomorrow);
    const nextTime = beijingSlotTime(tomorrowParts, 10);
    return {
      slot: "morning",
      label: beijingClockLabel(nextTime),
      time: nextTime,
    };
  }

  function minutesUntil(targetTime) {
    if (!(targetTime instanceof Date) || Number.isNaN(targetTime.getTime())) {
      return null;
    }
    return Math.max(
      0,
      Math.ceil((targetTime.getTime() - Date.now()) / (60 * 1000)),
    );
  }

  function countdownLabel(targetTime) {
    const totalMinutes = minutesUntil(targetTime);
    if (totalMinutes === null) {
      return "";
    }
    if (totalMinutes < 60) {
      return `约 ${totalMinutes} 分钟后`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes
      ? `约 ${hours} 小时 ${minutes} 分钟后`
      : `约 ${hours} 小时后`;
  }

  function refreshStateDetailText(notice, nextRefresh, tradingDate) {
    const coverageNote = tradeDateCoverageNote();
    if (notice && notice.mode === "waiting-slot")
      return [...notice.lines, coverageNote].filter(Boolean).join(" ");
    if (notice && notice.level === "info") {
      if (notice.mode === "early-refreshed") {
        return [
          `现在是北京时间 ${beijingClockLabel(new Date())}，虽然还没到 10:00 首轮窗口，但今天的首轮数据已经提前落地，最新交易日 ${tradingDate} 已到位。`,
          coverageNote,
        ]
          .filter(Boolean)
          .join(" ");
      }
      return [
        `现在是北京时间 ${beijingClockLabel(new Date())}，今天首轮刷新会在 ${nextRefresh.label} 左右开始；10:20 前仍显示最新交易日 ${tradingDate} 属于正常等待，不是故障。`,
        coverageNote,
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (notice && notice.lines && notice.lines.length) {
      const tail =
        notice.lines.length > 1 ? notice.lines[notice.lines.length - 1] : "";
      return [notice.lines[0], tail, coverageNote].filter(Boolean).join(" ");
    }
    if (coverageNote) {
      return `当前页面已加载 ${dateText(data.generated_at)} 的最新结果。${coverageNote}`;
    }
    return `当前页面已加载 ${dateText(data.generated_at)} 的最新结果。`;
  }

  function refreshGeneratedDetailText() {
    if (dataSourceLabel) {
      return `这是最近一次生成或同步时间；当前优先显示 ${dataSourceLabel}${dataSourceReason ? `，${dataSourceReason}` : "。"}`;
    }
    return "这是系统最近一次生成或同步时间，不等于价格明细里的交易日。";
  }

  function refreshTradingDateDetailText(notice, tradingDate) {
    const mismatchNote = latestTradingDateMismatchNote();
    const coverageNote = tradeDateCoverageNote();
    if (notice && notice.mode === "waiting-slot")
      return `这里是当前已加载行情的交易日，不等于页面刷新时间。${coverageNote}`;
    if (notice && notice.level === "info") {
      if (notice.mode === "early-refreshed") {
        const baseText = mismatchNote
          ? `这里显示的交易日已经提前切到 ${tradingDate}，说明今天首轮监测已经到位。${mismatchNote}`
          : `这里显示的交易日已经提前切到 ${tradingDate}，说明今天首轮监测已经到位。`;
        return [baseText, coverageNote].filter(Boolean).join("");
      }
      const baseText = mismatchNote
        ? `这里显示的是系统最新交易日。北京时间 10:20 前看到 ${tradingDate} 属正常等待；过了 10:20 仍不变化，再按异常处理。${mismatchNote}`
        : `这里显示的是系统最新交易日。北京时间 10:20 前看到 ${tradingDate} 属正常等待；过了 10:20 仍不变化，再按异常处理。`;
      return [baseText, coverageNote].filter(Boolean).join("");
    }
    return (
      coverageNote ||
      mismatchNote ||
      "价格明细里的日期代表交易日，不等于页面刷新时间。"
    );
  }

  function refreshNextSlotDetailText(nextRefresh) {
    const countdown = countdownLabel(nextRefresh.time);
    const cutoff = nextRefresh.slot === "morning" ? "10:20" : "15:20";
    return `${countdown ? `${countdown}进入下一轮计划刷新窗口；` : ""}过了 ${cutoff} 仍不变化，再按异常处理。`;
  }

  function applyRefreshCardTone(notice, coverage) {
    const stateCard = el("refreshStateLabel")
      ? el("refreshStateLabel").closest(".refresh-status-card")
      : null;
    const nextSlotCard = el("refreshNextSlot")
      ? el("refreshNextSlot").closest(".refresh-status-card")
      : null;
    [stateCard, nextSlotCard].forEach((card) => {
      if (card) {
        card.classList.remove("info-tone", "warning-tone");
      }
    });
    if (!notice) {
      if (coverage && coverage.mixedTradeDates && coverage.laggingCount > 0) {
        [stateCard, nextSlotCard].forEach((card) => {
          if (card) {
            card.classList.add("info-tone");
          }
        });
      }
      return;
    }
    const toneClass = notice.level === "warning" ? "warning-tone" : "info-tone";
    [stateCard, nextSlotCard].forEach((card) => {
      if (card) {
        card.classList.add(toneClass);
      }
    });
  }

  function renderPageTitle(notice, nextRefresh, coverage) {
    if (notice && notice.mode === "waiting-slot") {
      document.title = `${notice.headerLabel} | 迈瑟伦原材料价格日报`;
      return;
    }
    if (notice && notice.level === "info") {
      if (notice.mode === "early-refreshed") {
        document.title = "今日首轮已提前刷新 | 迈瑟伦原材料价格日报";
        return;
      }
      document.title = `系统正常，10:20 前属正常等待 | 迈瑟伦原材料价格日报`;
      return;
    }
    if (notice && notice.level === "warning") {
      document.title = `${notice.title} | 迈瑟伦原材料价格日报`;
      return;
    }
    if (coverage && coverage.mixedTradeDates && coverage.laggingCount > 0) {
      document.title = `${mixedCoverageStateLabel(coverage)} | 迈瑟伦原材料价格日报`;
      return;
    }
    document.title = "迈瑟伦原材料价格日报";
  }

  function freshnessNotice() {
    const generatedAt = data.generated_at ? new Date(data.generated_at) : null;
    if (!generatedAt || Number.isNaN(generatedAt.getTime())) {
      return null;
    }

    const now = new Date();
    const parts = beijingParts(now);
    const currentMinutes = parts.hour * 60 + parts.minute;
    const morningSlot = beijingSlotTime(parts, 10);
    const afternoonSlot = beijingSlotTime(parts, 15);
    const yesterdayAfternoon = new Date(afternoonSlot.getTime());
    yesterdayAfternoon.setUTCDate(yesterdayAfternoon.getUTCDate() - 1);
    const todayTradeDate = todayBeijingDateValue(now);
    const latestTradeDate = latestTradingDateValue();

    if (currentMinutes < 10 * 60) {
      if (
        latestTradeDate &&
        latestTradeDate === todayTradeDate &&
        generatedAt >= yesterdayAfternoon
      ) {
        return {
          level: "info",
          mode: "early-refreshed",
          headerLabel: "今日首轮已提前刷新",
          title: "今天首轮数据已经提前更新",
          lines: [
            `现在是北京时间 ${beijingClockLabel(now)}，虽然还没到 10:00 首轮刷新窗口，但今天的数据已经在 ${dateText(data.generated_at)} 提前落地。`,
            `当前最新交易日已经更新为 ${latestTradingDateLabel()}，说明今天上午这轮监测已经到位。`,
            `下一次计划刷新仍是 ${nextPlannedRefresh().label} 左右；当前页面显示的是今天首轮结果。`,
          ],
        };
      }
      if (generatedAt >= yesterdayAfternoon && generatedAt < morningSlot) {
        return {
          level: "info",
          headerLabel: "系统正常，10:20前属正常等待",
          title: "系统正常，今天 10:20 前仍属正常等待",
          lines: [
            `现在是北京时间 ${beijingClockLabel(now)}，下一次计划刷新时间约为 ${beijingClockLabel(morningSlot)}。`,
            `当前价格明细对应的最新交易日是 ${latestTradingDateLabel()}，清晨在 10:00 前看到它仍属正常。`,
            `当前显示的是 ${dateText(data.generated_at)} 刷新的上一监测时段结果，这不是故障。`,
            "公开页按计划会在今天 10:00 左右进入首轮刷新窗口，10:20 以后仍不变化时再按异常处理。",
          ],
        };
      }
      if (generatedAt < yesterdayAfternoon) {
        return {
          level: "warning",
          headerLabel: "上一监测时段结果偏旧",
          title: "上一监测时段结果也偏旧",
          lines: [
            `现在还没到今天 10:00 左右的首轮刷新时间，但上一监测时段最新时间仍是 ${dateText(data.generated_at)}。`,
            `当前价格明细对应的最新交易日是 ${latestTradingDateLabel()}。`,
            "这已经超出正常等待范围，建议稍后点击刷新，或运行“检查今日刷新状态”排查。",
          ],
        };
      }
    }

    if (
      currentMinutes >= 10 * 60 &&
      currentMinutes < 15 * 60 &&
      generatedAt < morningSlot
    ) {
      if (currentMinutes < 10 * 60 + 20 && generatedAt >= yesterdayAfternoon)
        return {
          level: "info",
          mode: "waiting-slot",
          headerLabel: "等待本轮更新",
          title: "等待上午本轮更新（10:20 前）",
          lines: [
            `当前保留 ${dateText(data.generated_at)} 的结果，正在等待今天 10:00 这一轮更新。`,
            "北京时间 10:20 前属于正常等待；超过 10:20 仍未更新，再关注刷新状态。",
          ],
        };
      return {
        level: "warning",
        headerLabel: "今日上午刷新待关注",
        title: "今天上午这轮刷新还没到位",
        lines: [
          `按计划应在北京时间 10:00 左右刷新，当前最新时间仍是 ${dateText(data.generated_at)}。`,
          `当前价格明细对应的最新交易日仍是 ${latestTradingDateLabel()}。`,
          "如果 10:20 以后仍未变化，建议点击刷新，或运行“检查今日刷新状态”自动补查。",
        ],
      };
    }

    if (currentMinutes >= 15 * 60 && generatedAt < afternoonSlot) {
      if (currentMinutes < 15 * 60 + 20 && generatedAt >= morningSlot)
        return {
          level: "info",
          mode: "waiting-slot",
          headerLabel: "等待本轮更新",
          title: "等待下午本轮更新（15:20 前）",
          lines: [
            `当前保留 ${dateText(data.generated_at)} 的结果，正在等待今天 15:00 这一轮更新。`,
            "北京时间 15:20 前属于正常等待；超过 15:20 仍未更新，再关注刷新状态。",
          ],
        };
      return {
        level: "warning",
        headerLabel: "今日下午刷新待关注",
        title: "今天下午这轮刷新还没到位",
        lines: [
          `按计划应在北京时间 15:00 左右刷新，当前最新时间仍是 ${dateText(data.generated_at)}。`,
          `当前价格明细对应的最新交易日仍是 ${latestTradingDateLabel()}。`,
          "如果 15:20 以后仍未变化，建议点击刷新，或运行“检查今日刷新状态”自动补查。",
        ],
      };
    }

    return null;
  }

  function num(value, digits = 0) {
    if (value === null || value === undefined || Number.isNaN(Number(value)))
      return "-";
    return Number(value).toLocaleString("zh-CN", {
      maximumFractionDigits: digits,
    });
  }

  function pct(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value)))
      return '<span class="neutral">-</span>';
    const n = Number(value);
    const cls = n > 0 ? "positive" : n < 0 ? "negative" : "neutral";
    const sign = n > 0 ? "+" : "";
    return `<span class="${cls}">${sign}${n.toFixed(2)}%</span>`;
  }

  function riskClass(item) {
    if (item.risk_level === "高") return "high";
    if (item.risk_level === "中偏高") return "medium";
    if (item.risk_level === "观察") return "watch";
    return "low";
  }

  function scoreText(score) {
    if (score >= 65) return "偏高，建议立即复核锁价";
    if (score >= 55) return "中偏高，关注补库窗口";
    if (score >= 45) return "观察，维持日度跟踪";
    return "压力偏低，采购节奏可控";
  }

  function historyFor(id, days = 90) {
    const rows = (data.history || [])
      .filter(
        (row) =>
          row.material_id === id &&
          row.date &&
          Number.isFinite(Number(row.price)),
      )
      .map((row) => ({ date: row.date, value: Number(row.price) }))
      .sort((left, right) => left.date.localeCompare(right.date));
    if (!rows.length) return rows;
    const cutoff = new Date(`${rows[rows.length - 1].date}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    return rows.filter((row) => new Date(`${row.date}T00:00:00Z`) >= cutoff);
  }

  function sparkline(id) {
    const points = historyFor(id, 90);
    if (points.length < 2) return '<span class="neutral">暂无曲线</span>';
    const w = 180;
    const h = 42;
    const values = points.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const x = (i) => (i / (points.length - 1)) * w;
    const y = (v) => h - ((v - min) / span) * (h - 6) - 3;
    const path = points
      .map(
        (p, i) =>
          `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`,
      )
      .join(" ");
    const up = points[points.length - 1].value >= points[0].value;
    const color = up ? "#ff8288" : "#5ed4a0";
    return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function hardReload() {
    const url = new URL(window.location.href);
    url.searchParams.set("ts", Date.now().toString());
    window.location.replace(url.toString());
  }

  function renderReportDate() {
    const notice = freshnessNotice();
    const nextRefresh = nextPlannedRefresh();
    const updatedLabel = dateText(data.generated_at);
    const tradingDate = latestTradingDateLabel();
    const coverage = tradeDateCoverageSummary();
    const coverageSuffix = coverageHeaderSuffix(coverage);
    renderPageTitle(notice, nextRefresh, coverage);
    if (notice && notice.mode === "waiting-slot") {
      el("reportDate").textContent =
        `${notice.headerLabel} · 当前结果生成于 ${updatedLabel} · 最新交易日 ${tradingDate}${coverageSuffix}`;
      return;
    }
    if (notice && notice.headerLabel) {
      const sourcePrefix = dataSourceLabel ? ` · ${dataSourceLabel}` : "";
      if (notice.level === "info") {
        if (notice.mode === "early-refreshed") {
          el("reportDate").textContent =
            `${notice.headerLabel}${sourcePrefix} · 现在 ${beijingClockLabel(new Date())}，今天数据已在 ${updatedLabel} 提前落地 · 最新交易日 ${tradingDate}${coverageSuffix}`;
          return;
        }
        const countdown = countdownLabel(nextRefresh.time);
        el("reportDate").textContent =
          `${notice.headerLabel}${sourcePrefix} · 现在 ${beijingClockLabel(new Date())}，今天首刷约 ${nextRefresh.label}${countdown ? `（${countdown}）` : ""} · 10:20 前仍显示最新交易日 ${tradingDate} 属正常等待，不是故障 · 上一监测结果生成于 ${updatedLabel}${coverageSuffix}`;
        return;
      }
      el("reportDate").textContent =
        `${notice.headerLabel}${sourcePrefix} · 当前显示上一监测时段 ${updatedLabel} 的结果 · 最新交易日 ${tradingDate}${coverageSuffix}`;
      return;
    }
    el("reportDate").textContent = dataSourceLabel
      ? `${dataSourceLabel}更新 ${updatedLabel}，最新交易日 ${tradingDate}${coverageSuffix}，今日价格与趋势已汇总`
      : `更新 ${updatedLabel}，最新交易日 ${tradingDate}${coverageSuffix}，今日价格与趋势已汇总`;
  }

  function renderHeader() {
    const score = data.summary.pressure_index;
    el("score").textContent = finite(score) ? Math.round(Number(score)) : "--";
    el("scoreText").textContent = finite(score)
      ? scoreText(Number(score))
      : "暂无评分";
    renderReportDate();
    const generated = data.generated_at ? new Date(data.generated_at) : null;
    setText(
      "briefDate",
      generated && !Number.isNaN(generated.getTime())
        ? generated.toLocaleDateString("zh-CN", {
            timeZone: "Asia/Shanghai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          })
        : "生成日期待确认",
    );
    el("tracked").textContent =
      data.summary.tracked_count ?? data.latest.length;
    el("rising").textContent = data.summary.rising_count ?? 0;
    el("highRisk").textContent = data.summary.high_risk_count ?? 0;
    el("newsRisk").textContent = data.summary.news_risk_count ?? 0;
  }

  function renderRefreshWarnings() {
    const banner = el("refreshWarningBanner");
    if (!banner) return;
    const warnings = refreshWarnings();
    const notice = freshnessNotice();
    const sections = [];

    if (notice) {
      sections.push(`
        <strong>${escapeHtml(notice.title)}</strong>
        <ul>${notice.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      `);
    }

    if (warnings.length) {
      sections.push(`
        <strong>本次刷新提示</strong>
        <ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
      `);
    }

    if (!sections.length) {
      banner.hidden = true;
      banner.classList.remove("info-mode");
      banner.innerHTML = "";
      return;
    }

    banner.hidden = false;
    banner.classList.toggle(
      "info-mode",
      notice && notice.level === "info" && !warnings.length,
    );
    banner.innerHTML = sections.join("");
  }

  function renderRefreshStatusStrip() {
    const notice = freshnessNotice();
    const nextRefresh = nextPlannedRefresh();
    const tradingDate = latestTradingDateLabel();
    const coverage = tradeDateCoverageSummary();
    const stateLabel = notice
      ? notice.headerLabel || notice.title
      : coverage && coverage.mixedTradeDates && coverage.laggingCount > 0
        ? mixedCoverageStateLabel(coverage)
        : "已覆盖当前时段";
    const stateDetail = refreshStateDetailText(
      notice,
      nextRefresh,
      tradingDate,
    );
    const generatedDetail = refreshGeneratedDetailText();
    const nextSlotDetail = refreshNextSlotDetailText(nextRefresh);

    const setText = (id, value) => {
      const node = el(id);
      if (node) {
        node.textContent = value;
      }
    };

    setText("refreshStateLabel", stateLabel);
    setText("refreshStateDetail", stateDetail);
    setText("refreshGeneratedAt", dateText(data.generated_at));
    setText("refreshGeneratedAtDetail", generatedDetail);
    setText("refreshTradingDate", tradingDate);
    setText(
      "refreshTradingDateDetail",
      refreshTradingDateDetailText(notice, tradingDate),
    );
    setText("refreshNextSlot", nextRefresh.label);
    setText("refreshNextSlotDetail", nextSlotDetail);
    applyRefreshCardTone(notice, coverage);
    const compact = el("freshnessSummary");
    if (compact)
      compact.innerHTML = `<span class="freshness-state">${escapeHtml(stateLabel)}</span><span>生成 ${escapeHtml(dateText(data.generated_at))}</span><span>最新交易日 ${escapeHtml(tradingDate)}</span><span>${coverage ? `当日覆盖 ${coverage.latestTradeDateCount}/${coverage.totalCount}${coverage.laggingCount ? ` · ${coverage.laggingCount}项日期较早` : ""}` : "暂无日期覆盖信息"}</span>`;
  }

  function refreshLiveStatus() {
    renderReportDate();
    renderRefreshWarnings();
    renderRefreshStatusStrip();
  }

  function backgroundDataCheck() {
    refreshLiveStatus();
    if (backgroundDataCheckInFlight || document.visibilityState === "hidden") {
      return;
    }

    backgroundDataCheckInFlight = true;
    const baselinePayload = {
      generated_at: data.generated_at,
      latest: Array.isArray(data.latest) ? data.latest : [],
    };

    const restoreCurrentPayload = () => {
      window.COMMODITY_MONITOR_DATA = data;
    };

    const finalize = () => {
      backgroundDataCheckInFlight = false;
      restoreCurrentPayload();
      refreshLiveStatus();
    };

    const loadDataScript = (src, onload, onerror) => {
      const script = document.createElement("script");
      script.async = true;
      script.src = src;
      script.onload = function () {
        onload(window.COMMODITY_MONITOR_DATA || {});
        script.remove();
      };
      script.onerror = function () {
        if (onerror) {
          onerror();
        }
        script.remove();
      };
      document.body.appendChild(script);
    };

    const shouldReloadForCandidate = (candidatePayload) => {
      if (shouldPromoteCandidatePayload(baselinePayload, candidatePayload)) {
        hardReload();
        return true;
      }
      restoreCurrentPayload();
      return false;
    };

    const checkPublicData = () => {
      if (!publicDataCheckEnabled) {
        finalize();
        return;
      }

      loadDataScript(
        `${publicDataUrl}?ts=${Date.now()}`,
        function (candidatePayload) {
          if (shouldReloadForCandidate(candidatePayload)) {
            return;
          }
          finalize();
        },
        finalize,
      );
    };

    loadDataScript(
      `./data.js?ts=${Date.now()}`,
      function (candidatePayload) {
        if (shouldReloadForCandidate(candidatePayload)) {
          return;
        }
        checkPublicData();
      },
      checkPublicData,
    );
  }

  function startLiveRefreshWatch() {
    window.setInterval(refreshLiveStatus, NOTICE_REFRESH_INTERVAL_MS);
    window.setInterval(backgroundDataCheck, BACKGROUND_DATA_CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        backgroundDataCheck();
      } else {
        refreshLiveStatus();
      }
    });
    window.addEventListener("focus", backgroundDataCheck);
  }

  const state = { search: "", category: "全部", filter: "all", sort: "risk" };
  const coverageById = new Map(
    (data.history_coverage || []).map((row) => [row.material_id, row]),
  );
  let lastDetailTrigger = null;
  let toastTimer;

  function basisInfo(item) {
    if (item && item.provider === "derived_from")
      return {
        cls: "proxy",
        label: "上游代理指标",
        hint: "不是该材料的直接报价",
        source: item.source || "上游行情代理",
      };
    if (item && item.provider === "manual")
      return {
        cls: "manual",
        label: "供应商补录",
        hint: "人工补录口径",
        source: item.source || "供应商补录",
      };
    return {
      cls: "real",
      label: "真实行情",
      hint: "公开市场参考价格",
      source: (item && item.source) || "公开行情",
    };
  }

  function basisBadge(item) {
    const basis = basisInfo(item);
    return `<span class="basis-badge ${basis.cls}">${escapeHtml(basis.label)}</span>`;
  }

  function plainPct(value) {
    if (
      value === null ||
      value === undefined ||
      !Number.isFinite(Number(value))
    )
      return "暂无可比记录";
    return `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
  }

  function shortName(item) {
    return String(item.material_name || "原料")
      .replace(/（.*?）|\(.*?\)/g, "")
      .trim();
  }

  function finite(value) {
    return (
      value !== null && value !== undefined && Number.isFinite(Number(value))
    );
  }

  function priorityRows() {
    return data.latest
      .slice()
      .sort(
        (a, b) => Number(b.up_probability || 0) - Number(a.up_probability || 0),
      );
  }

  function trendBase() {
    return window.location.pathname.toLowerCase().endsWith("/report.html")
      ? "./index.html"
      : "./trend.html";
  }

  function trendHref(materialId, view = "chart") {
    const mode = ["chart", "history", "detail"].includes(view) ? view : "chart";
    const params = new URLSearchParams();
    if (materialId && byId.has(materialId)) params.set("material", materialId);
    if (materialId) params.set("view", mode);
    const query = params.toString();
    return `${trendBase()}${query ? `?${query}` : ""}#${mode === "history" ? "historyPanel" : "chartSection"}`;
  }

  function safeNewsLink(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function setText(id, value) {
    const node = el(id);
    if (node) node.textContent = value;
  }

  function renderBrief() {
    const score = Number(data.summary.pressure_index);
    const first = priorityRows()[0];
    let headline = "成本压力可控，按需安排采购";
    if (!data.latest.length) headline = "暂无可用行情，请先核对数据状态";
    else if (!finite(data.summary.pressure_index))
      headline = "行情已汇总，请结合原料变化核对";
    else if (score >= 65) headline = "成本压力偏高，优先复核未锁价需求";
    else if (score >= 55) headline = "成本压力抬头，关注报价有效期";
    else if (first && first.risk_level === "高")
      headline = `成本总体可控，优先复核 ${shortName(first)}`;
    else if (Number(data.summary.news_risk_count || 0) > 0)
      headline = "成本总体可控，继续跟踪新闻扰动";
    setText("briefHeadline", headline);
    setText(
      "briefLead",
      `跟踪 ${data.summary.tracked_count ?? data.latest.length} 个价格与指标；${data.summary.rising_count ?? 0} 项较上一有效记录上涨，${data.summary.high_risk_count ?? 0} 项涨价概率达到预警线。`,
    );
    const primary = el("briefPrimaryAction");
    if (primary) {
      primary.disabled = !first;
      primary.textContent = first
        ? `查看${shortName(first)}的风险依据`
        : "暂无可查看的原料";
    }
    const risers = data.latest
      .filter((item) => finite(item.change_1d) && Number(item.change_1d) > 0)
      .sort((a, b) => Number(b.change_1d) - Number(a.change_1d))
      .slice(0, 3);
    const fallers = data.latest
      .filter((item) => finite(item.change_1d) && Number(item.change_1d) < 0)
      .sort((a, b) => Number(a.change_1d) - Number(b.change_1d))
      .slice(0, 3);
    const groups = [
      {
        title: "全局优先关注",
        rows: priorityRows().slice(0, 3),
        value: (item) => `涨价概率 ${item.up_probability ?? "—"}%（模型估算）`,
        empty: "暂无可比较的原料",
      },
      {
        title: "今日上涨靠前",
        rows: risers,
        value: (item) => `较上一有效记录 ${plainPct(item.change_1d)}`,
        empty: "本次没有上涨记录",
      },
      {
        title: "今日回落靠前",
        rows: fallers,
        value: (item) => `较上一有效记录 ${plainPct(item.change_1d)}`,
        empty: "本次没有下跌记录",
      },
    ];
    const cards = el("briefCards");
    if (cards)
      cards.innerHTML = groups
        .map(
          (group) =>
            `<section class="brief-reading-block"><h3>${group.title}</h3>${group.rows.length ? `<ul>${group.rows.map((item) => `<li><button type="button" class="material-link" data-brief-material="${escapeHtml(item.material_id)}">${escapeHtml(item.material_name)}</button><span>${escapeHtml(group.value(item))}</span></li>`).join("")}</ul>` : `<p class="neutral">${group.empty}</p>`}</section>`,
        )
        .join("");
    const actions =
      data.brief &&
      Array.isArray(data.brief.actions) &&
      data.brief.actions.length
        ? data.brief.actions
        : ["维持日度监测，结合实际需求核对报价与交期。"];
    if (el("actions"))
      el("actions").innerHTML = actions
        .map((action) => {
          const match = priorityRows().find(
            (item) =>
              shortName(item).length >= 2 &&
              String(action).includes(shortName(item)),
          );
          return `<li><span>${escapeHtml(action)}</span>${match ? `<button type="button" class="action-evidence" data-brief-material="${escapeHtml(match.material_id)}">核对原料依据</button>` : ""}</li>`;
        })
        .join("");
    renderPriorities();
  }

  function renderPriorities() {
    const target = el("priorityList");
    if (!target) return;
    const labels =
      '<div class="brief-priority-labels" aria-hidden="true"><span>原料 / 口径</span><span>最新价格</span><span>30日变化</span><span>涨价概率</span><span></span></div>';
    target.innerHTML =
      labels +
      (priorityRows()
        .slice(0, 3)
        .map(
          (item) =>
            `<button type="button" class="brief-priority-item ${riskClass(item)}" data-brief-material="${escapeHtml(item.material_id)}" aria-label="查看${escapeHtml(item.material_name)}原料详情"><span class="brief-priority-head"><strong>${escapeHtml(item.material_name)}</strong><small>${escapeHtml(basisInfo(item).label)}</small></span><span class="brief-priority-meta"><strong>${num(item.price, 2)} ${escapeHtml(item.unit || "")}</strong><small>交易日 ${escapeHtml(item.date || "待确认")}</small></span><span class="brief-priority-change"><strong>${pct(item.change_30d)}</strong><small>30日变化</small></span><span class="brief-priority-risk"><strong>${escapeHtml(item.up_probability ?? "—")}%</strong><small>模型估算</small></span><span class="brief-priority-action">查看依据</span></button>`,
        )
        .join("") || '<p class="empty">暂无原料行情，请稍后重新载入。</p>');
  }

  function categoryRows() {
    if (state.category === "全部") return data.latest.slice();
    const bucket = (data.cost_buckets || []).find(
      (item) => item.name === state.category,
    );
    const ids = new Set(bucket ? bucket.materials : []);
    return data.latest.filter((item) => ids.has(item.material_id));
  }

  function filteredRows() {
    const query = state.search.trim().toLocaleLowerCase();
    const rows = categoryRows().filter((item) => {
      if (
        query &&
        ![
          item.material_name,
          item.category,
          item.source,
          item.material_id,
        ].some((value) =>
          String(value || "")
            .toLocaleLowerCase()
            .includes(query),
        )
      )
        return false;
      if (state.filter === "high" && item.risk_level !== "高") return false;
      if (
        state.filter === "rising" &&
        !(finite(item.change_1d) && Number(item.change_1d) > 0)
      )
        return false;
      if (state.filter === "real" && basisInfo(item).cls !== "real")
        return false;
      if (state.filter === "proxy" && basisInfo(item).cls !== "proxy")
        return false;
      if (state.filter === "news" && !(item.matched_news || []).length)
        return false;
      return true;
    });
    const value = (v) => (finite(v) ? Number(v) : -Infinity);
    return rows.sort((a, b) =>
      state.sort === "name"
        ? String(a.material_name || "").localeCompare(
            String(b.material_name || ""),
            "zh-CN",
          )
        : value(
            b[state.sort === "change30" ? "change_30d" : "up_probability"],
          ) -
            value(
              a[state.sort === "change30" ? "change_30d" : "up_probability"],
            ) ||
          String(a.material_name || "").localeCompare(
            String(b.material_name || ""),
            "zh-CN",
          ),
    );
  }

  function renderTable() {
    const target = el("visualTable");
    if (!target) return;
    const rows = filteredRows();
    const filterLabels = {
      high: "高风险",
      rising: "今日上涨",
      real: "真实行情",
      proxy: "上游代理指标",
      news: "有匹配新闻",
    };
    const scope = [
      state.category === "全部" ? "全部大类" : state.category,
      filterLabels[state.filter],
      state.search.trim() ? `搜索 ${state.search.trim().slice(0, 40)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    setText(
      "briefResultCount",
      `${scope} · 显示 ${rows.length}/${categoryRows().length} 项`,
    );
    target.innerHTML = `<div class="table-wrap"><table class="brief-table"><thead><tr><th scope="col">原料 / 交易日</th><th>最新价 / 指标值</th><th>1日</th><th>30日</th><th>90日</th><th>涨价概率<small>模型估算</small></th><th>继续查看</th></tr></thead><tbody>${rows.map((item) => `<tr><td><button type="button" class="material-link" data-brief-material="${escapeHtml(item.material_id)}" aria-label="查看${escapeHtml(item.material_name)}原料详情">${escapeHtml(item.material_name)}</button><small class="brief-row-meta">${escapeHtml(item.date || "待确认")} · ${escapeHtml(item.category || "")}</small></td><td><strong>${num(item.price, 2)} ${escapeHtml(item.unit || "")}</strong><br>${basisBadge(item)}</td><td>${pct(item.change_1d)}</td><td>${pct(item.change_30d)}</td><td>${pct(item.change_90d)}</td><td><span class="probability ${riskClass(item)}">${escapeHtml(item.up_probability ?? "—")}%</span></td><td class="brief-table-actions"><a href="${escapeHtml(trendHref(item.material_id, "chart"))}">价格趋势</a><a href="${escapeHtml(trendHref(item.material_id, "history"))}">历史明细</a></td></tr>`).join("") || '<tr><td colspan="7" class="empty">没有匹配的原料。<button type="button" class="quiet-button" data-brief-reset>清除条件，查看全部</button></td></tr>'}</tbody></table></div>`;
    document
      .querySelectorAll("[data-brief-filter]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(
            button.dataset.briefFilter !== "news" &&
              button.dataset.briefFilter === state.filter,
          ),
        ),
      );
  }

  function renderComponents() {
    const target = el("componentGrid");
    if (!target) return;
    target.innerHTML =
      (data.cost_buckets || [])
        .map((bucket) => {
          const items = (bucket.materials || [])
            .map((id) => byId.get(id))
            .filter(Boolean);
          const avg = items.length
            ? items.reduce(
                (sum, item) => sum + Number(item.up_probability || 0),
                0,
              ) / items.length
            : null;
          const top = items
            .slice()
            .sort(
              (a, b) =>
                Number(b.up_probability || 0) - Number(a.up_probability || 0),
            )[0];
          return `<details class="component-card ${state.category === bucket.name ? "is-active" : ""}" ${state.category === bucket.name ? "open" : ""}><summary class="component-head"><h3>${escapeHtml(bucket.name)}</h3><span>${escapeHtml(bucket.share ?? "—")}%<small>配置参考占比</small></span></summary><p>${escapeHtml(bucket.boss_focus || "维持日度跟踪。")}</p><div class="component-meta"><span>类内平均涨价模型值 ${avg === null ? "—" : Math.round(avg)}%</span>${top ? `<button type="button" class="material-link" data-brief-material="${escapeHtml(top.material_id)}">重点 ${escapeHtml(shortName(top))} · ${escapeHtml(top.up_probability ?? "—")}%</button>` : ""}</div><button type="button" class="component-filter" data-brief-category="${escapeHtml(bucket.name)}" aria-pressed="${state.category === bucket.name}">查看关联原料 ${items.length} 项</button></details>`;
        })
        .join("") || '<p class="empty">暂无产品大类配置。</p>';
  }

  function renderIndexChart() {
    const svg = el("indexChart");
    if (!svg) return;
    const sorted = (data.index_history || [])
      .filter((row) => row.date && finite(row.value))
      .map((row) => ({ date: row.date, value: Number(row.value) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const latest = sorted[sorted.length - 1];
    const cutoff = latest ? new Date(`${latest.date}T00:00:00Z`) : null;
    if (cutoff) cutoff.setUTCDate(cutoff.getUTCDate() - 90);
    const points = sorted.filter(
      (row) => !cutoff || new Date(`${row.date}T00:00:00Z`) >= cutoff,
    );
    const w = Math.max(300, svg.parentElement.clientWidth - 4 || 920);
    const h = 250;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute(
      "aria-label",
      `近90天综合成本趋势，${points.length}个有效历史点；历史综合指数与采购成本压力评分口径不同`,
    );
    if (points.length < 2) {
      svg.innerHTML = `<text x="${w / 2}" y="125" text-anchor="middle" fill="#9daec4" font-size="13">暂无足够趋势数据</text>`;
      return;
    }
    const pad = { l: 58, r: 25, t: 20, b: 36 };
    const values = points.map((point) => point.value);
    const min = Math.min(...values),
      max = Math.max(...values),
      span = max - min || 1;
    const yMin = min - span * 0.08,
      yMax = max + span * 0.08;
    const x = (i) => pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r);
    const y = (value) =>
      pad.t + ((yMax - value) / (yMax - yMin)) * (h - pad.t - pad.b);
    const path = points
      .map(
        (point, i) =>
          `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(point.value).toFixed(1)}`,
      )
      .join(" ");
    const fillPath = `${path} L ${x(points.length - 1)} ${h - pad.b} L ${pad.l} ${h - pad.b} Z`;
    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((tick) => {
        const yy = pad.t + tick * (h - pad.t - pad.b);
        const label = yMax - tick * (yMax - yMin);
        return `<line x1="${pad.l}" x2="${w - pad.r}" y1="${yy}" y2="${yy}" stroke="#26364b"/><text x="${pad.l - 10}" y="${yy + 4}" text-anchor="end" fill="#9daec4" font-size="11">${num(label, 1)}</text>`;
      })
      .join("");
    svg.innerHTML = `${grid}<path d="${fillPath}" fill="#70d9db" opacity="0.07"></path><path d="${path}" fill="none" stroke="#70d9db" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="${x(points.length - 1)}" cy="${y(latest.value)}" r="4" fill="#70d9db"></circle><text x="${pad.l}" y="${h - 12}" fill="#9daec4" font-size="11">${points[0].date.slice(5)}</text><text x="${w - pad.r}" y="${h - 12}" text-anchor="end" fill="#9daec4" font-size="11">${latest.date.slice(5)}</text>`;
  }

  function renderNews() {
    const target = el("newsList");
    if (!target) return;
    target.innerHTML =
      (data.news || [])
        .slice(0, 12)
        .map((item) => {
          const href = safeNewsLink(item.link);
          return `<article class="news-item">${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || "未提供标题")}</a>` : `<strong>${escapeHtml(item.title || "未提供标题")}</strong>`}<span>${escapeHtml(item.source || "来源待核实")}${item.published ? ` · ${escapeHtml(dateText(item.published))}` : ""}</span><small>产业新闻线索，需打开原文核实关联</small></article>`;
        })
        .join("") ||
      '<p class="empty">本次暂无新闻记录，不代表市场不存在扰动。</p>';
  }

  function scrollToSection(id) {
    const node = el(id);
    if (!node) return;
    node.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  }

  function resetFilters() {
    state.search = "";
    state.category = "全部";
    state.filter = "all";
    state.sort = "risk";
    syncFilters();
    renderTable();
    renderComponents();
  }

  function syncFilters() {
    const pairs = [
      ["briefSearch", state.search],
      ["briefCategory", state.category],
      ["briefRiskFilter", state.filter],
      ["briefSort", state.sort],
    ];
    pairs.forEach(([id, value]) => {
      if (el(id)) el(id).value = value;
    });
  }

  function openMaterialDetail(materialId, trigger) {
    const item = byId.get(materialId),
      dialog = el("briefDetailDialog"),
      body = el("briefDetailBody");
    if (!item || !dialog || !body) return;
    lastDetailTrigger = trigger || document.activeElement;
    setText("briefDetailTitle", item.material_name);
    const basis = basisInfo(item),
      coverage = coverageById.get(materialId);
    const buckets = (data.cost_buckets || []).filter((bucket) =>
      (bucket.materials || []).includes(materialId),
    );
    const news = Array.isArray(item.matched_news) ? item.matched_news : [];
    const metrics = [
      ["1日变化", item.change_1d],
      ["7日变化", item.change_7d],
      ["30日变化", item.change_30d],
      ["90日变化", item.change_90d],
    ];
    const evidence = [
      [30, item.change_30d],
      [7, item.change_7d],
    ]
      .filter(([, value]) => finite(value))
      .map(
        ([days, value]) =>
          `近${days}日${Number(value) > 0 ? "上涨" : Number(value) < 0 ? "回落" : "持平"}${Number(value) === 0 ? "" : `${Math.abs(Number(value)).toFixed(2)}%`}`,
      )
      .join("，");
    const actions =
      item.risk_level === "高"
        ? [
            "优先复核未锁价需求及报价有效期",
            "向供应商确认交期、锁价条件与替代料",
            "结合实际用量和到货计划，评估后续采购安排",
          ]
        : [
            "维持日度跟踪，核对近期报价有效期",
            "供应商如提出调价，核验原料变化与传导依据",
            "结合实际需求安排采购，不因单一指标直接下单",
          ];
    body.innerHTML = `<div class="detail-meta">${basisBadge(item)}<span>${escapeHtml(item.category || "")}</span><span>交易日 ${escapeHtml(item.date || "待确认")}</span></div><section class="detail-hero"><div><span>${basis.cls === "proxy" ? "最新代理指标" : "最新价格"}</span><strong>${num(item.price, 2)} ${escapeHtml(item.unit || "")}</strong></div><div><span>涨价概率 · 模型估算</span><strong class="${riskClass(item)}">${escapeHtml(item.up_probability ?? "—")}%</strong><small>${escapeHtml(item.risk_level || "观察")} · ${escapeHtml(item.trend || "持续观察")}</small></div></section><section class="detail-section"><h3>价格变化与关注依据</h3><div class="detail-metrics">${metrics.map(([label, value]) => `<div><span>${label}</span><strong>${pct(value)}</strong></div>`).join("")}</div><p class="detail-evidence">${escapeHtml(evidence ? `${evidence}。请结合不同周期方向核对报价。` : "暂无可比区间变化，请先核实历史覆盖。")}</p><p class="detail-muted">30日波动率 ${finite(item.volatility_30d) ? `${num(item.volatility_30d, 2)}%` : "暂无记录"}${finite(item.future_premium_pct) ? ` · 期现升贴水 ${plainPct(item.future_premium_pct)}` : ""}</p><p class="detail-muted">涨价概率是综合趋势、波动与新闻的模型提示，不等于实际涨价结果或未来涨幅。</p></section><section class="detail-section"><h3>采购跟进建议</h3><ol>${actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ol><p class="detail-caution">需结合实际规格、需求和供应商报价核验；此处不生成采购订单。</p></section><section class="detail-section"><h3>来源、口径与覆盖</h3><dl class="detail-facts"><div><dt>行情来源</dt><dd>${escapeHtml(basis.source)}</dd></div><div><dt>价格口径</dt><dd>${escapeHtml(basis.label)} · ${escapeHtml(basis.hint)}</dd></div><div><dt>历史覆盖</dt><dd>${coverage ? `${escapeHtml(coverage.first_date || "—")} 至 ${escapeHtml(coverage.last_date || "—")} · ${escapeHtml(coverage.count ?? "—")}条可验证记录` : "暂无历史覆盖说明"}</dd></div></dl>${basis.cls === "proxy" ? '<p class="detail-caution">代理指标只能提示上游传导方向，不能当作该材料或部件的直接成交报价。</p>' : ""}<p class="detail-muted">${escapeHtml(item.notes && item.notes !== "NaN" ? item.notes : "暂无额外口径备注。")}</p></section><section class="detail-section"><h3>关联产品大类</h3><div class="detail-buckets">${buckets.length ? buckets.map((bucket) => `<article><strong>${escapeHtml(bucket.name)}</strong><p>${escapeHtml(bucket.boss_focus || "维持日度跟踪。")}</p></article>`).join("") : '<p class="detail-muted">暂无已配置的产品关联。</p>'}</div></section><section class="detail-section"><h3>匹配新闻 <small>${news.length}条</small></h3>${
      news.length
        ? news
            .map((item) => {
              const href = safeNewsLink(item.link);
              return `<article class="detail-news">${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || "新闻线索")}</a>` : `<strong>${escapeHtml(item.title || "新闻线索")}</strong>`}<p>${escapeHtml(item.source || "来源待核实")}${item.published ? ` · ${escapeHtml(dateText(item.published))}` : ""}</p></article>`;
            })
            .join("")
        : '<p class="detail-muted">本次没有匹配新闻，不代表没有市场扰动。</p>'
    }<p class="detail-muted">新闻按关键词匹配，需打开原文核实与该原料的关联。</p></section>`;
    if (el("briefDetailTrend"))
      el("briefDetailTrend").href = trendHref(materialId, "chart");
    if (el("briefDetailHistory"))
      el("briefDetailHistory").href = trendHref(materialId, "history");
    if (!dialog.open) dialog.showModal();
    body.scrollTop = 0;
    if (el("briefDetailClose"))
      el("briefDetailClose").focus({ preventScroll: true });
  }

  function showToast(message) {
    const toast = el("briefToast");
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 4200);
  }

  function publicSummaryText() {
    const coverage = tradeDateCoverageSummary();
    const top = priorityRows()
      .filter((item) => item.provider !== "manual")
      .slice(0, 3);
    const actions =
      data.brief && Array.isArray(data.brief.actions)
        ? data.brief.actions.filter(
            (action) =>
              typeof action === "string" &&
              !/(?:file:\/\/|[a-z]:[\\/]|\.private[\\/]|data[\\/]internal|runtime[\\/]internal)/i.test(
                action,
              ),
          )
        : [];
    return [
      "迈瑟伦原材料市场简报",
      `生成时间：${dateText(data.generated_at)}（北京时间）`,
      `最新交易日：${latestTradingDateLabel()}`,
      coverage
        ? `最新日覆盖：${coverage.latestTradeDateCount}/${coverage.totalCount}${coverage.laggingCount ? `；${coverage.laggingCount}项日期较早` : ""}`
        : "暂无日期覆盖说明",
      `采购成本压力评分：${finite(data.summary.pressure_index) ? Math.round(Number(data.summary.pressure_index)) : "暂无评分"}，${finite(data.summary.pressure_index) ? scoreText(Number(data.summary.pressure_index)) : "等待评估"}`,
      "重点原料：",
      ...top.map(
        (item) =>
          `${item.material_name}：${num(item.price, 2)} ${item.unit || ""}；30日${plainPct(item.change_30d)}；涨价概率${item.up_probability ?? "—"}%（模型估算）；${basisInfo(item).label}；交易日${item.date || "待确认"}`,
      ),
      "采购跟进：",
      ...actions.map((action, index) => `${index + 1}. ${String(action)}`),
      "说明：公开行情与代理指标用于跟踪，不替代实际规格、需求及供应商报价核验。",
    ].join("\n");
  }

  async function copySummary() {
    const button = el("copyBrief");
    if (button) button.disabled = true;
    try {
      const text = publicSummaryText();
      if (navigator.clipboard && window.isSecureContext)
        await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement("textarea");
        field.value = text;
        field.readOnly = true;
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand("copy");
        field.remove();
        if (!copied) throw new Error("clipboard unavailable");
      }
      showToast("已复制公开摘要，可粘贴到你的会议或工作记录。");
    } catch (_) {
      showToast("未能复制，请选中简报内容后使用浏览器复制。");
    } finally {
      if (button) {
        button.disabled = false;
        button.focus({ preventScroll: true });
      }
    }
  }

  function initInteractions() {
    document.querySelectorAll('a[href="#marketReading"]').forEach((link) =>
      link.addEventListener("click", () => {
        if (el("marketReading")) el("marketReading").open = true;
      }),
    );
    const category = el("briefCategory");
    if (category)
      category.innerHTML = [
        '<option value="全部">全部大类</option>',
        ...(data.cost_buckets || []).map(
          (bucket) =>
            `<option value="${escapeHtml(bucket.name)}">${escapeHtml(bucket.name)}</option>`,
        ),
      ].join("");
    const controls = [
      ["briefSearch", "input", "search"],
      ["briefCategory", "change", "category"],
      ["briefRiskFilter", "change", "filter"],
      ["briefSort", "change", "sort"],
    ];
    controls.forEach(([id, eventName, key]) => {
      const control = el(id);
      if (control)
        control.addEventListener(eventName, (event) => {
          state[key] = event.target.value;
          renderTable();
          if (key === "category") renderComponents();
        });
    });
    if (el("briefReset"))
      el("briefReset").addEventListener("click", resetFilters);
    if (el("briefPrimaryAction"))
      el("briefPrimaryAction").addEventListener("click", (event) => {
        const top = priorityRows()[0];
        if (top) openMaterialDetail(top.material_id, event.currentTarget);
      });
    if (el("copyBrief")) el("copyBrief").addEventListener("click", copySummary);
    if (el("printBrief"))
      el("printBrief").addEventListener("click", () => window.print());
    if (el("reloadButton"))
      el("reloadButton").addEventListener("click", hardReload);
    document.querySelectorAll("[data-trend-nav]").forEach((link) => {
      const section = [
        "overview",
        "chartSection",
        "riskSection",
        "newsSection",
      ].includes(link.dataset.trendNav)
        ? link.dataset.trendNav
        : "overview";
      link.href = `${trendBase()}#${section}`;
    });
    document.querySelectorAll("[data-trend-link]").forEach((link) => {
      link.href =
        link.dataset.trendLink === "overview"
          ? `${trendBase()}#overview`
          : trendHref("", link.dataset.trendLink);
    });
    document.addEventListener("click", (event) => {
      const item = event.target.closest("[data-brief-material]");
      if (item) {
        openMaterialDetail(item.dataset.briefMaterial, item);
        return;
      }
      if (event.target.closest("[data-brief-reset]")) {
        resetFilters();
        return;
      }
      const bucket = event.target.closest("[data-brief-category]");
      if (bucket) {
        state.category = bucket.dataset.briefCategory;
        state.search = "";
        state.filter = "all";
        syncFilters();
        renderTable();
        renderComponents();
        scrollToSection("materialSection");
        return;
      }
      const quick = event.target.closest("[data-brief-filter]");
      if (quick) {
        const filter = quick.dataset.briefFilter;
        if (filter === "news") {
          scrollToSection("briefNewsSection");
          return;
        }
        state.category = "全部";
        state.search = "";
        state.filter = filter;
        syncFilters();
        renderTable();
        renderComponents();
        scrollToSection("materialSection");
      }
    });
    const dialog = el("briefDetailDialog");
    if (dialog) {
      if (el("briefDetailClose"))
        el("briefDetailClose").addEventListener("click", () => dialog.close());
      dialog.addEventListener("close", () => {
        if (lastDetailTrigger && document.contains(lastDetailTrigger))
          lastDetailTrigger.focus({ preventScroll: true });
      });
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) {
          const rect = dialog.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            dialog.close();
        }
      });
    }
    syncFilters();
    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(renderIndexChart, 120);
    });
  }

  renderHeader();
  renderRefreshWarnings();
  renderRefreshStatusStrip();
  renderBrief();
  initInteractions();
  renderComponents();
  renderTable();
  renderIndexChart();
  renderNews();
  startLiveRefreshWatch();
})();
