import { describe, expect, it } from "vitest";
import { computerUseTopInset } from "../src/lib/computer-use";

describe("Computer Use preview placement", () => {
  it("does not reserve the header twice in an already inset chat pane", () => {
    expect(computerUseTopInset("ios", 122, 0, true)).toBe(0);
    expect(computerUseTopInset("ios", 122, 122, true)).toBe(0);
    expect(computerUseTopInset("android", 56, 0, true)).toBe(0);
  });
  it("clears the native iOS header even when the scroll view reports zero inset", () => {
    expect(computerUseTopInset("ios", 96, 0)).toBe(96);
    expect(computerUseTopInset("ios", 96, 120)).toBe(120);
    expect(computerUseTopInset("ios", 96, null)).toBe(96);
    expect(computerUseTopInset("android", 56, 0)).toBe(0);
  });
});
