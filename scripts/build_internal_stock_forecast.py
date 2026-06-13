from __future__ import annotations

import csv
import json
import math
import re
from collections import defaultdict
from datetime import datetime
from html import escape
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PROCUREMENT_DIR = ROOT / "data" / "internal" / "procurement"
H3_DIR = ROOT / "data" / "internal" / "h3_normalized"
LATEST_JSON = ROOT / "data" / "latest.json"

HORIZONS = [
    (30, 15),
    (90, 30),
    (180, 45),
    (365, 60),
]


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def clean_number(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if math.isnan(value):
            return 0.0
        return float(value)
    text = str(value).replace(",", "").replace("￥", "").replace("¥", "").strip()
    if not text or text in {"-", "--", "None", "nan"}:
        return 0.0
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    return float(match.group()) if match else 0.0


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).replace("\u00a0", " ")).strip()


def md_cell(value: Any) -> str:
    return clean_text(value).replace("|", " / ")


def fmt_number(value: Any, digits: int = 0) -> str:
    number = clean_number(value)
    if digits:
        return f"{number:,.{digits}f}"
    return f"{number:,.0f}"


def action_class(action: str) -> str:
    if "立即" in action:
        return "urgent"
    if "锁价" in action or "分批" in action or "确认" in action:
        return "watch"
    if "暂" in action or "观察" in action or "压价" in action:
        return "hold"
    return "quiet"


def load_market_risk() -> dict[str, float]:
    if not LATEST_JSON.exists():
        return {}
    data = json.loads(LATEST_JSON.read_text(encoding="utf-8"))
    return {
        item.get("material_id", ""): clean_number(item.get("up_probability"))
        for item in data.get("latest", [])
    }


def parse_material_name(value: str) -> str:
    text = clean_text(value)
    text = re.sub(r"^EZ\d{2}-\d{5}\s*", "", text)
    return text


def split_materials(value: str) -> list[str]:
    text = clean_text(value)
    if not text:
        return []
    parts = re.split(r"[,，;；|、]+", text)
    return [parse_material_name(part) for part in parts if parse_material_name(part)]


def group_h3_purchase_orders(rows: list[dict[str, str]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        names = split_materials(row.get("material_purchase", ""))
        if not names:
            continue
        qty = clean_number(row.get("remaining_tracking_qty")) or clean_number(row.get("purchase_total_qty"))
        amount = clean_number(row.get("purchase_total_amount"))
        supplier = clean_text(row.get("supplier_name") or row.get("supplier_selection"))
        per_qty = qty / len(names) if names else 0.0
        per_amount = amount / len(names) if names else 0.0
        for name in names:
            item = grouped.setdefault(
                name,
                {
                    "material_name": name,
                    "h3_open_purchase_qty": 0.0,
                    "h3_open_purchase_amount": 0.0,
                    "h3_latest_supplier": "",
                    "h3_latest_po": "",
                    "h3_expected_delivery": "",
                },
            )
            item["h3_open_purchase_qty"] += per_qty
            item["h3_open_purchase_amount"] += per_amount
            if supplier:
                item["h3_latest_supplier"] = supplier
            if row.get("purchase_order_no"):
                item["h3_latest_po"] = row["purchase_order_no"]
            if row.get("expected_delivery_date"):
                item["h3_expected_delivery"] = row["expected_delivery_date"]
    return grouped


def build_from_procurement_baseline(h3_purchase: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    rows = read_csv(PROCUREMENT_DIR / "procurement_impact.csv")
    source = "公共盘库存/BOM基线"
    if h3_purchase:
        source = "美途能进销存系统采购下单 + 公共盘库存/BOM基线"
    output: list[dict[str, Any]] = []
    for row in rows:
        material_name = clean_text(row.get("material_name"))
        if not material_name:
            continue
        h3 = h3_purchase.get(material_name, {})
        current_stock = clean_number(row.get("current_stock_qty"))
        inbound_qty = clean_number(row.get("inbound_qty")) + clean_number(h3.get("h3_open_purchase_qty"))
        daily_usage = clean_number(row.get("daily_outbound_qty"))
        stock_days = clean_number(row.get("stock_days"))
        unit_price = clean_number(row.get("unit_price"))
        market_prob = clean_number(row.get("market_up_probability"))
        priority = clean_number(row.get("purchase_priority"))
        supplier = clean_text(h3.get("h3_latest_supplier")) or clean_text(row.get("supplier"))
        action = clean_text(row.get("recommended_action"))
        for horizon_days, safety_days in HORIZONS:
            risk_multiplier = 1 + min(market_prob, 80) / 200
            demand_qty = daily_usage * horizon_days
            safety_qty = daily_usage * safety_days * risk_multiplier
            net_buy_qty = max(0.0, demand_qty + safety_qty - current_stock - inbound_qty)
            budget = net_buy_qty * unit_price
            if daily_usage <= 0 and clean_number(row.get("suggested_order_qty")) > 0:
                net_buy_qty = clean_number(row.get("suggested_order_qty"))
                budget = net_buy_qty * unit_price
            scenario = classify_action(horizon_days, stock_days, market_prob, net_buy_qty, action)
            output.append(
                {
                    "source": source,
                    "horizon_days": horizon_days,
                    "material_type": row.get("material_type", ""),
                    "material_name": material_name,
                    "supplier": supplier,
                    "current_stock_qty": round(current_stock, 4),
                    "inbound_qty": round(inbound_qty, 4),
                    "daily_usage_qty": round(daily_usage, 4),
                    "stock_days": round(stock_days, 2) if stock_days else "",
                    "market_up_probability": market_prob,
                    "purchase_priority": priority,
                    "unit_price": unit_price,
                    "forecast_demand_qty": round(demand_qty, 4),
                    "safety_stock_qty": round(safety_qty, 4),
                    "recommended_buy_qty": round(net_buy_qty, 4),
                    "estimated_budget": round(budget, 2),
                    "recommended_action": scenario,
                    "h3_latest_po": h3.get("h3_latest_po", ""),
                    "h3_expected_delivery": h3.get("h3_expected_delivery", ""),
                    "impacted_skus": row.get("impacted_skus", ""),
                    "commodity_names": row.get("commodity_names", ""),
                }
            )
    return output, source


def classify_action(
    horizon_days: int,
    stock_days: float,
    market_prob: float,
    net_buy_qty: float,
    current_action: str,
) -> str:
    if horizon_days == 30:
        if stock_days and stock_days <= 30:
            return "立即补货"
        if net_buy_qty > 0 and market_prob >= 55:
            return "本周确认并分批补货"
        if net_buy_qty > 0:
            return "询价确认"
        return "暂不补货，继续跟踪"
    if horizon_days == 90:
        if market_prob >= 60 and net_buy_qty > 0:
            return "90天分批备货/谈锁价"
        if net_buy_qty > 0:
            return "90天滚动补货"
        return "维持当前库存策略"
    if horizon_days == 180:
        if market_prob >= 60:
            return "半年战略备货评估"
        if "暂缓" in current_action:
            return "半年内压价跟踪"
        return "半年滚动观察"
    if market_prob >= 60:
        return "年度锁价或替代料评估"
    return "年度需求观察"


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames: list[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_report(path: Path, rows: list[dict[str, Any]], source: str) -> None:
    by_horizon: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_horizon[int(row["horizon_days"])].append(row)
    lines = [
        "# 采购备货滚动测算",
        "",
        f"- 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"- 当前数据源：{source}",
        "- 说明：美途能进销存系统为最高可信源；若氚云导出文件未落地，则暂用公共盘库存/BOM基线兜底。",
        "",
    ]
    for horizon in (30, 90, 180, 365):
        items = sorted(by_horizon.get(horizon, []), key=lambda item: item["estimated_budget"], reverse=True)
        budget = sum(clean_number(item["estimated_budget"]) for item in items)
        buy_count = sum(1 for item in items if clean_number(item["recommended_buy_qty"]) > 0)
        lines.extend(
            [
                f"## {horizon}天",
                "",
                f"- 建议采购物料：{buy_count}",
                f"- 测算预算：{budget:,.2f}",
                "",
                "| 物料 | 供应商 | 动作 | 建议数量 | 测算预算 | 库存天数 | 涨价概率 | 影响SKU |",
                "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
            ]
        )
        for item in items[:12]:
            lines.append(
                "| {material} | {supplier} | {action} | {qty:,.0f} | {budget:,.2f} | {days} | {prob:.0f}% | {skus} |".format(
                    material=item["material_name"],
                    supplier=item["supplier"],
                    action=item["recommended_action"],
                    qty=clean_number(item["recommended_buy_qty"]),
                    budget=clean_number(item["estimated_budget"]),
                    days=item["stock_days"] or "-",
                    prob=clean_number(item["market_up_probability"]),
                    skus=md_cell(item["impacted_skus"] or "-"),
                )
            )
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_html(path: Path, rows: list[dict[str, Any]], source: str) -> None:
    by_horizon: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_horizon[int(row["horizon_days"])].append(row)

    cards: list[str] = []
    sections: list[str] = []
    for horizon in (30, 90, 180, 365):
        items = sorted(by_horizon.get(horizon, []), key=lambda item: clean_number(item["estimated_budget"]), reverse=True)
        budget = sum(clean_number(item["estimated_budget"]) for item in items)
        buy_count = sum(1 for item in items if clean_number(item["recommended_buy_qty"]) > 0)
        top_action = "观察"
        if buy_count:
            top_action = "需要采购"
        if horizon >= 180 and buy_count:
            top_action = "中长期备货"

        cards.append(
            f"""
            <button class="horizon-card" data-target="h{horizon}" type="button">
              <span>{horizon}天</span>
              <strong>{buy_count}</strong>
              <small>{top_action} · 预算 ¥{budget:,.0f}</small>
            </button>
            """
        )

        table_rows = []
        for item in items:
            action = clean_text(item["recommended_action"])
            table_rows.append(
                f"""
                <tr>
                  <td>
                    <strong>{escape(clean_text(item["material_name"]))}</strong>
                    <span>{escape(clean_text(item["material_type"]))}</span>
                  </td>
                  <td>{escape(clean_text(item["supplier"]) or "-")}</td>
                  <td>{escape(clean_text(item["recommended_action"]))}</td>
                  <td class="num">{fmt_number(item["recommended_buy_qty"])}</td>
                  <td class="num">¥{fmt_number(item["estimated_budget"], 2)}</td>
                  <td class="num">{escape(clean_text(item["stock_days"]) or "-")}</td>
                  <td class="num">{fmt_number(item["market_up_probability"])}%</td>
                  <td>{escape(clean_text(item["h3_expected_delivery"]) or "-")}</td>
                  <td>{escape(clean_text(item["impacted_skus"]) or "-")}</td>
                  <td><span class="pill {action_class(action)}">{escape(action)}</span></td>
                </tr>
                """
            )

        sections.append(
            f"""
            <section class="panel horizon" id="h{horizon}">
              <div class="panel-head">
                <div>
                  <span>滚动周期</span>
                  <h2>{horizon}天采购备货测算</h2>
                </div>
                <p>建议采购物料 {buy_count} 项，测算预算 ¥{budget:,.0f}。</p>
              </div>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>物料</th><th>供应商</th><th>建议动作</th><th>建议数量</th><th>测算预算</th>
                      <th>库存天数</th><th>涨价概率</th><th>预计交期</th><th>影响SKU</th><th>状态</th>
                    </tr>
                  </thead>
                  <tbody>{''.join(table_rows)}</tbody>
                </table>
              </div>
            </section>
            """
        )

    html = f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>采购备货滚动测算</title>
  <style>
    :root {{
      --bg:#f5f5f7; --panel:#fff; --ink:#1d1d1f; --muted:#6e6e73; --line:#d2d2d7;
      --blue:#0071e3; --green:#147b3d; --amber:#b86e00; --red:#b42318;
      font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei","PingFang SC","Segoe UI",Arial,sans-serif;
    }}
    * {{ box-sizing:border-box; }}
    html {{ scroll-behavior:smooth; }}
    body {{ margin:0; background:radial-gradient(circle at top,#fff 0,#f5f5f7 42%,#ececf1 100%); color:var(--ink); }}
    main {{ max-width:1480px; margin:0 auto; padding:30px; }}
    header {{ display:grid; grid-template-columns:1fr auto; gap:20px; align-items:start; margin-bottom:18px; }}
    h1 {{ margin:0; font-size:36px; letter-spacing:0; }}
    p {{ color:var(--muted); margin:8px 0 0; line-height:1.65; }}
    .stamp {{ color:var(--muted); font-size:13px; text-align:right; }}
    .source {{ display:inline-flex; margin-top:12px; padding:7px 10px; border-radius:999px; background:#fff; border:1px solid var(--line); color:var(--muted); font-size:13px; }}
    .horizon-grid {{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin:18px 0; }}
    .horizon-card {{ text-align:left; background:rgba(255,255,255,.94); border:1px solid var(--line); border-radius:16px; padding:18px; box-shadow:0 18px 45px rgba(0,0,0,.06); cursor:pointer; transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease; color:inherit; }}
    .horizon-card:hover {{ transform:translateY(-2px); box-shadow:0 22px 52px rgba(0,0,0,.09); border-color:#9ec9ff; }}
    .horizon-card span,.horizon-card small {{ display:block; color:var(--muted); font-size:13px; }}
    .horizon-card strong {{ display:block; font-size:34px; margin:9px 0 5px; }}
    .panel {{ background:rgba(255,255,255,.96); border:1px solid var(--line); border-radius:16px; overflow:hidden; box-shadow:0 18px 45px rgba(0,0,0,.06); margin-top:16px; }}
    .panel-head {{ display:flex; justify-content:space-between; gap:18px; align-items:flex-start; padding:18px; border-bottom:1px solid #e8e8ed; }}
    .panel-head span {{ color:var(--muted); font-size:12px; font-weight:800; }}
    .panel-head h2 {{ margin:4px 0 0; font-size:23px; }}
    .panel-head p {{ margin:0; max-width:420px; }}
    .table-wrap {{ overflow:auto; }}
    table {{ width:100%; border-collapse:collapse; min-width:1180px; }}
    th,td {{ padding:14px; border-bottom:1px solid #e8e8ed; text-align:left; vertical-align:top; font-size:14px; }}
    th {{ color:var(--muted); font-size:12px; font-weight:800; background:#fbfbfd; position:sticky; top:0; }}
    td strong {{ display:block; }}
    td span {{ display:block; color:var(--muted); font-size:12px; margin-top:4px; }}
    .num {{ text-align:right; white-space:nowrap; }}
    .pill {{ display:inline-flex; align-items:center; border-radius:999px; padding:5px 9px; font-size:12px; font-weight:800; }}
    .urgent {{ background:rgba(180,35,24,.12); color:var(--red); }}
    .watch {{ background:rgba(0,113,227,.1); color:var(--blue); }}
    .hold {{ background:rgba(184,110,0,.12); color:var(--amber); }}
    .quiet {{ background:#ececf1; color:var(--muted); }}
    @media (max-width: 860px) {{
      main {{ padding:18px; }}
      header {{ grid-template-columns:1fr; }}
      .stamp {{ text-align:left; }}
      .horizon-grid {{ grid-template-columns:1fr 1fr; }}
      h1 {{ font-size:28px; }}
    }}
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>采购备货滚动测算</h1>
        <p>把库存天数、未到货数量、BOM 影响、公开行情涨价概率放在一起，按 30/90/180/365 天给出采购动作和预算测算。</p>
        <div class="source">当前数据源：{escape(source)}</div>
      </div>
      <div class="stamp">生成 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</div>
    </header>
    <nav class="horizon-grid">{''.join(cards)}</nav>
    {''.join(sections)}
  </main>
  <script>
    document.querySelectorAll('.horizon-card').forEach((card) => {{
      card.addEventListener('click', () => document.getElementById(card.dataset.target).scrollIntoView({{block:'start'}}));
    }});
  </script>
</body>
</html>
"""
    path.write_text(html, encoding="utf-8")


def main() -> int:
    h3_purchase_rows = read_csv(H3_DIR / "purchase_orders.csv")
    h3_purchase = group_h3_purchase_orders(h3_purchase_rows)
    rows, source = build_from_procurement_baseline(h3_purchase)
    rows = sorted(
        rows,
        key=lambda item: (
            int(item["horizon_days"]),
            -clean_number(item["estimated_budget"]),
            -clean_number(item["purchase_priority"]),
        ),
    )
    write_csv(PROCUREMENT_DIR / "stock_forecast.csv", rows)
    write_report(PROCUREMENT_DIR / "stock_forecast.md", rows, source)
    write_html(PROCUREMENT_DIR / "stock_forecast.html", rows, source)
    print(f"Rows: {len(rows)}")
    print(f"Source: {source}")
    print(f"Output: {PROCUREMENT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
