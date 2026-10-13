import brandColors from "../../client/src/theme/brand-colors.json";

// Desktop chrome has its own quieter palette; mobile branding and native screens stay independent.
const desktopColors: Record<string, [string, string]> = {
  background: ["#fbfbfc", "#141519"],
  plain: ["#ffffff", "#191a20"],
  card: ["#ffffff", "#1d1e25"],
  cardRaised: ["#ffffff", "#26272f"],
  inset: ["#f5f5f7", "#202128"],
  label: ["#26272d", "#eeeef2"],
  secondaryLabel: ["#6b6e79", "#a4a6b3"],
  tertiaryLabel: ["#7b7e89", "#7e8190"],
  separator: ["#e5e5eb", "#30313b"],
  fill: ["#25263008", "#ffffff08"],
  fillStrong: ["#25263010", "#ffffff10"],
  sidebarBackground: ["#f6f6f8", "#17181e"],
  sidebarAccent: ["#e8e9ee", "#292b35"],
  code: ["#f5f5f8", "#14151b"],
  codeText: ["#353642", "#dedfe8"],
  userBubble: ["#f0f0f5", "#252631"],
  accent: ["#5e6ad2", "#5e6ad2"],
  accentHover: ["#515dc0", "#5360c4"],
  accentSoft: ["#eeeffb", "#5e6ad21c"],
  primaryForeground: ["#ffffff", "#ffffff"],
  link: ["#5260c5", "#a3adff"],
  success: ["#218058", "#73c59e"],
  ok: ["#218058", "#73c59e"],
  warning: ["#917021", "#d8b76c"],
  waiting: ["#917021", "#d8b76c"],
  waitingSoft: ["#9170210d", "#d8b76c10"],
  info: ["#5260c5", "#a3adff"],
  running: ["#5260c5", "#a3adff"],
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
