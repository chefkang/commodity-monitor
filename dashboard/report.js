(function () {
  const data = window.COMMODITY_MONITOR_DATA || { latest: [], history: [], index_history: [], news: [], summary: {}, brief: {} };
  const byId = new Map(data.latest.map((item) => [item.material_id, item]));

  const coreOrder = [
    "copper",
    "tin",
    "lithium_carbonate",
    "aluminum",
    "abs",
    "epoxy_resin",
    "glass_proxy",
    "organic_silicon_dmc",
    "corrugated_paper",
    "paper_pulp",
    "pp",
    "pvc",
    "pc",
    "waste_paper",
  ];

  function el(id) {
    return document.getElementById(id);
  }

  function dateText(value) {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return value || "";
    return d.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function num(value, digits = 0) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
    return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits });
  }

  function pct(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '<span class="neutral">-</span>';
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
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return data.history
      .filter((row) => row.material_id === id)
      .filter((row) => new Date(row.date) >= cutoff)
      .map((row) => ({ date: row.date, value: Number(row.price) }))
      .filter((row) => Number.isFinite(row.value));
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
    const path = points.map((p, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
    const up = points[points.length - 1].value >= points[0].value;
    const color = up ? "#b42318" : "#147b3d";
    return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function renderHeader() {
    const score = data.summary.pressure_index;
    el("score").textContent = score === undefined ? "--" : Math.round(score);
    el("scoreText").textContent = scoreText(Number(score || 0));
    el("reportDate").textContent = `更新 ${dateText(data.generated_at)}，今日价格与趋势已汇总`;
    el("tracked").textContent = data.summary.tracked_count ?? data.latest.length;
    el("rising").textContent = data.summary.rising_count ?? 0;
    el("highRisk").textContent = data.summary.high_risk_count ?? 0;
    el("newsRisk").textContent = data.summary.news_risk_count ?? 0;
  }

  function renderBrief() {
    const sorted = data.latest.slice().sort((a, b) => (b.up_probability || 0) - (a.up_probability || 0));
    const watch = sorted.slice(0, 3);
    const risers = data.latest
      .filter((item) => item.change_1d !== null && item.change_1d !== undefined)
      .sort((a, b) => (b.change_1d || 0) - (a.change_1d || 0))
      .slice(0, 3);
    const fallers = data.latest
      .filter((item) => item.change_1d !== null && item.change_1d !== undefined)
      .sort((a, b) => (a.change_1d || 0) - (b.change_1d || 0))
      .slice(0, 3);

    el("briefCards").innerHTML = [
      {
        title: "重点盯盘",
        body: watch.map((item) => `${item.material_name}${item.up_probability}%`).join("、") || "暂无高风险品种",
      },
      {
        title: "涨幅靠前",
        body: risers.map((item) => `${item.material_name}${item.change_1d > 0 ? "+" : ""}${item.change_1d}%`).join("、"),
      },
      {
        title: "跌幅靠前",
        body: fallers.map((item) => `${item.material_name}${item.change_1d > 0 ? "+" : ""}${item.change_1d}%`).join("、"),
      },
    ]
      .map((card) => `<article class="brief-card"><strong>${card.title}</strong><p>${card.body}</p></article>`)
      .join("");

    const actions = data.brief && data.brief.actions && data.brief.actions.length ? data.brief.actions : ["维持日度监控，重点观察短线上行品种。"];
    el("actions").innerHTML = actions.map((action) => `<li>${action}</li>`).join("");
  }

  function renderTable() {
    const ordered = [
      ...coreOrder.map((id) => byId.get(id)).filter(Boolean),
      ...data.latest.filter((item) => !coreOrder.includes(item.material_id)),
    ];
    el("visualTable").innerHTML = `
      <div class="table-head">
        <span>原材料</span><span>最新价</span><span>90日趋势</span><span>1日</span><span>30日</span><span>90日</span><span>判断</span><span>概率</span>
      </div>
      ${ordered
        .map(
          (item) => `
          <article class="material-row">
            <div class="material-name"><strong>${item.material_name}</strong><span>${item.category || ""} · ${item.source || ""}</span></div>
            <div class="price">${num(item.price, 2)}<span class="source">${item.unit || ""}</span></div>
            <div class="spark">${sparkline(item.material_id)}</div>
            <div>${pct(item.change_1d)}</div>
            <div>${pct(item.change_30d)}</div>
            <div>${pct(item.change_90d)}</div>
            <div>${item.trend || "-"}</div>
            <div><span class="risk-pill ${riskClass(item)}">${item.up_probability ?? "-"}%</span></div>
          </article>
        `
        )
        .join("")}
    `;
  }

  function renderIndexChart() {
    const svg = el("indexChart");
    const points = data.index_history.slice(-90).map((row) => ({ date: row.date, value: Number(row.value) }));
    if (points.length < 2) {
      svg.innerHTML = '<text x="460" y="130" text-anchor="middle" fill="#6b6359">暂无足够趋势数据</text>';
      return;
    }
    const w = 920;
    const h = 260;
    const pad = { l: 62, r: 28, t: 22, b: 38 };
    const values = points.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const yMin = min - span * 0.08;
    const yMax = max + span * 0.08;
    const x = (i) => pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r);
    const y = (v) => pad.t + ((yMax - v) / (yMax - yMin)) * (h - pad.t - pad.b);
    const path = points.map((p, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
    const fillPath = `${path} L ${x(points.length - 1)} ${h - pad.b} L ${pad.l} ${h - pad.b} Z`;
    const color = points[points.length - 1].value >= points[0].value ? "#b42318" : "#147b3d";
    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((tick) => {
        const yy = pad.t + tick * (h - pad.t - pad.b);
        const label = yMax - tick * (yMax - yMin);
        return `<line x1="${pad.l}" x2="${w - pad.r}" y1="${yy}" y2="${yy}" stroke="#ded5c8"/><text x="${pad.l - 10}" y="${yy + 4}" text-anchor="end" fill="#6b6359" font-size="12">${num(label, 1)}</text>`;
      })
      .join("");
    svg.innerHTML = `
      ${grid}
      <path d="${fillPath}" fill="${color}" opacity="0.08"></path>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
      <circle cx="${x(points.length - 1)}" cy="${y(points[points.length - 1].value)}" r="5" fill="${color}"></circle>
      <text x="${pad.l}" y="${h - 14}" fill="#6b6359" font-size="12">${points[0].date.slice(5)}</text>
      <text x="${w - pad.r}" y="${h - 14}" fill="#6b6359" font-size="12" text-anchor="end">${points[points.length - 1].date.slice(5)}</text>
    `;
  }

  function renderNews() {
    el("newsList").innerHTML =
      data.news
        .slice(0, 8)
        .map((item) => `<article class="news-item"><a href="${item.link}" target="_blank" rel="noreferrer">${item.title}</a><span>${item.source || "News"}</span></article>`)
        .join("") || '<p class="neutral">暂无新闻风险。</p>';
  }

  renderHeader();
  renderBrief();
  renderTable();
  renderIndexChart();
  renderNews();
})();
