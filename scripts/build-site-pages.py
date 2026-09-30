#!/usr/bin/env python3
"""Writes docs/site/docs/ and docs/site/pricing/ from docs/site/index.html.

The site is one page with three views; GitHub Pages serves each view at its
own path so it can carry its own title, description and canonical URL.
Run after editing docs/site/index.html.
"""

import datetime
import pathlib
import re

SITE = pathlib.Path(__file__).resolve().parent.parent / "docs" / "site"
BASE = "https://liutianjie.github.io/LinkShell/"

PAGES = {
    "docs": {
        "title": "LinkShell 文档 | 安装、连接手机、自建网关",
        "description": "LinkShell 文档：安装 CLI、启动 host、用官方网关或自建网关连接手机、在终端里用 linkshell claude / codex 接力，以及常见问题。",
    },
    "pricing": {
        "title": "LinkShell 定价 | 免费使用，Pro 提供官方网关",
        "description": "LinkShell 全部功能免费，自建网关即可使用。Pro 每月 $1，提供官方网关：不用部署服务器，登录同一账号即可连接。",
    },
}


def replace_one(pattern: str, replacement: str, text: str) -> str:
    result, count = re.subn(pattern, lambda _: replacement, text, count=1)
    if count != 1:
        raise SystemExit(f"pattern not found: {pattern}")
    return result


def main() -> None:
    source = (SITE / "index.html").read_text(encoding="utf-8")
    for page, meta in PAGES.items():
        url = f"{BASE}{page}/"
        html = source
        html = replace_one(r'<meta charset="UTF-8" />', '<meta charset="UTF-8" />\n  <base href="../" />', html)
        html = replace_one(r"<title>[^<]*</title>", f"<title>{meta['title']}</title>", html)
        html = replace_one(r'<meta name="description"\s+content="[^"]*" />', f'<meta name="description"\n    content="{meta["description"]}" />', html)
        html = replace_one(r'<link rel="canonical" href="[^"]*" />', f'<link rel="canonical" href="{url}" />', html)
        html = replace_one(r'<meta property="og:title" content="[^"]*" />', f'<meta property="og:title" content="{meta["title"]}" />', html)
        html = replace_one(r'<meta property="og:description"\s+content="[^"]*" />', f'<meta property="og:description"\n    content="{meta["description"]}" />', html)
        html = replace_one(r'<meta property="og:url" content="[^"]*" />', f'<meta property="og:url" content="{url}" />', html)
        html = replace_one(r'<meta name="twitter:title" content="[^"]*" />', f'<meta name="twitter:title" content="{meta["title"]}" />', html)
        out = SITE / page / "index.html"
        out.parent.mkdir(exist_ok=True)
        out.write_text(html, encoding="utf-8")
        print(f"wrote {out.relative_to(SITE.parent.parent)}")

    today = datetime.date.today().isoformat()
    sitemap = SITE / "sitemap.xml"
    sitemap.write_text(re.sub(r"<lastmod>[^<]*</lastmod>", f"<lastmod>{today}</lastmod>", sitemap.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"sitemap dated {today}")


if __name__ == "__main__":
    main()
