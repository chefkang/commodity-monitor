"""Regression tests for the public package boundary and its runtime fallback.

All input files are synthetic and created in an owned temporary directory.  The
tests never inspect the project's real internal data or supplier quote file.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch


BUILDER_PATH = Path(__file__).resolve().with_name("build_public_site.py")
CANARY = "PRIVATE_CANARY_NOT_FOR_PUBLIC_OUTPUT"


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 11, 20, 14, 0, 0, tzinfo=tz)


class HtmlResources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stylesheets: list[str] = []
        self.links: list[str] = []
        self.inline_scripts: list[str] = []
        self._script_parts: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "link" and attributes.get("rel") == "stylesheet":
            self.stylesheets.append(attributes.get("href", ""))
        if tag == "a":
            self.links.append(attributes.get("href", ""))
        if tag == "script" and "src" not in attributes:
            self._script_parts = []

    def handle_data(self, data):
        if self._script_parts is not None:
            self._script_parts.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self._script_parts is not None:
            self.inline_scripts.append("".join(self._script_parts))
            self._script_parts = None


NODE_LOADER_RUNNER = r"""
const vm = require('node:vm');
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const mode = input.mode;
let nextTimer = 0;
let clock = 0;
const timers = new Map();
const requested = [];
const removed = [];
let publicScript = null;
let appStarts = 0;
const schedule = (callback, delay = 0) => {
  const id = ++nextTimer;
  timers.set(id, { callback, due: clock + Number(delay) });
  return id;
};
const localPayload = {
  generated_at: '2026-11-20T10:00:00+08:00',
  latest: [{ material_id: 'synthetic-public-material' }]
};
const publicPayload = {
  generated_at: '2026-11-20T10:10:00+08:00',
  latest: [{ material_id: 'synthetic-public-material' }]
};
const windowObject = {
  location: { protocol: 'http:', hostname: '127.0.0.1', pathname: '/trend.html' }
};
const context = {
  window: windowObject,
  URL,
  console,
  setTimeout: schedule,
  clearTimeout(id) { timers.delete(id); },
  document: {
    createElement(tag) {
      if (tag !== 'script') throw new Error('Unexpected element: ' + tag);
      return {
        setAttribute() {},
        remove() { this.removed = true; removed.push(String(this.src || '')); }
      };
    },
    body: {
      appendChild(script) {
        const src = String(script.src || '');
        requested.push(src);
        if (src.startsWith('./data.js')) {
          const completeLocalData = () => {
            windowObject.COMMODITY_MONITOR_DATA = localPayload;
            if (script.onload) script.onload();
          };
          if (mode === 'required_data_delayed') {
            // Required data is slow, not failed: it completes after the optional
            // upstream's 4.5-second cutoff.  A short global deadline must not
            // remove it and strand the application in its loading state.
            schedule(completeLocalData, 9000);
          } else {
            completeLocalData();
          }
        } else if (src.startsWith('https://')) {
          publicScript = script;
          if (mode === 'public_error') {
            if (script.onerror) script.onerror(new Error('Synthetic upstream failure'));
          } else if (mode === 'public_success') {
            windowObject.COMMODITY_MONITOR_DATA = publicPayload;
            if (script.onload) script.onload();
          }
          // public_timeout and required_data_delayed intentionally emit no public
          // callback; the optional upstream's own deadline must recover.
        } else if (/^\.\/app\.js(?:\?|$)/.test(src)) {
          appStarts += 1;
          if (script.onload) script.onload();
        } else {
          throw new Error('Unexpected public resource: ' + src);
        }
      }
    }
  }
};
vm.runInNewContext(input.script, context, { timeout: 1000 });
let timerSteps = 0;
while (timers.size) {
  if (++timerSteps > 50) throw new Error('Loader did not settle');
  const [id, timer] = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
  timers.delete(id);
  clock = timer.due;
  timer.callback();
}
// Browser/network callbacks may arrive late after an error or timeout.  They must
// not dispatch a second application instance or discard the established fallback.
if (publicScript && mode !== 'public_success' && publicScript.onload) {
  publicScript.onload();
}
process.stdout.write(JSON.stringify({
  requested,
  removed,
  appStarts,
  settledAt: clock,
  source: windowObject.COMMODITY_MONITOR_RUNTIME?.data_source,
  generatedAt: windowObject.COMMODITY_MONITOR_DATA?.generated_at
}));
"""


class PublicSiteBuildTests(unittest.TestCase):
    def setUp(self):
        owned_temp = tempfile.TemporaryDirectory(prefix="commodity-public-build-test-")
        self.addCleanup(owned_temp.cleanup)
        self.root = Path(owned_temp.name).resolve()
        self.dashboard = self.root / "dashboard"
        self.public = self.root / "public"
        self.briefs = self.root / "briefs"
        self.dashboard.mkdir()
        self.briefs.mkdir()
        (self.dashboard / "assets").mkdir()

        spec = importlib.util.spec_from_file_location("public_site_builder_under_test", BUILDER_PATH)
        assert spec is not None and spec.loader is not None
        self.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.builder)
        for name, value in (
            ("ROOT", self.root),
            ("DASHBOARD", self.dashboard),
            ("PUBLIC", self.public),
            ("datetime", FrozenDateTime),
        ):
            self.enterContext(patch.object(self.builder, name, value))

        old_loader = (
            "<!-- runtime-loader:start -->"
            '<script src="./internal-quotes.js"></script>'
            f'<script>window.MTN_INTERNAL_SUPPLIER_QUOTES = "{CANARY}";</script>'
            "<!-- runtime-loader:end -->"
        )
        for name, css, destination in (
            ("index.html", "styles.css", "report.html"),
            ("report.html", "report.css", "index.html"),
        ):
            stylesheets = (
                '<link rel="stylesheet" href="./styles.css?v=old-shared" />'
                '<link rel="stylesheet" href="./report.css?v=old-report" />'
                if name == "report.html"
                else f'<link rel="stylesheet" href="./{css}?v=old" />'
            )
            (self.dashboard / name).write_text(
                '<!doctype html><html><head>'
                f'{stylesheets}'
                '</head><body><h1>Synthetic public monitor</h1>'
                f'<a href="./{destination}">Related view</a>{old_loader}'
                '</body></html>',
                encoding="utf-8",
            )
        for name, contents in {
            "styles.css": "body { color: #edf2fa; background: #0b111b; }\n",
            "report.css": "body { color: #18202d; }\n",
            "app.js": "window.SYNTHETIC_PUBLIC_APP = true;\n",
            "report.js": "window.SYNTHETIC_PUBLIC_REPORT = true;\n",
            "data.js": 'window.COMMODITY_MONITOR_DATA = {"latest":[]};\n',
            "internal-quotes.js": f'window.MTN_INTERNAL_SUPPLIER_QUOTES = "{CANARY}";\n',
        }.items():
            (self.dashboard / name).write_text(contents, encoding="utf-8")
        (self.dashboard / "assets" / "synthetic-logo.png").write_bytes(b"\x89PNG\r\n\x1a\nSYNTHETIC")
        (self.briefs / "2026-11-20.md").write_text("# Synthetic public daily brief\n", encoding="utf-8")
        (self.briefs / "2026-11-20-procurement-notes.md").write_text(CANARY, encoding="utf-8")
        (self.root / ".private").mkdir()
        (self.root / ".private" / "synthetic-private.txt").write_text(CANARY, encoding="utf-8")
        self.source_bytes = {
            path: path.read_bytes()
            for base in (self.dashboard, self.briefs, self.root / ".private")
            for path in base.rglob("*")
            if path.is_file()
        }

    def build(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.builder.main(), 0)

    def public_snapshot(self):
        return {
            path.relative_to(self.public).as_posix(): path.read_bytes()
            for path in self.public.rglob("*")
            if path.is_file()
        }

    def test_public_package_excludes_internal_values_and_non_daily_notes(self):
        stale = self.public / "briefs" / "2026-09-08-procurement-notes.md"
        stale.parent.mkdir(parents=True)
        stale.write_text(CANARY, encoding="utf-8")

        self.build()
        snapshot = self.public_snapshot()
        self.assertIn("trend.html", snapshot)
        self.assertIn("index.html", snapshot)
        self.assertIn("briefs/2026-11-20.md", snapshot)
        self.assertEqual(
            snapshot["briefs/2026-11-20.md"],
            self.source_bytes[self.briefs / "2026-11-20.md"],
        )
        self.assertNotIn("internal-quotes.js", snapshot)
        self.assertNotIn("briefs/2026-11-20-procurement-notes.md", snapshot)
        self.assertFalse(stale.exists())
        for name, contents in snapshot.items():
            with self.subTest(public_file=name):
                self.assertNotIn(CANARY.encode(), contents)
        for name in ("index.html", "trend.html"):
            self.assertNotIn(b"internal-quotes.js", snapshot[name])
        for path, original in self.source_bytes.items():
            with self.subTest(original_source=path.relative_to(self.root).as_posix()):
                self.assertEqual(path.read_bytes(), original)

    def test_existing_stylesheet_query_is_replaced_with_generated_version(self):
        self.build()
        generated_versions = set()
        for html_name, css_names in (
            ("trend.html", ("styles.css",)),
            ("index.html", ("styles.css", "report.css")),
        ):
            resources = HtmlResources()
            resources.feed((self.public / html_name).read_text(encoding="utf-8"))
            with self.subTest(html=html_name):
                self.assertEqual(len(resources.stylesheets), len(css_names))
            for css_name in css_names:
                matches = [href for href in resources.stylesheets if urlsplit(href).path == f"./{css_name}"]
                with self.subTest(html=html_name, stylesheet=css_name):
                    self.assertEqual(len(matches), 1)
                    query = urlsplit(matches[0]).query
                    versions = parse_qs(query).get("v", [])
                    self.assertEqual(len(versions), 1)
                    self.assertTrue(versions[0])
                    self.assertNotIn("old", query)
                    generated_versions.add(versions[0])
        self.assertEqual(len(generated_versions), 1, "All public stylesheets must use this build's version")

    def test_public_report_and_trend_links_use_the_public_routes(self):
        self.build()
        for html_name, expected_link, local_link in (
            ("index.html", "./trend.html", "./index.html"),
            ("trend.html", "./index.html", "./report.html"),
        ):
            resources = HtmlResources()
            resources.feed((self.public / html_name).read_text(encoding="utf-8"))
            with self.subTest(html=html_name):
                self.assertIn(expected_link, resources.links)
                self.assertNotIn(local_link, resources.links)

    def test_repeated_build_with_unchanged_inputs_is_stable(self):
        self.build()
        first = self.public_snapshot()
        self.build()
        self.assertEqual(self.public_snapshot(), first)
        self.assertEqual(
            (self.briefs / "2026-11-20-procurement-notes.md").read_bytes(),
            self.source_bytes[self.briefs / "2026-11-20-procurement-notes.md"],
        )

    def simulate_loader(self, mode):
        self.build()
        resources = HtmlResources()
        resources.feed((self.public / "trend.html").read_text(encoding="utf-8"))
        self.assertEqual(len(resources.inline_scripts), 1)
        node = shutil.which("node")
        assert node is not None
        completed = subprocess.run(
            [node, "-e", NODE_LOADER_RUNNER],
            input=json.dumps({"mode": mode, "script": resources.inline_scripts[0]}),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    @unittest.skipUnless(shutil.which("node"), "Node is unavailable; public loader VM check skipped")
    def test_optional_upstream_error_or_timeout_still_starts_one_app(self):
        for mode in ("public_error", "public_timeout", "public_success"):
            with self.subTest(network_state=mode):
                result = self.simulate_loader(mode)
                self.assertEqual(result["appStarts"], 1, result)
                self.assertEqual(sum(url.startswith("https://") for url in result["requested"]), 1)
                self.assertFalse(any("internal-quotes" in url for url in result["requested"]))
                expected_source = "public" if mode == "public_success" else "local"
                self.assertEqual(result["source"], expected_source)
                expected_time = "10:10:00" if mode == "public_success" else "10:00:00"
                self.assertIn(expected_time, result["generatedAt"])

    @unittest.skipUnless(shutil.which("node"), "Node is unavailable; public loader VM check skipped")
    def test_required_data_can_finish_after_the_optional_timeout(self):
        result = self.simulate_loader("required_data_delayed")
        self.assertGreaterEqual(result["settledAt"], 9000)
        self.assertEqual(result["appStarts"], 1, result)
        self.assertFalse(
            any(
                url.startswith("./data.js") or url.startswith("./app.js")
                for url in result["removed"]
            ),
            result,
        )
        self.assertEqual(result["source"], "local")
        self.assertIn("10:00:00", result["generatedAt"])


if __name__ == "__main__":
    unittest.main()
