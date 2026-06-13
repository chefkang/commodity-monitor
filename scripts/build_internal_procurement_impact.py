from __future__ import annotations

import csv
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PROCUREMENT_DIR = ROOT / "data" / "internal" / "procurement"


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def clean_number(value: Any) -> float:
    if value is None:
        return 0.0
    text = str(value).replace(",", "").strip()
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def normalize_name(value: str) -> str:
    text = re.sub(r"EZ\d{2}-\d{5}\s*", "", value)
    text = re.sub(r"[\s（）()_\-—/]+", "", text)
    text = text.replace("款", "").replace("版", "")
    return text.lower()


def model_tokens(value: str) -> set[str]:
    return set(re.findall(r"\d{3,4}", value))


def is_match(procurement_name: str, bom_name: str) -> bool:
    left = normalize_name(procurement_name)
    right = normalize_name(bom_name)
    if not left or not right:
        return False
    left_tokens = model_tokens(procurement_name)
    right_tokens = model_tokens(bom_name)
    if left_tokens and right_tokens and not left_tokens.intersection(right_tokens):
        return False
    if left in right or right in left:
        return True
    key_words = ["电路板", "铝合金外壳", "外壳", "气泵", "电机", "电芯", "电池", "夹", "线"]
    return any(word in procurement_name and word in bom_name for word in key_words) and bool(
        left_tokens.intersection(right_tokens) if left_tokens and right_tokens else False
    )


def build_impacts(procurement_rows: list[dict[str, str]], bom_rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    impacts: list[dict[str, Any]] = []
    for row in procurement_rows:
        matches = [bom for bom in bom_rows if is_match(row["material_name"], bom["material_name"])]
        sku_cost: dict[str, float] = defaultdict(float)
        sku_lines: dict[str, int] = defaultdict(int)
        for bom in matches:
            sku = bom.get("sku", "")
            if not sku:
                continue
            sku_cost[sku] += clean_number(bom.get("line_cost"))
            sku_lines[sku] += 1
        top_skus = sorted(sku_cost.items(), key=lambda item: item[1], reverse=True)[:12]
        impacts.append(
            {
                **row,
                "impacted_sku_count": len(sku_cost),
                "impacted_skus": "|".join(sku for sku, _ in top_skus),
                "matched_bom_lines": len(matches),
                "matched_bom_cost": round(sum(sku_cost.values()), 4),
                "top_sku_costs": "|".join(f"{sku}:{cost:.2f}" for sku, cost in top_skus),
            }
        )
    return sorted(impacts, key=lambda item: (float(item["purchase_priority"]), item["impacted_sku_count"]), reverse=True)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(rows[0].keys()) if rows else []
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_report(path: Path, rows: list[dict[str, Any]]) -> None:
    lines = [
        "# 采购物料影响SKU分析",
        "",
        f"- 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"- 采购物料数：{len(rows)}",
        f"- 已匹配到SKU的物料：{sum(1 for row in rows if int(row['impacted_sku_count']) > 0)}",
        "",
        "## 重点物料",
        "",
        "| 优先级 | 动作 | 物料 | 库存天数 | 建议采购 | 预算 | 影响SKU数 | 主要影响SKU |",
        "| ---: | --- | --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for row in rows[:25]:
        lines.append(
            "| {priority} | {action} | {material} | {days} | {qty} | {budget} | {sku_count} | {skus} |".format(
                priority=row["purchase_priority"],
                action=row["recommended_action"],
                material=row["material_name"],
                days="" if not row["stock_days"] else f"{clean_number(row['stock_days']):.1f}",
                qty="" if not row["suggested_order_qty"] else f"{clean_number(row['suggested_order_qty']):,.0f}",
                budget=f"{clean_number(row['suggested_budget']):,.2f}",
                sku_count=row["impacted_sku_count"],
                skus=row["impacted_skus"] or "未匹配",
            )
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    procurement = read_csv(PROCUREMENT_DIR / "procurement_baseline.csv")
    bom = read_csv(PROCUREMENT_DIR / "sku_bom_baseline.csv")
    impacts = build_impacts(procurement, bom)
    write_csv(PROCUREMENT_DIR / "procurement_impact.csv", impacts)
    write_report(PROCUREMENT_DIR / "procurement_impact.md", impacts)
    print(f"Rows: {len(impacts)}")
    print(f"Output: {PROCUREMENT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
