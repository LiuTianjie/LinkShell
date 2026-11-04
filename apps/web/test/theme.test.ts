import { describe, expect, it } from "vitest";
import brandColors from "../../client/src/theme/brand-colors.json";
import { consolePalette, desktopPalette } from "../src/theme";

// docs/design/visual-system.md: one set of brand and status colours for every end; each surface
// brings only its own neutrals.
const brandTokens = [
  "accent", "accentFill", "accentHover", "accentSoft", "running",
  "waiting", "waitingFill", "waitingSoft", "ok", "okSoft", "danger", "dangerSoft",
] as const;

describe.each([
  ["browser console", consolePalette],
  ["desktop app", desktopPalette],
])("the %s palette", (_, palette) => {
  it("takes every brand and status colour from brand-colors.json", () => {
    for (const token of brandTokens) expect(palette[token], token).toEqual(brandColors[token]);
  });

  it("gives the older names the spec's values", () => {
    for (const name of ["link", "focus", "info", "running", "monitorCpu"]) expect(palette[name], name).toEqual(brandColors.accent);
    expect(palette.runningSoft).toEqual(brandColors.accentSoft);
    expect(palette.success).toEqual(brandColors.ok);
    expect(palette.warning).toEqual(brandColors.waiting);
    expect(palette.primaryForeground).toEqual(["#ffffff", "#ffffff"]);
    // Idle and memory are grey, in the surface's own greys.
    expect(palette.idle).toEqual(palette.tertiaryLabel);
    expect(palette.monitorMemory).toEqual(palette.secondaryLabel);
  });
});

it("keeps each surface's own neutrals", () => {
  expect(consolePalette.label).not.toEqual(brandColors.label);
  expect(desktopPalette.secondaryLabel).not.toEqual(consolePalette.secondaryLabel);
});

/** `#rrggbb`, `#rrggbbaa` or `rgba(r,g,b,a)` → [r, g, b, a]. */
function parse(color: string): [number, number, number, number] {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16);
    return [channel(0), channel(2), channel(4), hex.length === 8 ? channel(6) / 255 : 1];
  }
  const [r, g, b, a = 1] = color.match(/[\d.]+/g)!.map(Number);
  return [r!, g!, b!, a];
}

/** WCAG contrast of `text` (blended over `ground`) against `ground`. */
function contrast(text: string, ground: string): number {
  const [br, bg, bb] = parse(ground);
  const [r, g, b, a] = parse(text);
  const luminance = (channels: number[]) => {
    const [lr, lg, lb] = channels.map((value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
  };
  const front = luminance([r * a + br! * (1 - a), g * a + bg! * (1 - a), b * a + bb! * (1 - a)]);
  const back = luminance([br!, bg!, bb!]);
  return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
}

// 12–13 px secondary and tertiary text needs 4.5:1 on every light surface it sits on, and the
// hierarchy holds: secondary reads darker than tertiary.
describe.each([
  ["browser console", consolePalette, ["plain", "card", "background", "inset", "code", "userBubble"]],
  ["desktop app", desktopPalette, ["plain", "card", "background", "inset", "sheetCard", "code"]],
  ["Android (brand-colors.json)", brandColors as unknown as Record<string, [string, string]>, ["card", "background", "plain", "inset"]],
] as const)("the %s light text", (_, palette, grounds) => {
  it.each(["secondaryLabel", "tertiaryLabel"])("%s keeps 4.5:1", (name) => {
    for (const ground of grounds) expect(contrast(palette[name]![0], palette[ground]![0]), `${name} on ${ground}`).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps secondary above tertiary", () => {
    for (const ground of grounds) {
      expect(contrast(palette.secondaryLabel![0], palette[ground]![0])).toBeGreaterThan(contrast(palette.tertiaryLabel![0], palette[ground]![0]) + 1);
    }
  });
});
