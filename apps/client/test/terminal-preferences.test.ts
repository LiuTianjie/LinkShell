import { describe, expect, it, vi } from "vitest";
const saved = new Map<string, string>();
vi.mock("expo-sqlite/kv-store", () => ({ default: {
  getItemSync: (key: string) => saved.get(key) ?? null,
  setItemSync: (key: string, value: string) => saved.set(key, value),
} }));
const { terminalFontSize, TERMINAL_FONT_DEFAULT, setTerminalFontSize } = await import("../src/lib/terminal-preferences");
describe("terminal font preference", () => {
  it("starts at nine and permits every one-point step down to six", () => {
    expect(TERMINAL_FONT_DEFAULT).toBe(9);
    let size = 9;
    const steps = [];
    for (let i = 0; i < 5; i++) { size = terminalFontSize(size - 1); steps.push(size); }
    expect(steps).toEqual([8, 7, 6, 6, 6]);
  });
  it("persists a valid selected size and rejects non-finite values", () => {
    setTerminalFontSize(7);
    expect(saved.get("terminal.font-size")).toBe("7");
    expect(terminalFontSize(NaN)).toBe(9);
    expect(terminalFontSize(100)).toBe(32);
  });
});
