// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import brandColors from "../../client/src/theme/brand-colors.json";
import { subagentGlyphs } from "../../client/src/theme/subagent-glyphs";
import {
  AgentMark,
  DESKTOP_ICON_METRICS,
  DESKTOP_ICON_NAMES,
  DesktopIcon,
  SubagentGlyph,
  normalizeAgentMarkKey,
  subagentGlyphIndex,
  type DesktopIconName,
  type DesktopIconSize,
} from "../src/icons";
import {
  applyDesktopAppearance,
  desktopPalette,
  getResolvedTheme,
  getTerminalAnsiPalette,
  resolveThemeMode,
  terminalDarkAnsiPalette,
  terminalLightAnsiPalette,
  wcagContrast,
} from "../src/theme";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const readStyle = (fileName: string) =>
  readFileSync(resolve(TEST_DIR, "..", "src", "styles", fileName), "utf8");

const CANONICAL_BRAND_TOKENS = [
  "accent",
  "accentFill",
  "accentHover",
  "accentSoft",
  "running",
  "waiting",
  "waitingFill",
  "waitingSoft",
  "ok",
  "okSoft",
  "danger",
  "dangerSoft",
] as const;

const DESKTOP_SURFACES = [
  "ground",
  "sidebar",
  "plain",
  "background",
  "sheet",
  "inset",
  "code",
  "card",
  "cardRaised",
  "composerSurface",
  "composerToolbar",
  "userBubble",
  "sheetCard",
  "popover",
] as const;

const REQUIRED_CONTRACT_ICONS: readonly DesktopIconName[] = [
  // 17 Bespoke Domain Icons
  "fusion-mode",
  "remote-screen",
  "host-daemon",
  "gateway-relay",
  "direct-p2p",
  "pair-qr",
  "worktree",
  "session-fork",
  "subagent",
  "approval-shield",
  "approval-pending",
  "diff-changes",
  "terminal",
  "port-preview",
  "keep-awake",
  "keep-awake-off",
  "usage-meter",
  // 77 Canonical UI Icons from Shared Interface Contract (#11)
  "sidebar-toggle",
  "inspector-toggle",
  "bottom-dock",
  "search",
  "command",
  "settings",
  "plus",
  "minus",
  "close",
  "check",
  "chevron-right",
  "chevron-down",
  "chevron-left",
  "chevron-up",
  "chevrons-up-down",
  "arrow-up",
  "arrow-down",
  "arrow-left",
  "arrow-right",
  "corner-down-left",
  "stop-square",
  "play",
  "pause",
  "refresh",
  "external-link",
  "more-horizontal",
  "more-vertical",
  "computer-mac",
  "computer-pc",
  "computer-linux",
  "phone-device",
  "wifi-lan",
  "globe",
  "lock",
  "unlock",
  "key",
  "user",
  "log-out",
  "folder",
  "folder-open",
  "folder-plus",
  "file",
  "file-code",
  "file-text",
  "git-branch",
  "git-commit",
  "git-merge",
  "git-pull-request",
  "copy",
  "clipboard",
  "edit",
  "trash",
  "archive",
  "archive-restore",
  "download",
  "upload",
  "paperclip",
  "image",
  "eye",
  "eye-off",
  "maximize",
  "minimize",
  "sliders",
  "info",
  "alert-triangle",
  "alert-circle",
  "check-circle",
  "clock",
  "sparkles",
  "code",
  "list-checks",
  "puzzle",
  "split-columns",
  "unified-diff",
  "send-to-agent",
  "pin",
  "filter",
];

describe("LinkShell Desktop brand & CSS cascade invariants", () => {
  it("preserves every canonical brand and status token from brand-colors.json", () => {
    for (const token of CANONICAL_BRAND_TOKENS) {
      expect(desktopPalette[token], token).toEqual(brandColors[token]);
    }
    expect(desktopPalette.link).toEqual(brandColors.accent);
    expect(desktopPalette.focus).toEqual(brandColors.accent);
    expect(desktopPalette.info).toEqual(brandColors.running);
    expect(desktopPalette.runningSoft).toEqual(brandColors.accentSoft);
    expect(desktopPalette.success).toEqual(brandColors.ok);
    expect(desktopPalette.warning).toEqual(brandColors.waiting);
    expect(desktopPalette.primaryForeground).toEqual(["#ffffff", "#ffffff"]);
    expect(desktopPalette.idle).toEqual(desktopPalette.tertiaryLabel);
    expect(desktopPalette.monitorMemory).toEqual(desktopPalette.secondaryLabel);
  });

  it("declares explicit CSS cascade layer priority order upfront in index.css", () => {
    const indexCss = readStyle("index.css");
    const firstLine = indexCss.trim().split("\n")[0]?.trim();
    expect(firstLine).toBe(
      "@layer reset, base, theme, primitives, components, utilities;",
    );
  });

  it("keeps live light-dark() brand colors in tokens.css without registering <color> @property", () => {
    const tokensCss = readStyle("tokens.css");
    expect(tokensCss).toContain("color-scheme: light dark;");
    expect(tokensCss).toContain("interpolate-size: allow-keywords;");
    expect(tokensCss).not.toMatch(/@property\s+--ls-[^{]*\{[^}]*syntax:\s*["']<color>["']/);

    const expectedLightDarkPairs: Array<[string, keyof typeof brandColors]> = [
      ["--ls-accent", "accent"],
      ["--ls-accent-fill", "accentFill"],
      ["--ls-accent-hover", "accentHover"],
      ["--ls-waiting", "waiting"],
      ["--ls-waiting-fill", "waitingFill"],
      ["--ls-ok", "ok"],
      ["--ls-danger", "danger"],
    ];

    for (const [cssVar, token] of expectedLightDarkPairs) {
      const [lightVal, darkVal] = brandColors[token];
      expect(tokensCss).toContain(
        `${cssVar}: light-dark(${lightVal.toLowerCase()}, ${darkVal.toLowerCase()});`,
      );
    }
  });

  it("enforces cross-platform macOS traffic-light & Windows titleBarOverlay safe zones in chrome.css", () => {
    const chromeCss = readStyle("chrome.css");
    expect(chromeCss).not.toContain("desktop-sidebar-toggle-pin");
    expect(chromeCss).toContain("padding-inline-start: 84px;");
    expect(chromeCss).toContain("--titlebar-left-inset: 84px;");
    expect(chromeCss).toContain("--caption-inset:");
    expect(chromeCss).toContain(".modal-window-drag-strip");
    expect(chromeCss).toContain("overflow: clip;");
  });
});

describe("WCAG AA >= 4.5:1 multi-elevation contrast across Light and Dark modes", () => {
  it.each([
    ["light", 0 as const],
    ["dark", 1 as const],
  ])("maintains >= 4.5:1 for secondaryLabel & tertiaryLabel across all %s surfaces", (_, idx) => {
    for (const surface of DESKTOP_SURFACES) {
      const bg = desktopPalette[surface]![idx];
      const primary = wcagContrast(desktopPalette.label![idx], bg);
      const secondary = wcagContrast(desktopPalette.secondaryLabel![idx], bg);
      const tertiary = wcagContrast(desktopPalette.tertiaryLabel![idx], bg);

      expect(primary, `label on ${surface} (${bg})`).toBeGreaterThanOrEqual(7.0);
      expect(secondary, `secondaryLabel on ${surface} (${bg})`).toBeGreaterThanOrEqual(4.5);
      expect(tertiary, `tertiaryLabel on ${surface} (${bg})`).toBeGreaterThanOrEqual(4.5);
      expect(
        secondary - tertiary,
        `hierarchy separation on ${surface} (${bg})`,
      ).toBeGreaterThan(1.0);
    }
  });

  it("maintains >= 4.5:1 white foreground contrast on solid action fills", () => {
    for (const idx of [0, 1] as const) {
      expect(wcagContrast("#ffffff", desktopPalette.accentFill![idx])).toBeGreaterThanOrEqual(4.5);
      expect(wcagContrast("#ffffff", desktopPalette.waitingFill![idx])).toBeGreaterThanOrEqual(4.5);
    }
    expect(wcagContrast("#ffffff", desktopPalette.danger![0])).toBeGreaterThanOrEqual(4.5);
  });

  it("maintains >= 3.0:1 non-text contrast for scrollbar thumbs across primary surfaces", () => {
    for (const idx of [0, 1] as const) {
      for (const surface of ["plain", "background", "inset", "card", "sheetCard"] as const) {
        const ratio = wcagContrast(
          desktopPalette.scrollbarThumb![idx],
          desktopPalette[surface]![idx],
        );
        expect(ratio, `scrollbarThumb[${idx}] on ${surface}`).toBeGreaterThanOrEqual(3.0);
      }
    }
  });

  it("applies light, dark, and system appearance modes cleanly on :root", () => {
    expect(resolveThemeMode("light", true)).toBe("light");
    expect(resolveThemeMode("dark", false)).toBe("dark");
    expect(resolveThemeMode("system", true)).toBe("dark");
    expect(resolveThemeMode("system", false)).toBe("light");

    applyDesktopAppearance("dark");
    expect(document.documentElement.dataset.themeMode).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(getResolvedTheme()).toBe("dark");

    applyDesktopAppearance("light");
    expect(document.documentElement.dataset.themeMode).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(getResolvedTheme()).toBe("light");

    applyDesktopAppearance("system");
    expect(document.documentElement.dataset.themeMode).toBe("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("provides Light and Dark xterm ANSI palettes with WCAG AA >= 4.5:1 contrast on #fbfcfd and #090a0d", () => {
    expect(desktopPalette.terminal).toEqual(["#fbfcfd", "#090a0d"]);
    expect(desktopPalette.terminalBg).toEqual(["#fbfcfd", "#090a0d"]);
    expect(desktopPalette.terminalFg).toEqual(["#181b22", "#e6e9f0"]);
    expect(desktopPalette.terminalChrome).toEqual(["#f3f5f8", "#0d0f13"]);

    expect(getTerminalAnsiPalette("light")).toEqual(terminalLightAnsiPalette);
    expect(getTerminalAnsiPalette("dark")).toEqual(terminalDarkAnsiPalette);
    expect(terminalLightAnsiPalette.background).toBe("#fbfcfd");
    expect(terminalDarkAnsiPalette.background).toBe("#090a0d");

    for (const key of [
      "foreground",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
    ] as const) {
      expect(
        wcagContrast(terminalLightAnsiPalette[key], "#fbfcfd"),
        `light terminal ${key} (${terminalLightAnsiPalette[key]}) on #fbfcfd`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        wcagContrast(terminalDarkAnsiPalette[key], "#090a0d"),
        `dark terminal ${key} (${terminalDarkAnsiPalette[key]}) on #090a0d`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    const tokensCss = readStyle("tokens.css");
    const chromeCss = readStyle("chrome.css");
    const inspectorCss = readStyle("inspector.css");
    expect(tokensCss).toContain("--ls-terminal-bg: light-dark(#fbfcfd, #090a0d);");
    expect(tokensCss).toContain("--ls-terminal-fg: light-dark(#181b22, #e6e9f0);");
    expect(tokensCss).toContain("--ls-terminal-chrome: light-dark(#f3f5f8, #0d0f13);");
    expect(tokensCss).not.toContain(".ls-terminal-well");
    expect(chromeCss).not.toContain(".ls-terminal-well");
    expect(inspectorCss).not.toContain("color-scheme: dark;");
  });
});

describe("DesktopIcon bespoke system & optical geometry", () => {
  it("registers every single required domain and UI icon from the Shared Interface Contract", () => {
    const registered = new Set<string>(DESKTOP_ICON_NAMES);
    for (const requiredName of REQUIRED_CONTRACT_ICONS) {
      expect(registered.has(requiredName), `missing icon: ${requiredName}`).toBe(true);
    }
  });

  it("renders every DesktopIconName cleanly across all 5 optical sizes with calibrated strokes", () => {
    const sizes: DesktopIconSize[] = ["xs", "sm", "md", "lg", "xl"];
    for (const name of DESKTOP_ICON_NAMES) {
      for (const size of sizes) {
        const { px, strokeWidth } = DESKTOP_ICON_METRICS[size];
        const html = renderToStaticMarkup(createElement(DesktopIcon, { name, size }));

        expect(html, `${name}@${size}`).toContain(`data-icon="${name}"`);
        expect(html, `${name}@${size}`).toContain(`width="${px}"`);
        expect(html, `${name}@${size}`).toContain(`height="${px}"`);
        expect(html, `${name}@${size}`).toContain(`stroke-width="${strokeWidth}"`);
        expect(html, `${name}@${size}`).toContain('viewBox="0 0 24 24"');
        expect(html, `${name}@${size}`).toContain('aria-hidden="true"');
        expect(html, `${name}@${size}`).toMatch(/<(path|rect|circle|polygon|polyline|ellipse|line)\b/);
        expect(html, `${name}@${size}`).not.toContain("NaN");
        expect(html, `${name}@${size}`).not.toContain("undefined");
      }
    }
  });

  it("exposes accessible role='img' and <title> when title prop is provided", () => {
    const html = renderToStaticMarkup(
      createElement(DesktopIcon, {
        name: "fusion-mode",
        size: "md",
        title: "开启融合模式",
      }),
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="开启融合模式"');
    expect(html).toContain("<title>开启融合模式</title>");
    expect(html).not.toContain('aria-hidden="true"');
  });
});

describe("AgentMark & SubagentGlyph parity and scoped SVG <defs>", () => {
  it("renders official agent marks with unique scoped gradient IDs and clean custom fallbacks", () => {
    expect(normalizeAgentMarkKey("Claude-Code")).toBe("claude");
    expect(normalizeAgentMarkKey("gemini-cli")).toBe("gemini");
    expect(normalizeAgentMarkKey("github-copilot")).toBe("copilot");

    const agents = [
      "claude",
      "claude-code",
      "codex",
      "gemini",
      "cursor",
      "opencode",
      "copilot",
      "grok",
      "antigravity",
      "custom-acp-runner",
    ];
    for (const agent of agents) {
      const html = renderToStaticMarkup(createElement(AgentMark, { agent, size: "md" }));
      expect(html.length).toBeGreaterThan(20);
      expect(html).not.toContain("undefined");
      if (agent !== "custom-acp-runner") {
        expect(html).toContain('<span class="ls-theme-light"><svg');
        expect(html).toContain('<span class="ls-theme-dark"><svg');
      }
    }

    // Two gradient-bearing marks mounted side-by-side must never share identical <linearGradient id="...">
    const sideBySide = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(AgentMark, { agent: "codex" }),
        createElement(AgentMark, { agent: "codex" }),
      ),
    );
    const ids = [...sideBySide.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("matches iOS FNV-1a subagent glyph hashing and scopes <defs> per mounted instance", () => {
    expect(subagentGlyphs).toHaveLength(16);
    expect(subagentGlyphIndex(["sess-42", "tool-99"])).toBe(
      subagentGlyphIndex("sess-42", "tool-99"),
    );
    expect(subagentGlyphIndex(JSON.stringify(["sess-42", "tool-99"]))).toBe(
      subagentGlyphIndex("sess-42", "tool-99"),
    );
    expect(subagentGlyphIndex("tool-only")).toBe(subagentGlyphIndex("", "tool-only"));

    const twinHtml = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(SubagentGlyph, { seed: ["sess-42", "tool-99"], size: "md" }),
        createElement(SubagentGlyph, { seed: ["sess-42", "tool-99"], size: "md" }),
      ),
    );
    expect(twinHtml).toContain('<span class="ls-theme-light"><svg');
    expect(twinHtml).toContain('<span class="ls-theme-dark"><svg');
    const ids = [...twinHtml.matchAll(/<linearGradient[^>]*\sid="([^"]+)"/g)].map(
      (m) => m[1],
    );
    // 2 instances * 2 themes (light + dark) * 3 gradients (main, reverse, edge) = 12 unique IDs
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });
});
