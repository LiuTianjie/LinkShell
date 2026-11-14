import brandColors from "../../client/src/theme/brand-colors.json";
import { desktopPlatform } from "./bridge/desktop-bridge";

export type ColorPair = readonly [light: string, dark: string];
export type Palette = Record<string, ColorPair>;
export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const pair = (values: readonly string[]): ColorPair => [values[0]!, values[1]!];

/**
 * Brand and status hues come exclusively from `apps/client/src/theme/brand-colors.json`
 * (`docs/design/visual-system.md`). Semantic aliases point to those canonical pairs so
 * desktop, mobile, watch, and site never drift.
 */
const brandAliases: Palette = {
  link: pair(brandColors.accent),
  focus: pair(brandColors.accent),
  info: pair(brandColors.running),
  runningSoft: pair(brandColors.accentSoft),
  success: pair(brandColors.ok),
  warning: pair(brandColors.waiting),
  primaryForeground: ["#ffffff", "#ffffff"],
  monitorCpu: pair(brandColors.accent),
};

/**
 * 7-tier Carbon-Obsidian & Alabaster multi-elevation surface and typography ramp
 * (Paseo + T3 Code sculpted instrument aesthetic) for LinkShell Desktop (macOS & Windows).
 * Every light and dark surface satisfies WCAG AA >= 4.5:1 for both `secondaryLabel` and
 * `tertiaryLabel`, with `contrast(secondaryLabel) > contrast(tertiaryLabel) + 1.0`.
 */
export const desktopNeutrals: Palette = {
  // L0 Deep Carbon Window Ground & L1 Sidebar Rail (macOS vibrancy uses translucent L1 in CSS)
  ground: ["#f2f3f6", "#090a0c"],
  sidebar: ["#f2f3f6", "#090a0c"],
  sidebarTranslucent: ["rgba(242,243,246,0.82)", "rgba(9,10,12,0.84)"],
  sidebarAccent: ["rgba(17,19,24,0.06)", "rgba(255,255,255,0.075)"],

  // L2 Sculpted Workspace Island Canvas (100% opaque to protect text contrast & GPU compositing)
  plain: ["#ffffff", "#0e0f12"],

  // L3 Inspector / Split Workbench / Grouped Management Canvas
  background: ["#f7f8fa", "#0b0c0f"],
  sheet: ["#f7f8fa", "#111216"],

  // L4 Recessed Instrument Well (Code blocks, Diffs, Logs, Segmented control tracks)
  inset: ["#eff1f5", "#090a0d"],
  code: ["#eff1f5", "#090a0d"],

  // L5 Sculpted Cards (Composer shell, Selected Session Card, Approval card, Management cards)
  card: ["#ffffff", "#141519"],
  cardRaised: ["#f6f7f9", "#181a20"],
  composerSurface: ["#ffffff", "#141519"],
  composerToolbar: ["#f7f8fa", "#111216"],
  userBubble: ["#eef0f4", "#181a20"],

  // L6 Floating Top-Layer Surfaces (Menus, Popovers, Command Center, Modals, Tooltips)
  sheetCard: ["#ffffff", "#1d1f26"],
  popover: ["#ffffff", "#1d1f26"],

  // Monochrome High-Contrast Primary Keycaps (Paseo / T3 Code primary action triggers)
  primaryKeycapBg: ["#141518", "#ededf0"],
  primaryKeycapFg: ["#ffffff", "#0b0c0e"],
  primaryKeycapHover: ["#26282e", "#ffffff"],

  // Dedicated Terminal Well (Light & Dark calibrated)
  terminal: ["#fbfcfd", "#090a0d"],
  terminalBg: ["#fbfcfd", "#090a0d"],
  terminalFg: ["#181b22", "#e6e9f0"],
  terminalChrome: ["#f3f5f8", "#0d0f13"],

  // Ink Hierarchy (AA verified >= 4.89:1 across L0–L6 in both Light and Dark)
  label: ["#111318", "#f0f2f5"],
  secondaryLabel: ["#434852", "#b4bac6"],
  tertiaryLabel: ["#606672", "#8b92a0"],
  // Decorative / disabled-only slot hint; never used for required UI copy
  quaternaryLabel: ["#8a909c", "#59606d"],
  placeholder: ["#606672", "#8b92a0"],
  codeText: ["#181b22", "#e6e9f0"],

  // Hairlines & Interactive Fills (real borders so Forced Colors preserves structure)
  borderSubtle: ["rgba(17,19,24,0.06)", "rgba(255,255,255,0.055)"],
  separator: ["rgba(17,19,24,0.095)", "rgba(255,255,255,0.075)"],
  separatorStrong: ["rgba(17,19,24,0.16)", "rgba(255,255,255,0.13)"],
  hover: ["rgba(17,19,24,0.045)", "rgba(255,255,255,0.055)"],
  active: ["rgba(17,19,24,0.08)", "rgba(255,255,255,0.09)"],
  fill: ["rgba(17,19,24,0.05)", "rgba(255,255,255,0.065)"],
  fillStrong: ["rgba(17,19,24,0.10)", "rgba(255,255,255,0.12)"],

  // Crisp Emerald & Coral Diff Grounds & Text (Paseo / T3 Code precision review)
  diffAdd: ["rgba(26,127,55,0.11)", "rgba(63,185,80,0.15)"],
  diffDel: ["rgba(207,34,46,0.10)", "rgba(248,81,73,0.15)"],
  diffAddText: ["#1a7f37", "#3fb950"],
  diffDelText: ["#cf222e", "#f85149"],

  // Scrollbar Thumbs (>= 3:1 resting contrast against all surfaces)
  scrollbarThumb: ["#7d8390", "#6b7280"],
  scrollbarThumbHover: ["#606672", "#8b92a0"],
};

/** Shiki CSS-variable syntax theme tokens (`codex-light` / `codex-dark` calibrated). */
export const codeSyntaxColors: Palette = {
  "code-foreground": ["currentColor", "currentColor"],
  "code-background": ["transparent", "transparent"],
  "code-token-keyword": ["#a63d6f", "#f69ec4"],
  "code-token-string": ["#257230", "#83d498"],
  "code-token-string-expression": ["#257230", "#83d498"],
  "code-token-function": ["#1c4d96", "#6eb0ff"],
  "code-token-constant": ["#a3461b", "#f4a578"],
  "code-token-parameter": ["#5d36a8", "#bfa0f8"],
  "code-token-comment": ["#636873", "#8b919e"],
  "code-token-punctuation": ["currentColor", "currentColor"],
  "code-token-link": ["#1c4d96", "#6eb0ff"],
  "code-token-inserted": ["#187a4a", "#6adba3"],
  "code-token-deleted": ["#c8322f", "#ff948d"],
  "code-token-changed": ["#ad5200", "#ffad5c"],
};

const neutralAliases = (neutrals: Palette): Palette => ({
  idle: neutrals.tertiaryLabel!,
  monitorMemory: neutrals.secondaryLabel!,
});

export const desktopPalette: Palette = {
  ...Object.fromEntries(
    Object.entries(brandColors).map(([name, values]) => [name, pair(values)]),
  ),
  ...desktopNeutrals,
  ...brandAliases,
  ...neutralAliases(desktopNeutrals),
  ...codeSyntaxColors,
};

/** Calibrated Ghostty-inspired Dark ANSI 16 palette for integrated xterm instances. */
export const terminalDarkAnsiPalette = {
  background: "#090a0d",
  foreground: "#e6e9f0",
  cursor: "#8d9bff",
  cursorAccent: "#090a0d",
  selectionBackground: "rgba(141, 155, 255, 0.26)",
  black: "#1b1e24",
  red: "#ff7b72",
  green: "#4cc38a",
  yellow: "#ffad5c",
  blue: "#79a8ff",
  magenta: "#c89bff",
  cyan: "#5fd3df",
  white: "#cfd5e2",
  brightBlack: "#636873",
  brightRed: "#ffa198",
  brightGreen: "#7ee2b3",
  brightYellow: "#ffc685",
  brightBlue: "#9ec0ff",
  brightMagenta: "#dcbdff",
  brightCyan: "#8ae5ef",
  brightWhite: "#f5f7fb",
} as const;

/** Calibrated Alabaster Light ANSI 16 palette (WCAG AA >= 4.5:1 on `#fbfcfd`). */
export const terminalLightAnsiPalette = {
  background: "#fbfcfd",
  foreground: "#181b22",
  cursor: "#2563eb",
  cursorAccent: "#fbfcfd",
  selectionBackground: "rgba(37, 99, 235, 0.18)",
  black: "#181b22",
  red: "#cf222e",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#0e7490",
  white: "#57606a",
  brightBlack: "#606672",
  brightRed: "#a40e26",
  brightGreen: "#116329",
  brightYellow: "#7d4e00",
  brightBlue: "#0550ae",
  brightMagenta: "#6639ba",
  brightCyan: "#155e75",
  brightWhite: "#111318",
} as const;

/** Backwards-compatible dark ANSI palette alias. */
export const terminalAnsiPalette = terminalDarkAnsiPalette;

/** Returns the active Light or Dark ANSI 16 palette for xterm instances. */
export function getTerminalAnsiPalette(
  theme: ResolvedTheme = getResolvedTheme(),
): typeof terminalLightAnsiPalette | typeof terminalDarkAnsiPalette {
  return theme === "light" ? terminalLightAnsiPalette : terminalDarkAnsiPalette;
}

/** Parses `#rrggbb`, `#rrggbbaa`, or `rgba(r, g, b, a)` into `[r, g, b, a]`. */
export function parseColorRgba(color: string): [number, number, number, number] {
  const trimmed = color.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16);
    return [
      channel(0),
      channel(2),
      channel(4),
      hex.length === 8 ? channel(6) / 255 : 1,
    ];
  }
  const matches = trimmed.match(/[\d.]+/g);
  if (!matches || matches.length < 3) {
    throw new Error(`Unsupported color literal: ${color}`);
  }
  const [r, g, b, a = 1] = matches.map(Number);
  return [r!, g!, b!, a];
}

/** WCAG 2.1 relative luminance for `[r, g, b]` in `0..255`. */
export function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  const linearize = (channel: number) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG 2.1 contrast ratio of `foreground` alpha-composited over `background`. */
export function wcagContrast(foreground: string, background: string): number {
  const [br, bg, bb] = parseColorRgba(background);
  const [fr, fg, fb, fa] = parseColorRgba(foreground);
  const frontLum = relativeLuminance([
    fr * fa + br * (1 - fa),
    fg * fa + bg * (1 - fa),
    fb * fa + bb * (1 - fa),
  ]);
  const backLum = relativeLuminance([br, bg, bb]);
  return (Math.max(frontLum, backLum) + 0.05) / (Math.min(frontLum, backLum) + 0.05);
}

/** Resolves `"light" | "dark" | "system"` against system `prefers-color-scheme`. */
export function resolveThemeMode(mode: ThemeMode, prefersDark?: boolean): ResolvedTheme {
  if (mode === "light" || mode === "dark") return mode;
  const systemDark =
    prefersDark ??
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  return systemDark ? "dark" : "light";
}

/** Reads the currently active resolved theme from `document.documentElement` or `matchMedia`. */
export function getResolvedTheme(): ResolvedTheme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.dataset.theme;
    if (attr === "light" || attr === "dark") return attr;
  }
  return resolveThemeMode("system");
}

/**
 * Applies appearance mode to `:root` without wiping stored preferences on `matchMedia` events.
 * Uses CSS `color-scheme` + unregistered `light-dark()` custom properties (`tokens.css`) so
 * every L0–L6 surface and scoped dark well updates in 0ms without inline style loops.
 */
export function applyDesktopAppearance(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveThemeMode(mode);
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.dataset.themeMode = mode;
    if (!root.dataset.platform) {
      root.dataset.platform = desktopPlatform;
    }
    if (mode === "system") {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = mode;
    }
  }
  return resolved;
}
