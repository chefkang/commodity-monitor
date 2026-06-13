from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = ROOT / "dashboard"
PUBLIC = ROOT / "public"


def copy_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def main() -> int:
    if PUBLIC.exists():
        shutil.rmtree(PUBLIC)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "briefs").mkdir(parents=True, exist_ok=True)

    for filename in ["report.css", "report.js", "styles.css", "app.js", "data.js"]:
        copy_file(DASHBOARD / filename, PUBLIC / filename)

    assets = DASHBOARD / "assets"
    if assets.exists():
        shutil.copytree(assets, PUBLIC / "assets", dirs_exist_ok=True)

    asset_version = datetime.now().strftime("%Y%m%d%H%M%S")

    report_html = (DASHBOARD / "report.html").read_text(encoding="utf-8")
    report_html = report_html.replace('href="./index.html"', 'href="./trend.html"')
    report_html = report_html.replace('href="./report.css"', f'href="./report.css?v={asset_version}"')
    report_html = report_html.replace('src="./data.js"', f'src="./data.js?v={asset_version}"')
    report_html = report_html.replace('src="./report.js"', f'src="./report.js?v={asset_version}"')
    (PUBLIC / "index.html").write_text(report_html, encoding="utf-8")

    trend_html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
    trend_html = trend_html.replace('href="./report.html"', 'href="./index.html"')
    trend_html = trend_html.replace('href="./styles.css"', f'href="./styles.css?v={asset_version}"')
    trend_html = trend_html.replace('src="./data.js"', f'src="./data.js?v={asset_version}"')
    trend_html = trend_html.replace('src="./app.js"', f'src="./app.js?v={asset_version}"')
    trend_html = trend_html.replace('    <script src="./internal-quotes.js" data-local-only="true"></script>\n', "")
    (PUBLIC / "trend.html").write_text(trend_html, encoding="utf-8")

    briefs = ROOT / "briefs"
    if briefs.exists():
        for brief in briefs.glob("*.md"):
            copy_file(brief, PUBLIC / "briefs" / brief.name)

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
