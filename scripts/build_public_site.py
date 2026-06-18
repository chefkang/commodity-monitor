from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = ROOT / "dashboard"
PUBLIC = ROOT / "public"
LOADER_START = "<!-- runtime-loader:start -->"
LOADER_END = "<!-- runtime-loader:end -->"


def copy_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def runtime_loader(app_script: str, asset_version: str, *, include_internal_quotes: bool = False) -> str:
    next_loader = f'loadScript("./{app_script}?v={asset_version}");'
    if include_internal_quotes:
        next_loader = (
            'loadScript("./internal-quotes.js?ts=" + stamp, function () {\n'
            f'            loadScript("./{app_script}?v={asset_version}");\n'
            '          }, { "data-local-only": "true" });'
        )

    return f"""    {LOADER_START}
    <script>
      (function () {{
        var stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
        var PUBLIC_DATA_URL = "https://chefkang.github.io/commodity-monitor/data.js";
        var PUBLIC_HOST_RE = /(^|\\.)chefkang\\.github\\.io$/i;
        var PUBLIC_LAG_TOLERANCE_MS = 3 * 60 * 1000;

        function loadScript(src, onload, attrs, onerror) {{
          var script = document.createElement("script");
          script.src = src;
          script.async = false;
          if (attrs) {{
            Object.keys(attrs).forEach(function (key) {{
              script.setAttribute(key, attrs[key]);
            }});
          }}
          if (onload) {{
            script.onload = onload;
          }}
          if (onerror) {{
            script.onerror = onerror;
          }}
          document.body.appendChild(script);
        }}

        function parseGeneratedAtMs(payload) {{
          var value = payload && payload.generated_at ? Date.parse(payload.generated_at) : NaN;
          return Number.isFinite(value) ? value : null;
        }}

        function latestCount(payload) {{
          return payload && Array.isArray(payload.latest) ? payload.latest.length : 0;
        }}

        function shouldCheckPublicData() {{
          var protocol = String(window.location.protocol || "").toLowerCase();
          var hostname = String(window.location.hostname || "").toLowerCase();
          if (protocol === "file:") {{
            return true;
          }}
          if (!hostname) {{
            return true;
          }}
          return !PUBLIC_HOST_RE.test(hostname);
        }}

        function shouldPreferCandidate(basePayload, candidatePayload) {{
          var baseGeneratedAt = parseGeneratedAtMs(basePayload);
          var candidateGeneratedAt = parseGeneratedAtMs(candidatePayload);

          if (candidateGeneratedAt !== null && baseGeneratedAt === null) {{
            return true;
          }}

          if (
            candidateGeneratedAt !== null &&
            baseGeneratedAt !== null &&
            candidateGeneratedAt > baseGeneratedAt + PUBLIC_LAG_TOLERANCE_MS
          ) {{
            return true;
          }}

          if (latestCount(candidatePayload) !== latestCount(basePayload)) {{
            if (candidateGeneratedAt === null) {{
              return baseGeneratedAt === null;
            }}
            return baseGeneratedAt === null || candidateGeneratedAt >= baseGeneratedAt;
          }}

          return false;
        }}

        function ensurePreferredDataSource(continueLoad) {{
          var localPayload = window.COMMODITY_MONITOR_DATA || {{}};
          var checkPublicData = shouldCheckPublicData();

          window.COMMODITY_MONITOR_RUNTIME = {{
            check_public_data: checkPublicData,
            public_data_url: PUBLIC_DATA_URL,
            public_lag_tolerance_ms: PUBLIC_LAG_TOLERANCE_MS,
            data_source: checkPublicData ? "local" : "public",
            data_source_label: checkPublicData ? "本地副本" : "公网实时结果",
            data_source_reason: ""
          }};

          if (!checkPublicData) {{
            continueLoad();
            return;
          }}

          loadScript(PUBLIC_DATA_URL + "?ts=" + stamp, function () {{
            var publicPayload = window.COMMODITY_MONITOR_DATA || {{}};
            if (shouldPreferCandidate(localPayload, publicPayload)) {{
              window.COMMODITY_MONITOR_RUNTIME.data_source = "public";
              window.COMMODITY_MONITOR_RUNTIME.data_source_label = "公网同步结果";
              window.COMMODITY_MONITOR_RUNTIME.data_source_reason = "当前页面自动优先使用比本地副本更新的公网结果。";
            }} else {{
              window.COMMODITY_MONITOR_DATA = localPayload;
            }}
            continueLoad();
          }}, null, function () {{
            window.COMMODITY_MONITOR_DATA = localPayload;
            continueLoad();
          }});
        }}

        loadScript("./data.js?ts=" + stamp, function () {{
          ensurePreferredDataSource(function () {{
            {next_loader}
          }});
        }});
      }})();
    </script>
    {LOADER_END}"""


def replace_loader(html: str, loader: str) -> str:
    start = html.find(LOADER_START)
    end = html.find(LOADER_END)
    if start == -1 or end == -1 or end < start:
        raise ValueError("runtime loader markers not found")
    end += len(LOADER_END)
    return html[:start] + loader + html[end:]


def main() -> int:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    briefs_public = PUBLIC / "briefs"
    briefs_public.mkdir(parents=True, exist_ok=True)

    for filename in ["report.css", "report.js", "styles.css", "app.js", "data.js"]:
        copy_file(DASHBOARD / filename, PUBLIC / filename)

    assets = DASHBOARD / "assets"
    if assets.exists():
        shutil.copytree(assets, PUBLIC / "assets", dirs_exist_ok=True)

    asset_version = datetime.now().strftime("%Y%m%d%H%M%S")

    report_html = (DASHBOARD / "report.html").read_text(encoding="utf-8")
    report_html = report_html.replace('href="./index.html"', 'href="./trend.html"')
    report_html = report_html.replace('href="./report.css"', f'href="./report.css?v={asset_version}"')
    report_html = replace_loader(report_html, runtime_loader("report.js", asset_version))
    (PUBLIC / "index.html").write_text(report_html, encoding="utf-8")

    trend_html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
    trend_html = trend_html.replace('href="./report.html"', 'href="./index.html"')
    trend_html = trend_html.replace('href="./styles.css"', f'href="./styles.css?v={asset_version}"')
    trend_html = replace_loader(
        trend_html,
        runtime_loader("app.js", asset_version, include_internal_quotes=False),
    )
    (PUBLIC / "trend.html").write_text(trend_html, encoding="utf-8")

    briefs = ROOT / "briefs"
    if briefs.exists():
        for existing in briefs_public.glob("*.md"):
            existing.unlink(missing_ok=True)
        for brief in briefs.glob("*.md"):
            copy_file(brief, briefs_public / brief.name)

    readme = f"""# 大宗商品价格日报在线版

这个目录由自动化流程生成，可直接发布到 GitHub Pages、Cloudflare Pages、Vercel 或任意静态网站服务器。

入口文件：
- `index.html`: 汇报式日报
- `trend.html`: 完整趋势看板

生成时间：{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
"""
    (PUBLIC / "README.md").write_text(readme, encoding="utf-8")

    headers = """/*
  Cache-Control: public, max-age=300
/data.js
  Cache-Control: public, max-age=300
/*.css
  Cache-Control: public, max-age=86400
/*.js
  Cache-Control: public, max-age=86400
"""
    (PUBLIC / "_headers").write_text(headers, encoding="utf-8")
    print(f"Built public site: {PUBLIC}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
