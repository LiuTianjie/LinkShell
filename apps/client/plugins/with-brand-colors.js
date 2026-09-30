const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

// Writes src/theme/brand-colors.json as Android color resources: light values
// in res/values, dark in res/values-night. colors.ts reads them with
// PlatformColor("@color/ls_<name>") so they follow the system theme.

/** CSS "#rrggbb" / "rgba(r,g,b,a)" → Android "#AARRGGBB". */
function toAndroid(css) {
  const hex = /^#([0-9a-f]{6})$/i.exec(css);
  if (hex) return `#FF${hex[1].toUpperCase()}`;
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(css);
  if (!rgba) throw new Error(`with-brand-colors: unsupported colour ${css}`);
  const byte = (n) => Math.round(Number(n)).toString(16).padStart(2, "0").toUpperCase();
  const alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
  return `#${byte(alpha * 255)}${byte(rgba[1])}${byte(rgba[2])}${byte(rgba[3])}`;
}

function resources(colors, index) {
  const lines = Object.entries(colors).map(([name, pair]) => `  <color name="ls_${name}">${toAndroid(pair[index])}</color>`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated from src/theme/brand-colors.json. Do not edit. -->\n<resources>\n${lines.join("\n")}\n</resources>\n`;
}

module.exports = function withBrandColors(config) {
  return withDangerousMod(config, [
    "android",
    (config) => {
      const colors = JSON.parse(fs.readFileSync(path.join(config.modRequest.projectRoot, "src/theme/brand-colors.json"), "utf8"));
      const res = path.join(config.modRequest.platformProjectRoot, "app/src/main/res");
      for (const [dir, index] of [["values", 0], ["values-night", 1]]) {
        fs.mkdirSync(path.join(res, dir), { recursive: true });
        fs.writeFileSync(path.join(res, dir, "ls_brand_colors.xml"), resources(colors, index));
      }
      return config;
    },
  ]);
};
