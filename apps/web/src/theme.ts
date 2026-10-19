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

const nativeDesktopColors: Record<string, [string, string]> = {
  "background": ["#fafafb", "#060709"],
  "plain": ["#fafafb", "#060709"],
  "card": ["#ffffff", "#111318"],
  "cardRaised": ["#ffffff", "#1a1c22"],
  "inset": ["#edf0f5", "#0d0f13"],
  "sidebarBackground": ["#eef0f4", "#0b0c0f"],
  "sidebarAccent": ["#dfe3ea", "#1d1e22"],
  "label": ["#202636", "#f0f1f3"],
  "secondaryLabel": ["#596276", "#a8adb5"],
  "tertiaryLabel": ["#737c8d", "#8b909a"],
  "quaternaryLabel": ["#b2b4be", "#555562"],
  "separator": ["#28385212", "#dce5ff12"],
  "separatorStrong": ["#28385228", "#dce5ff26"],
  "fill": ["#70758d0c", "#cacaf20a"],
  "fillStrong": ["#70758d18", "#cacaf214"],
  "accent": ["#4a6cf7", "#607ff0"],
  "accentHover": ["#3e5ee5", "#7390fc"],
  "accentSoft": ["#4a6cf714", "#7d95ff1c"],
  "link": ["#4966d9", "#a1b2ff"],
  "userBubble": ["#eeeef4", "#181a20"],
  "code": ["#f3f3f7", "#101216"],
  "codeText": ["#323442", "#e3e3ee"],
  "desktop-shadow": ["#24283e0b", "#05051026"],
  "desktop-highlight": ["#ffffffb3", "#ffffff07"],
  "desktop-selected-shadow": ["#20274809", "#00000016"],
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
