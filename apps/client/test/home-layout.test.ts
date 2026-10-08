import { describe, expect, it } from "vitest";
import { homeNavigationLayout, homeUsesInlineControls } from "../src/lib/home-layout";
import { workspaceLayout } from "../src/lib/workspace-layout";

describe("Home native header geometry", () => {
  it("puts root controls beside search only for a compact list without a side toolbar", () => {
    const phone = { top: 62, left: 0, right: 0, bottom: 34 };
    expect(homeUsesInlineControls(phone, false, false)).toBe(true);
    expect(homeUsesInlineControls(phone, false, true)).toBe(false);
    expect(homeUsesInlineControls(phone, true, false)).toBe(false);
    expect(homeUsesInlineControls({ ...phone, top: 0, left: 62, right: 62 }, false, false)).toBe(true);
    expect(homeUsesInlineControls({ ...phone, right: 84 }, false, false)).toBe(false);
    expect(homeUsesInlineControls({ ...phone, left: 84 }, false, false)).toBe(false);
  });
  it("clears the status bar rather than reserving a hidden root toolbar", () => {
    const phone = { top: 62, left: 0, right: 0, bottom: 83 };
    expect(homeNavigationLayout(phone, phone, 106, false)).toEqual({ headerTransparent: true, contentTop: 62 });
  });
  it("does not toggle the header while half-folded portrait metrics catch up", () => {
    const system = { top: 82, left: 0, right: 0, bottom: 83 };
    const frames = [
      { height: 869, divisions: [{ x: 0, y: 372.5, width: 669, height: 40, active: true }], top: 0 },
      { height: 951, divisions: [], top: 82 },
      { height: 869, divisions: [], top: 0 },
      { height: 951, divisions: [{ x: 0, y: 454.5, width: 669, height: 40, active: true }], top: 0 },
    ];
    expect(frames.map((frame) => workspaceLayout(669, 1, frame.divisions, frame.height).split)).toEqual([true, false, false, true]);
    for (const frame of frames) {
      expect(homeNavigationLayout({ ...system, top: frame.top }, system, 82)).toEqual({ headerTransparent: true, contentTop: 82 });
    }
  });

  it("does not turn a side toolbar height into a large top gap", () => {
    const page = { top: 0, left: 0, right: 0, bottom: 34 };
    expect(homeNavigationLayout(page, { ...page, right: 84 }, 669).contentTop).toBe(0);
    expect(homeNavigationLayout(page, { ...page, left: 84 }, 669).contentTop).toBe(0);
  });

  it("still clears a horizontal header on conventional landscape phones", () => {
    const page = { top: 0, left: 0, right: 0, bottom: 21 };
    expect(homeNavigationLayout(page, { ...page, left: 59, right: 59 }, 44).contentTop).toBe(44);
  });
});
