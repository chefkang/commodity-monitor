(function () {
  const data = window.COMMODITY_MONITOR_DATA || {
    summary: {},
    latest: [],
    history: [],
    history_coverage: [],
    index_history: [],
    news: [],
    cost_buckets: [],
    manual_watch_items: [],
  };

  const defaultHistoryStart = (data.summary && data.summary.history_start_date) || "2024-01-01";

  const state = {
    category: "全部",
    selectedMaterial: "index",
    rangeDays: 90,
    historyStart: defaultHistoryStart,
    historyEnd: "",
  };

  const el = (id) => document.getElementById(id);
  const latestById = new Map(data.latest.map((item) => [item.material_id, item]));
  const coverageById = new Map((data.history_coverage || []).map((item) => [item.material_id, item]));
  const costBucketByName = new Map((data.cost_buckets || []).map((bucket) => [bucket.name, bucket]));
  const materialSortOrder = new Map();
  const runtimeMeta = window.COMMODITY_MONITOR_RUNTIME || {};
  const dataSourceLabel = String(runtimeMeta.data_source_label || "").trim();
  const dataSourceReason = String(runtimeMeta.data_source_reason || "").trim();
  const publicDataCheckEnabled = Boolean(runtimeMeta.check_public_data);
  const publicDataUrl = String(runtimeMeta.public_data_url || "https://chefkang.github.io/commodity-monitor/data.js");
  const publicLagToleranceMs = Number(runtimeMeta.public_lag_tolerance_ms || 3 * 60 * 1000);
  (data.cost_buckets || []).forEach((bucket, bucketIndex) => {
    (bucket.materials || []).forEach((materialId, materialIndex) => {
      if (!materialSortOrder.has(materialId)) {
        materialSortOrder.set(materialId, { bucketIndex, materialIndex, bucketName: bucket.name });
      }
    });
  });
  const internalQuotes = window.MTN_INTERNAL_SUPPLIER_QUOTES || { items: [] };
  const internalQuoteByWatchId = new Map((internalQuotes.items || []).map((item) => [item.watch_id || item.id, item]));
  const NOTICE_REFRESH_INTERVAL_MS = 60 * 1000;
  const BACKGROUND_DATA_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  let backgroundDataCheckInFlight = false;

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
    return data.summary.refresh_warnings.filter((warning) => String(warning || "").trim());
  }

  function formatDateTime(value) {
    if (!value) return "等待数据";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function parseGeneratedAtMs(payload) {
    const value = payload && payload.generated_at ? Date.parse(payload.generated_at) : Number.NaN;
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
      return baseGeneratedAt === null || candidateGeneratedAt >= baseGeneratedAt;
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
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, hour - 8, 0, 0));
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
    if (Array.isArray(data.trade_date_distribution) && data.trade_date_distribution.length) {
      return data.trade_date_distribution
        .map((entry) => ({
          date: String(entry && entry.date ? entry.date : "").trim(),
          count: Number(entry && entry.count ? entry.count : 0),
        }))
        .filter((entry) => entry.date && Number.isFinite(entry.count) && entry.count > 0)
        .sort((left, right) => right.count - left.count || right.date.localeCompare(left.date));
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
      .sort((left, right) => right.count - left.count || right.date.localeCompare(left.date));
  }

  function tradeDateCoverageSummary() {
    const distribution = tradeDateDistribution();
    if (!distribution.length) {
      return null;
    }
    const latestTradeDate = latestTradingDateValue();
    const latestEntry = distribution.find((entry) => entry.date === latestTradeDate) || null;
    const totalCount = distribution.reduce((sum, entry) => sum + entry.count, 0);
    const dominantEntry = distribution[0] || null;
    return {
      distribution,
      totalCount,
      latestTradeDate,
      latestTradeDateCount: latestEntry ? latestEntry.count : 0,
      dominantTradeDate: dominantEntry ? dominantEntry.date : "",
      dominantTradeDateCount: dominantEntry ? dominantEntry.count : 0,
      mixedTradeDates: distribution.length > 1,
      laggingCount: Math.max(totalCount - (latestEntry ? latestEntry.count : 0), 0),
    };
  }

  function tradeDateCoverageNote() {
    const coverage = tradeDateCoverageSummary();
    if (!coverage || !coverage.mixedTradeDates || !coverage.latestTradeDate || !coverage.laggingCount) {
      return "";
    }
    if (coverage.dominantTradeDate && coverage.dominantTradeDate !== coverage.latestTradeDate) {
      return `当前 ${coverage.totalCount} 个跟踪品类里，只有 ${coverage.latestTradeDateCount} 个已经切到 ${coverage.latestTradeDate}，仍有 ${coverage.laggingCount} 个停留在 ${coverage.dominantTradeDate}；这说明今天脚本已经执行，但多数上游价格源尚未全面换日。`;
    }
    return `当前 ${coverage.totalCount} 个跟踪品类里，最新交易日 ${coverage.latestTradeDate} 仅覆盖了 ${coverage.latestTradeDateCount} 个，其余 ${coverage.laggingCount} 个仍停留在更早交易日；这说明今天脚本已经执行，但不同上游价格源的换日节奏并不一致。`;
  }

  function mixedCoverageStateLabel(coverage) {
    if (!coverage || !coverage.mixedTradeDates || !coverage.laggingCount) {
      return "";
    }
    if (coverage.dominantTradeDate && coverage.dominantTradeDate !== coverage.latestTradeDate) {
      return "部分更新，主行情仍是上一交易日";
    }
    return "今天已刷新，但行情日期混合";
  }

  function coverageHeaderSuffix(coverage) {
    if (!coverage || !coverage.mixedTradeDates || !coverage.latestTradeDate || !coverage.laggingCount) {
      return "";
    }
    if (coverage.dominantTradeDate && coverage.dominantTradeDate !== coverage.latestTradeDate) {
      return ` · ${coverage.latestTradeDateCount}/${coverage.totalCount} 品类到 ${coverage.latestTradeDate}，${coverage.laggingCount} 项仍为 ${coverage.dominantTradeDate}`;
    }
    return ` · ${coverage.latestTradeDateCount}/${coverage.totalCount} 品类到 ${coverage.latestTradeDate}，${coverage.laggingCount} 项日期较早`;
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
    return Math.max(0, Math.ceil((targetTime.getTime() - Date.now()) / (60 * 1000)));
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
    return minutes ? `约 ${hours} 小时 ${minutes} 分钟后` : `约 ${hours} 小时后`;
  }

  function refreshStateDetailText(notice, nextRefresh, tradingDate) {
    const coverageNote = tradeDateCoverageNote();
    if (notice && notice.level === "info") {
      if (notice.mode === "early-refreshed") {
        return [`现在是北京时间 ${beijingClockLabel(new Date())}，虽然还没到 10:00 首轮窗口，但今天的首轮数据已经提前落地，最新交易日 ${tradingDate} 已到位。`, coverageNote]
          .filter(Boolean)
          .join(" ");
      }
      return [`现在是北京时间 ${beijingClockLabel(new Date())}，今天首轮刷新会在 ${nextRefresh.label} 左右开始；10:20 前仍显示最新交易日 ${tradingDate} 属于正常等待，不是故障。`, coverageNote]
        .filter(Boolean)
        .join(" ");
    }
    if (notice && notice.lines && notice.lines.length) {
      const tail = notice.lines.length > 1 ? notice.lines[notice.lines.length - 1] : "";
      return [notice.lines[0], tail, coverageNote].filter(Boolean).join(" ");
    }
    if (coverageNote) {
      return `当前页面已加载 ${formatDateTime(data.generated_at)} 的最新结果。${coverageNote}`;
    }
    return `当前页面已加载 ${formatDateTime(data.generated_at)} 的最新结果。`;
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
    return coverageNote || mismatchNote || "价格明细里的日期代表交易日，不等于页面刷新时间。";
  }

  function refreshNextSlotDetailText(nextRefresh) {
    const countdown = countdownLabel(nextRefresh.time);
    const cutoff = nextRefresh.slot === "morning" ? "10:20" : "15:20";
    return `${countdown ? `${countdown}进入下一轮计划刷新窗口；` : ""}过了 ${cutoff} 仍不变化，再按异常处理。`;
  }

  function applyRefreshCardTone(notice, coverage) {
    const stateCard = el("refreshStateLabel") ? el("refreshStateLabel").closest(".refresh-status-card") : null;
    const nextSlotCard = el("refreshNextSlot") ? el("refreshNextSlot").closest(".refresh-status-card") : null;
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
    if (notice && notice.level === "info") {
      if (notice.mode === "early-refreshed") {
        document.title = "今日首轮已提前刷新 | 迈瑟伦原材料价格监测";
        return;
      }
      document.title = `系统正常，10:20 前属正常等待 | 迈瑟伦原材料价格监测`;
      return;
    }
    if (notice && notice.level === "warning") {
      document.title = `${notice.title} | 迈瑟伦原材料价格监测`;
      return;
    }
    if (coverage && coverage.mixedTradeDates && coverage.laggingCount > 0) {
      document.title = `${mixedCoverageStateLabel(coverage)} | 迈瑟伦原材料价格监测`;
      return;
    }
    document.title = "迈瑟伦原材料价格监测";
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
      if (latestTradeDate && latestTradeDate === todayTradeDate && generatedAt >= yesterdayAfternoon) {
        return {
          level: "info",
          mode: "early-refreshed",
          headerLabel: "今日首轮已提前刷新",
          title: "今天首轮数据已经提前更新",
          lines: [
            `现在是北京时间 ${beijingClockLabel(now)}，虽然还没到 10:00 首轮刷新窗口，但今天的数据已经在 ${formatDateTime(data.generated_at)} 提前落地。`,
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
            `当前显示的是 ${formatDateTime(data.generated_at)} 刷新的上一监测时段结果，这不是故障。`,
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
            `现在还没到今天 10:00 左右的首轮刷新时间，但上一监测时段最新时间仍是 ${formatDateTime(data.generated_at)}。`,
            `当前价格明细对应的最新交易日是 ${latestTradingDateLabel()}。`,
            "这已经超出正常等待范围，建议稍后点击刷新，或运行“检查今日刷新状态”排查。",
          ],
        };
      }
    }

    if (currentMinutes >= 10 * 60 && currentMinutes < 15 * 60 && generatedAt < morningSlot) {
      return {
        level: "warning",
        headerLabel: "今日上午刷新待关注",
        title: "今天上午这轮刷新还没到位",
        lines: [
          `按计划应在北京时间 10:00 左右刷新，当前最新时间仍是 ${formatDateTime(data.generated_at)}。`,
          `当前价格明细对应的最新交易日仍是 ${latestTradingDateLabel()}。`,
          "如果 10:20 以后仍未变化，建议点击刷新，或运行“检查今日刷新状态”自动补查。",
        ],
      };
    }

    if (currentMinutes >= 15 * 60 && generatedAt < afternoonSlot) {
      return {
        level: "warning",
        headerLabel: "今日下午刷新待关注",
        title: "今天下午这轮刷新还没到位",
        lines: [
          `按计划应在北京时间 15:00 左右刷新，当前最新时间仍是 ${formatDateTime(data.generated_at)}。`,
          `当前价格明细对应的最新交易日仍是 ${latestTradingDateLabel()}。`,
          "如果 15:20 以后仍未变化，建议点击刷新，或运行“检查今日刷新状态”自动补查。",
        ],
      };
    }

    return null;
  }

  function formatNumber(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
    return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  }

  function pct(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return '<span class="neutral">-</span>';
    }
    const number = Number(value);
    const cls = number > 0 ? "positive" : number < 0 ? "negative" : "neutral";
    const sign = number > 0 ? "+" : "";
    return `<span class="${cls}">${sign}${number.toFixed(2)}%</span>`;
  }

  function plainPct(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
    const number = Number(value);
    const sign = number > 0 ? "+" : "";
    return `${sign}${number.toFixed(2)}%`;
  }

  function rangeLabel() {
    return state.rangeDays === "all" ? "2024起" : `${state.rangeDays}天`;
  }

  function priceLine(item) {
    if (!item) return "-";
    return `${formatNumber(item.price)} ${item.unit || ""}`;
  }

  function basisInfo(item) {
    const provider = item && item.provider;
    if (provider === "derived_from") {
      return {
        cls: "proxy",
        label: "上游代理指标",
        hint: "非该材料直接报价",
        source: item.source || "上游真实行情",
      };
    }
    if (provider === "manual") {
      return {
        cls: "manual",
        label: "供应商报价",
        hint: "人工补录",
        source: item.source || "供应商报价",
      };
    }
    return {
      cls: "real",
      label: "真实行情",
      hint: "公开市场价格",
      source: item.source || "公开行情",
    };
  }

  function basisBadge(item) {
    const basis = basisInfo(item);
    return `<span class="basis-badge ${basis.cls}">${basis.label}</span>`;
  }

  function sourceCell(item) {
    const basis = basisInfo(item);
    return `
      <div class="source-cell">
        ${basisBadge(item)}
        <span>${escapeHtml(basis.source)}</span>
        <small>${escapeHtml(basis.hint)}</small>
      </div>
    `;
  }

  function sortMaterialsByCategory(rows) {
    const activeBucket = state.category !== "全部" ? costBucketByName.get(state.category) : null;
    const activeOrder = new Map((activeBucket ? activeBucket.materials : []).map((materialId, index) => [materialId, index]));
    return rows.slice().sort((a, b) => {
      if (activeBucket) {
        const left = activeOrder.has(a.material_id) ? activeOrder.get(a.material_id) : 9999;
        const right = activeOrder.has(b.material_id) ? activeOrder.get(b.material_id) : 9999;
        if (left !== right) return left - right;
      }
      const leftOrder = materialSortOrder.get(a.material_id) || { bucketIndex: 9999, materialIndex: 9999 };
      const rightOrder = materialSortOrder.get(b.material_id) || { bucketIndex: 9999, materialIndex: 9999 };
      if (leftOrder.bucketIndex !== rightOrder.bucketIndex) return leftOrder.bucketIndex - rightOrder.bucketIndex;
      if (leftOrder.materialIndex !== rightOrder.materialIndex) return leftOrder.materialIndex - rightOrder.materialIndex;
      return (a.material_name || "").localeCompare(b.material_name || "", "zh-CN");
    });
  }

  function shortName(item) {
    return (item.material_name || "")
      .replace(/（.*?）/g, "")
      .replace(/\(.*?\)/g, "")
      .trim();
  }

  function riskClass(item) {
    if (item.risk_level === "高") return "high";
    if (item.risk_level === "中偏高") return "medium";
    if (item.risk_level === "观察") return "watch";
    return "low";
  }

  function pressureLabel(value) {
    if (value >= 65) return "偏高，建议锁价复核";
    if (value >= 55) return "中偏高，关注补库窗口";
    if (value >= 45) return "观察，维持日度跟踪";
    return "偏低，采购压力可控";
  }

  function reportPageHref() {
    const path = window.location.pathname.toLowerCase();
    if (path.endsWith("/trend.html")) return "./index.html";
    return "./report.html";
  }

  function hardReload() {
    const url = new URL(window.location.href);
    url.searchParams.set("ts", Date.now().toString());
    window.location.replace(url.toString());
  }

  function renderUpdatedAtLabel() {
    const notice = freshnessNotice();
    const nextRefresh = nextPlannedRefresh();
    const updatedLabel = formatDateTime(data.generated_at);
    const tradingDate = latestTradingDateLabel();
    const coverage = tradeDateCoverageSummary();
    const coverageSuffix = coverageHeaderSuffix(coverage);
    renderPageTitle(notice, nextRefresh, coverage);
    if (notice && notice.headerLabel) {
      const sourcePrefix = dataSourceLabel ? ` · ${dataSourceLabel}` : "";
      if (notice.level === "info") {
        if (notice.mode === "early-refreshed") {
          el("updatedAt").textContent = `${notice.headerLabel}${sourcePrefix} · 现在 ${beijingClockLabel(new Date())}，今天数据已在 ${updatedLabel} 提前落地 · 最新交易日 ${tradingDate}${coverageSuffix}`;
          return;
        }
        const countdown = countdownLabel(nextRefresh.time);
        el("updatedAt").textContent = `${notice.headerLabel}${sourcePrefix} · 现在 ${beijingClockLabel(new Date())}，今天首刷约 ${nextRefresh.label}${countdown ? `（${countdown}）` : ""} · 10:20 前仍显示最新交易日 ${tradingDate} 属正常等待，不是故障 · 上一监测结果生成于 ${updatedLabel}${coverageSuffix}`;
        return;
      }
      el("updatedAt").textContent = `${notice.headerLabel}${sourcePrefix} · 上一监测结果 ${updatedLabel} · 最新交易日 ${tradingDate}${coverageSuffix}`;
      return;
    }
    el("updatedAt").textContent = dataSourceLabel
      ? `${dataSourceLabel}更新 ${updatedLabel} · 最新交易日 ${tradingDate}${coverageSuffix}`
      : `更新 ${updatedLabel} · 最新交易日 ${tradingDate}${coverageSuffix}`;
  }

  function initHeader() {
    renderUpdatedAtLabel();
    const pressure = data.summary.pressure_index;
    el("pressureIndex").textContent = pressure === undefined ? "--" : Math.round(pressure);
    el("pressureStatus").textContent = pressureLabel(Number(pressure || 0));
    el("trackedCount").textContent = data.summary.tracked_count ?? data.latest.length;
    el("highRiskCount").textContent = data.summary.high_risk_count ?? 0;
    el("risingCount").textContent = data.summary.rising_count ?? 0;
    el("newsRiskCount").textContent = data.summary.news_risk_count ?? 0;

    el("briefLink").href = reportPageHref();
    el("reloadButton").addEventListener("click", hardReload);
    renderDecisionStrip(Number(pressure || 0));
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
    banner.classList.toggle("info-mode", notice && notice.level === "info" && !warnings.length);
    banner.innerHTML = sections.join("");
  }

  function renderRefreshStatusStrip() {
    const notice = freshnessNotice();
    const nextRefresh = nextPlannedRefresh();
    const tradingDate = latestTradingDateLabel();
    const coverage = tradeDateCoverageSummary();
    const stateLabel = notice
      ? (notice.headerLabel || notice.title)
      : coverage && coverage.mixedTradeDates && coverage.laggingCount > 0
        ? mixedCoverageStateLabel(coverage)
        : "已覆盖当前时段";
    const stateDetail = refreshStateDetailText(notice, nextRefresh, tradingDate);
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
    setText("refreshGeneratedAt", formatDateTime(data.generated_at));
    setText("refreshGeneratedAtDetail", generatedDetail);
    setText("refreshTradingDate", tradingDate);
    setText("refreshTradingDateDetail", refreshTradingDateDetailText(notice, tradingDate));
    setText("refreshNextSlot", nextRefresh.label);
    setText("refreshNextSlotDetail", nextSlotDetail);
    applyRefreshCardTone(notice, coverage);
  }

  function refreshLiveStatus() {
    renderUpdatedAtLabel();
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

      loadDataScript(`${publicDataUrl}?ts=${Date.now()}`, function (candidatePayload) {
        if (shouldReloadForCandidate(candidatePayload)) {
          return;
        }
        finalize();
      }, finalize);
    };

    loadDataScript(`./data.js?ts=${Date.now()}`, function (candidatePayload) {
      if (shouldReloadForCandidate(candidatePayload)) {
        return;
      }
      checkPublicData();
    }, checkPublicData);
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

  function renderDecisionStrip(pressure) {
    const topRisk = data.latest.slice().sort((a, b) => (b.up_probability || 0) - (a.up_probability || 0));
    const risers = data.latest
      .filter((item) => item.change_1d !== null && item.change_1d !== undefined)
      .sort((a, b) => (b.change_1d || 0) - (a.change_1d || 0));
    const focus = topRisk.slice(0, 3).map((item) => `${shortName(item)} ${item.up_probability ?? "-"}%`).join("、");
    const risingFocus = risers.slice(0, 3).map((item) => `${shortName(item)} ${plainPct(item.change_1d)}`).join("、");
    const highRiskCount = Number(data.summary.high_risk_count || 0);
    const newsRiskCount = Number(data.summary.news_risk_count || 0);
    const risingCount = Number(data.summary.rising_count || 0);
    const trackedCount = Number(data.summary.tracked_count || data.latest.length || 0);

    let title = "成本压力处于观察区";
    let body = "暂不需要被单一价格牵着走，先按产品大类看传导链条，重点盯短线上行品种和供应链新闻。";
    let actionTitle = "滚动补库";
    if (pressure >= 65) {
      title = "成本压力偏高";
      body = "高风险品种已经进入预警区，建议当天复核主力供应商报价、锁价条款和安全库存。";
      actionTitle = "锁价复核";
    } else if (pressure >= 55) {
      title = "成本压力中偏高";
      body = "价格压力开始抬头，优先复核电池包、PCBA、线束夹等高占比物料的报价有效期。";
      actionTitle = "补库评估";
    } else if (risingCount > trackedCount / 2) {
      title = "短线上涨品种较多";
      body = "整体指数仍可控，但今日上涨覆盖面偏广，建议关注是否从上游原料传导到供应商报价。";
      actionTitle = "询价确认";
    } else if (newsRiskCount > 0) {
      title = "新闻扰动需跟踪";
      body = "价格端暂未明显失控，但产业新闻已有扰动信号，适合提前问价而不是临时追单。";
      actionTitle = "供应链复核";
    }

    const firstAction = data.brief && data.brief.actions && data.brief.actions[0] ? data.brief.actions[0] : "维持日度监控，重点观察短线上行品种。";
    const setText = (id, value) => {
      const node = el(id);
      if (node) node.textContent = value;
    };
    const summaryPrefix = dataSourceReason ? `${dataSourceReason} ` : "";
    setText(
      "marketSummary",
      `${summaryPrefix}更新 ${formatDateTime(data.generated_at)}，最新交易日 ${latestTradingDateLabel()}，覆盖 ${trackedCount || data.latest.length} 个价格与指标；真实行情、上游代理指标和供应商补录会在明细中分开标注。`
    );
    setText("decisionTitle", title);
    setText("decisionBody", body);
    setText("decisionFocus", focus || "暂无重点");
    setText("decisionFocusMeta", risingFocus ? `今日涨幅靠前：${risingFocus}` : "暂无有效涨幅数据。");
    setText("decisionActionTitle", actionTitle);
    setText("decisionActionBody", firstAction);
  }

  function initCategories() {
    const categories = ["全部", ...(data.cost_buckets || []).map((bucket) => bucket.name)];
    el("categoryNav").innerHTML = categories
      .map((category) => `<button data-category="${category}" class="${category === state.category ? "active" : ""}">${category}</button>`)
      .join("");
    el("categoryNav").querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        state.category = button.dataset.category;
        initCategories();
        renderMaterials();
        renderRiskList();
      });
    });
  }

  function initMaterialSelect() {
    const options = [
      '<option value="index">成本压力指数</option>',
      ...sortMaterialsByCategory(data.latest).map((item) => `<option value="${item.material_id}">${item.material_name}</option>`),
    ];
    el("materialSelect").innerHTML = options.join("");
    el("materialSelect").addEventListener("change", (event) => {
      state.selectedMaterial = event.target.value;
      syncExportSelectionToCurrentMaterial();
      renderChart();
      renderHistoryTable();
    });
    el("rangeControl").querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        state.rangeDays = button.dataset.days === "all" ? "all" : Number(button.dataset.days);
        el("rangeControl").querySelectorAll("button").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        renderChart();
      });
    });
  }

  function initHistoryFilters() {
    const startInput = el("historyStartInput");
    const endInput = el("historyEndInput");
    const resetButton = el("historyResetButton");
    if (startInput) {
      startInput.value = state.historyStart;
      startInput.addEventListener("change", (event) => {
        state.historyStart = event.target.value || defaultHistoryStart;
        renderHistoryTable();
      });
    }
    if (endInput) {
      endInput.addEventListener("change", (event) => {
        state.historyEnd = event.target.value || "";
        renderHistoryTable();
      });
    }
    if (resetButton) {
      resetButton.addEventListener("click", () => {
        state.historyStart = defaultHistoryStart;
        state.historyEnd = "";
        if (startInput) startInput.value = state.historyStart;
        if (endInput) endInput.value = "";
        renderHistoryTable();
      });
    }
  }

  function initHistoryExpand() {
    const panel = el("historyPanel");
    const button = el("historyExpandButton");
    const closeButton = el("historyCloseExpandButton");
    if (!panel || !button || !closeButton) return;
    const setExpanded = (expanded) => {
      panel.classList.toggle("is-expanded", expanded);
      document.body.classList.toggle("history-expanded", expanded);
      button.setAttribute("aria-expanded", String(expanded));
      button.textContent = expanded ? "已全屏查看" : "全屏查看";
      button.disabled = expanded;
      if (expanded) panel.querySelector(".history-table-wrap")?.focus({ preventScroll: true });
    };
    button.addEventListener("click", () => setExpanded(!panel.classList.contains("is-expanded")));
    closeButton.addEventListener("click", () => setExpanded(false));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && panel.classList.contains("is-expanded")) setExpanded(false);
    });
  }

  function exportMaterialIds() {
    return Array.from(document.querySelectorAll('#historyExportMaterialList input[type="checkbox"]:checked')).map((input) => input.value);
  }

  function setExportMaterialIds(ids, customized = false) {
    const selected = new Set(ids);
    document.querySelectorAll('#historyExportMaterialList input[type="checkbox"]').forEach((input) => {
      input.checked = selected.has(input.value);
    });
    const list = el("historyExportMaterialList");
    if (list) list.dataset.customized = customized ? "true" : "false";
  }

  function initHistoryExport() {
    const list = el("historyExportMaterialList");
    const exportButton = el("historyExportButton");
    if (!list || !exportButton) return;

    const materials = sortMaterialsByCategory(data.latest);
    list.innerHTML = materials
      .map((item) => `<label><input type="checkbox" value="${escapeHtml(item.material_id)}" />${escapeHtml(item.material_name)}<span class="neutral">${escapeHtml(item.unit || "")}</span></label>`)
      .join("");
    const initialIds = state.selectedMaterial === "index" ? materials.map((item) => item.material_id) : [state.selectedMaterial];
    setExportMaterialIds(initialIds);

    list.addEventListener("change", () => {
      list.dataset.customized = "true";
    });
    el("historyExportSelectAllButton").addEventListener("click", () => setExportMaterialIds(materials.map((item) => item.material_id), true));
    el("historyExportClearButton").addEventListener("click", () => setExportMaterialIds([], true));
    exportButton.addEventListener("click", exportHistoryWorkbook);
  }

  function syncExportSelectionToCurrentMaterial() {
    const list = el("historyExportMaterialList");
    if (!list || list.dataset.customized === "true") return;
    const ids = state.selectedMaterial === "index" ? data.latest.map((item) => item.material_id) : [state.selectedMaterial];
    setExportMaterialIds(ids);
  }

  function xmlEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function columnName(index) {
    let result = "";
    let value = index + 1;
    while (value > 0) {
      const remainder = (value - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      value = Math.floor((value - 1) / 26);
    }
    return result;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function concatBytes(parts) {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function createZip(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const body = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
      const crc = crc32(body);
      const localHeader = new Uint8Array(30);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, dosTime, true);
      localView.setUint16(12, dosDate, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, body.length, true);
      localView.setUint32(22, body.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localView.setUint16(28, 0, true);
      localParts.push(localHeader, nameBytes, body);

      const centralHeader = new Uint8Array(46);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, dosTime, true);
      centralView.setUint16(14, dosDate, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, body.length, true);
      centralView.setUint32(24, body.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, localOffset, true);
      centralParts.push(centralHeader, nameBytes);
      localOffset += localHeader.length + nameBytes.length + body.length;
    }

    const central = concatBytes(centralParts);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, central.length, true);
    endView.setUint32(16, localOffset, true);
    return concatBytes([...localParts, central, end]);
  }

  function sheetXml(rows, styles = {}, options = {}) {
    const body = rows
      .map((row, rowIndex) => {
        const cells = row
          .map((cell, cellIndex) => {
            const ref = `${columnName(cellIndex)}${rowIndex + 1}`;
            const style = styles[`${rowIndex}:${cellIndex}`] !== undefined ? ` s="${styles[`${rowIndex}:${cellIndex}`]}"` : "";
            if (typeof cell === "number" && Number.isFinite(cell)) return `<c r="${ref}"${style}><v>${cell}</v></c>`;
            return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
          })
          .join("");
        return `<row r="${rowIndex + 1}">${cells}</row>`;
      })
      .join("");
    const headerRow = options.headerRow || 1;
    const columnCount = options.columnCount || Math.max(...rows.map((row) => row.length));
    const filter = options.filter === false ? "" : `<autoFilter ref="A${headerRow}:${columnName(columnCount - 1)}${rows.length}"/>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${body}</sheetData>${filter}</worksheet>`;
  }

  function uniqueSheetName(name, usedNames) {
    const base = String(name || "品种").replace(/[\\/?*\[\]:]/g, "_").slice(0, 31) || "品种";
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate)) {
      const postfix = `_${suffix}`;
      candidate = `${base.slice(0, 31 - postfix.length)}${postfix}`;
      suffix += 1;
    }
    usedNames.add(candidate);
    return candidate;
  }

  function buildXlsx(sheets) {
    const contentTypes = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
    const workbookSheets = sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
    const relationships = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
    const files = [
      { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${contentTypes}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
      { name: "_rels/.rels", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: "xl/styles.xml", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#\,##0.00"/><numFmt numFmtId="165" formatCode="0.00%"/></numFmts><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>' },
      ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: sheetXml(sheet.rows, sheet.styles, sheet.options) })),
    ];
    return createZip(files);
  }

  function exportHistoryWorkbook() {
    const materialIds = exportMaterialIds();
    if (!materialIds.length) {
      window.alert("请至少勾选一个需要导出的品种。");
      return;
    }
    const selected = new Set(materialIds);
    const rowsByMaterial = new Map();
    (data.history || [])
      .filter((row) => selected.has(row.material_id))
      .filter((row) => rowsWithinHistoryRange([row]).length)
      .sort((a, b) => a.material_id.localeCompare(b.material_id) || a.date.localeCompare(b.date))
      .forEach((row) => {
        if (!rowsByMaterial.has(row.material_id)) rowsByMaterial.set(row.material_id, []);
        rowsByMaterial.get(row.material_id).push(row);
      });
    const usedSheetNames = new Set();
    const materialSheets = [];
    rowsByMaterial.forEach((rows, materialId) => {
      const latest = latestById.get(materialId) || {};
      const materialName = rows[0].material_name || latest.material_name || materialId;
      const prices = rows.map((row) => Number(row.price)).filter(Number.isFinite);
      const firstPrice = Number(rows[0].price);
      const lastPrice = Number(rows.at(-1).price);
      const periodChange = Number.isFinite(firstPrice) && firstPrice !== 0 && Number.isFinite(lastPrice) ? lastPrice / firstPrice - 1 : "";
      const detailRows = [
        [`${materialName}历史价格`, "", "", "", "", "", "", "", "", ""],
        ["筛选区间", `${state.historyStart || defaultHistoryStart} 至 ${state.historyEnd || data.latest_trade_date || "当前"}`, "", "", "", "", "", "", "", ""],
        ["最高价", prices.length ? Math.max(...prices) : "", "最低价", prices.length ? Math.min(...prices) : "", "区间变动率", periodChange, "", "", ""],
        ["", "", "", "", "", "", "", "", "", ""],
        ["日期", "品种", "成本分类", "价格", "单位", "较上一记录", "价格口径", "数据来源", "来源日期", "备注"],
      ];
      rows.forEach((row, index) => {
        const previous = index ? Number(rows[index - 1].price) : NaN;
        const price = Number(row.price);
        const change = Number.isFinite(previous) && previous !== 0 && Number.isFinite(price) ? price / previous - 1 : "";
        const basis = basisInfo({ ...latest, ...row });
        detailRows.push([row.date, materialName, latest.category || "", price, row.unit || latest.unit || "", change, basis.label || "", row.source || basis.source || "", row.source_date || row.date || "", row.notes || ""]);
      });
      const styles = {};
      detailRows[4].forEach((_, index) => { styles[`4:${index}`] = 1; });
      styles["2:1"] = 2;
      styles["2:3"] = 2;
      styles["2:6"] = 3;
      detailRows.slice(5).forEach((_, rowIndex) => {
        styles[`${rowIndex + 5}:3`] = 2;
        styles[`${rowIndex + 5}:5`] = 3;
      });
      materialSheets.push({
        name: uniqueSheetName(materialName, usedSheetNames),
        rows: detailRows,
        styles,
        options: { headerRow: 5, columnCount: 10 },
      });
    });
    if (!materialSheets.length) {
      window.alert("当前日期范围内没有可导出的公开历史记录。");
      return;
    }
    const materialNames = materialIds.map((id) => (latestById.get(id) || {}).material_name || id).join("、");
    const start = state.historyStart || defaultHistoryStart;
    const end = state.historyEnd || data.latest_trade_date || new Date().toISOString().slice(0, 10);
    const noteRows = [
      ["项目", "说明"],
      ["导出时间", new Date().toLocaleString("zh-CN")],
      ["筛选日期", `${start} 至 ${end}`],
      ["导出品种", materialNames],
      ["导出子表数", materialSheets.length],
      ["明细记录数", Array.from(rowsByMaterial.values()).reduce((total, rows) => total + rows.length, 0)],
      ["子表结构", "每个品种单独一个工作表，顶部展示最高价、最低价和区间变动率。"],
      ["数据范围", `仅导出当前网页已加载的公开历史记录；当前可验证历史起点为 ${defaultHistoryStart}。`],
      ["价格口径", "明细中明确区分真实行情、上游价格代理指标与成本压力模型；代理指标不等于供应商报价。"],
      ["数据安全", "本导出不读取或输出内部库存、BOM、采购价、供应商报价及其他内部数据。"],
    ];
    const noteStyles = {};
    noteRows[0].forEach((_, index) => { noteStyles[`0:${index}`] = 1; });
    const sheets = [...materialSheets, { name: uniqueSheetName("导出说明", usedSheetNames), rows: noteRows, styles: noteStyles, options: { filter: false, columnCount: 2 } }];
    const bytes = buildXlsx(sheets);
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const compactDate = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    link.href = url;
    link.download = `原材料历史价格_${start}_${end}_${compactDate}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function filteredLatest() {
    let rows = data.latest.slice();
    if (state.category !== "全部") {
      const bucket = costBucketByName.get(state.category);
      const materialIds = new Set(bucket ? bucket.materials : []);
      rows = rows.filter((item) => materialIds.has(item.material_id));
    }
    return sortMaterialsByCategory(rows);
  }

  function renderMaterials() {
    const rows = filteredLatest();
    el("materialsTable").innerHTML = rows
      .map(
        (item) => `
          <tr>
            <td><strong>${item.material_name}</strong><br><span class="neutral">${item.date || ""}</span></td>
            <td><span class="tag">${item.category || "-"}</span></td>
            <td><strong>${formatNumber(item.price)} ${item.unit || ""}</strong><br>${basisBadge(item)}</td>
            <td>${pct(item.change_1d)}</td>
            <td>${pct(item.change_7d)}</td>
            <td>${pct(item.change_30d)}</td>
            <td>${pct(item.change_90d)}</td>
            <td><span class="probability ${riskClass(item)}">${item.up_probability ?? "-"}%</span></td>
            <td>${item.trend || "-"}</td>
            <td>${sourceCell(item)}</td>
          </tr>
        `
      )
      .join("");
  }

  function rowDate(row) {
    const date = new Date(`${row.date}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function rowsWithinHistoryRange(rows) {
    const start = state.historyStart ? new Date(`${state.historyStart}T00:00:00`) : null;
    const end = state.historyEnd ? new Date(`${state.historyEnd}T23:59:59`) : null;
    return rows.filter((row) => {
      const date = rowDate(row);
      return date && (!start || date >= start) && (!end || date <= end);
    });
  }

  function selectedHistoryRows() {
    if (state.selectedMaterial === "index") {
      return rowsWithinHistoryRange(
        (data.index_history || []).map((row) => ({
          date: row.date,
          price: row.value,
          unit: "指数",
          basis: { label: "综合指数", source: "成本压力模型" },
        }))
      );
    }
    const latest = latestById.get(state.selectedMaterial);
    return rowsWithinHistoryRange(
      (data.history || [])
        .filter((row) => row.material_id === state.selectedMaterial)
        .map((row) => ({
          ...row,
          basis: basisInfo({ ...(latest || {}), ...row }),
        }))
    );
  }

  function renderHistoryTable() {
    const latest = latestById.get(state.selectedMaterial);
    const rowsAsc = selectedHistoryRows().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const rows = rowsAsc
      .map((row, index) => {
        const prev = rowsAsc[index - 1];
        const current = Number(row.price);
        const previous = prev ? Number(prev.price) : NaN;
        const change = Number.isFinite(current) && Number.isFinite(previous) && previous !== 0 ? ((current - previous) / previous) * 100 : null;
        return { ...row, change };
      })
      .reverse();
    const coverage = coverageById.get(state.selectedMaterial);
    const coverageText = coverage
      ? (coverage.full_from_target ? `已覆盖 ${coverage.target_start_date} 起首个有效行情日` : `可验证起点 ${coverage.first_date || "-"}，早于该日暂未取到真实源`)
      : `目标起点 ${defaultHistoryStart}`;
    const title = state.selectedMaterial === "index" ? "成本压力指数累计历史" : `${latest ? latest.material_name : "原材料"}累计历史价格`;
    const meta = rows.length ? `${rows[rows.length - 1].date} 至 ${rows[0].date} · ${rows.length} 条 · ${coverageText}` : `暂无该区间历史记录 · ${coverageText}`;
    const setText = (id, value) => {
      const node = el(id);
      if (node) node.textContent = value;
    };
    setText("historyTitle", title);
    setText("historyMeta", meta);
    el("historyTable").innerHTML =
      rows
        .map((row) => {
          const basis = row.basis || basisInfo(latest || {});
          return `
            <tr>
              <td>${escapeHtml(row.date || "-")}</td>
              <td><strong>${formatNumber(row.price)} ${escapeHtml(row.unit || (latest && latest.unit) || "")}</strong></td>
              <td>${row.change === null || row.change === undefined ? '<span class="neutral">-</span>' : pct(row.change)}</td>
              <td><span class="basis-badge ${basis.cls || "real"}">${escapeHtml(basis.label || "真实行情")}</span><small>${escapeHtml([basis.source, row.source_date].filter(Boolean).join(" · "))}</small></td>
            </tr>
          `;
        })
        .join("") || '<tr><td colspan="4" class="empty">暂无该区间历史记录</td></tr>';
  }

  function renderRiskList() {
    const rows = filteredLatest()
      .slice()
      .sort((a, b) => (b.up_probability || 0) - (a.up_probability || 0))
      .slice(0, 7);
    el("riskList").innerHTML =
      rows
        .map((item) => {
          const news = item.matched_news && item.matched_news[0] ? item.matched_news[0] : null;
          const newsTitle = news ? news.title : "";
          const newsSource = news && news.source ? ` · ${news.source}` : "";
          return `
            <article class="risk-item ${riskClass(item)}">
              <h4>${item.material_name} · ${item.up_probability ?? "-"}%</h4>
              <p>${item.trend || "震荡"}，30日${item.change_30d ?? "-"}%，${basisInfo(item).cls === "proxy" ? "最新指标" : "最新价格"} ${formatNumber(item.price)} ${item.unit || ""} · ${basisInfo(item).label}</p>
              ${newsTitle ? `<p>新闻线索：${newsTitle}${newsSource}</p>` : ""}
            </article>
          `;
        })
        .join("") || '<div class="empty">暂无风险数据</div>';
  }

  function seriesForChart() {
    const rows = state.selectedMaterial === "index"
      ? (data.index_history || []).map((row) => ({ date: row.date, value: Number(row.value) }))
      : (data.history || [])
          .filter((row) => row.material_id === state.selectedMaterial)
          .map((row) => ({ date: row.date, value: Number(row.price) }));
    const sorted = rows
      .filter((row) => row.date && Number.isFinite(row.value))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (state.rangeDays === "all" || sorted.length === 0) {
      return sorted;
    }
    const maxDate = new Date(`${sorted[sorted.length - 1].date}T00:00:00`);
    const cutoff = new Date(maxDate);
    cutoff.setDate(cutoff.getDate() - Number(state.rangeDays));
    return sorted.filter((row) => new Date(`${row.date}T00:00:00`) >= cutoff);
  }

  function renderChart() {
    const svg = el("trendChart");
    const series = seriesForChart();
    const selected = latestById.get(state.selectedMaterial);
    el("chartTitle").textContent = selected ? `${selected.material_name}价格趋势` : "成本压力指数";
    renderChartSummary(selected, series);

    if (series.length < 2) {
      svg.innerHTML = '<text x="450" y="180" text-anchor="middle" fill="#67615a">暂无足够趋势数据</text>';
      return;
    }

    const width = 900;
    const height = 360;
    const padding = { top: 28, right: 34, bottom: 46, left: 68 };
    const values = series.map((point) => point.value).filter((value) => Number.isFinite(value));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const yMin = min - span * 0.08;
    const yMax = max + span * 0.08;
    const xStep = (width - padding.left - padding.right) / (series.length - 1);

    const x = (index) => padding.left + index * xStep;
    const y = (value) => padding.top + (yMax - value) / (yMax - yMin) * (height - padding.top - padding.bottom);
    const path = series.map((point, index) => `${index === 0 ? "M" : "L"} ${x(index).toFixed(2)} ${y(point.value).toFixed(2)}`).join(" ");
    const fillPath = `${path} L ${x(series.length - 1).toFixed(2)} ${height - padding.bottom} L ${padding.left} ${height - padding.bottom} Z`;
    const last = series[series.length - 1];
    const first = series[0];
    const lineColor = last.value >= first.value ? "#b42318" : "#147b3d";
    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((tick) => {
        const yy = padding.top + tick * (height - padding.top - padding.bottom);
        const value = yMax - tick * (yMax - yMin);
        return `
          <line x1="${padding.left}" x2="${width - padding.right}" y1="${yy}" y2="${yy}" stroke="#ded8d0" stroke-width="1" />
          <text x="${padding.left - 12}" y="${yy + 4}" text-anchor="end" fill="#67615a" font-size="12">${formatNumber(value)}</text>
        `;
      })
      .join("");

    const startLabel = series[0].date.slice(5);
    const endLabel = series[series.length - 1].date.slice(5);

    svg.innerHTML = `
      <rect x="0" y="0" width="${width}" height="${height}" fill="#f8f7f4"></rect>
      ${grid}
      <path d="${fillPath}" fill="${lineColor}" opacity="0.08"></path>
      <path d="${path}" fill="none" stroke="${lineColor}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"></path>
      <circle cx="${x(series.length - 1)}" cy="${y(last.value)}" r="5" fill="${lineColor}"></circle>
      <line x1="${padding.left}" x2="${width - padding.right}" y1="${height - padding.bottom}" y2="${height - padding.bottom}" stroke="#bfb7ad"></line>
      <text x="${padding.left}" y="${height - 16}" fill="#67615a" font-size="12">${startLabel}</text>
      <text x="${width - padding.right}" y="${height - 16}" fill="#67615a" font-size="12" text-anchor="end">${endLabel}</text>
      <text x="${width - padding.right}" y="${padding.top + 2}" fill="${lineColor}" font-size="13" text-anchor="end">${formatNumber(last.value)}</text>
    `;
  }

  function renderChartSummary(selected, series) {
    const summary = el("chartSummary");
    if (!summary) return;
    if (selected) {
      summary.innerHTML = `
        <article>
          <span>最新价格</span>
          <strong>${priceLine(selected)}</strong>
          <small>${selected.date || ""} · ${basisInfo(selected).label} · ${basisInfo(selected).source}</small>
        </article>
        <article>
          <span>1日变化</span>
          <strong>${plainPct(selected.change_1d)}</strong>
          <small>相对上一有效价格</small>
        </article>
        <article>
          <span>30日变化</span>
          <strong>${plainPct(selected.change_30d)}</strong>
          <small>${selected.trend || "持续观察"}</small>
        </article>
        <article>
          <span>涨价概率</span>
          <strong>${selected.up_probability ?? "-"}%</strong>
          <small>${selected.risk_level || "观察"}</small>
        </article>
      `;
      return;
    }

    const latest = series[series.length - 1];
    const first = series[0];
    const change = latest && first && first.value ? (latest.value / first.value - 1) * 100 : null;
    summary.innerHTML = `
      <article>
        <span>最新指数</span>
        <strong>${latest ? formatNumber(latest.value) : "-"}</strong>
        <small>${latest ? latest.date : "等待数据"}</small>
      </article>
      <article>
        <span>${rangeLabel()}变化</span>
        <strong>${plainPct(change)}</strong>
        <small>综合成本压力方向</small>
      </article>
      <article>
        <span>高风险品种</span>
        <strong>${data.summary.high_risk_count ?? 0}</strong>
        <small>达到预警线</small>
      </article>
      <article>
        <span>今日上涨</span>
        <strong>${data.summary.rising_count ?? 0}</strong>
        <small>相对上一有效价格</small>
      </article>
    `;
  }

  function renderBuckets() {
    el("bucketGrid").innerHTML = data.cost_buckets
      .map((bucket) => {
        const items = bucket.materials
          .map((materialId) => latestById.get(materialId))
          .filter(Boolean);
        const avgRisk = items.length
          ? items.reduce((sum, item) => sum + Number(item.up_probability || 0), 0) / items.length
          : 0;
        const top = items.slice().sort((a, b) => (b.up_probability || 0) - (a.up_probability || 0))[0];
        const chips = items
          .slice()
          .sort((a, b) => (b.up_probability || 0) - (a.up_probability || 0))
          .slice(0, 8)
          .map((item) => `<span class="chip">${item.material_name}</span>`)
          .join("");
        return `
          <article class="bucket">
            <div class="bucket-head">
              <h4>${bucket.name}</h4>
              <strong>${bucket.share ?? "-"}%</strong>
            </div>
            <p>${bucket.boss_focus || "维持日度跟踪。"}</p>
            <div class="bucket-pressure">
              <span>当前压力 ${Math.round(avgRisk)}%</span>
              <span>重点 ${top ? `${top.material_name} ${top.up_probability ?? "-"}%` : "-"}</span>
            </div>
            <div class="chips">${chips}</div>
          </article>
        `;
      })
      .join("");
  }

  function renderNews() {
    el("newsFeed").innerHTML =
      data.news
        .slice(0, 12)
        .map((item) => {
          const source = item.source || "新闻";
          const date = item.published ? formatDateTime(item.published) : "";
          return `
            <article class="news-item">
              <a href="${item.link}" target="_blank" rel="noreferrer">${item.title}</a>
              <span>${source}${date ? ` · ${date}` : ""}</span>
            </article>
          `;
        })
        .join("") || '<div class="empty">暂无新闻数据</div>';
  }

  function renderManualWatch() {
    el("manualWatch").innerHTML =
      data.manual_watch_items
        .map((item) => {
          const quote = internalQuoteByWatchId.get(item.id);
          const quoteRows = quote && quote.quotes
            ? quote.quotes
                .map(
                  (row) => `
                    <tr>
                      <td>${escapeHtml(row.spec)}</td>
                      <td>${formatNumber(row.ah)} Ah</td>
                      <td>${formatNumber(row.price_per_ah)} 元/Ah</td>
                      <td>${formatNumber(row.estimated_cell_cost)} 元/颗</td>
                    </tr>
                  `
                )
                .join("")
            : "";
          const quoteBlock = quote
            ? `
              <div class="quote-block">
                <div class="quote-meta">
                  <span>已补录</span>
                  <small>${escapeHtml(quote.updated_at || "")}${quote.source ? ` · ${escapeHtml(quote.source)}` : ""}</small>
                </div>
                <table class="quote-table">
                  <thead><tr><th>规格</th><th>容量</th><th>报价</th><th>估算单颗</th></tr></thead>
                  <tbody>${quoteRows}</tbody>
                </table>
                ${quote.note ? `<p class="quote-note">${escapeHtml(quote.note)}</p>` : ""}
              </div>
            `
            : "";
          return `
            <article class="watch-item">
              <h4>${escapeHtml(item.name)}</h4>
              <p>${escapeHtml(item.unit)}</p>
              <p>${escapeHtml(item.reason)}</p>
              ${quoteBlock}
            </article>
          `;
        })
        .join("") || '<div class="empty">暂无补录项</div>';
  }

  initHeader();
  renderRefreshWarnings();
  initCategories();
  initMaterialSelect();
  initHistoryFilters();
  initHistoryExpand();
  initHistoryExport();
  renderMaterials();
  renderRiskList();
  renderChart();
  renderHistoryTable();
  renderBuckets();
  renderNews();
  renderManualWatch();
  startLiveRefreshWatch();
})();
