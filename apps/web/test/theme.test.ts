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
