import brandColors from "../../client/src/theme/brand-colors.json";

type Palette = Record<string, [string, string]>;
const pair = (values: readonly string[]): [string, string] => [values[0]!, values[1]!];

// Brand and status colours have one source shared with the phone and the native windows
// (docs/design/visual-system.md). The other names the components read are those same values under
// the names they already use, so no surface can drift from the spec.
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

// Status names that are grey take each surface's own greys: idle and finished are the normal
// state, and memory is the neutral line beside the CPU's accent.
const neutralAliases = (neutrals: Palette): Palette => ({
  idle: neutrals.tertiaryLabel!,
  monitorMemory: neutrals.secondaryLabel!,
});

/** Every variable one surface defines: the shared brand values over that surface's neutrals. */
const palette = (neutrals: Palette): Palette => ({
  ...Object.fromEntries(Object.entries(brandColors).map(([name, values]) => [name, pair(values)])),
  ...neutrals,
  ...brandAliases,
  ...neutralAliases(neutrals),
  ...codeColors,
});

// The browser console's neutrals: brand and status colours are not defined here.
const consoleNeutrals: Palette = {
  // A darker app frame with the workspace as a lighter inset panel. The dark
  // ramp is a continuous luminance ladder (frame darkest → panel → raised),
  // inset reads as recessed (darker than its surface), and every hairline is a
  // translucent tint so it blends on any backdrop.
  background: ["#f6f6f8", "#08090a"],
  plain: ["#ffffff", "#0f1011"],
  card: ["#ffffff", "#131417"],
  cardRaised: ["#ffffff", "#16171a"],
  inset: ["#f1f1f4", "#0b0c0d"],
  label: ["#17181b", "#f0f1f3"],
  // Light-mode text keeps 4.5:1 on every light surface, secondary a clear step darker.
  secondaryLabel: ["#51545d", "#a0a3ab"],
  tertiaryLabel: ["#65686f", "#70737b"],
  quaternaryLabel: ["#aeb0b8", "#4e5059"],
  // Hairlines: translucent, and the container frame one tier stronger than
  // the row dividers it holds.
  separator: ["#0000000f", "#ffffff12"],
  separatorStrong: ["#00000020", "#ffffff1f"],
  fill: ["#1b1c200a", "#ffffff0a"],
  fillStrong: ["#1b1c2014", "#ffffff14"],
  sidebarBackground: ["#f6f6f8", "#08090a"],
  sidebarAccent: ["#00000010", "#ffffff14"],
  code: ["#f3f3f6", "#0b0c0d"],
  codeText: ["#30323b", "#dedfe8"],
  userBubble: ["#ececf1", "#1a1b1f"],
  composerSurface: ["#ffffff", "#232428"],
  composerToolbar: ["#f7f8fa", "#ffffff04"],
};

// Syntax colours (Codex's codex-light / codex-dark), read by the highlighter's CSS-variable theme
// in highlight-engine.ts; text the grammar doesn't colour keeps the block's own colour.
const codeColors: Palette = {
  "code-foreground": ["currentColor", "currentColor"],
  "code-background": ["transparent", "transparent"],
  "code-token-keyword": ["#ab4f7a", "#f8a6c8"],
  "code-token-string": ["#3a843f", "#83d197"],
  "code-token-string-expression": ["#3a843f", "#83d197"],
  "code-token-function": ["#1f4e94", "#63a8f8"],
  "code-token-constant": ["#ac4f23", "#f1a275"],
  "code-token-parameter": ["#643cae", "#b897f4"],
  "code-token-comment": ["#1a1c1f80", "#ffffff73"],
  "code-token-punctuation": ["currentColor", "currentColor"],
  "code-token-link": ["#1f4e94", "#63a8f8"],
  "code-token-inserted": ["#3a843f", "#83d197"],
  "code-token-deleted": ["#c0271f", "#f8a6a3"],
  "code-token-changed": ["#ac4f23", "#f1a275"],
};

// The desktop app's neutrals (brand and status colours are not defined here): text and hairlines
// as translucent ink so they sit on any surface, a translucent sidebar over the window's vibrancy
// and a solid main surface beside it.
const desktopNeutrals: Palette = {
  // The window's ground where vibrancy is off (unfocused, 4K, "opaque window"); the sidebar is
  // see-through over it, the main surface is not.
  "background": ["#f3f4f6", "#1c1d20"],
  "plain": ["#ffffff", "#18191c"],
  "sidebarBackground": ["#edeef266", "#20212666"],
  "card": ["#ffffff", "#18191c"],
  "cardRaised": ["#ffffff", "#232428"],
  "inset": ["#f3f4f6", "#131417"],
  "sheet": ["#ffffffb3", "#212121f5"],
  "sheetCard": ["#f9f9f9", "#181818"],
  "sidebarAccent": ["#1a1c1f14", "#ffffff14"],
  "label": ["#1a1c1f", "#dfdfdf"],
  "secondaryLabel": ["#1a1c1fbf", "#ffffffb3"],
  "tertiaryLabel": ["#1a1c1fa3", "#ffffff80"],
  "quaternaryLabel": ["#1a1c1f59", "#ffffff4d"],
  "placeholder": ["#1a1c1f73", "#ffffff66"],
  "separator": ["#1a1c1f14", "#ffffff14"],
  "separatorStrong": ["#1a1c1f1f", "#ffffff29"],
  // Hover and press: 5 % / 12 % of the ink, 8 % / 16 % of white in the dark.
  "fill": ["#1a1c1f0d", "#ffffff14"],
  "fillStrong": ["#1a1c1f1f", "#ffffff29"],
  "userBubble": ["#1a1c1f12", "#ffffff12"],
  "code": ["#f9f9f9", "#131313"],
  "codeText": ["#1a1c1f", "#dfdfdf"],
  // The terminal is the panel itself: no darker block inside it.
  "terminal": ["#ffffff", "#18191c"],
  "diffAdd": ["#00a24026", "#40c9773b"],
  "diffDel": ["#e02e2a26", "#fa423e3b"],
  "diffAddText": ["#3a843f", "#83d197"],
  "diffDelText": ["#c0271f", "#f8a6a3"],
  "desktop-shadow": ["#0000001f", "#00000080"],
  "desktop-highlight": ["#00000000", "#ffffff33"],
  "desktop-selected-shadow": ["#00000000", "#00000000"],
};

export const consolePalette = palette(consoleNeutrals);
export const desktopPalette = palette({ ...consoleNeutrals, ...desktopNeutrals });

const variables = (index: 0 | 1) =>
  Object.entries(consolePalette)
    .map(([name, values]) => `--${name}: ${values[index]};`)
    .join("\n");

export const themeStyles = `
  :root { ${variables(0)} color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${variables(1)} color-scheme: dark; } }
  :root[data-theme="dark"] { ${variables(1)} color-scheme: dark; }
`;

export function applyDesktopTheme(theme: "light" | "dark"): void {
  const root = document.documentElement;
  const index = theme === "dark" ? 1 : 0;
  root.dataset.theme = theme;
  // Native appearance changes must update the same resolved tokens on every
  // control and portal; a second CSS palette must not retain light values.
  for (const [name, values] of Object.entries(desktopPalette)) {
    root.style.setProperty(`--${name}`, values[index]);
  }
  root.style.colorScheme = theme;
}
