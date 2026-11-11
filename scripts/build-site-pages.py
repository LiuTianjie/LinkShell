#!/usr/bin/env python3
"""Writes the site's pages, its sitemap and its 404 page from docs/site/index.src.html.

The source is one multilingual document with five views (home, docs, pricing, and the
claude-code and codex landing pages). Every view in each of its languages gets its own address,
so each page a search engine sees has one language, one view, one <h1>, and its own title,
description, canonical URL, hreflang alternates, social cards and structured data:

    /      /docs/      /pricing/      /claude-code/      /codex/      (Chinese; the root is x-default)
    /en/   /en/docs/   /en/pricing/   /en/claude-code/   /en/codex/   (English)
                                      /ja/claude-code/   /ja/codex/   (Japanese: these two views only)

A view lists its languages in VIEW_LANGS; hreflang, the language switch and the sitemap name only
the ones it has. A link from a Japanese page to a view without Japanese leads to its English page.

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
# The landing pages are read outside China too: the store picks the visitor's own region.
APP_STORE_ANY = "https://apps.apple.com/app/id6761547516"
GITHUB_PAGES_REDIRECT = (
    '<script>if(location.hostname.endsWith("github.io"))location.replace("https://linkshell.itool.tech"'
    '+location.pathname.replace(/^\\/LinkShell/i,"")+location.search+location.hash)</script>'
)
PRODUCT_HUNT = "https://www.producthunt.com/products/linkshell"

LANGS = {
    "zh": {"prefix": "", "html": "zh-CN", "og": "zh_CN", "og_image": "assets/og.png"},
    "en": {"prefix": "en/", "html": "en", "og": "en_US", "og_image": "assets/og-en.png"},
    # No Japanese share image exists: the English one is the closer of the two.
    "ja": {"prefix": "ja/", "html": "ja", "og": "ja_JP", "og_image": "assets/og-en.png"},
}
VIEWS = {"home": "", "docs": "docs/", "pricing": "pricing/", "claude-code": "claude-code/", "codex": "codex/"}
# The languages each view is written in; the first is x-default.
VIEW_LANGS = {
    "home": ("zh", "en"),
    "docs": ("zh", "en"),
    "pricing": ("zh", "en"),
    "claude-code": ("zh", "en", "ja"),
    "codex": ("zh", "en", "ja"),
}
LANDING = ("claude-code", "codex")
# Where a page in one language sends a link to a view that isn't written in it.
FALLBACK = {"ja": "en"}
SWITCH_LABEL = {"zh": "中文", "en": "EN", "ja": "日本語"}

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
        "title": "LinkShell 定价 | 免费使用，iTool 会员提供官方网关",
        "description": "LinkShell 全部功能免费，自建网关即可使用。iTool 会员提供官方网关：月度 ¥9.9 含 iTool 网站和 LinkShell，年度 ¥99 含全部 iTool 产品，在 itool.tech 用支付宝开通。连接始终端到端加密。",
        "keywords": "LinkShell 定价, iTool 会员, 官方网关, 免费, 自建网关",
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
        "title": "LinkShell Pricing: Free, or the iTool Membership from $3.19 a Month",
        "description": "Every LinkShell feature is free with your own gateway. The iTool membership adds the official gateway: $3.19 USD monthly or $26.49 USD yearly. Pay by international card or Alipay.",
        "keywords": "LinkShell pricing, iTool membership, official gateway, free, self-hosted gateway",
        "image_alt": "LinkShell: follow the coding agents on your computer from your phone",
    },
    ("zh", "claude-code"): {
        "title": "手机远程控制 Claude Code：iPhone、Android 上审批和插话 | LinkShell",
        "description": "Claude Code 留在电脑上跑，你在 iPhone、Android 和 Apple Watch 上看回复、批准权限请求、往正在跑的一轮里插话。linkshell claude 在终端和手机之间接力，端到端加密，自建网关免费。",
        "keywords": "手机远程控制 Claude Code, Claude Code 手机, Claude Code iPhone, Claude Code 远程, Claude Code 审批, linkshell claude, Claude Code Android, Apple Watch",
        "image_alt": "LinkShell：在手机上跟进、批准和插话 Claude Code",
    },
    ("en", "claude-code"): {
        "title": "Claude Code Remote Control from iPhone and Android | LinkShell",
        "description": "Keep Claude Code running on your computer and control it from your phone: follow replies, approve permission requests from the Lock Screen or Apple Watch, and steer the running turn. End-to-end encrypted.",
        "keywords": "Claude Code remote control, Claude Code on phone, Claude Code iPhone, Claude Code mobile, approve Claude Code permissions, linkshell claude, Claude Code Android, Apple Watch",
        "image_alt": "LinkShell: follow, approve and steer Claude Code from your phone",
    },
    ("ja", "claude-code"): {
        "title": "iPhone で Claude Code を操作・承認 | LinkShell",
        "description": "Claude Code はパソコンで動かしたまま、iPhone・Android・Apple Watch から返信を追い、権限リクエストを承認し、実行中のターンに指示を送れます。通信はエンドツーエンドで暗号化されます。",
        "keywords": "Claude Code iPhone, iPhone で Claude Code を操作, Claude Code リモート操作, Claude Code スマホ, Claude Code 承認, linkshell claude, Apple Watch",
        "image_alt": "LinkShell：iPhone から Claude Code を追い、承認し、指示を送る",
    },
    ("zh", "codex"): {
        "title": "手机上用 Codex：iPhone 审批、插话和 Computer Use | LinkShell",
        "description": "Codex 留在电脑上跑，linkshell codex 让终端和手机同时在线：在 iPhone、Android 和 Apple Watch 上看进度、批准请求、插话，还能让 Codex 操作 Mac 上的浏览器和应用。端到端加密。",
        "keywords": "Codex 手机, 手机远程控制 Codex, Codex iPhone, Codex 审批, linkshell codex, Codex Computer Use, Codex Android, Apple Watch",
        "image_alt": "LinkShell：在手机上跟进、批准和插话 Codex",
    },
    ("en", "codex"): {
        "title": "Codex on Your Phone: Approve and Steer Codex from iPhone | LinkShell",
        "description": "Run Codex on your computer and stay in the loop from iPhone, Android or Apple Watch: approve requests, steer the running turn and watch Computer Use live. The terminal and the phone stay live together.",
        "keywords": "Codex on phone, Codex iPhone, approve Codex from iPhone, Codex mobile, Codex remote control, linkshell codex, Codex Computer Use, Codex Android",
        "image_alt": "LinkShell: follow, approve and steer Codex from your phone",
    },
    ("ja", "codex"): {
        "title": "iPhone で Codex を操作・承認 | LinkShell",
        "description": "Codex はパソコンで動かしたまま、iPhone・Android・Apple Watch から進み具合を追い、リクエストを承認し、実行中のターンに指示を送れます。Computer Use の画面もライブで見られます。",
        "keywords": "Codex iPhone, iPhone で Codex を操作, Codex スマホ, Codex 承認, Codex リモート操作, linkshell codex, Codex Computer Use",
        "image_alt": "LinkShell：iPhone から Codex を追い、承認し、指示を送る",
    },
}

APP_DESCRIPTION = {
    "zh": "在手机上关注、审批和指挥电脑上运行的编程 Agent（Claude Code、Codex、Gemini CLI、GitHub Copilot 等），并提供远程桌面、终端和本地网页预览。端到端加密，可自建网关。",
    "en": "Follow, steer and approve the coding agents running on your computer (Claude Code, Codex, Gemini CLI, GitHub Copilot and more) from your phone, with remote desktop control, a terminal and local web previews. End-to-end encrypted, with a self-hostable gateway.",
    "ja": "パソコンで動くコーディングエージェント（Claude Code、Codex、Gemini CLI、GitHub Copilot など）を、スマートフォンから追い、承認し、指示を送れます。Mac のリモートデスクトップ、ターミナル、ローカル Web のプレビューにも対応。通信はエンドツーエンドで暗号化され、ゲートウェイはセルフホストできます。",
}
CRUMB = {
    "zh": {"home": "首页", "docs": "文档", "pricing": "定价", "claude-code": "Claude Code", "codex": "Codex"},
    "en": {"home": "Home", "docs": "Docs", "pricing": "Pricing", "claude-code": "Claude Code", "codex": "Codex"},
    # Japanese has no home page of its own: the crumb leads to the English one, by name.
    "ja": {"home": "LinkShell", "claude-code": "Claude Code", "codex": "Codex"},
}
FILM = {
    # The cuts' first publication (git history) and their length (49.9 s).
    "zh": {"name": "LinkShell 介绍片", "video": "assets/promo/linkshell-2.0.mp4", "still": "assets/promo/film.jpg", "uploaded": "2026-09-30T22:36:03-07:00"},
    "en": {"name": "LinkShell film", "video": "assets/promo/linkshell-en.mp4", "still": "assets/promo/film-en.jpg", "uploaded": "2026-10-20T05:29:57+08:00"},
}
THEME_LABEL = {"zh": "切换浅色或深色模式", "en": "Toggle light / dark", "ja": "ライトモードとダークモードを切り替え"}

CJK = re.compile(r"[　-鿿＀-￯]")
KANA = re.compile(r"[぀-ヿ]")
LANG_TAG = re.compile(r'<(/?)(span|a)(?=[\s>])([^>]*)>')
RAW = re.compile(r"(<script\b.*?</script>|<style\b.*?</style>)", re.S)


def written_in(lang: str, view: str) -> str:
    """The language a link to `view` from a page in `lang` leads to."""
    return lang if lang in VIEW_LANGS[view] else FALLBACK[lang]


def url(lang: str, view: str) -> str:
    return BASE + LANGS[lang]["prefix"] + VIEWS[view]


def rel(lang: str, view: str) -> str:
    """The page's address against the site's root (the pages' <base>)."""
    return LANGS[lang]["prefix"] + VIEWS[view] or "./"


def others(lang: str, view: str) -> list:
    """The view's other languages, in VIEW_LANGS order."""
    return [code for code in VIEW_LANGS[view] if code != lang]


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
            found = re.search(r'\slang="(zh|en|ja)"', attrs)
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
    """alt / aria-label written "中文 / English" (or "中文 / English / 日本語") keep this language's part.

    A Japanese page reads the English part of a value that has no Japanese one."""

    def one(match: re.Match) -> str:
        value = match.group(2)
        if " / " not in value:
            return match.group(0)
        parts = value.split(" / ")
        if len(parts) == 3 and CJK.search(parts[0]) and not CJK.search(parts[1]) and KANA.search(parts[2]):
            return f'{match.group(1)}="{parts[("zh", "en", "ja").index(lang)]}"'
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
    elif view == "pricing" or view in LANDING:
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
        if view in LANDING:
            webpage["about"] = {"@id": software_id}
        webpage["breadcrumb"] = {"@id": here + "#breadcrumb"}
        graph.append({
            "@type": "BreadcrumbList",
            "@id": here + "#breadcrumb",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": CRUMB[lang]["home"], "item": url(written_in(lang, "home"), "home")},
                {"@type": "ListItem", "position": 2, "name": CRUMB[lang][view], "item": here},
            ],
        })
    graph.append(webpage)

    if view in ("home", "pricing") or view in LANDING:
        site = lambda target: url(written_in(lang, target), target)
        pricing = site("pricing")
        # www and a locale up front: the bare domain costs two redirects. itool.tech has no Japanese.
        # checkout= opens that plan's payment once the visitor is signed in.
        buy = f"https://www.itool.tech/{'zh' if lang == 'zh' else 'en'}/pro?from=linkshell&checkout="
        # USD list prices verified against iTool's live /api/pay/creem/config on 2026-11-11.
        currency, monthly_price, yearly_price = ("USD", "3.19", "26.49") if lang == "en" and view == "pricing" else ("CNY", "9.9", "99")
        graph.append({
            "@type": "SoftwareApplication",
            "@id": software_id,
            "name": "LinkShell",
            "description": APP_DESCRIPTION[lang],
            "applicationCategory": "DeveloperApplication",
            "operatingSystem": "iOS, Android, macOS, Windows, Linux",
            "url": site("home"),
            "downloadUrl": site("docs") + "#d-install",
            "installUrl": APP_STORE_ANY if view in LANDING else APP_STORE,
            "softwareHelp": {"@type": "CreativeWork", "url": site("docs")},
            "image": BASE + LANGS[lang]["og_image"],
            "screenshot": [BASE + p for p in ("assets/promo/clip-follow.jpg", "assets/promo/lock-screen.jpg", "assets/promo/clip-queue.jpg", "assets/promo/clip-screen.jpg")],
            "license": "https://opensource.org/licenses/MIT",
            "isAccessibleForFree": True,
            "publisher": org,
            "offers": [
                {"@type": "Offer", "name": "Free", "price": "0", "priceCurrency": currency, "url": pricing},
                {
                    "@type": "Offer", "name": "iTool membership (monthly)", "price": monthly_price, "priceCurrency": currency, "url": buy + "monthly",
                    "priceSpecification": {"@type": "UnitPriceSpecification", "price": monthly_price, "priceCurrency": currency, "billingDuration": "P1M"},
                },
                {
                    "@type": "Offer", "name": "iTool membership (yearly)", "price": yearly_price, "priceCurrency": currency, "url": buy + "yearly",
                    "priceSpecification": {"@type": "UnitPriceSpecification", "price": yearly_price, "priceCurrency": currency, "billingDuration": "P1Y"},
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
    meta, here = META[(lang, view)], url(lang, view)
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
        *(f'<link rel="alternate" hreflang="{LANGS[code]["html"]}" href="{url(code, view)}" />' for code in VIEW_LANGS[view]),
        f'<link rel="alternate" hreflang="x-default" href="{url(VIEW_LANGS[view][0], view)}" />',
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
        *(f'<meta property="og:locale:alternate" content="{LANGS[code]["og"]}" />' for code in others(lang, view)),
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
            # (The landing views sit last, so dropping them leaves the gap before the footer as it was.)
            page = replace_one(r'\n  <!-- ═+ %s ═+ -->\n  <main class="page" data-page="%s">.*?\n  </main>\n' % (other.upper(), other), "" if other in LANDING else "\n", page, re.S)
    page = page.replace(f'<main class="page" data-page="{view}">', f'<main class="page visible" data-page="{view}">')
    # Styles a view keeps to itself, so the other pages stay as they are.
    def scoped(match: re.Match) -> str:
        return match.group(0).replace(match.group(1), "") if view in match.group(2).split() else ""
    page = re.sub(r'  <style( data-views="([^"]*)")>.*?</style>\n', scoped, page, flags=re.S)
    if view != "home":
        # The iPhone Duo viewer lives on the home page only.
        page = replace_one(r'  <link rel="stylesheet" href="assets/duo/viewer\.css[^"]*" />\n', "", page)
        page = replace_one(r'  <script src="assets/duo/viewer\.js[^"]*" defer></script>\n', "", page)

    # One language per address.
    page = pick_language(page, lang)
    page = pick_attributes(page, lang)
    page = page.replace('aria-label="Toggle light / dark"', f'aria-label="{THEME_LABEL[lang]}"')
    if lang != "zh":
        # English stills (Japanese pages have none of their own), and links that stay in this
        # language, or in English where a view has no Japanese.
        page = re.sub(r'(src|srcset)="([^"]*)" data-en="([^"]*)"', r'\1="\3"', page)
        targets = {path or "./": name for name, path in VIEWS.items()}
        pattern = "|".join(re.escape(path) for path in sorted(targets, key=len, reverse=True))
        page = re.sub(r'href="(%s)' % pattern, lambda m: 'href="' + LANGS[written_in(lang, targets[m.group(1)])]["prefix"] + ("" if m.group(1) == "./" else m.group(1)), page)
    else:
        page = re.sub(r' data-en="[^"]*"', "", page)
    # Every page links the other of Chinese and English (a Japanese page: English); a view with
    # Japanese links its third language too, a switch that gives way on narrow screens.
    other = "en" if lang == "zh" else "zh"
    first = "en" if lang == "ja" else other
    switches = [first] + [code for code in others(lang, view) if code != first]

    def switch(code: str, primary: bool) -> str:
        names = 'class="lang-switch" id="lang-toggle"' if primary else 'class="lang-switch lang-more"'
        html_lang = LANGS[code]["html"]
        return f'<a {names} href="{rel(code, view)}" hreflang="{html_lang}" lang="{html_lang}">{SWITCH_LABEL[code]}</a>'

    page = replace_one(
        r'<a class="lang-switch" id="lang-toggle" href="[^"]*">[^<]*</a>',
        "".join(switch(code, i == 0) for i, code in enumerate(switches)),
        page,
    )

    depth = (LANGS[lang]["prefix"] + VIEWS[view]).count("/")
    # data-alt is where a visitor who chose the first switch's language goes; data-alt-<lang>
    # names a view's other languages (Japanese, or Chinese from a Japanese page).
    extra = "".join(f' data-alt-{code}="{rel(code, view)}"' for code in switches[1:])
    page = replace_one(
        r'<html lang="zh-CN" data-lang="zh">',
        f'<html lang="{LANGS[lang]["html"]}" data-lang="{lang}" data-product="linkshell" data-prefix="{LANGS[lang]["prefix"]}" data-alt="{rel(first, view)}"{extra}>',
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


def page_images(page: str, lang: str) -> list:
    """The page's share image and the content images it shows, against the site root."""
    found = [LANGS[lang]["og_image"]]
    for src in re.findall(r'<img\b[^>]*?\ssrc="(assets/[^"?#]+)"', page):
        if src not in found and not src.startswith("assets/duo/"):
            found.append(src)
    return found


def main() -> None:
    source = (SITE / "index.src.html").read_text(encoding="utf-8")
    sitemap = SITE / "sitemap.xml"
    previous = dict(re.findall(r"<loc>([^<]*)</loc>.*?<lastmod>([^<]*)</lastmod>", sitemap.read_text(encoding="utf-8"), re.S)) if sitemap.exists() else {}
    today = datetime.date.today().isoformat()
    entries = []
    for view in VIEWS:
        for lang in VIEW_LANGS[view]:
            out = SITE / (LANGS[lang]["prefix"] + VIEWS[view]) / "index.html"
            page = build(source, lang, view)
            unchanged = out.exists() and out.read_text(encoding="utf-8") == page
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(page, encoding="utf-8")
            print(f"wrote {out.relative_to(SITE.parent.parent)}")
            # A page keeps its date until its content changes.
            entries.append((url(lang, view), previous.get(url(lang, view)) if unchanged and url(lang, view) in previous else today, view, page_images(page, lang)))

    alternates = lambda view: "".join(
        f'\n    <xhtml:link rel="alternate" hreflang="{code}" href="{url(lang, view)}" />'
        for code, lang in [(LANGS[lang]["html"], lang) for lang in VIEW_LANGS[view]] + [("x-default", VIEW_LANGS[view][0])]
    )
    images = lambda found: "".join(f"\n    <image:image><image:loc>{BASE + src}</image:loc></image:image>" for src in found)
    body = "".join(f"  <url>\n    <loc>{loc}</loc>\n    <lastmod>{mod}</lastmod>{images(found)}{alternates(view)}\n  </url>\n" for loc, mod, view, found in entries)
    sitemap.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n'
        f"{body}</urlset>\n",
        encoding="utf-8",
    )
    print(f"wrote {sitemap.relative_to(SITE.parent.parent)} ({len(entries)} pages)")
    (SITE / "404.html").write_text(NOT_FOUND.replace("{redirect}", GITHUB_PAGES_REDIRECT), encoding="utf-8")
    print("wrote docs/site/404.html")


if __name__ == "__main__":
    main()
