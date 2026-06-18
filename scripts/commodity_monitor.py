from __future__ import annotations

import argparse
import csv
import email.utils
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus
from zoneinfo import ZoneInfo

import pandas as pd
import requests
from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "materials.json"
DATA_DIR = ROOT / "data"
DASHBOARD_DIR = ROOT / "dashboard"
BRIEFS_DIR = ROOT / "briefs"
OUTPUTS_DIR = ROOT / "outputs"
PRICE_CSV = DATA_DIR / "prices.csv"
LATEST_JSON = DATA_DIR / "latest.json"
NEWS_JSON = DATA_DIR / "news.json"
DASHBOARD_DATA = DASHBOARD_DIR / "data.js"
MANUAL_PRICE_CSV = DATA_DIR / "manual_prices.csv"
TIMEZONE = ZoneInfo("Asia/Shanghai")
AKSHARE_TIMEOUT_SECONDS = int(os.environ.get("COMMODITY_MONITOR_AKSHARE_TIMEOUT_SECONDS", "240"))


UP_KEYWORDS = [
    "上涨",
    "涨价",
    "上调",
    "反弹",
    "走强",
    "供应紧张",
    "短缺",
    "减产",
    "停产",
    "检修",
    "罢工",
    "制裁",
    "关税",
    "冲突",
    "中东",
    "红海",
    "库存下降",
    "出口限制",
    "surge",
    "rally",
    "rise",
    "higher",
    "shortage",
    "tight supply",
    "strike",
    "sanction",
    "tariff",
    "disruption",
    "conflict",
    "export ban",
]

DOWN_KEYWORDS = [
    "下跌",
    "走弱",
    "下调",
    "回落",
    "降价",
    "需求疲软",
    "库存增加",
    "过剩",
    "复产",
    "slump",
    "fall",
    "lower",
    "weak demand",
    "surplus",
    "oversupply",
]

NEWS_EXCLUDE_KEYWORDS = [
    "黑马",
    "股票",
    "股价",
    "涨停",
    "概念股",
    "财富号",
    "问询函",
    "可转换公司债券",
    "公告",
    "研报",
    "目标价",
]


@dataclass
class PriceRecord:
    date: str
    material_id: str
    material_name: str
    category: str
    price: float
    unit: str
    source: str
    provider: str
    symbol: str = ""
    source_date: str = ""
    daily_change_pct: float | None = None
    near_contract_price: float | None = None
    dominant_contract_price: float | None = None
    dom_basis_rate: float | None = None
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "date": self.date,
            "material_id": self.material_id,
            "material_name": self.material_name,
            "category": self.category,
            "price": self.price,
            "unit": self.unit,
            "source": self.source,
            "provider": self.provider,
            "symbol": self.symbol,
            "source_date": self.source_date or self.date,
            "daily_change_pct": self.daily_change_pct,
            "near_contract_price": self.near_contract_price,
            "dominant_contract_price": self.dominant_contract_price,
            "dom_basis_rate": self.dom_basis_rate,
            "notes": self.notes,
        }


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def ensure_dirs() -> None:
    for path in [DATA_DIR, DASHBOARD_DIR, BRIEFS_DIR, OUTPUTS_DIR]:
        path.mkdir(parents=True, exist_ok=True)


def log_status(message: str, *, stream: Any = sys.stdout) -> None:
    print(message, file=stream, flush=True)


def now_cn() -> datetime:
    return datetime.now(TIMEZONE)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def clean_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except TypeError:
        pass
    text = str(value).replace(",", "").replace("%", "").strip()
    if text in {"", "-", "nan", "None"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_yyyymmdd(value: Any) -> str:
    text = str(value).strip()
    if re.fullmatch(r"\d{8}", text):
        return datetime.strptime(text, "%Y%m%d").date().isoformat()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text
    raise ValueError(f"Cannot parse date: {value!r}")


def infer_mmdd(mmdd: str, today: date) -> str:
    month, day = [int(part) for part in mmdd.split("-")]
    guessed = date(today.year, month, day)
    if guessed > today + timedelta(days=7):
        guessed = date(today.year - 1, month, day)
    return guessed.isoformat()


def fetch_akshare_rows(start: date, end: date, symbols: list[str]) -> list[dict[str, Any]]:
    helper = """
import json
import sys
import warnings
from pathlib import Path

import akshare as ak

output_path = Path(sys.argv[1])
start_day = sys.argv[2]
end_day = sys.argv[3]
symbols = json.loads(sys.argv[4])

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    df = ak.futures_spot_price_daily(
        start_day=start_day,
        end_day=end_day,
        vars_list=symbols,
    )

output_path.write_text(df.to_json(orient="records", force_ascii=False), encoding="utf-8")
"""
    with tempfile.TemporaryDirectory(prefix="commodity-monitor-akshare-") as tmp_dir:
        output_path = Path(tmp_dir) / "akshare.json"
        try:
            completed = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    helper,
                    str(output_path),
                    start.strftime("%Y%m%d"),
                    end.strftime("%Y%m%d"),
                    json.dumps(symbols, ensure_ascii=False),
                ],
                capture_output=True,
                check=True,
                encoding="utf-8",
                text=True,
                timeout=AKSHARE_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"AKShare request timed out after {AKSHARE_TIMEOUT_SECONDS}s") from exc
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or exc.stdout or "").strip()
            message = detail.splitlines()[-1] if detail else f"exit code {exc.returncode}"
            raise RuntimeError(f"AKShare request failed: {message}") from exc

        if not output_path.exists():
            detail = (completed.stderr or completed.stdout or "").strip()
            raise RuntimeError(f"AKShare request finished without output: {detail or 'no details'}")

        raw = output_path.read_text(encoding="utf-8").strip()
    if not raw:
        return []
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        snippet = raw[:300]
        raise RuntimeError(f"AKShare returned invalid JSON: {snippet}") from exc


def fetch_akshare_records(config: dict[str, Any], start: date, end: date) -> list[PriceRecord]:
    materials = {
        item["symbol"]: item
        for item in config["materials"]
        if item.get("provider") == "akshare_basis" and item.get("symbol")
    }
    if not materials:
        return []

    symbols = list(materials.keys())
    records: list[PriceRecord] = []
    rows = fetch_akshare_rows(start, end, symbols)
    if not rows:
        return records

    for row in rows:
        symbol = str(row.get("symbol", "")).strip()
        material = materials.get(symbol)
        if not material:
            continue
        price = clean_float(row.get("spot_price"))
        if price is None:
            continue
        near = clean_float(row.get("near_contract_price"))
        dominant = clean_float(row.get("dominant_contract_price"))
        basis_rate = clean_float(row.get("dom_basis_rate"))
        source_date = parse_yyyymmdd(row.get("date"))
        records.append(
            PriceRecord(
                date=source_date,
                material_id=material["id"],
                material_name=material["name"],
                category=material["category"],
                price=price,
                unit=material.get("unit", "元/吨"),
                source=material.get("source_name", "AKShare"),
                provider="akshare_basis",
                symbol=symbol,
                source_date=source_date,
                near_contract_price=near,
                dominant_contract_price=dominant,
                dom_basis_rate=basis_rate,
            )
        )
    return records


def get_with_100ppi_check(session: requests.Session, url: str) -> str:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
        )
    }
    response = session.get(url, headers=headers, timeout=25)
    text = response.text
    if "HW_CHECK" in text and "安全检查" in text:
        match = re.search(r'var\s+_0x2\s*=\s*"([^"]+)"', text)
        if match:
            domain = re.sub(r"^https?://([^/]+).*$", r"\1", url)
            session.cookies.set("HW_CHECK", match.group(1), domain=domain, path="/")
            response = session.get(url, headers=headers, timeout=25)
            text = response.text
    response.raise_for_status()
    return text


def fetch_sunsirs_vane_records(config: dict[str, Any], today: date) -> list[PriceRecord]:
    records: list[PriceRecord] = []
    session = requests.Session()
    for material in config["materials"]:
        if material.get("provider") != "sunsirs_vane":
            continue
        url = material.get("url")
        if not url:
            continue
        try:
            html = get_with_100ppi_check(session, url)
            soup = BeautifulSoup(html, "lxml")
            lines = [line.strip() for line in soup.get_text("\n").splitlines() if line.strip()]
        except Exception as exc:
            log_status(
                f"Sunsirs fetch failed for {material['id']}: {type(exc).__name__}: {exc}",
                stream=sys.stderr,
            )
            records.append(
                PriceRecord(
                    date=today.isoformat(),
                    material_id=material["id"],
                    material_name=material["name"],
                    category=material["category"],
                    price=math.nan,
                    unit=material.get("unit", "元/吨"),
                    source=material.get("source_name", "生意社"),
                    provider="sunsirs_vane",
                    notes=f"抓取失败: {type(exc).__name__}: {exc}",
                )
            )
            continue

        table_start = None
        for idx, line in enumerate(lines):
            if line == "日期" and idx + 2 < len(lines) and lines[idx + 1] == "价格":
                table_start = idx + 3
                break
        if table_start is None:
            continue

        pos = table_start
        while pos + 2 < len(lines):
            raw_date, raw_price, raw_change = lines[pos], lines[pos + 1], lines[pos + 2]
            if not re.fullmatch(r"\d{2}-\d{2}", raw_date):
                break
            price = clean_float(raw_price)
            if price is not None:
                records.append(
                    PriceRecord(
                        date=infer_mmdd(raw_date, today),
                        material_id=material["id"],
                        material_name=material["name"],
                        category=material["category"],
                        price=price,
                        unit=material.get("unit", "元/吨"),
                        source=material.get("source_name", "生意社基准价"),
                        provider="sunsirs_vane",
                        source_date=infer_mmdd(raw_date, today),
                        daily_change_pct=clean_float(raw_change),
                    )
                )
            pos += 3
    return [record for record in records if not math.isnan(record.price)]


def load_manual_records(today: date) -> list[PriceRecord]:
    if not MANUAL_PRICE_CSV.exists():
        return []
    records: list[PriceRecord] = []
    with MANUAL_PRICE_CSV.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            price = clean_float(row.get("price"))
            if price is None:
                continue
            record_date = row.get("date") or today.isoformat()
            records.append(
                PriceRecord(
                    date=record_date,
                    material_id=row.get("material_id", "").strip(),
                    material_name=row.get("material_name", "").strip(),
                    category="供应商报价",
                    price=price,
                    unit=row.get("unit", "").strip(),
                    source=row.get("source", "供应商报价").strip(),
                    provider="manual",
                    source_date=record_date,
                    notes=row.get("notes", "").strip(),
                )
            )
    return records


def build_derived_records(config: dict[str, Any], base_records: list[PriceRecord]) -> list[PriceRecord]:
    by_material: dict[str, list[PriceRecord]] = defaultdict(list)
    for record in base_records:
        by_material[record.material_id].append(record)

    records: list[PriceRecord] = []
    for material in config["materials"]:
        if material.get("provider") != "derived_from":
            continue
        source_id = material.get("source_material_id")
        if not source_id:
            continue
        source_records = by_material.get(source_id, [])
        for source in source_records:
            records.append(
                PriceRecord(
                    date=source.date,
                    material_id=material["id"],
                    material_name=material["name"],
                    category=material["category"],
                    price=source.price,
                    unit=material.get("unit", source.unit),
                    source=material.get("source_name", f"{source.material_name}价格代理"),
                    provider="derived_from",
                    symbol=source.symbol,
                    source_date=source.source_date or source.date,
                    daily_change_pct=source.daily_change_pct,
                    near_contract_price=source.near_contract_price,
                    dominant_contract_price=source.dominant_contract_price,
                    dom_basis_rate=source.dom_basis_rate,
                    notes=material.get("notes", ""),
                )
            )
    return records


def merge_price_records(records: list[PriceRecord]) -> pd.DataFrame:
    new_df = pd.DataFrame([record.to_dict() for record in records])
    if PRICE_CSV.exists():
        existing = pd.read_csv(PRICE_CSV, encoding="utf-8-sig")
        combined = pd.concat([existing, new_df], ignore_index=True)
    else:
        combined = new_df
    if combined.empty:
        return combined
    combined["price"] = pd.to_numeric(combined["price"], errors="coerce")
    combined = combined.dropna(subset=["date", "material_id", "price"])
    combined["date"] = pd.to_datetime(combined["date"], errors="coerce").dt.date.astype(str)
    combined = combined.dropna(subset=["date"])
    combined = combined.sort_values(["material_id", "date", "provider"])
    combined = combined.drop_duplicates(subset=["date", "material_id"], keep="last")
    combined.to_csv(PRICE_CSV, index=False, encoding="utf-8-sig")
    return combined


def fetch_news(config: dict[str, Any], max_items: int = 50) -> list[dict[str, Any]]:
    session = requests.Session()
    headers = {"User-Agent": "Mozilla/5.0"}
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    min_published = now_cn() - timedelta(days=14)
    material_keywords = {
        str(keyword).lower()
        for material in config.get("materials", [])
        for keyword in material.get("keywords", [])
        if str(keyword).strip()
    }
    global_keywords = {
        "commodity",
        "supply",
        "shipping",
        "freight",
        "tariff",
        "sanctions",
        "red sea",
        "oil",
        "metals",
        "大宗",
        "供应",
        "减产",
        "关税",
        "制裁",
        "红海",
        "中东",
        "原油",
        "运费",
    }
    required_keywords = material_keywords | global_keywords
    for query in config.get("news_queries", []):
        recent_query = f"{query} when:14d"
        url = (
            "https://news.google.com/rss/search?q="
            + quote_plus(recent_query)
            + "&hl=zh-CN&gl=CN&ceid=CN:zh-Hans"
        )
        try:
            response = session.get(url, headers=headers, timeout=20)
            response.raise_for_status()
            root = ET.fromstring(response.content)
        except Exception:
            continue
        for item in root.findall(".//item")[:8]:
            title = (item.findtext("title") or "").strip()
            if not title or title in seen:
                continue
            lowered_title = title.lower()
            if any(keyword in lowered_title for keyword in NEWS_EXCLUDE_KEYWORDS):
                continue
            if not any(keyword in lowered_title for keyword in required_keywords):
                continue
            if title_has_stale_month(title, now_cn().date()):
                continue
            seen.add(title)
            link = (item.findtext("link") or "").strip()
            pub_raw = item.findtext("pubDate") or ""
            try:
                published_dt = email.utils.parsedate_to_datetime(pub_raw)
                published = published_dt.astimezone(TIMEZONE).isoformat()
            except Exception:
                published_dt = None
                published = pub_raw
            if published_dt and published_dt.astimezone(TIMEZONE) < min_published:
                continue
            source_el = item.find("source")
            source = source_el.text.strip() if source_el is not None and source_el.text else ""
            text = lowered_title
            up_hits = sum(1 for keyword in UP_KEYWORDS if keyword.lower() in text)
            down_hits = sum(1 for keyword in DOWN_KEYWORDS if keyword.lower() in text)
            signal = clamp(up_hits - down_hits, -3, 3)
            items.append(
                {
                    "title": title,
                    "link": link,
                    "source": source,
                    "published": published,
                    "query": query,
                    "signal": signal,
                }
            )
            if len(items) >= max_items:
                break
        if len(items) >= max_items:
            break
    items.sort(key=lambda x: x.get("published", ""), reverse=True)
    NEWS_JSON.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    return items


def title_has_stale_month(title: str, today: date) -> bool:
    months = [int(match.group(1)) for match in re.finditer(r"(?<!\d)(1[0-2]|[1-9])月", title)]
    if not months:
        return False
    allowed = {today.month, (today.month - 1) or 12}
    return all(month not in allowed for month in months)


def news_signal_for_material(material: dict[str, Any], news: list[dict[str, Any]]) -> tuple[float, list[dict[str, Any]]]:
    keywords = [str(keyword).lower() for keyword in material.get("keywords", [])]
    matched: list[dict[str, Any]] = []
    signal = 0.0
    for item in news:
        title = item.get("title", "")
        text = title.lower()
        if any(keyword and keyword in text for keyword in keywords):
            matched.append(item)
            signal += float(item.get("signal", 0))
    return clamp(signal, -4, 4), matched[:4]


def pct_since(group: pd.DataFrame, current_date: date, current_price: float, days: int) -> float | None:
    target = current_date - timedelta(days=days)
    prior = group[group["_date"] <= target]
    if prior.empty:
        return None
    old_price = clean_float(prior.iloc[-1]["price"])
    if old_price is None or old_price == 0:
        return None
    return (current_price / old_price - 1) * 100


def daily_change(group: pd.DataFrame, latest_row: pd.Series) -> float | None:
    explicit = clean_float(latest_row.get("daily_change_pct"))
    if explicit is not None:
        return explicit
    if len(group) < 2:
        return None
    prev = clean_float(group.iloc[-2]["price"])
    latest = clean_float(latest_row["price"])
    if prev is None or latest is None or prev == 0:
        return None
    return (latest / prev - 1) * 100


def volatility_30d(group: pd.DataFrame) -> float:
    recent = group.tail(30).copy()
    if len(recent) < 4:
        return 0.0
    returns = recent["price"].astype(float).pct_change().dropna() * 100
    if returns.empty:
        return 0.0
    return float(returns.std())


def make_latest(config: dict[str, Any], prices: pd.DataFrame, news: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if prices.empty:
        return [], {}

    prices = prices.copy()
    prices["_date"] = pd.to_datetime(prices["date"], errors="coerce").dt.date
    prices = prices.dropna(subset=["_date"])

    by_id = {item["id"]: item for item in config["materials"]}
    latest_rows: list[dict[str, Any]] = []

    for material_id, group in prices.sort_values(["material_id", "_date"]).groupby("material_id"):
        group = group.sort_values("_date")
        row = group.iloc[-1]
        current_price = float(row["price"])
        current_date = row["_date"]
        material = by_id.get(material_id, {})
        change_1d = daily_change(group, row)
        change_7d = pct_since(group, current_date, current_price, 7)
        change_30d = pct_since(group, current_date, current_price, 30)
        change_90d = pct_since(group, current_date, current_price, 90)
        vol = volatility_30d(group)

        future_premium_pct = None
        dominant = clean_float(row.get("dominant_contract_price"))
        if dominant is not None and current_price:
            future_premium_pct = (dominant / current_price - 1) * 100

        news_signal, matched_news = news_signal_for_material(material, news) if material else (0.0, [])
        score = 50.0
        if change_7d is not None:
            score += clamp(change_7d, -12, 12) * 1.1
        if change_30d is not None:
            score += clamp(change_30d, -25, 25) * 0.45
        if change_90d is not None:
            score += clamp(change_90d, -40, 40) * 0.18
        if future_premium_pct is not None:
            score += clamp(future_premium_pct * 1.8, -6, 6)
        score += news_signal * 3.5
        score += clamp(vol * 0.7, 0, 7)
        probability = int(round(clamp(score, 5, 95)))

        if probability >= config["settings"]["high_risk_threshold"]:
            risk_level = "高"
        elif probability >= config["settings"]["medium_risk_threshold"]:
            risk_level = "中偏高"
        elif probability >= 45:
            risk_level = "观察"
        else:
            risk_level = "低"

        if change_30d is not None and change_30d > 3:
            trend = "上行"
        elif change_30d is not None and change_30d < -3:
            trend = "下行"
        elif change_7d is not None and change_7d > 1:
            trend = "短线上行"
        elif change_7d is not None and change_7d < -1:
            trend = "短线下行"
        else:
            trend = "震荡"

        latest_rows.append(
            {
                "material_id": material_id,
                "material_name": row.get("material_name", material.get("name", material_id)),
                "category": row.get("category", material.get("category", "")),
                "date": row["date"],
                "price": round(current_price, 4),
                "unit": row.get("unit", material.get("unit", "")),
                "source": row.get("source", ""),
                "provider": row.get("provider", ""),
                "symbol": row.get("symbol", ""),
                "change_1d": round(change_1d, 2) if change_1d is not None else None,
                "change_7d": round(change_7d, 2) if change_7d is not None else None,
                "change_30d": round(change_30d, 2) if change_30d is not None else None,
                "change_90d": round(change_90d, 2) if change_90d is not None else None,
                "volatility_30d": round(vol, 2),
                "future_premium_pct": round(future_premium_pct, 2) if future_premium_pct is not None else None,
                "up_probability": probability,
                "risk_level": risk_level,
                "trend": trend,
                "impact_weight": material.get("impact_weight", 1),
                "matched_news": matched_news,
                "notes": row.get("notes", ""),
            }
        )

    weight_sum = sum(float(item.get("impact_weight", 1)) for item in latest_rows) or 1
    pressure_index = sum(
        float(item.get("impact_weight", 1)) * float(item.get("up_probability", 50))
        for item in latest_rows
    ) / weight_sum
    rising_count = sum(1 for item in latest_rows if (item.get("change_1d") or 0) > 0)
    high_risk_count = sum(1 for item in latest_rows if item.get("risk_level") == "高")
    news_risk = sum(1 for item in news[:20] if item.get("signal", 0) > 0)

    summary = {
        "pressure_index": round(pressure_index, 1),
        "rising_count": rising_count,
        "high_risk_count": high_risk_count,
        "tracked_count": len(latest_rows),
        "news_risk_count": news_risk,
    }
    latest_rows.sort(key=lambda item: (item["risk_level"] != "高", -item["up_probability"], item["material_name"]))
    return latest_rows, summary


def make_history(prices: pd.DataFrame, start_date: date) -> list[dict[str, Any]]:
    if prices.empty:
        return []
    df = prices.copy()
    df["_date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
    df = df[df["_date"] >= start_date]
    df = df.sort_values(["material_id", "_date"])
    return [
        {
            "date": row["date"],
            "material_id": row["material_id"],
            "material_name": row["material_name"],
            "price": round(float(row["price"]), 4),
            "unit": row.get("unit", ""),
            "source": row.get("source", ""),
            "provider": row.get("provider", ""),
            "source_date": row.get("source_date", row["date"]),
            "notes": row.get("notes", ""),
        }
        for _, row in df.iterrows()
    ]


def make_index_history(history: list[dict[str, Any]], latest: list[dict[str, Any]]) -> list[dict[str, Any]]:
    weights = {item["material_id"]: float(item.get("impact_weight", 1)) for item in latest}
    by_material: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in history:
        by_material[row["material_id"]].append(row)

    base_prices: dict[str, float] = {}
    for material_id, rows in by_material.items():
        rows.sort(key=lambda row: row["date"])
        if rows and rows[0]["price"]:
            base_prices[material_id] = float(rows[0]["price"])

    by_date: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for row in history:
        material_id = row["material_id"]
        base = base_prices.get(material_id)
        if not base:
            continue
        weight = weights.get(material_id, 1.0)
        by_date[row["date"]].append((float(row["price"]) / base * 100, weight))

    result = []
    for day, values in sorted(by_date.items()):
        weight_sum = sum(weight for _, weight in values) or 1
        index_value = sum(value * weight for value, weight in values) / weight_sum
        result.append({"date": day, "value": round(index_value, 2)})
    return result


def make_history_coverage(config: dict[str, Any], history: list[dict[str, Any]], start_date: date) -> list[dict[str, Any]]:
    by_material: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in history:
        by_material[row["material_id"]].append(row)

    coverage: list[dict[str, Any]] = []
    for material in config.get("materials", []):
        material_id = material["id"]
        rows = sorted(by_material.get(material_id, []), key=lambda row: row["date"])
        first_date = rows[0]["date"] if rows else None
        last_date = rows[-1]["date"] if rows else None
        first_dt = date.fromisoformat(first_date) if first_date else None
        is_full = bool(first_dt and first_dt <= start_date + timedelta(days=7))
        coverage.append(
            {
                "material_id": material_id,
                "material_name": material.get("name", material_id),
                "target_start_date": start_date.isoformat(),
                "first_date": first_date,
                "last_date": last_date,
                "count": len(rows),
                "provider": material.get("provider", ""),
                "source_name": material.get("source_name", ""),
                "full_from_target": is_full,
            }
        )
    return coverage


def make_brief(config: dict[str, Any], latest: list[dict[str, Any]], summary: dict[str, Any], news: list[dict[str, Any]]) -> dict[str, Any]:
    top_risers = sorted(
        [item for item in latest if item.get("change_1d") is not None],
        key=lambda item: item.get("change_1d") or 0,
        reverse=True,
    )[:5]
    top_fallers = sorted(
        [item for item in latest if item.get("change_1d") is not None],
        key=lambda item: item.get("change_1d") or 0,
    )[:5]
    high_risk = [item for item in latest if item.get("risk_level") == "高"][:6]

    actions: list[str] = []
    for item in high_risk[:4]:
        actions.append(
            f"{item['material_name']}涨价概率{item['up_probability']}%，建议核对未锁价订单、供应商交期和可替代料。"
        )
    if not actions:
        actions.append("目前未出现高风险品种，建议维持日度监控并重点观察短线上行品种。")

    return {
        "date": now_cn().date().isoformat(),
        "summary": summary,
        "top_risers": top_risers,
        "top_fallers": top_fallers,
        "high_risk": high_risk,
        "actions": actions,
        "news": news[:10],
        "cost_buckets": config.get("cost_buckets", []),
    }


def write_brief_markdown(brief: dict[str, Any]) -> Path:
    day = brief["date"]
    path = BRIEFS_DIR / f"{day}.md"
    lines = [
        f"# 大宗商品价格监测简报 {day}",
        "",
        "## 总览",
        f"- 采购成本压力指数: {brief['summary'].get('pressure_index', '-')}/100",
        f"- 高风险品种: {brief['summary'].get('high_risk_count', 0)} 个",
        f"- 今日上涨品种: {brief['summary'].get('rising_count', 0)} 个",
        f"- 跟踪品种: {brief['summary'].get('tracked_count', 0)} 个",
    ]
    refresh_warnings = brief["summary"].get("refresh_warnings", [])
    if refresh_warnings:
        lines.extend(["", "## 刷新告警"])
        for warning in refresh_warnings:
            lines.append(f"- {warning}")
    lines.extend(["", "## 高风险品种"])
    if brief["high_risk"]:
        for item in brief["high_risk"]:
            lines.append(
                f"- {item['material_name']}: {item['price']}{item['unit']}，"
                f"30日{fmt_pct(item.get('change_30d'))}，涨价概率{item['up_probability']}%，趋势{item['trend']}"
            )
    else:
        lines.append("- 暂无高风险品种。")

    lines.extend(["", "## 今日涨幅靠前"])
    for item in brief["top_risers"]:
        lines.append(f"- {item['material_name']}: {fmt_pct(item.get('change_1d'))}，{item['price']}{item['unit']}")

    lines.extend(["", "## 今日跌幅靠前"])
    for item in brief["top_fallers"]:
        lines.append(f"- {item['material_name']}: {fmt_pct(item.get('change_1d'))}，{item['price']}{item['unit']}")

    lines.extend(["", "## 采购动作"])
    for action in brief["actions"]:
        lines.append(f"- {action}")

    lines.extend(["", "## 新闻风险"])
    if brief["news"]:
        for item in brief["news"]:
            source = f" - {item['source']}" if item.get("source") else ""
            lines.append(f"- {item['title']}{source}")
    else:
        lines.append("- 暂未抓取到新闻。")

    lines.extend(
        [
            "",
            "> 提醒: 概率用于采购风险预警，不构成投资建议；供应商合同价应以实际报价、账期、物流和规格为准。",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def fmt_pct(value: Any) -> str:
    number = clean_float(value)
    if number is None:
        return "-"
    sign = "+" if number > 0 else ""
    return f"{sign}{number:.2f}%"


def write_dashboard_data(
    config: dict[str, Any],
    latest: list[dict[str, Any]],
    summary: dict[str, Any],
    history: list[dict[str, Any]],
    history_coverage: list[dict[str, Any]],
    index_history: list[dict[str, Any]],
    news: list[dict[str, Any]],
    brief: dict[str, Any],
) -> None:
    payload = {
        "generated_at": now_cn().isoformat(),
        "currency": config["settings"].get("base_currency", "CNY"),
        "summary": summary,
        "latest": latest,
        "history": history,
        "history_coverage": history_coverage,
        "index_history": index_history,
        "news": news[:30],
        "brief": brief,
        "cost_buckets": config.get("cost_buckets", []),
        "manual_watch_items": config.get("manual_watch_items", []),
        "sources": [
            "AKShare 期货现货与基差接口",
            "生意社商品基准价公开页面",
            "上游价格代理指标",
            "Google News RSS",
            "供应商人工报价文件 data/manual_prices.csv",
        ],
    }
    LATEST_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    js = "window.COMMODITY_MONITOR_DATA = "
    js += json.dumps(payload, ensure_ascii=False, indent=2)
    js += ";\n"
    DASHBOARD_DATA.write_text(js, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Daily commodity price monitor")
    parser.add_argument("--backfill-days", type=int, default=None, help="Days of history to refresh")
    parser.add_argument("--history-start", default=None, help="Start date for verified history, YYYY-MM-DD")
    parser.add_argument("--no-news", action="store_true", help="Skip news RSS fetch")
    args = parser.parse_args()

    ensure_dirs()
    config = load_config()
    today = now_cn().date()
    history_start_text = args.history_start or config["settings"].get("history_start_date")
    if args.backfill_days is not None:
        start = today - timedelta(days=args.backfill_days)
    elif history_start_text:
        start = date.fromisoformat(history_start_text)
    else:
        start = today - timedelta(days=int(config["settings"].get("lookback_days", 180)))

    log_status(f"Refreshing commodity data: {start.isoformat()} to {today.isoformat()}")
    records: list[PriceRecord] = []
    refresh_warnings: list[str] = []

    try:
        log_status("Fetching AKShare basis data...")
        akshare_records = fetch_akshare_records(config, start, today)
        log_status(f"AKShare basis records: {len(akshare_records)}")
        records.extend(akshare_records)
    except Exception as exc:
        warning = f"AKShare basis fetch failed: {type(exc).__name__}: {exc}"
        refresh_warnings.append(warning)
        log_status(warning, stream=sys.stderr)

    try:
        log_status("Fetching Sunsirs basis pages...")
        sunsirs_records = fetch_sunsirs_vane_records(config, today)
        log_status(f"Sunsirs basis records: {len(sunsirs_records)}")
        records.extend(sunsirs_records)
    except Exception as exc:
        warning = f"Sunsirs basis fetch failed: {type(exc).__name__}: {exc}"
        refresh_warnings.append(warning)
        log_status(warning, stream=sys.stderr)

    manual_records = load_manual_records(today)
    log_status(f"Manual quote records: {len(manual_records)}")
    records.extend(manual_records)

    derived_records = build_derived_records(config, records)
    log_status(f"Derived records: {len(derived_records)}")
    records.extend(derived_records)

    if not records:
        log_status("No price records were fetched.", stream=sys.stderr)
        return 2

    log_status("Merging price history...")
    prices = merge_price_records(records)
    if args.no_news:
        news = []
        log_status("Skipping news fetch (--no-news).")
    else:
        try:
            log_status("Fetching Google News RSS...")
            news = fetch_news(config)
            log_status(f"News items kept: {len(news)}")
        except Exception as exc:
            warning = f"News fetch failed: {type(exc).__name__}: {exc}"
            refresh_warnings.append(warning)
            log_status(warning, stream=sys.stderr)
            news = []
    latest, summary = make_latest(config, prices, news)
    history = make_history(prices, start)
    history_coverage = make_history_coverage(config, history, start)
    index_history = make_index_history(history, latest)
    if refresh_warnings:
        summary["refresh_warnings"] = refresh_warnings
    brief = make_brief(config, latest, summary, news)
    brief_path = write_brief_markdown(brief)
    summary["history_start_date"] = start.isoformat()
    write_dashboard_data(config, latest, summary, history, history_coverage, index_history, news, brief)

    log_status(f"Updated: {PRICE_CSV}")
    log_status(f"Generated dashboard data: {DASHBOARD_DATA}")
    log_status(f"Generated brief: {brief_path}")
    log_status(f"Procurement pressure index: {summary.get('pressure_index')}/100")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
