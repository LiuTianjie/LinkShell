import { describe, expect, it, vi } from "vitest";

// The phone's key-value store, as a map.
const kept = new Map<string, string>();
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: (key: string) => kept.get(key) ?? null,
    setItemSync: (key: string, value: string) => void kept.set(key, value),
    removeItemSync: (key: string) => void kept.delete(key),
  },
}));
const { loadScreenShortcuts, normalizeHostUrl, saveScreenShortcuts, screenShortcuts } = await import("@/lib/settings");

describe("a computer's address, as typed", () => {
  it("becomes a WebSocket address", () => {
    expect(normalizeHostUrl(" 192.168.1.5:7878 ")).toBe("ws://192.168.1.5:7878");
    expect(normalizeHostUrl("wss://host.example/")).toBe("wss://host.example");
    expect(normalizeHostUrl("WS://127.0.0.1:7878")).toBe("WS://127.0.0.1:7878");
  });

  it("is refused when it isn't an address", () => {
    expect(normalizeHostUrl("")).toBeNull();
    expect(normalizeHostUrl("   ")).toBeNull();
    expect(normalizeHostUrl("ws://")).toBeNull();
    expect(normalizeHostUrl("not an address")).toBeNull();
  });
});

describe("the screen viewer's own shortcuts", () => {
  it("keeps only key combinations the computer would take", () => {
    expect(
      screenShortcuts([
        { name: " 保存 ", k: "s", m: ["cmd"] },
        { name: "强制退出", k: "escape", m: ["alt", "cmd", "hyper"] },
        { name: "", k: "s", m: [] },
        { name: "未知按键", k: "printscreen", m: [] },
        { name: "两个键", k: "ab", m: [] },
        "not a shortcut",
        null,
      ]),
    ).toEqual([
      { name: "保存", k: "s", m: ["cmd"] },
      // Modifiers come back in one order, without the ones nobody has.
      { name: "强制退出", k: "escape", m: ["alt", "cmd"] },
    ]);
  });

  it("shortens long names and stops at twenty-four", () => {
    expect(screenShortcuts([{ name: "很".repeat(40), k: "f12", m: [] }])[0]?.name).toBe("很".repeat(16));
    const many = Array.from({ length: 30 }, (_, index) => ({ name: `快捷键 ${index}`, k: "a", m: [] }));
    expect(screenShortcuts(many)).toHaveLength(24);
    expect(screenShortcuts("not a list")).toEqual([]);
  });

  it("survives being saved and loaded, and something unreadable in the store", () => {
    saveScreenShortcuts([{ name: "保存", k: "s", m: ["cmd"] }]);
    expect(loadScreenShortcuts()).toEqual([{ name: "保存", k: "s", m: ["cmd"] }]);
    kept.set("screen.shortcuts", "{broken");
    expect(loadScreenShortcuts()).toEqual([]);
  });
});
