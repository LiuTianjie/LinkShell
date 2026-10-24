#!/usr/bin/env python3
"""Writes the site's pages, its sitemap and its 404 page from docs/site/index.src.html.

The source is one bilingual document with three views (home, docs, pricing). Every view in
every language gets its own address, so each page a search engine sees has one language,
one view, one <h1>, and its own title, description, canonical URL, hreflang alternates,
social cards and structured data:

    /            /docs/            /pricing/          (Chinese; the root is x-default)
    /en/         /en/docs/         /en/pricing/       (English)

Run after editing docs/site/index.src.html. Never edit the generated index.html files.
"""

import datetime
import html
import json
import pathlib
import re

SITE = pathlib.Path(__file__).resolve().parent.parent / "docs" / "site"
BASE = "https://linkshell.itool.tech/"
GITHUB = "https://github.com/LiuTianjie/LinkShell"
APP_STORE = "https://apps.apple.com/cn/app/linkshell/id6761547516"
GITHUB_PAGES_REDIRECT = (
    '<script>if(location.hostname.endsWith("github.io"))location.replace("https://linkshell.itool.tech"'
    '+location.pathname.replace(/^\\/LinkShell/i,"")+location.search+location.hash)</script>'
)
PRODUCT_HUNT = "https://www.producthunt.com/products/linkshell"

LANGS = {
    "zh": {"prefix": "", "html": "zh-CN", "og": "zh_CN", "og_image": "assets/og.png"},
    "en": {"prefix": "en/", "html": "en", "og": "en_US", "og_image": "assets/og-en.png"},
}
VIEWS = {"home": "", "docs": "docs/", "pricing": "pricing/"}

META = {
    ("zh", "home"): {
        "title": "LinkShell | 手机远程控制 Claude Code、Codex 编程 Agent",
        "description": "LinkShell 让 Claude Code、Codex、Gemini CLI 等编程 Agent 留在电脑上运行，你在 iPhone、Android、手表或锁屏上看进度、审批、插话；还能远程控制 Mac 桌面。端到端加密，可自建网关。",
        "keywords": "LinkShell, 手机远程控制 Claude Code, Codex 手机, 编程 Agent, AI 编程助手, 远程桌面, Mac 远程控制, 远程终端, iOS, Android, 端到端加密, 自建网关",
        "image_alt": "LinkShell 首页：离开电脑，Agent 接着干，手机上收到 Claude 的审批请求",
    },
    ("zh", "docs"): {
        "title": "LinkShell 文档 | 安装、连接手机、自建网关",
        "description": "LinkShell 文档：安装 Mac / Windows 桌面 App 或 CLI，启动 Host，用官方网关或自建网关连接手机，远程桌面，在终端里用 linkshell claude / codex 接力，以及常见问题。",
        "keywords": "LinkShell 文档, LinkShell 安装, 自建网关, linkshell claude, linkshell codex, 远程桌面, 连接手机",
        "image_alt": "LinkShell：在手机上继续电脑里的编程 Agent",
    },
    ("zh", "pricing"): {
        "title": "LinkShell 定价 | 免费使用，Pro 提供官方网关",
        "description": "LinkShell 全部功能免费，自建网关即可使用。Pro 每月 ¥9.9 或每年 ¥99，提供官方网关：不用部署服务器，登录同一账号即可连接，连接始终端到端加密。",
        "keywords": "LinkShell 定价, LinkShell Pro, 官方网关, 免费, 自建网关",
        "image_alt": "LinkShell：在手机上继续电脑里的编程 Agent",
    },
    ("en", "home"): {
        "title": "LinkShell: Control Claude Code and Codex from Your Phone",
        "description": "Follow, approve and steer Claude Code, Codex and other coding agents on your computer from iPhone or Android. Remote Mac desktop, end-to-end encrypted.",
        "keywords": "LinkShell, Claude Code mobile, Codex on phone, remote control coding agent, AI coding agent, remote desktop, remote Mac, remote terminal, iOS, Android, end-to-end encryption, self-hosted gateway",
        "image_alt": "LinkShell's home page: leave your desk, your agents keep going, with a request from Claude on the phone",
    },
    ("en", "docs"): {
        "title": "LinkShell Docs: Install, Connect Your Phone, Self-Host",
        "description": "Install LinkShell on Mac, Windows or Linux, connect your phone through the official or a self-hosted gateway, and hand off Claude Code and Codex sessions.",
        "keywords": "LinkShell docs, install LinkShell, self-hosted gateway, linkshell claude, linkshell codex, remote screen, pair phone",
        "image_alt": "LinkShell: follow the coding agents on your computer from your phone",
    },
    ("en", "pricing"): {
        "title": "LinkShell Pricing: Free, or Pro for ¥9.9 a Month",
        "description": "Every LinkShell feature is free with your own gateway. Pro, ¥9.9 a month or ¥99 a year, adds the official gateway: no server to run, just sign in.",
        "keywords": "LinkShell pricing, LinkShell Pro, official gateway, free, self-hosted gateway",
        "image_alt": "LinkShell: follow the coding agents on your computer from your phone",
    },
}

APP_DESCRIPTION = {
    "zh": "在手机上关注、审批和指挥电脑上运行的编程 Agent（Claude Code、Codex、Gemini CLI、GitHub Copilot 等），并提供远程桌面、终端和本地网页预览。端到端加密，可自建网关。",
    "en": "Follow, steer and approve the coding agents running on your computer (Claude Code, Codex, Gemini CLI, GitHub Copilot and more) from your phone, with remote desktop control, a terminal and local web previews. End-to-end encrypted, with a self-hostable gateway.",
}
CRUMB = {"zh": {"home": "首页", "docs": "文档", "pricing": "定价"}, "en": {"home": "Home", "docs": "Docs", "pricing": "Pricing"}}
FILM = {
    # The cuts' first publication (git history) and their length (49.9 s).
    "zh": {"name": "LinkShell 介绍片", "video": "assets/promo/linkshell-2.0.mp4", "still": "assets/promo/film.jpg", "uploaded": "2026-09-30T22:36:03-07:00"},
    "en": {"name": "LinkShell film", "video": "assets/promo/linkshell-en.mp4", "still": "assets/promo/film-en.jpg", "uploaded": "2026-10-20T05:29:57+08:00"},
}
THEME_LABEL = {"zh": "切换浅色或深色模式", "en": "Toggle light / dark"}

CJK = re.compile(r"[　-鿿＀-￯]")
LANG_TAG = re.compile(r'<(/?)(span|a)(?=[\s>])([^>]*)>')
RAW = re.compile(r"(<script\b.*?</script>|<style\b.*?</style>)", re.S)


def url(lang: str, view: str) -> str:
    return BASE + LANGS[lang]["prefix"] + VIEWS[view]


def rel(lang: str, view: str) -> str:
    """The page's address against the site's root (the pages' <base>)."""
    return LANGS[lang]["prefix"] + VIEWS[view] or "./"


def replace_one(pattern: str, replacement: str, text: str, flags: int = 0) -> str:
    result, count = re.subn(pattern, lambda _: replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"pattern not found: {pattern}")
    return result


def pick_language(markup: str, lang: str) -> str:
    """Drops every element in the other language and unwraps this language's spans."""

    def chunk(text: str) -> str:
        out, stack, last = [], [], 0
        for match in LANG_TAG.finditer(text):
            dropping = "drop" in stack
            if not dropping:
                out.append(text[last:match.start()])
            last = match.end()
            closing, name, attrs = match.group(1), match.group(2), match.group(3)
            if closing:
                action = stack.pop()
                if not dropping and action == "keep":
                    out.append(match.group(0))
                continue
            found = re.search(r'\slang="(zh|en)"', attrs)
            if not found:
                stack.append("keep")
                if not dropping:
                    out.append(match.group(0))
            elif found.group(1) != lang:
                stack.append("drop")
            elif name == "span" and attrs.strip() == found.group(0).strip():
                stack.append("unwrap")
            else:
                stack.append("keep")
                if not dropping:
                    out.append(f"<{name}{attrs.replace(found.group(0), '')}>")
        if stack:
            raise SystemExit("unbalanced <span>/<a> in index.src.html")
        out.append(text[last:])
        return "".join(out)

    parts = RAW.split(markup)
    return "".join(part if i % 2 else chunk(part) for i, part in enumerate(parts))


def pick_attributes(markup: str, lang: str) -> str:
    """alt / aria-label written "中文 / English" keep this language's half."""

    def one(match: re.Match) -> str:
        value = match.group(2)
        if " / " not in value:
            return match.group(0)
        zh, en = value.split(" / ", 1)
        if not CJK.search(zh) or CJK.search(en):
            return match.group(0)
        return f'{match.group(1)}="{zh if lang == "zh" else en}"'

    return re.sub(r'\b(alt|aria-label)="([^"]*)"', one, markup)


def text_of(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", fragment))).strip()


def faq(page: str, view: str) -> list:
    if view == "docs":
        section = page[page.index('<h2 id="d-faq">'):page.index("</article>")]
    elif view == "pricing":
        section = page[page.index('<section class="faq'):]
        section = section[:section.index("</section>")]
    else:
        return []
    return [(text_of(q), text_of(a)) for q, a in re.findall(r"<h3>(.*?)</h3>\s*<p>(.*?)</p>", section, re.S)]


def structured_data(lang: str, view: str, page: str) -> dict:
    meta, here = META[(lang, view)], url(lang, view)
    org = {"@id": BASE + "#organization"}
    software_id = BASE + "#software"
    graph = [
        {
            "@type": "Organization",
            "@id": BASE + "#organization",
            "name": "LinkShell",
            "url": BASE,
            "logo": {"@type": "ImageObject", "url": BASE + "assets/icon-512.png", "width": 512, "height": 512},
            "sameAs": [GITHUB, PRODUCT_HUNT, APP_STORE],
        },
        {
            "@type": "WebSite",
            "@id": BASE + "#website",
            "url": BASE,
            "name": "LinkShell",
            "inLanguage": ["zh-CN", "en"],
            "publisher": org,
        },
    ]
    webpage = {
        "@type": "WebPage",
        "@id": here + "#webpage",
        "url": here,
        "name": meta["title"],
        "description": meta["description"],
        "inLanguage": LANGS[lang]["html"],
        "isPartOf": {"@id": BASE + "#website"},
        "primaryImageOfPage": {"@type": "ImageObject", "url": BASE + LANGS[lang]["og_image"], "width": 1200, "height": 630},
    }
    if view == "home":
        webpage["about"] = {"@id": software_id}
    else:
        webpage["breadcrumb"] = {"@id": here + "#breadcrumb"}
        graph.append({
            "@type": "BreadcrumbList",
            "@id": here + "#breadcrumb",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": CRUMB[lang]["home"], "item": url(lang, "home")},
                {"@type": "ListItem", "position": 2, "name": CRUMB[lang][view], "item": here},
            ],
        })
    graph.append(webpage)

    if view in ("home", "pricing"):
        pricing = url(lang, "pricing")
        graph.append({
            "@type": "SoftwareApplication",
            "@id": software_id,
            "name": "LinkShell",
            "description": APP_DESCRIPTION[lang],
            "applicationCategory": "DeveloperApplication",
            "operatingSystem": "iOS, Android, macOS, Windows, Linux",
            "url": url(lang, "home"),
            "downloadUrl": GITHUB + "/releases/latest",
            "installUrl": APP_STORE,
            "softwareHelp": {"@type": "CreativeWork", "url": url(lang, "docs")},
            "image": BASE + LANGS[lang]["og_image"],
            "screenshot": [BASE + p for p in ("assets/promo/clip-follow.jpg", "assets/promo/lock-screen.jpg", "assets/promo/clip-queue.jpg", "assets/promo/clip-screen.jpg")],
            "license": "https://opensource.org/licenses/MIT",
            "isAccessibleForFree": True,
            "publisher": org,
            "offers": [
                {"@type": "Offer", "name": "Free", "price": "0", "priceCurrency": "CNY", "url": pricing},
                {
                    "@type": "Offer", "name": "Pro (monthly)", "price": "9.9", "priceCurrency": "CNY", "url": pricing,
                    "priceSpecification": {"@type": "UnitPriceSpecification", "price": "9.9", "priceCurrency": "CNY", "billingDuration": "P1M"},
                },
                {
                    "@type": "Offer", "name": "Pro (yearly)", "price": "99", "priceCurrency": "CNY", "url": pricing,
                    "priceSpecification": {"@type": "UnitPriceSpecification", "price": "99", "priceCurrency": "CNY", "billingDuration": "P1Y"},
                },
            ],
        })
    if view == "home":
        graph.append({
            "@type": "MobileApplication",
            "@id": BASE + "#ios-app",
            "name": "LinkShell",
            "operatingSystem": "iOS 16.4 or later",
            "applicationCategory": "UtilitiesApplication",
            "installUrl": APP_STORE,
            "url": APP_STORE,
            "isPartOf": {"@id": software_id},
            "offers": {"@type": "Offer", "price": "0", "priceCurrency": "CNY"},
        })
        film = FILM[lang]
        still_alt = re.search(r'<img src="[^"]*film[^"]*"[^>]*alt="([^"]*)"', page)
        graph.append({
            "@type": "VideoObject",
            "@id": here + "#film",
            "name": film["name"],
            "description": html.unescape(still_alt.group(1)),
            "thumbnailUrl": BASE + film["still"],
            "contentUrl": BASE + film["video"],
            "uploadDate": film["uploaded"],
            "duration": "PT50S",
            "inLanguage": LANGS[lang]["html"],
            "publisher": org,
        })
    questions = faq(page, view)
    if questions:
        graph.append({
            "@type": "FAQPage",
            "@id": here + "#faq",
            "inLanguage": LANGS[lang]["html"],
            "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in questions],
        })
    return {"@context": "https://schema.org", "@graph": graph}


def head(lang: str, view: str, page: str) -> str:
    meta, here, other = META[(lang, view)], url(lang, view), "en" if lang == "zh" else "zh"
    e = lambda value: html.escape(value, quote=True)
    image = BASE + LANGS[lang]["og_image"]
    lines = [
        f"<title>{e(meta['title'])}</title>",
        f'<meta name="description" content="{e(meta["description"])}" />',
        f'<meta name="keywords" content="{e(meta["keywords"])}" />',
        '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />',
        '<meta name="applicable-device" content="pc,mobile" />',
        '<meta http-equiv="Cache-Control" content="no-transform" />',
        f'<link rel="canonical" href="{here}" />',
        f'<link rel="alternate" hreflang="zh-CN" href="{url("zh", view)}" />',
        f'<link rel="alternate" hreflang="en" href="{url("en", view)}" />',
        f'<link rel="alternate" hreflang="x-default" href="{url("zh", view)}" />',
        '<meta property="og:type" content="website" />',
        '<meta property="og:site_name" content="LinkShell" />',
        f'<meta property="og:title" content="{e(meta["title"])}" />',
        f'<meta property="og:description" content="{e(meta["description"])}" />',
        f'<meta property="og:url" content="{here}" />',
        f'<meta property="og:image" content="{image}" />',
        '<meta property="og:image:type" content="image/png" />',
        '<meta property="og:image:width" content="1200" />',
        '<meta property="og:image:height" content="630" />',
        f'<meta property="og:image:alt" content="{e(meta["image_alt"])}" />',
        f'<meta property="og:locale" content="{LANGS[lang]["og"]}" />',
        f'<meta property="og:locale:alternate" content="{LANGS[other]["og"]}" />',
        '<meta name="twitter:card" content="summary_large_image" />',
        f'<meta name="twitter:title" content="{e(meta["title"])}" />',
        f'<meta name="twitter:description" content="{e(meta["description"])}" />',
        f'<meta name="twitter:image" content="{image}" />',
        f'<meta name="twitter:image:alt" content="{e(meta["image_alt"])}" />',
    ]
    if view == "home":
        # The film's still is the largest thing painted: fetch the one <picture> will choose first.
        tall = "assets/promo/film-vertical.jpg" if lang == "zh" else "assets/promo/film-en-vertical.jpg"
        lines += [
            f'<link rel="preload" as="image" href="{FILM[lang]["still"]}" media="(min-width: 701px)" fetchpriority="high" />',
            f'<link rel="preload" as="image" href="{tall}" media="(max-width: 700px)" fetchpriority="high" />',
        ]
    data = json.dumps(structured_data(lang, view, page), ensure_ascii=False, indent=2).replace("</", "<\\/")
    lines.append('<script type="application/ld+json">\n' + data + "\n</script>")
    return "\n".join("  " + line for line in lines) + "\n"


def build(source: str, lang: str, view: str) -> str:
    page = source
    # One view per address.
    for other in VIEWS:
        if other != view:
            page = replace_one(r'\n  <!-- ═+ %s ═+ -->\n  <main class="page" data-page="%s">.*?\n  </main>\n' % (other.upper(), other), "\n", page, re.S)
    page = page.replace(f'<main class="page" data-page="{view}">', f'<main class="page visible" data-page="{view}">')
    if view != "home":
        # The iPhone Duo viewer lives on the home page only.
        page = replace_one(r'  <link rel="stylesheet" href="assets/duo/viewer\.css[^"]*" />\n', "", page)
        page = replace_one(r'  <script src="assets/duo/viewer\.js[^"]*" defer></script>\n', "", page)

    # One language per address.
    page = pick_language(page, lang)
    page = pick_attributes(page, lang)
    page = page.replace('aria-label="Toggle light / dark"', f'aria-label="{THEME_LABEL[lang]}"')
    if lang == "en":
        # English stills, and links that stay in English.
        page = re.sub(r'(src|srcset)="([^"]*)" data-en="([^"]*)"', r'\1="\3"', page)
        page = re.sub(r'href="(\./|docs/|pricing/)', lambda m: 'href="en/' + ("" if m.group(1) == "./" else m.group(1)), page)
    else:
        page = re.sub(r' data-en="[^"]*"', "", page)
    other = "en" if lang == "zh" else "zh"
    page = replace_one(
        r'<a class="lang-switch" id="lang-toggle" href="[^"]*">[^<]*</a>',
        f'<a class="lang-switch" id="lang-toggle" href="{rel(other, view)}" hreflang="{LANGS[other]["html"]}" lang="{LANGS[other]["html"]}">{"EN" if other == "en" else "中文"}</a>',
        page,
    )

    depth = (LANGS[lang]["prefix"] + VIEWS[view]).count("/")
    page = replace_one(
        r'<html lang="zh-CN" data-lang="zh">',
        f'<html lang="{LANGS[lang]["html"]}" data-lang="{lang}" data-prefix="{LANGS[lang]["prefix"]}" data-alt="{rel(other, view)}">',
        page,
    )
    if depth:
        page = replace_one(r'<meta charset="UTF-8" />', f'<meta charset="UTF-8" />\n  <base href="{"../" * depth}" />', page)
    page = replace_one(r"  <!-- seo:start.*?<!-- seo:end -->\n", head(lang, view, page), page, re.S)
    # GitHub Pages keeps publishing docs/site for install.sh and the desktop update feeds but cannot
    # send a 301, so a page opened there moves the visitor to the site's own host.
    page = replace_one(r'<meta charset="UTF-8" />', '<meta charset="UTF-8" />\n  ' + GITHUB_PAGES_REDIRECT, page)
    return page


NOT_FOUND = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  {redirect}
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>页面不存在 · Page not found | LinkShell</title>
  <meta name="robots" content="noindex" />
  <meta name="theme-color" content="#09090b" />
  <base href="/" />
  <link rel="icon" type="image/png" sizes="32x32" href="assets/favicon-32.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="assets/apple-touch-icon.png" />
  <style>
    /* Served for any missing address, at any depth: everything is against <base>. */
    :root { color-scheme: dark; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #09090b; color: #f4f4f5;
      font: 17px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif; }
    main { max-width: 560px; padding: 32px 24px; }
    img { border-radius: 10px; }
    h1 { margin: 24px 0 8px; font-size: 34px; line-height: 1.2; letter-spacing: -.02em; font-weight: 600; }
    p { margin: 0 0 6px; color: #a1a1aa; }
    nav { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 28px; }
    a { display: inline-flex; align-items: center; height: 44px; padding: 0 20px; border-radius: 999px; background: #18181b; color: #f4f4f5; text-decoration: none; }
    a:hover, a:focus-visible { background: #222226; }
    a.primary { background: #f4f4f5; color: #09090b; }
  </style>
</head>
<body>
  <main>
    <img src="assets/icon-192.png" alt="" width="48" height="48" />
    <h1>页面不存在 <span lang="en">· Page not found</span></h1>
    <p>这个地址没有内容，可能已经移动。</p>
    <p lang="en">Nothing lives at this address; it may have moved.</p>
    <nav>
      <a class="primary" href="./">LinkShell 首页</a>
      <a href="docs/">文档</a>
      <a href="pricing/">定价</a>
      <a href="en/" lang="en">English</a>
      <a href="en/docs/" lang="en">Docs</a>
    </nav>
  </main>
</body>
</html>
"""


def main() -> None:
    source = (SITE / "index.src.html").read_text(encoding="utf-8")
    sitemap = SITE / "sitemap.xml"
    previous = dict(re.findall(r"<loc>([^<]*)</loc>.*?<lastmod>([^<]*)</lastmod>", sitemap.read_text(encoding="utf-8"), re.S)) if sitemap.exists() else {}
    today = datetime.date.today().isoformat()
    entries = []
    for view in VIEWS:
        for lang in LANGS:
            out = SITE / (LANGS[lang]["prefix"] + VIEWS[view]) / "index.html"
            page = build(source, lang, view)
            unchanged = out.exists() and out.read_text(encoding="utf-8") == page
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(page, encoding="utf-8")
            print(f"wrote {out.relative_to(SITE.parent.parent)}")
            # A page keeps its date until its content changes.
            entries.append((url(lang, view), previous.get(url(lang, view)) if unchanged and url(lang, view) in previous else today, view))

    alternates = lambda view: "".join(
        f'\n    <xhtml:link rel="alternate" hreflang="{code}" href="{url(lang, view)}" />'
        for code, lang in (("zh-CN", "zh"), ("en", "en"), ("x-default", "zh"))
    )
    body = "".join(f"  <url>\n    <loc>{loc}</loc>\n    <lastmod>{mod}</lastmod>{alternates(view)}\n  </url>\n" for loc, mod, view in entries)
    sitemap.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
        f"{body}</urlset>\n",
        encoding="utf-8",
    )
    print(f"wrote {sitemap.relative_to(SITE.parent.parent)} ({len(entries)} pages)")
    (SITE / "404.html").write_text(NOT_FOUND.replace("{redirect}", GITHUB_PAGES_REDIRECT), encoding="utf-8")
    print("wrote docs/site/404.html")


if __name__ == "__main__":
    main()
