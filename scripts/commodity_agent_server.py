from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import time
import uuid
from collections import defaultdict
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import requests

try:
    import winreg
except ImportError:  # pragma: no cover - non-Windows fallback
    winreg = None


ROOT = Path(__file__).resolve().parents[1]
UI_DIR = ROOT / "agent_ui"
ASSETS_DIR = ROOT / "dashboard" / "assets"
CONFIG_PATH = ROOT / "config" / "materials.json"
SECRET_CONFIG_PATH = ROOT / "config" / "commodity_agent.secret.json"
LATEST_JSON = ROOT / "data" / "latest.json"
BRIEFS_DIR = ROOT / "briefs"
RUNTIME_DIR = ROOT / "runtime" / "agent"
SESSION_PATH = RUNTIME_DIR / "sessions.json"
LOG_PATH = RUNTIME_DIR / "agent.log"

PUBLIC_SITE_URL = "https://chefkang.github.io/commodity-monitor/"
DEFAULT_MODEL = "gpt-5.5"
DEFAULT_RESEARCH_MODEL = "o4-mini-deep-research"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
REQUEST_TIMEOUT = int(os.environ.get("COMMODITY_AGENT_TIMEOUT_SECONDS", "180"))
RESEARCH_TIMEOUT = int(os.environ.get("COMMODITY_AGENT_RESEARCH_TIMEOUT_SECONDS", "600"))


class AgentError(RuntimeError):
    """Expected runtime error returned to the UI."""


def ensure_runtime() -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def append_log(event: dict[str, Any]) -> None:
    ensure_runtime()
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def safe_load_json(path: Path) -> Any | None:
    try:
        return load_json(path)
    except (OSError, json.JSONDecodeError):
        return None


def clean_number(value: Any, digits: int = 2) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "-"
    text = f"{number:,.{digits}f}"
    return text.rstrip("0").rstrip(".")


def pct_text(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "-"
    sign = "+" if number > 0 else ""
    return f"{sign}{number:.2f}%"


def provider_label(provider: str) -> str:
    mapping = {
        "akshare_basis": "公开行情/期现基差",
        "sunsirs_vane": "公开基准价",
        "derived_from": "上游代理指标",
        "manual": "人工补录报价",
    }
    return mapping.get(provider or "", provider or "未知口径")


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", "", value).lower()


def read_recent_briefs(limit: int = 3) -> list[dict[str, str]]:
    if not BRIEFS_DIR.exists():
        return []
    items: list[dict[str, str]] = []
    for path in sorted(BRIEFS_DIR.glob("*.md"), reverse=True)[:limit]:
        items.append({"name": path.name, "content": path.read_text(encoding="utf-8")})
    return items


def build_material_catalog(config: dict[str, Any], latest_items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    latest_by_id = {item["material_id"]: item for item in latest_items}
    catalog: dict[str, dict[str, Any]] = {}
    for material in config.get("materials", []):
        material_id = material.get("id")
        if not material_id:
            continue
        merged = dict(material)
        merged["latest"] = latest_by_id.get(material_id)
        catalog[material_id] = merged
    return catalog


def detect_relevant_materials(
    question: str,
    catalog: dict[str, dict[str, Any]],
    latest_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    normalized = normalize_text(question)
    matched: list[dict[str, Any]] = []
    for material in catalog.values():
        latest = material.get("latest")
        if not latest:
            continue
        names = [str(material.get("name", ""))] + [str(keyword) for keyword in material.get("keywords", [])]
        if any(normalize_text(name) and normalize_text(name) in normalized for name in names):
            matched.append(latest)
    if matched:
        return matched[:6]
    ordered = sorted(
        latest_items,
        key=lambda item: (
            float(item.get("up_probability") or 0),
            float(item.get("impact_weight") or 0),
            float(item.get("change_30d") or 0),
        ),
        reverse=True,
    )
    return ordered[:6]


def build_history_map(history_rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in history_rows:
        material_id = row.get("material_id")
        if not material_id:
            continue
        grouped[material_id].append(row)
    for rows in grouped.values():
        rows.sort(key=lambda item: item.get("date", ""))
    return grouped


def summarize_material(item: dict[str, Any]) -> str:
    return (
        f"- {item.get('material_name', item.get('material_id'))}: "
        f"{clean_number(item.get('price'))} {item.get('unit', '')}, "
        f"1日 {pct_text(item.get('change_1d'))}, "
        f"7日 {pct_text(item.get('change_7d'))}, "
        f"30日 {pct_text(item.get('change_30d'))}, "
        f"90日 {pct_text(item.get('change_90d'))}, "
        f"风险 {item.get('up_probability', '-') }%, "
        f"趋势 {item.get('trend', '-')}, "
        f"口径 {provider_label(str(item.get('provider', '')))}, "
        f"来源 {item.get('source', '-')}"
    )


def summarize_history(material: dict[str, Any], history_map: dict[str, list[dict[str, Any]]]) -> list[str]:
    rows = history_map.get(material.get("material_id"), [])
    if not rows:
        return ["  - 暂无累计历史记录。"]
    tail = rows[-6:]
    values = ", ".join(f"{row.get('date')}: {clean_number(row.get('price'))}" for row in tail)
    return [f"  - 最近6条历史: {values}"]


def read_latest_payload() -> dict[str, Any]:
    if not LATEST_JSON.exists():
        raise AgentError("缺少 data/latest.json，请先运行今日刷新。")
    payload = load_json(LATEST_JSON)
    if not isinstance(payload, dict):
        raise AgentError("data/latest.json 格式异常，无法读取本地监测结果。")
    return payload


def snapshot_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "material_id": item.get("material_id"),
        "material_name": item.get("material_name", item.get("material_id")),
        "price_text": f"{clean_number(item.get('price'))} {item.get('unit', '')}".strip(),
        "change_1d_text": pct_text(item.get("change_1d")),
        "change_30d_text": pct_text(item.get("change_30d")),
        "up_probability": item.get("up_probability", "-"),
        "trend": item.get("trend", "-"),
        "basis_label": provider_label(str(item.get("provider", ""))),
        "source": item.get("source", "-"),
    }


def build_dynamic_prompts(
    top_risk: list[dict[str, Any]],
    top_risers: list[dict[str, Any]],
    news_items: list[dict[str, Any]],
) -> list[str]:
    risk_names = [str(item.get("material_name", item.get("material_id", ""))) for item in top_risk[:3] if item]
    riser_names = [str(item.get("material_name", item.get("material_id", ""))) for item in top_risers[:3] if item]

    prompts = ["今天哪些原材料最值得盯盘，为什么？"]
    if risk_names:
        prompts.append(f"请把{'、'.join(risk_names)}这几个高风险品种的短线风险、价格口径和采购动作分别讲清楚。")
    if riser_names:
        prompts.append(f"{'、'.join(riser_names)}今天为什么会排到涨幅前列？哪些是真实行情，哪些只是代理指标？")
    if news_items:
        prompts.append("请结合今天的本地监测和最新外部新闻，判断未来一周成本压力会不会抬升。")
    else:
        prompts.append("请基于今天的本地监测，判断未来一周成本压力会不会抬升，以及我该怎么安排采购节奏。")
    prompts.append("把今天的行情结论整理成老板能直接看的短汇报。")
    return prompts[:4]


def build_brief_summary_text(brief: dict[str, Any], summary: dict[str, Any]) -> str:
    brief_summary = brief.get("summary")
    if isinstance(brief_summary, str) and brief_summary.strip():
        return brief_summary.strip()

    pressure_index = summary.get("pressure_index")
    tracked_count = summary.get("tracked_count")
    rising_count = summary.get("rising_count")
    high_risk_count = summary.get("high_risk_count")
    news_risk_count = summary.get("news_risk_count")

    parts = []
    if pressure_index is not None:
        parts.append(f"当前成本压力指数 {clean_number(pressure_index, 1)}/100")
    if tracked_count is not None:
        parts.append(f"本地已跟踪 {tracked_count} 个品种")
    if rising_count is not None:
        parts.append(f"其中 {rising_count} 个品种今天上涨")
    if high_risk_count:
        parts.append(f"{high_risk_count} 个品种已进入高风险区")
    else:
        parts.append("当前没有品种进入高风险区")
    if news_risk_count:
        parts.append(f"另有 {news_risk_count} 条新闻扰动需要关注")
    return "；".join(parts) + "。"


def build_local_snapshot_payload() -> dict[str, Any]:
    latest_payload = read_latest_payload()
    latest_items = list(latest_payload.get("latest", []))
    summary = latest_payload.get("summary", {})
    brief = latest_payload.get("brief", {})
    news_items = list(latest_payload.get("news", []))

    top_risk = sorted(latest_items, key=lambda item: float(item.get("up_probability") or 0), reverse=True)[:5]
    top_risers = sorted(
        [item for item in latest_items if item.get("change_1d") is not None],
        key=lambda item: float(item.get("change_1d") or 0),
        reverse=True,
    )[:5]

    return {
        "ok": True,
        "generated_at": latest_payload.get("generated_at"),
        "summary": {
            "pressure_index": summary.get("pressure_index"),
            "tracked_count": summary.get("tracked_count"),
            "rising_count": summary.get("rising_count"),
            "high_risk_count": summary.get("high_risk_count"),
            "news_risk_count": summary.get("news_risk_count"),
            "history_start_date": summary.get("history_start_date"),
        },
        "brief_summary": build_brief_summary_text(brief, summary),
        "actions": [str(item) for item in brief.get("actions", [])[:4]],
        "top_risk": [snapshot_item(item) for item in top_risk],
        "top_risers": [snapshot_item(item) for item in top_risers],
        "news_headlines": [
            {
                "title": str(item.get("title", "")),
                "source": str(item.get("source", "")),
            }
            for item in news_items[:5]
            if item.get("title")
        ],
        "focus_materials": [str(item.get("material_name", item.get("material_id", ""))) for item in top_risk[:3]],
        "prompts": build_dynamic_prompts(top_risk, top_risers, news_items),
    }


def build_local_context(question: str) -> tuple[str, dict[str, Any]]:
    config = load_json(CONFIG_PATH)
    latest_payload = read_latest_payload()
    latest_items = list(latest_payload.get("latest", []))
    history_map = build_history_map(list(latest_payload.get("history", [])))
    catalog = build_material_catalog(config, latest_items)
    focus_items = detect_relevant_materials(question, catalog, latest_items)

    summary = latest_payload.get("summary", {})
    top_risk = sorted(latest_items, key=lambda item: float(item.get("up_probability") or 0), reverse=True)[:8]
    top_risers = sorted(
        [item for item in latest_items if item.get("change_1d") is not None],
        key=lambda item: float(item.get("change_1d") or 0),
        reverse=True,
    )[:6]
    briefs = read_recent_briefs(limit=3)

    context_lines = [
        "你正在读取这个项目的本地公开监测结果，不允许假设任何内部采购、库存、BOM 或供应商私有报价数据。",
        f"本地最新刷新时间: {latest_payload.get('generated_at', '-')}",
        f"公开站点: {PUBLIC_SITE_URL}",
        (
            "监测概览: "
            f"压力指数 {summary.get('pressure_index', '-')}/100, "
            f"跟踪品种 {summary.get('tracked_count', '-')}, "
            f"今日上涨 {summary.get('rising_count', '-')}, "
            f"高风险 {summary.get('high_risk_count', '-')}, "
            f"新闻风险 {summary.get('news_risk_count', '-')}, "
            f"累计历史起点 {summary.get('history_start_date', '-')}"
        ),
        "必须明确区分口径: 公开行情/公开基准价 = 可公开市场口径；上游代理指标 = 趋势代理，不等于该材料真实成交价；人工补录报价 = 仅当上下文里明确出现时才能说明它是本地补录。",
        "",
        "与当前问题最相关的本地品种:",
    ]
    for item in focus_items:
        context_lines.append(summarize_material(item))
        context_lines.extend(summarize_history(item, history_map))

    context_lines.extend(["", "整体高风险排序前8:"])
    context_lines.extend(summarize_material(item) for item in top_risk)
    context_lines.extend(["", "今日涨幅靠前6个品种:"])
    context_lines.extend(summarize_material(item) for item in top_risers)

    recent_actions = latest_payload.get("brief", {}).get("actions", [])
    if recent_actions:
        context_lines.extend(["", "今日简报建议动作:"])
        context_lines.extend(f"- {action}" for action in recent_actions[:6])

    if briefs:
        context_lines.extend(["", "最近3份本地简报摘录:"])
        for brief in briefs:
            snippet = "\n".join(brief["content"].splitlines()[:18]).strip()
            context_lines.append(f"--- {brief['name']} ---")
            context_lines.append(snippet)

    local_summary = {
        "generated_at": latest_payload.get("generated_at"),
        "focus_materials": [item.get("material_name", item.get("material_id")) for item in focus_items],
        "tracked_count": summary.get("tracked_count"),
        "pressure_index": summary.get("pressure_index"),
    }
    return "\n".join(context_lines), local_summary


def build_instructions(mode: str) -> str:
    model_style = "更长、更完整的联网研究答复" if mode == "research" else "简洁但专业的业务答复"
    return (
        "你是迈瑟伦大宗商品价格监测与行情分析助手。"
        "你的首要依据是用户提供的本地公开监测上下文，其次才是联网检索。"
        "回答必须使用中文，面向采购和经营判断，给出明确结论、原因、风险和动作。"
        "如果引用联网信息，必须把结论和本地监测数据区分开，并尽量附来源。"
        "如果本地数据与联网信息时间不同，必须写清具体日期和时间。"
        "如果某项价格只是上游代理指标，不能把它说成该材料真实成交价。"
        "不要编造内部数据，不要要求访问 .private、data/internal 或 runtime/internal。"
        f"本轮回答风格: {model_style}。"
    )


def build_user_input(question: str, local_context: str) -> str:
    return (
        "下面是这个项目的本地公开监测上下文，请先用它建立判断，再决定是否需要联网搜索补充。\n\n"
        f"{local_context}\n\n"
        "用户问题如下，请直接回答，不要复述整段上下文。\n"
        f"{question}"
    )


def extract_output_text(response_payload: dict[str, Any]) -> str:
    chunks: list[str] = []
    for item in response_payload.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                chunks.append(str(content["text"]))
    if chunks:
        return "\n\n".join(chunk.strip() for chunk in chunks if chunk.strip()).strip()
    if response_payload.get("output_text"):
        return str(response_payload["output_text"]).strip()
    return ""


def extract_citations(response_payload: dict[str, Any]) -> list[dict[str, str]]:
    citations: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for item in response_payload.get("output", []):
        if item.get("type") == "message":
            for content in item.get("content", []):
                for annotation in content.get("annotations", []):
                    if annotation.get("type") != "url_citation":
                        continue
                    url = str(annotation.get("url", "")).strip()
                    title = str(annotation.get("title", "")).strip() or url
                    key = (title, url)
                    if url and key not in seen:
                        seen.add(key)
                        citations.append({"title": title, "url": url})
        if item.get("type") == "web_search_call":
            for source in item.get("action", {}).get("sources", []):
                url = str(source.get("url", "")).strip()
                title = str(source.get("title", "")).strip() or url
                key = (title, url)
                if url and key not in seen:
                    seen.add(key)
                    citations.append({"title": title, "url": url})
    return citations


def read_sessions() -> dict[str, Any]:
    ensure_runtime()
    if not SESSION_PATH.exists():
        return {}
    try:
        return load_json(SESSION_PATH)
    except json.JSONDecodeError:
        return {}


def write_sessions(payload: dict[str, Any]) -> None:
    ensure_runtime()
    write_json(SESSION_PATH, payload)


def read_secret_settings() -> dict[str, str]:
    payload = safe_load_json(SECRET_CONFIG_PATH)
    if not isinstance(payload, dict):
        return {}
    result: dict[str, str] = {}
    mapping = {
        "openai_api_key": "api_key",
        "openai_base_url": "base_url",
        "openai_project": "project",
        "commodity_agent_model": "quick_model",
        "commodity_agent_research_model": "research_model",
    }
    for source_key, target_key in mapping.items():
        value = payload.get(source_key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            result[target_key] = text
    return result


def read_windows_env_settings() -> dict[str, tuple[str, str]]:
    if os.name != "nt" or winreg is None:
        return {}

    result: dict[str, tuple[str, str]] = {}
    lookup_items = {
        "OPENAI_API_KEY": "api_key",
        "OPENAI_BASE_URL": "base_url",
        "OPENAI_PROJECT": "project",
        "COMMODITY_AGENT_MODEL": "quick_model",
        "COMMODITY_AGENT_RESEARCH_MODEL": "research_model",
    }
    key_specs = [
        (winreg.HKEY_CURRENT_USER, r"Environment", "windows_user_env"),
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment", "windows_machine_env"),
    ]

    for root_key, sub_key, source_name in key_specs:
        try:
            handle = winreg.OpenKey(root_key, sub_key)
        except OSError:
            continue

        with handle:
            for source_key, target_key in lookup_items.items():
                if target_key in result:
                    continue
                try:
                    value, _ = winreg.QueryValueEx(handle, source_key)
                except OSError:
                    continue
                text = str(value).strip()
                if text:
                    result[target_key] = (text, source_name)
    return result


def runtime_settings() -> dict[str, Any]:
    settings: dict[str, Any] = {
        "api_key": "",
        "base_url": DEFAULT_OPENAI_BASE_URL,
        "project": "",
        "quick_model": DEFAULT_MODEL,
        "research_model": DEFAULT_RESEARCH_MODEL,
        "key_source": "missing",
        "base_url_source": "default",
        "project_source": "default",
        "quick_model_source": "default",
        "research_model_source": "default",
    }

    windows_env = read_windows_env_settings()
    for field, (value, source_name) in windows_env.items():
        if field == "api_key":
            settings["key_source"] = source_name
        else:
            settings[f"{field}_source"] = source_name
        settings[field] = value

    secret_settings = read_secret_settings()
    for field, value in secret_settings.items():
        if field == "api_key":
            settings["key_source"] = "secret_file"
        else:
            settings[f"{field}_source"] = "secret_file"
        settings[field] = value

    env_settings = {
        "api_key": os.environ.get("OPENAI_API_KEY", "").strip(),
        "base_url": os.environ.get("OPENAI_BASE_URL", "").strip(),
        "project": os.environ.get("OPENAI_PROJECT", "").strip(),
        "quick_model": os.environ.get("COMMODITY_AGENT_MODEL", "").strip(),
        "research_model": os.environ.get("COMMODITY_AGENT_RESEARCH_MODEL", "").strip(),
    }
    for field, value in env_settings.items():
        if not value:
            continue
        if field == "api_key":
            settings["key_source"] = "process_env"
        else:
            settings[f"{field}_source"] = "process_env"
        settings[field] = value

    settings["base_url"] = str(settings["base_url"]).rstrip("/") or DEFAULT_OPENAI_BASE_URL
    settings["key_configured"] = bool(settings["api_key"])
    settings["key_source_label"] = {
        "missing": "未配置",
        "process_env": "当前进程环境变量",
        "secret_file": "本地 secret 配置文件",
        "windows_user_env": "Windows 用户环境变量",
        "windows_machine_env": "Windows 系统环境变量",
    }.get(str(settings["key_source"]), str(settings["key_source"]))
    return settings


def get_api_key(settings: dict[str, Any]) -> str:
    api_key = str(settings.get("api_key", "")).strip()
    if not api_key:
        raise AgentError(
            "未检测到 OpenAI key。请先配置 OPENAI_API_KEY，或在 config/commodity_agent.secret.json 中写入 openai_api_key。"
        )
    return api_key


def call_openai(
    *,
    question: str,
    mode: str,
    previous_response_id: str | None,
    local_context: str,
) -> tuple[dict[str, Any], str | None, str]:
    settings = runtime_settings()
    api_key = get_api_key(settings)
    model = settings["research_model"] if mode == "research" else settings["quick_model"]
    timeout = RESEARCH_TIMEOUT if mode == "research" else REQUEST_TIMEOUT
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Client-Request-Id": str(uuid.uuid4()),
    }
    if settings["project"]:
        headers["OpenAI-Project"] = settings["project"]

    payload: dict[str, Any] = {
        "model": model,
        "instructions": build_instructions(mode),
        "input": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": build_user_input(question, local_context),
                    }
                ],
            }
        ],
        "tools": [{"type": "web_search"}],
        "include": ["web_search_call.action.sources"],
        "max_output_tokens": 2800 if mode == "research" else 1800,
        "store": True,
    }
    if previous_response_id:
        payload["previous_response_id"] = previous_response_id

    started = time.time()
    response = requests.post(
        f"{settings['base_url']}/responses",
        headers=headers,
        json=payload,
        timeout=timeout,
    )
    elapsed = round(time.time() - started, 2)
    request_id = response.headers.get("x-request-id")

    if response.status_code >= 400:
        detail = response.text
        try:
            error_payload = response.json()
            detail = error_payload.get("error", {}).get("message", detail)
        except ValueError:
            pass
        append_log(
            {
                "ts": now_iso(),
                "kind": "openai_error",
                "model": model,
                "status_code": response.status_code,
                "elapsed_seconds": elapsed,
                "request_id": request_id,
                "detail": detail,
            }
        )
        raise AgentError(f"OpenAI 请求失败: {detail}")

    response_payload = response.json()
    append_log(
        {
            "ts": now_iso(),
            "kind": "openai_success",
            "model": model,
            "elapsed_seconds": elapsed,
            "request_id": request_id,
            "response_id": response_payload.get("id"),
        }
    )
    return response_payload, request_id, str(model)


def answer_question(question: str, mode: str, session_id: str, reset_session: bool) -> dict[str, Any]:
    question = question.strip()
    if not question:
        raise AgentError("请输入要分析的问题。")
    if mode not in {"quick", "research"}:
        raise AgentError("mode 只支持 quick 或 research。")

    sessions = read_sessions()
    if reset_session:
        sessions.pop(session_id, None)

    local_context, local_summary = build_local_context(question)
    previous_response_id = sessions.get(session_id, {}).get("previous_response_id")
    response_payload, request_id, used_model = call_openai(
        question=question,
        mode=mode,
        previous_response_id=previous_response_id,
        local_context=local_context,
    )

    response_id = str(response_payload.get("id", "")).strip()
    if response_id:
        sessions[session_id] = {
            "previous_response_id": response_id,
            "updated_at": now_iso(),
            "mode": mode,
        }
        write_sessions(sessions)

    answer = extract_output_text(response_payload)
    if not answer:
        raise AgentError("模型返回为空，未生成可展示的文本。")

    return {
        "answer": answer,
        "citations": extract_citations(response_payload),
        "response_id": response_id,
        "request_id": request_id,
        "mode": mode,
        "model": used_model,
        "local_summary": local_summary,
        "updated_at": now_iso(),
    }


def status_payload(port: int) -> dict[str, Any]:
    latest_generated_at = None
    tracked_count = None
    if LATEST_JSON.exists():
        try:
            latest_payload = read_latest_payload()
            latest_generated_at = latest_payload.get("generated_at")
            tracked_count = latest_payload.get("summary", {}).get("tracked_count")
        except (AgentError, json.JSONDecodeError):
            latest_generated_at = "invalid-json"

    settings = runtime_settings()
    return {
        "ok": True,
        "key_configured": settings["key_configured"],
        "key_source": settings["key_source"],
        "key_source_label": settings["key_source_label"],
        "latest_generated_at": latest_generated_at,
        "tracked_count": tracked_count,
        "public_site_url": PUBLIC_SITE_URL,
        "local_agent_url": f"http://127.0.0.1:{port}/",
        "quick_model": settings["quick_model"],
        "research_model": settings["research_model"],
        "openai_base_url": settings["base_url"],
        "secret_config_path": str(SECRET_CONFIG_PATH),
    }


class AgentHandler(BaseHTTPRequestHandler):
    server_version = "CommodityAgent/0.1"

    def log_message(self, format: str, *args: Any) -> None:
        append_log({"ts": now_iso(), "kind": "http", "message": format % args})

    def do_GET(self) -> None:
        if self.path in {"/", "/index.html"}:
            self.serve_file(UI_DIR / "index.html", "text/html; charset=utf-8")
            return
        if self.path == "/app.js":
            self.serve_file(UI_DIR / "app.js", "application/javascript; charset=utf-8")
            return
        if self.path == "/styles.css":
            self.serve_file(UI_DIR / "styles.css", "text/css; charset=utf-8")
            return
        if self.path.startswith("/assets/"):
            asset_path = ASSETS_DIR / self.path.removeprefix("/assets/")
            self.serve_file(asset_path)
            return
        if self.path == "/api/status":
            self.send_json(status_payload(self.server.server_port))
            return
        if self.path == "/api/local-snapshot":
            try:
                self.send_json(build_local_snapshot_payload())
            except AgentError as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not Found")

    def do_POST(self) -> None:
        if self.path == "/api/query":
            self.handle_query()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not Found")

    def handle_query(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
            question = str(payload.get("question", ""))
            mode = str(payload.get("mode", "quick"))
            session_id = str(payload.get("session_id", "")).strip() or str(uuid.uuid4())
            reset_session = bool(payload.get("reset_session"))
            result = answer_question(question, mode, session_id, reset_session)
            result["session_id"] = session_id
            self.send_json({"ok": True, **result})
        except AgentError as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
        except requests.Timeout:
            self.send_json({"ok": False, "error": "OpenAI 请求超时，请稍后再试。"}, status=HTTPStatus.GATEWAY_TIMEOUT)
        except Exception as exc:  # pragma: no cover - defensive path
            append_log({"ts": now_iso(), "kind": "unhandled_error", "detail": repr(exc)})
            self.send_json({"ok": False, "error": f"服务异常: {type(exc).__name__}: {exc}"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def serve_file(self, path: Path, content_type: str | None = None) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Not Found")
            return
        body = path.read_bytes()
        mime = content_type or (mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local commodity monitor AI agent server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("COMMODITY_AGENT_PORT", "8787")))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    ensure_runtime()
    if not UI_DIR.exists():
        raise SystemExit("agent_ui directory is missing.")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), AgentHandler)
    print(f"Commodity agent listening on http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
