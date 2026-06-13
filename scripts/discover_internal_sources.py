from __future__ import annotations

import argparse
import csv
import json
import os
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "data" / "internal" / "discovery"


EXTENSIONS = {
    ".csv",
    ".xls",
    ".xlsx",
    ".xlsm",
    ".et",
    ".doc",
    ".docx",
    ".pdf",
    ".ppt",
    ".pptx",
    ".json",
    ".txt",
}


CATEGORIES: dict[str, list[str]] = {
    "sales": [
        "销售",
        "销量",
        "订单",
        "出库",
        "发货",
        "客户",
        "店铺",
        "sales",
        "order",
        "shipment",
        "sku",
    ],
    "inventory": [
        "库存",
        "仓库",
        "入库",
        "出库",
        "进销存",
        "盘点",
        "库龄",
        "inventory",
        "stock",
        "warehouse",
    ],
    "bom": [
        "bom",
        "BOM",
        "物料清单",
        "材料清单",
        "用量",
        "配方",
        "物料表",
        "bill of material",
    ],
    "purchase": [
        "采购",
        "采购单",
        "采购价",
        "询价",
        "报价",
        "下单",
        "purchase",
        "po",
        "quotation",
    ],
    "supplier": [
        "供应商",
        "供应链",
        "账期",
        "交期",
        "MOQ",
        "供方",
        "supplier",
        "vendor",
    ],
    "production": [
        "生产",
        "排产",
        "工单",
        "产量",
        "计划",
        "制程",
        "production",
        "work order",
    ],
    "rd": [
        "研发",
        "图纸",
        "结构",
        "原理图",
        "PCB",
        "BOM",
        "测试",
        "样品",
        "drawing",
        "schematic",
    ],
    "finance": [
        "财务",
        "成本",
        "利润",
        "毛利",
        "应付",
        "应收",
        "finance",
        "cost",
        "margin",
    ],
}


TABLE_LIKE_EXTENSIONS = {".csv", ".xls", ".xlsx", ".xlsm", ".et"}


@dataclass
class FileRecord:
    root_label: str
    full_path: str
    relative_path: str
    name: str
    extension: str
    size_bytes: int
    modified_at: str
    categories: list[str]
    score: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a read-only index of internal company data candidates."
    )
    parser.add_argument("--roots", nargs="+", required=True, help="Directories to scan.")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT), help="Output directory.")
    parser.add_argument("--max-depth", type=int, default=6, help="Maximum directory depth.")
    parser.add_argument(
        "--max-files-per-root",
        type=int,
        default=12000,
        help="Safety limit per root.",
    )
    parser.add_argument(
        "--extensions",
        nargs="*",
        default=sorted(EXTENSIONS),
        help="File extensions to include.",
    )
    parser.add_argument(
        "--follow-links",
        action="store_true",
        help="Follow directory links. Use for DingDrive virtual folders.",
    )
    return parser.parse_args()


def normalize_exts(values: Iterable[str]) -> set[str]:
    return {value.lower() if value.startswith(".") else f".{value.lower()}" for value in values}


def classify(text: str, ext: str) -> tuple[list[str], int]:
    lower = text.lower()
    matched: list[str] = []
    score = 0
    for category, keywords in CATEGORIES.items():
        hits = sum(1 for keyword in keywords if keyword.lower() in lower)
        if hits:
            matched.append(category)
            score += hits * 10
    if ext.lower() in TABLE_LIKE_EXTENSIONS:
        score += 8
    if any(category in matched for category in ["sales", "inventory", "bom", "purchase", "supplier"]):
        score += 12
    return matched, score


def iter_files(
    root: Path,
    max_depth: int,
    max_files: int,
    extensions: set[str],
    follow_links: bool = False,
) -> Iterable[Path]:
    queue: deque[tuple[Path, int]] = deque([(root, 0)])
    yielded = 0
    while queue and yielded < max_files:
        current, depth = queue.popleft()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=follow_links):
                            if depth < max_depth:
                                queue.append((Path(entry.path), depth + 1))
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        path = Path(entry.path)
                        if path.suffix.lower() not in extensions:
                            continue
                        yielded += 1
                        yield path
                        if yielded >= max_files:
                            break
                    except OSError:
                        continue
        except OSError:
            continue


def build_records(
    roots: list[str],
    max_depth: int,
    max_files: int,
    extensions: set[str],
    follow_links: bool = False,
) -> list[FileRecord]:
    records: list[FileRecord] = []
    for root_text in roots:
        root = Path(root_text)
        if not root.exists():
            continue
        root_label = str(root)
        for path in iter_files(
            root,
            max_depth=max_depth,
            max_files=max_files,
            extensions=extensions,
            follow_links=follow_links,
        ):
            try:
                stat = path.stat()
            except OSError:
                continue
            rel = path.relative_to(root) if path.is_relative_to(root) else path.name
            categories, score = classify(f"{path.name} {path.parent}", path.suffix)
            records.append(
                FileRecord(
                    root_label=root_label,
                    full_path=str(path),
                    relative_path=str(rel),
                    name=path.name,
                    extension=path.suffix.lower(),
                    size_bytes=stat.st_size,
                    modified_at=datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                    categories=categories,
                    score=score,
                )
            )
    return records


def write_csv(path: Path, rows: list[FileRecord]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "root_label",
                "full_path",
                "relative_path",
                "name",
                "extension",
                "size_bytes",
                "modified_at",
                "categories",
                "score",
            ],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "root_label": row.root_label,
                    "full_path": row.full_path,
                    "relative_path": row.relative_path,
                    "name": row.name,
                    "extension": row.extension,
                    "size_bytes": row.size_bytes,
                    "modified_at": row.modified_at,
                    "categories": "|".join(row.categories),
                    "score": row.score,
                }
            )


def write_summary(out_dir: Path, records: list[FileRecord], candidates: list[FileRecord]) -> None:
    by_category: dict[str, list[FileRecord]] = defaultdict(list)
    for record in candidates:
        for category in record.categories:
            by_category[category].append(record)

    extension_counts = Counter(record.extension for record in records)
    root_counts = Counter(record.root_label for record in records)

    summary = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "total_files_indexed": len(records),
        "candidate_files": len(candidates),
        "extensions": dict(extension_counts.most_common()),
        "roots": dict(root_counts.most_common()),
        "categories": {key: len(value) for key, value in sorted(by_category.items())},
    }
    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    lines = [
        "# 内部数据发现摘要",
        "",
        f"- 生成时间：{summary['generated_at']}",
        f"- 索引文件数：{len(records)}",
        f"- 高相关候选文件数：{len(candidates)}",
        "",
        "## 类别候选数量",
        "",
    ]
    for category, count in sorted(summary["categories"].items()):
        lines.append(f"- {category}: {count}")
    lines.extend(["", "## 优先查看文件", ""])
    for record in candidates[:60]:
        lines.append(
            f"- [{record.score}] {','.join(record.categories)} | {record.modified_at} | {record.full_path}"
        )
    (out_dir / "discovery_summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    out_dir = Path(args.out_dir)
    extensions = normalize_exts(args.extensions)
    records = build_records(
        roots=args.roots,
        max_depth=args.max_depth,
        max_files=args.max_files_per_root,
        extensions=extensions,
        follow_links=args.follow_links,
    )
    candidates = sorted(
        [record for record in records if record.score > 0],
        key=lambda record: (record.score, record.modified_at),
        reverse=True,
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    write_csv(out_dir / "internal_file_inventory.csv", records)
    write_csv(out_dir / "candidate_files.csv", candidates)
    write_summary(out_dir, records, candidates)

    print(f"Indexed files: {len(records)}")
    print(f"Candidate files: {len(candidates)}")
    print(f"Output: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
