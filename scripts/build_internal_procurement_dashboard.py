from __future__ import annotations

import csv
from datetime import datetime
from html import escape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROCUREMENT_DIR = ROOT / "data" / "internal" / "procurement"


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def number(value: str) -> float:
    if not value:
        return 0.0
    try:
        return float(str(value).replace(",", ""))
    except ValueError:
        return 0.0


def fmt(value: str, digits: int = 0) -> str:
    val = number(value)
    if digits:
        return f"{val:,.{digits}f}"
    return f"{val:,.0f}"


def action_class(action: str) -> str:
    if "立即" in action:
        return "urgent"
    if "分批" in action or "关注" in action:
        return "watch"
    if "暂缓" in action:
        return "hold"
    return "quiet"


def build_html(rows: list[dict[str, str]], bom_rows: list[dict[str, str]]) -> str:
    total_budget = sum(number(row.get("suggested_budget", "")) for row in rows)
    immediate_count = sum(1 for row in rows if "立即" in row.get("recommended_action", ""))
    mapped_count = sum(1 for row in rows if number(row.get("impacted_sku_count", "")) > 0)
    top_rows = sorted(rows, key=lambda row: number(row.get("purchase_priority", "")), reverse=True)
    sku_count = len({row.get("sku", "") for row in bom_rows if row.get("sku")})
    bom_line_count = len(bom_rows)

    table_rows = []
    for row in top_rows:
        action = row.get("recommended_action", "")
        priority = number(row.get("purchase_priority", ""))
        width = max(4, min(100, priority))
        table_rows.append(
            f"""
            <tr>
              <td><strong>{escape(row.get('material_name', ''))}</strong><span>{escape(row.get('material_type', ''))}</span></td>
              <td>{escape(row.get('supplier', ''))}</td>
              <td class="num">{fmt(row.get('stock_days', ''), 1) if row.get('stock_days') else '-'}</td>
              <td class="num">{fmt(row.get('suggested_order_qty', '')) if row.get('suggested_order_qty') else '-'}</td>
              <td class="num">¥{fmt(row.get('suggested_budget', ''), 2)}</td>
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
    .grid {{ display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; margin:18px 0; }}
    .card {{ background:rgba(255,255,255,.92); border:1px solid var(--line); border-radius:12px; padding:18px; box-shadow:0 16px 36px rgba(0,0,0,.055); }}
    .card span {{ display:block; color:var(--muted); font-size:13px; }}
    .card strong {{ display:block; font-size:30px; margin-top:8px; }}
    .panel {{ background:rgba(255,255,255,.94); border:1px solid var(--line); border-radius:12px; overflow:hidden; box-shadow:0 16px 36px rgba(0,0,0,.055); }}
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
      .grid {{ grid-template-columns:1fr 1fr; }}
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
        <p>基于库存采购表、SKU BOM 与公开行情风险生成。此页面只保存在本地项目目录，不发布到公网。</p>
      </div>
      <div class="stamp">生成 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</div>
    </header>
    <section class="grid">
      <div class="card"><span>采购物料</span><strong>{len(rows)}</strong></div>
      <div class="card"><span>预采购预算</span><strong>¥{total_budget:,.0f}</strong></div>
      <div class="card"><span>立即处理</span><strong>{immediate_count}</strong></div>
      <div class="card"><span>已关联SKU</span><strong>{mapped_count}</strong></div>
      <div class="card"><span>SKU / BOM行</span><strong>{sku_count} / {bom_line_count}</strong></div>
    </section>
    <section class="panel">
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
