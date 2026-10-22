import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compactTime } from "../src/live/session-time";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

async function load(platform?: string) {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { __LINKSHELL_CONFIG__: { desktop: true, desktopPlatform: platform } }));
  return import("../src/live/desktop-commands");
}
const key = (init: Partial<KeyboardEvent> & { code: string; key: string }) =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...init }) as KeyboardEvent;

it("acts only on the command shapes the shell understands", async () => {
  const { desktopCommand } = await load();
  expect(desktopCommand({ command: "palette" })).toEqual({ command: "palette" });
  expect(desktopCommand({ command: "new-session", cwd: "/work/app" })).toEqual({ command: "new-session", cwd: "/work/app" });
  expect(desktopCommand({ command: "new-session", cwd: 4 })).toEqual({ command: "new-session" });
  expect(desktopCommand({ command: "inspector", panel: "terminal" })).toEqual({ command: "inspector", panel: "terminal" });
  expect(desktopCommand({ command: "inspector", panel: "anything" })).toEqual({ command: "inspector" });
  expect(desktopCommand({ command: "eval" })).toBeUndefined();
  expect(desktopCommand("palette")).toBeUndefined();
  expect(desktopCommand(null)).toBeUndefined();
});

it("matches shortcuts by the physical key, with ⌘ on the Mac", async () => {
  const { desktopShortcuts, matchesShortcut, shortcutText } = await load();
  expect(matchesShortcut(key({ metaKey: true, code: "KeyK", key: "k" }), desktopShortcuts.palette)).toBe(true);
  expect(matchesShortcut(key({ ctrlKey: true, code: "KeyK", key: "k" }), desktopShortcuts.palette)).toBe(false);
  // ⌥ turns "b" into "∫"; the inspector toggle still fires, the sidebar toggle does not.
  const optionB = key({ metaKey: true, altKey: true, code: "KeyB", key: "∫" });
  expect(matchesShortcut(optionB, desktopShortcuts.toggleInspector)).toBe(true);
  expect(matchesShortcut(optionB, desktopShortcuts.toggleSidebar)).toBe(false);
  expect(matchesShortcut(key({ metaKey: true, shiftKey: true, code: "BracketRight", key: "}" }), desktopShortcuts.nextSession)).toBe(true);
  // An IME composition owns its keys.
  expect(matchesShortcut(key({ metaKey: true, code: "KeyK", key: "k", isComposing: true }), desktopShortcuts.palette)).toBe(false);
  expect(shortcutText(desktopShortcuts.toggleInspector)).toBe("⌥⌘B");
});

it("uses Ctrl and spelled-out keys on Windows", async () => {
  const { desktopShortcuts, matchesShortcut, shortcutText } = await load("win32");
  expect(matchesShortcut(key({ ctrlKey: true, code: "KeyN", key: "n" }), desktopShortcuts.newSession)).toBe(true);
  expect(matchesShortcut(key({ metaKey: true, code: "KeyN", key: "n" }), desktopShortcuts.newSession)).toBe(false);
  expect(shortcutText(desktopShortcuts.previousSession)).toBe("Ctrl+Shift+[");
});

it("keeps sidebar times short", () => {
  const now = new Date(2026, 9, 22, 18, 0).getTime();
  expect(compactTime(now - 20_000, now)).toBe("刚刚");
  expect(compactTime(now - 12 * 60_000, now)).toBe("12 分");
  expect(compactTime(new Date(2026, 9, 22, 9, 5).getTime(), now)).toBe("09:05");
  expect(compactTime(new Date(2026, 9, 21, 23, 0).getTime(), now)).toBe("昨天");
  expect(compactTime(new Date(2026, 9, 3).getTime(), now)).toBe("10/3");
});
