import { describe, expect, it } from "vitest";
import type { LayoutMetrics } from "../modules/link-layout";
import { matchingLayoutMetrics, safeContentInsets } from "../src/lib/adaptive-insets";
import { workspaceLayout } from "../src/lib/workspace-layout";

const fallback = { top: 0, right: 0, bottom: 34, left: 0 };
const outer: LayoutMetrics = {
  revision: "1:951x669", width: 951, height: 669,
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  occlusions: [{ x: 867, y: 0, width: 84, height: 120, active: true }], divisions: [],
};
const inner: LayoutMetrics = {
  revision: "2:867x669", width: 867, height: 669, insets: fallback,
  occlusions: [], divisions: [{ x: 455.5, y: 0, width: 40, height: 669, active: false }],
};

describe("Duo geometry continuity", () => {
  it("uses the measured outer occlusion once, then lays out inside the safe width", () => {
    const insets = safeContentInsets(matchingLayoutMetrics(outer, outer, outer.revision), fallback);
    expect(insets).toEqual({ top: 0, right: 84, bottom: 34, left: 0 });
    const width = outer.width - insets.left - insets.right;
    expect(width).toBe(inner.width);
    const current = matchingLayoutMetrics(inner, { width, height: outer.height }, inner.revision)!;
    const layout = workspaceLayout(width, 1, current.divisions, current.height);
    expect(layout).toMatchObject({ split: true, folded: false, axis: "row", gap: 24, paneWidth: 421.5 });
    expect(layout.before + layout.gap + layout.after).toBe(width);
  });

  it("never carries a landscape side bar or hinge into the portrait frame", () => {
    const portrait = { width: 669, height: 951 };
    const current = matchingLayoutMetrics(outer, portrait, "3:669x951");
    const portraitFallback = { top: 64, right: 0, bottom: 34, left: 0 };
    expect(current).toBeNull();
    expect(safeContentInsets(current, portraitFallback)).toEqual(portraitFallback);
    const layout = workspaceLayout(portrait.width, 1, matchingLayoutMetrics(inner, portrait)?.divisions, portrait.height);
    expect(layout).toMatchObject({ split: false, axis: "row", paneWidth: 669 });
  });

  it("rejects stale heights and events from an earlier visit to the same dimensions", () => {
    expect(matchingLayoutMetrics(inner, { width: 867, height: 550 }, inner.revision)).toBeNull();
    expect(matchingLayoutMetrics(inner, { width: 867, height: 669 }, "4:867x669")).toBeNull();
    expect(matchingLayoutMetrics({ ...inner, revision: "4:867x669" }, inner, "4:867x669")).not.toBeNull();
    expect(matchingLayoutMetrics(inner, { width: 0, height: 0 })).toBeNull();
  });

  it("tracks an active hinge in either axis using the current local frame", () => {
    const vertical = workspaceLayout(867, 1, [{ ...inner.divisions[0]!, active: true }], 669);
    expect(vertical).toMatchObject({ folded: true, axis: "row", before: 455.5, gap: 40, after: 371.5 });
    const horizontal = workspaceLayout(669, 1, [{ x: 0, y: 413.5, width: 669, height: 40, active: true }], 867);
    expect(horizontal).toMatchObject({ folded: true, axis: "column", before: 413.5, gap: 40, after: 413.5 });
    expect(horizontal.before + horizontal.gap + horizontal.after).toBe(867);
  });
});
