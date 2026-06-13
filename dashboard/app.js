(function () {
  const data = window.COMMODITY_MONITOR_DATA || {
    summary: {},
    latest: [],
    history: [],
    index_history: [],
    news: [],
    cost_buckets: [],
    manual_watch_items: [],
  };

  const state = {
    category: "全部",
    selectedMaterial: "index",
    rangeDays: 90,
  };

  const el = (id) => document.getElementById(id);
  const latestById = new Map(data.latest.map((item) => [item.material_id, item]));
  const costBucketByName = new Map((data.cost_buckets || []).map((bucket) => [bucket.name, bucket]));
  const internalQuotes = window.MTN_INTERNAL_SUPPLIER_QUOTES || { items: [] };
  const internalQuoteByWatchId = new Map((internalQuotes.items || []).map((item) => [item.watch_id || item.id, item]));

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
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

  function initHeader() {
    el("updatedAt").textContent = `更新 ${formatDateTime(data.generated_at)}`;
    const pressure = data.summary.pressure_index;
    el("pressureIndex").textContent = pressure === undefined ? "--" : Math.round(pressure);
    el("pressureStatus").textContent = pressureLabel(Number(pressure || 0));
    el("trackedCount").textContent = data.summary.tracked_count ?? data.latest.length;
    el("highRiskCount").textContent = data.summary.high_risk_count ?? 0;
    el("risingCount").textContent = data.summary.rising_count ?? 0;
    el("newsRiskCount").textContent = data.summary.news_risk_count ?? 0;

    el("briefLink").href = reportPageHref();
    el("reloadButton").addEventListener("click", () => window.location.reload());
    renderDecisionStrip(Number(pressure || 0));
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
    setText("marketSummary", `更新 ${formatDateTime(data.generated_at)}，覆盖 ${trackedCount || data.latest.length} 个价格与指标；真实行情、上游代理指标和供应商补录会在明细中分开标注。`);
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
      ...data.latest
        .slice()
        .sort((a, b) => a.material_name.localeCompare(b.material_name, "zh-CN"))
        .map((item) => `<option value="${item.material_id}">${item.material_name}</option>`),
    ];
    el("materialSelect").innerHTML = options.join("");
    el("materialSelect").addEventListener("change", (event) => {
      state.selectedMaterial = event.target.value;
      renderChart();
    });
    el("rangeControl").querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        state.rangeDays = Number(button.dataset.days);
        el("rangeControl").querySelectorAll("button").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        renderChart();
      });
    });
  }

  function filteredLatest() {
    let rows = data.latest.slice();
    if (state.category !== "全部") {
      const bucket = costBucketByName.get(state.category);
      const materialIds = new Set(bucket ? bucket.materials : []);
      rows = rows.filter((item) => materialIds.has(item.material_id));
    }
    return rows;
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
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - state.rangeDays);

    if (state.selectedMaterial === "index") {
      return data.index_history
        .filter((row) => new Date(row.date) >= cutoff)
        .map((row) => ({ date: row.date, value: Number(row.value) }));
    }

    return data.history
      .filter((row) => row.material_id === state.selectedMaterial)
      .filter((row) => new Date(row.date) >= cutoff)
      .map((row) => ({ date: row.date, value: Number(row.price) }));
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
        <span>${state.rangeDays}天变化</span>
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
  initCategories();
  initMaterialSelect();
  renderMaterials();
  renderRiskList();
  renderChart();
  renderBuckets();
  renderNews();
  renderManualWatch();
})();
