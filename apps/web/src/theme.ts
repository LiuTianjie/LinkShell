import brandColors from "../../client/src/theme/brand-colors.json";

// Desktop chrome has its own quieter palette; mobile branding and native screens stay independent.
const desktopColors: Record<string, [string, string]> = {
  // Linear-style: a darker app frame with the workspace as a lighter inset
  // panel. The dark ramp is a continuous luminance ladder (frame darkest →
  // panel → raised), inset reads as recessed (darker than its surface), and
  // every hairline is a translucent tint so it blends on any backdrop.
  background: ["#f6f6f8", "#08090a"],
  plain: ["#ffffff", "#0f1011"],
  card: ["#ffffff", "#131417"],
  cardRaised: ["#ffffff", "#16171a"],
  inset: ["#f1f1f4", "#0b0c0d"],
  label: ["#17181b", "#f0f1f3"],
  secondaryLabel: ["#5c5f68", "#a0a3ab"],
  tertiaryLabel: ["#8a8d96", "#70737b"],
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
  accent: ["#5e6ad2", "#6872e5"],
  accentHover: ["#515dc0", "#7681ec"],
  accentSoft: ["#5e6ad214", "#6872e524"],
  primaryForeground: ["#ffffff", "#ffffff"],
  link: ["#5260c5", "#9aa5ff"],
  success: ["#218058", "#6cc29a"],
  ok: ["#218058", "#6cc29a"],
  warning: ["#917021", "#d8b76c"],
  waiting: ["#917021", "#d8b76c"],
  waitingSoft: ["#9170210d", "#d8b76c10"],
  info: ["#5260c5", "#9aa5ff"],
  running: ["#5260c5", "#9aa5ff"],
  danger: ["#c03e48", "#f08891"],
};
const variables = (index: 0 | 1) =>
  Object.entries({ ...brandColors, ...desktopColors })
    .map(([name, pair]) => `--${name}: ${pair[index]};`)
    .join("\n");

export const themeStyles = `
  :root { ${variables(0)} color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${variables(1)} color-scheme: dark; } }
  :root[data-theme="dark"] { ${variables(1)} color-scheme: dark; }
`;

// The desktop app's own system, after Codex's desktop app (docs/design/codex-reference.md):
// neutral greys, text and hairlines as translucent ink so they sit on any surface, a
// translucent sidebar over the window's vibrancy and a solid main surface beside it. Colour is
// kept for state (blue running, amber waiting on you, red failed); the one filled control is ink.
const nativeDesktopColors: Record<string, [string, string]> = {
  // The window's ground where vibrancy is off (unfocused, 4K, "opaque window"); the sidebar is
  // see-through over it, the main surface is not.
  "background": ["#f3f3f3", "#1d1d1d"],
  "plain": ["#ffffff", "#181818"],
  "sidebarBackground": ["#ededed66", "#21212166"],
  "card": ["#ffffff", "#181818"],
  "cardRaised": ["#ffffff", "#212121"],
  "inset": ["#f3f3f3", "#131313"],
  "sheet": ["#ffffffb3", "#212121f5"],
  "sheetCard": ["#f9f9f9", "#181818"],
  "sidebarAccent": ["#1a1c1f14", "#ffffff14"],
  "label": ["#1a1c1f", "#dfdfdf"],
  "secondaryLabel": ["#1a1c1fb3", "#ffffffb3"],
  "tertiaryLabel": ["#1a1c1f80", "#ffffff80"],
  "quaternaryLabel": ["#1a1c1f59", "#ffffff4d"],
  "placeholder": ["#1a1c1f73", "#ffffff66"],
  "separator": ["#1a1c1f14", "#ffffff14"],
  "separatorStrong": ["#1a1c1f1f", "#ffffff29"],
  // Codex's ghost hover and press: 5 % / 12 % of the ink, 8 % / 16 % of white in the dark.
  "fill": ["#1a1c1f0d", "#ffffff14"],
  "fillStrong": ["#1a1c1f1f", "#ffffff29"],
  // The filled control is the text's own colour, its label the surface's (Codex's primary-solid).
  "accent": ["#1a1c1f", "#dfdfdf"],
  "accentHover": ["#303030", "#ededed"],
  "accentSoft": ["#1a1c1f0d", "#ffffff0d"],
  "primaryForeground": ["#ffffff", "#0d0d0d"],
  "link": ["#0169cc", "#339cff"],
  "focus": ["#339cff", "#339cffb3"],
  "running": ["#0285ff", "#339cff"],
  "runningSoft": ["#0285ff1a", "#339cff24"],
  "info": ["#0285ff", "#339cff"],
  "success": ["#00a240", "#40c977"],
  "ok": ["#00a240", "#40c977"],
  "okSoft": ["#00a2401a", "#40c97724"],
  // A finished session is the normal state, not news: it stays grey.
  "idle": ["#1a1c1f80", "#ffffff80"],
  "warning": ["#e25507", "#ff8549"],
  "waiting": ["#e25507", "#ff8549"],
  "waitingSoft": ["#e255071a", "#ff854924"],
  "danger": ["#e02e2a", "#fa423e"],
  "dangerSoft": ["#e02e2a14", "#fa423e24"],
  "userBubble": ["#1a1c1f0d", "#ffffff0d"],
  "code": ["#f9f9f9", "#131313"],
  "codeText": ["#1a1c1f", "#dfdfdf"],
  "diffAdd": ["#00a24026", "#40c9773b"],
  "diffDel": ["#e02e2a26", "#fa423e3b"],
  "diffAddText": ["#3a843f", "#83d197"],
  "diffDelText": ["#c0271f", "#f8a6a3"],
  "desktop-shadow": ["#0000001f", "#00000080"],
  "desktop-highlight": ["#00000000", "#ffffff33"],
  "desktop-selected-shadow": ["#00000000", "#00000000"],
};

export function applyDesktopTheme(theme: "light" | "dark"): void {
  const root = document.documentElement;
  const index = theme === "dark" ? 1 : 0;
  root.dataset.theme = theme;
  // Native appearance changes must update the same resolved tokens on every
  // control and portal; a second CSS palette must not retain light values.
  for (const [name, values] of Object.entries({ ...brandColors, ...desktopColors, ...nativeDesktopColors })) {
    root.style.setProperty(`--${name}`, values[index]);
  }
  root.style.colorScheme = theme;
}
