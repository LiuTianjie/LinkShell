import brandColors from "../../client/src/theme/brand-colors.json";

// Keep the browser palette tied to the same light/dark pairs as the mobile app.
const variables = (index: 0 | 1) =>
  Object.entries(brandColors)
    .map(([name, pair]) => `--${name}: ${pair[index]};`)
    .join("\n");

export const themeStyles = `
  :root { ${variables(0)} color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${variables(1)} color-scheme: dark; } }
  :root[data-theme="dark"] { ${variables(1)} color-scheme: dark; }
`;
