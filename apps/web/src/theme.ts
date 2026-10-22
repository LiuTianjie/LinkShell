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

// The desktop app's own system, shared with LinkShell.app's native pages (DesktopStyle in
// apps/mac): neutral greys only, elevation by a step in lightness. Dark steps down from the
// window ground (panels are darker than it); light steps up (white panels on a grey ground).
// Colour is kept for state: mint while an agent works, amber when it waits on you, red when it
// failed. The one filled control is inverted ink, so `accent` is ink, never a hue.
const nativeDesktopColors: Record<string, [string, string]> = {
  "background": ["#ececec", "#1b1b1b"],
  "plain": ["#ffffff", "#111111"],
  "sidebarBackground": ["#ffffff", "#111111"],
  "card": ["#f5f5f5", "#0b0b0b"],
  "cardRaised": ["#ffffff", "#1d1d1d"],
  "inset": ["#f2f2f2", "#0b0b0b"],
  "sheet": ["#ffffff", "#111111"],
  "sheetCard": ["#f5f5f5", "#0b0b0b"],
  "sidebarAccent": ["#e4e4e4", "#2b2b2b"],
  "label": ["#121212", "#f2f2f2"],
  "secondaryLabel": ["#4d4d4d", "#b5b5b5"],
  "tertiaryLabel": ["#616161", "#969696"],
  "quaternaryLabel": ["#8a8a8a", "#6b6b6b"],
  "placeholder": ["#6b6b6b", "#8f8f8f"],
  "separator": ["#e2e2e2", "#262626"],
  "separatorStrong": ["#cccccc", "#3d3d3d"],
  "fill": ["#0000000a", "#ffffff0d"],
  "fillStrong": ["#00000014", "#ffffff17"],
  "accent": ["#1a1a1a", "#f2f2f2"],
  "accentHover": ["#424242", "#cccccc"],
  "accentSoft": ["#0000000f", "#ffffff14"],
  "primaryForeground": ["#ffffff", "#0f0f0f"],
  "link": ["#0b6e5d", "#5fd9c0"],
  "running": ["#077a66", "#3ddbb9"],
  "runningSoft": ["#077a661a", "#3ddbb924"],
  "info": ["#077a66", "#3ddbb9"],
  "success": ["#077a66", "#3ddbb9"],
  "ok": ["#077a66", "#3ddbb9"],
  "okSoft": ["#077a661a", "#3ddbb924"],
  // A finished session is the normal state, not news: it stays grey.
  "idle": ["#616161", "#969696"],
  "warning": ["#965c05", "#f2a33d"],
  "waiting": ["#965c05", "#f2a33d"],
  "waitingSoft": ["#965c051a", "#f2a33d24"],
  "danger": ["#b3292b", "#e6576f"],
  "dangerSoft": ["#b3292b14", "#e6576f24"],
  "userBubble": ["#f0f0f0", "#1f1f1f"],
  "code": ["#f5f5f5", "#0b0b0b"],
  "codeText": ["#2b2b2b", "#e0e0e0"],
  "diffAdd": ["#077a6614", "#3ddbb91a"],
  "diffDel": ["#b3292b12", "#e6576f1c"],
  "diffAddText": ["#066b59", "#7fe3cd"],
  "diffDelText": ["#a32527", "#f28a9b"],
  "desktop-shadow": ["#0000001f", "#00000080"],
  "desktop-highlight": ["#00000000", "#00000000"],
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
