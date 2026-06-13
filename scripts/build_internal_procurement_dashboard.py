from __future__ import annotations

import csv
import json
from datetime import datetime
from html import escape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROCUREMENT_DIR = ROOT / "data" / "internal" / "procurement"
H3_STATUS = ROOT / "data" / "internal" / "h3_normalized" / "import_status.json"


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def read_optional_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    return read_csv(path)


def read_import_status() -> dict[str, str]:
    if not H3_STATUS.exists():
        return {
            "primary_system": "美途能进销存系统",
            "scanned_files": "0",
            "matched_files": "0",
            "status_text": "等待氚云导出文件",
        }
    data = json.loads(H3_STATUS.read_text(encoding="utf-8"))
    matched = int(data.get("matched_files") or 0)
    return {
        "primary_system": str(data.get("primary_system") or "美途能进销存系统"),
        "scanned_files": str(data.get("scanned_files") or 0),
        "matched_files": str(matched),
        "status_text": "已接入进销存导出" if matched else "等待氚云导出文件",
    }


def number(value: str | int | float | None) -> float:
    if value is None or value == "":
        return 0.0
    try:
        return float(str(value).replace(",", "").replace("¥", "").replace("￥", ""))
    except ValueError:
        return 0.0


def fmt(value: str | int | float | None, digits: int = 0) -> str:
    val = number(value)
    if digits:
        return f"{val:,.{digits}f}"
    return f"{val:,.0f}"


def action_class(action: str) -> str:
    if "立即" in action:
        return "urgent"
    if "分批" in action or "关注" in action or "确认" in action or "锁价" in action:
        return "watch"
    if "暂" in action or "观察" in action or "压价" in action:
        return "hold"
    return "quiet"


def build_forecast_section(forecast_rows: list[dict[str, str]]) -> str:
    if not forecast_rows:
        return """
        <section class="panel empty">
          <h2>采购备货测算</h2>
          <p>还没有生成 30/90/180/365 天测算，运行内部测算脚本后这里会自动出现。</p>
        </section>
        """

    grouped: dict[int, list[dict[str, str]]] = {}
    for row in forecast_rows:
        grouped.setdefault(int(number(row.get("horizon_days"))), []).append(row)

    cards = []
    for horizon in (30, 90, 180, 365):
        rows = grouped.get(horizon, [])
        budget = sum(number(row.get("estimated_budget")) for row in rows)
        buy_count = sum(1 for row in rows if number(row.get("recommended_buy_qty")) > 0)
        cards.append(
            f"""
            <div class="forecast-card">
              <span>{horizon}天</span>
              <strong>{buy_count}</strong>
              <small>建议采购物料 · 预算 ¥{budget:,.0f}</small>
            </div>
            """
        )

    top_rows = sorted(forecast_rows, key=lambda row: number(row.get("estimated_budget")), reverse=True)[:16]
    table_rows = []
    for row in top_rows:
        action = row.get("recommended_action", "")
        table_rows.append(
            f"""
            <tr>
              <td><strong>{escape(row.get('material_name', ''))}</strong><span>{escape(row.get('commodity_names', ''))}</span></td>
              <td>{escape(row.get('supplier', ''))}</td>
              <td class="num">{escape(row.get('horizon_days', ''))}</td>
              <td><span class="pill {action_class(action)}">{escape(action)}</span></td>
              <td class="num">{fmt(row.get('recommended_buy_qty'))}</td>
              <td class="num">¥{fmt(row.get('estimated_budget'), 2)}</td>
              <td class="num">{escape(row.get('stock_days', '') or '-')}</td>
              <td class="num">{fmt(row.get('market_up_probability'))}%</td>
            </tr>
            """
        )

    return f"""
    <section class="panel forecast">
      <div class="panel-head">
        <div>
          <span>采购备货测算</span>
          <h2>30/90/180/365天滚动计划</h2>
        </div>
        <p>以美途能进销存系统为最高可信源；导出文件未落地时，先用本地库存/BOM基线兜底。</p>
      </div>
      <div class="forecast-grid">{''.join(cards)}</div>
      <table>
        <thead>
          <tr><th>物料</th><th>供应商</th><th>周期</th><th>动作</th><th>建议数量</th><th>预算</th><th>库存天数</th><th>涨价概率</th></tr>
        </thead>
        <tbody>{''.join(table_rows)}</tbody>
      </table>
    </section>
    """


def build_html(rows: list[dict[str, str]], bom_rows: list[dict[str, str]]) -> str:
    forecast_rows = read_optional_csv(PROCUREMENT_DIR / "stock_forecast.csv")
    import_status = read_import_status()
    total_budget = sum(number(row.get("suggested_budget")) for row in rows)
    immediate_count = sum(1 for row in rows if "立即" in row.get("recommended_action", ""))
    mapped_count = sum(1 for row in rows if number(row.get("impacted_sku_count")) > 0)
    top_rows = sorted(rows, key=lambda row: number(row.get("purchase_priority")), reverse=True)
    sku_count = len({row.get("sku", "") for row in bom_rows if row.get("sku")})
    bom_line_count = len(bom_rows)

    table_rows = []
    for row in top_rows:
        action = row.get("recommended_action", "")
        priority = number(row.get("purchase_priority"))
        width = max(4, min(100, priority))
        table_rows.append(
            f"""
            <tr>
              <td><strong>{escape(row.get('material_name', ''))}</strong><span>{escape(row.get('material_type', ''))}</span></td>
              <td>{escape(row.get('supplier', ''))}</td>
              <td class="num">{fmt(row.get('stock_days'), 1) if row.get('stock_days') else '-'}</td>
              <td class="num">{fmt(row.get('suggested_order_qty')) if row.get('suggested_order_qty') else '-'}</td>
              <td class="num">¥{fmt(row.get('suggested_budget'), 2)}</td>
              <td><span class="pill {action_class(action)}">{escape(action)}</span></td>
              <td>
                <div class="score"><i style="width:{width:.0f}%"></i></div>
                <small>{priority:.1f}</small>
              </td>
              <td>{escape(row.get('impacted_skus', '') or '未匹配')}</td>
              <td>{escape(row.get('market_risk_level', ''))} {escape(row.get('market_up_probability', ''))}%</td>
            </tr>
            """
        )

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>迈瑟伦内部采购建议看板</title>
  <style>
    :root {{
      --bg:#f5f5f7; --panel:#fff; --ink:#1d1d1f; --muted:#6e6e73;
      --line:#d2d2d7; --blue:#0071e3; --green:#147b3d; --amber:#b86e00; --red:#b42318;
      font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei","PingFang SC","Segoe UI",Arial,sans-serif;
    }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:var(--bg); color:var(--ink); }}
    main {{ max-width:1480px; margin:0 auto; padding:28px; }}
    header {{ display:flex; justify-content:space-between; gap:24px; align-items:flex-start; margin-bottom:18px; }}
    h1 {{ margin:0; font-size:34px; letter-spacing:0; }}
    p {{ color:var(--muted); margin:8px 0 0; line-height:1.6; }}
    .stamp {{ color:var(--muted); font-size:13px; }}
    .grid {{ display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:12px; margin:18px 0; }}
    .card {{ background:rgba(255,255,255,.92); border:1px solid var(--line); border-radius:12px; padding:18px; box-shadow:0 16px 36px rgba(0,0,0,.055); }}
    .card span {{ display:block; color:var(--muted); font-size:13px; }}
    .card strong {{ display:block; font-size:30px; margin-top:8px; }}
    .panel {{ background:rgba(255,255,255,.94); border:1px solid var(--line); border-radius:12px; overflow:hidden; box-shadow:0 16px 36px rgba(0,0,0,.055); margin-top:14px; }}
    .panel-head {{ display:flex; justify-content:space-between; gap:18px; align-items:flex-start; padding:18px 18px 0; }}
    .panel-head span {{ color:var(--muted); font-size:12px; font-weight:800; }}
    .panel-head h2 {{ margin:4px 0 0; font-size:22px; }}
    .panel-head p {{ max-width:520px; margin:0; }}
    .forecast-grid {{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; padding:18px; }}
    .forecast-card {{ border:1px solid #e8e8ed; border-radius:10px; padding:15px; background:#fbfbfd; }}
    .forecast-card span,.forecast-card small {{ display:block; color:var(--muted); font-size:12px; }}
    .forecast-card strong {{ display:block; font-size:28px; margin:8px 0 4px; }}
    .empty {{ padding:18px; }}
    .empty h2 {{ margin:0 0 6px; }}
    table {{ width:100%; border-collapse:collapse; }}
    th,td {{ padding:14px 14px; border-bottom:1px solid #e8e8ed; vertical-align:top; text-align:left; font-size:14px; }}
    th {{ color:var(--muted); font-size:12px; font-weight:800; background:#fbfbfd; position:sticky; top:0; }}
    td span {{ display:block; color:var(--muted); font-size:12px; margin-top:4px; }}
    .num {{ text-align:right; white-space:nowrap; }}
    .pill {{ display:inline-flex; color:var(--ink); border-radius:999px; padding:5px 9px; font-size:12px; font-weight:800; }}
    .urgent {{ background:rgba(180,35,24,.12); color:var(--red); }}
    .watch {{ background:rgba(0,113,227,.1); color:var(--blue); }}
    .hold {{ background:rgba(184,110,0,.12); color:var(--amber); }}
    .quiet {{ background:#ececf1; color:var(--muted); }}
    .score {{ width:88px; height:8px; border-radius:999px; background:#ececf1; overflow:hidden; margin-top:4px; }}
    .score i {{ display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,var(--blue),var(--green)); }}
    @media (max-width: 980px) {{
      main {{ padding:18px; }}
      header {{ flex-direction:column; }}
      .grid,.forecast-grid {{ grid-template-columns:1fr 1fr; }}
      .panel {{ overflow:auto; }}
      table {{ min-width:1120px; }}
    }}
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>内部采购建议看板</h1>
        <p>基于美途能进销存系统、库存/BOM基线与公开行情风险生成。此页面只保存在本地项目内部目录，不发布到公网。</p>
      </div>
      <div class="stamp">生成 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</div>
    </header>
    <section class="grid">
      <div class="card"><span>采购物料</span><strong>{len(rows)}</strong></div>
      <div class="card"><span>预采购预算</span><strong>¥{total_budget:,.0f}</strong></div>
      <div class="card"><span>立即处理</span><strong>{immediate_count}</strong></div>
      <div class="card"><span>已关联SKU</span><strong>{mapped_count}</strong></div>
      <div class="card"><span>SKU / BOM行</span><strong>{sku_count} / {bom_line_count}</strong></div>
      <div class="card"><span>{escape(import_status['primary_system'])}</span><strong>{escape(import_status['matched_files'])}/{escape(import_status['scanned_files'])}</strong><span>{escape(import_status['status_text'])}</span></div>
    </section>
    {build_forecast_section(forecast_rows)}
    <section class="panel">
      <div class="panel-head">
        <div>
          <span>采购物料影响</span>
          <h2>优先处理清单</h2>
        </div>
        <p>按照库存、行情、BOM影响和供应商线索排序。</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>物料</th><th>供应商</th><th>库存天数</th><th>建议采购</th><th>预算</th>
            <th>动作</th><th>优先级</th><th>影响SKU</th><th>行情风险</th>
          </tr>
        </thead>
        <tbody>{''.join(table_rows)}</tbody>
      </table>
    </section>
  </main>
</body>
</html>
"""


def main() -> int:
    rows = read_csv(PROCUREMENT_DIR / "procurement_impact.csv")
    bom_rows = read_csv(PROCUREMENT_DIR / "sku_bom_baseline.csv")
    html = build_html(rows, bom_rows)
    output = PROCUREMENT_DIR / "procurement_dashboard.html"
    output.write_text(html, encoding="utf-8")
    print(f"Dashboard: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
