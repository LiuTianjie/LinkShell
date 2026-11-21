import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

async function load(platform = "MacIntel") {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { platform, userAgent: platform });
  return import("../src/live/workspace-commands");
}

const key = (init: Partial<KeyboardEvent> & { code: string; key: string }) =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...init }) as KeyboardEvent;

it("acts only on the workspace command shapes it understands", async () => {
  const { workspaceCommand } = await load();
  expect(workspaceCommand({ command: "palette" })).toEqual({ command: "palette" });
  expect(workspaceCommand({ command: "new-session", cwd: "/work/app" })).toEqual({ command: "new-session", cwd: "/work/app" });
  expect(workspaceCommand({ command: "new-session", cwd: 4 })).toEqual({ command: "new-session" });
  expect(workspaceCommand({ command: "inspector", panel: "terminal" })).toEqual({ command: "inspector", panel: "terminal" });
  expect(workspaceCommand({ command: "inspector", panel: "anything" })).toEqual({ command: "inspector" });
  expect(workspaceCommand({ command: "composer", target: "focus" })).toEqual({ command: "composer", target: "focus" });
  expect(workspaceCommand({ command: "composer", target: "model" })).toEqual({ command: "composer", target: "model" });
  expect(workspaceCommand({ command: "composer", target: "mode" })).toEqual({ command: "composer", target: "mode" });
  expect(workspaceCommand({ command: "composer", target: "effort" })).toEqual({ command: "composer", target: "effort" });
  expect(workspaceCommand({ command: "composer", target: "unknown" })).toBeUndefined();
  expect(workspaceCommand({ command: "manage" })).toBeUndefined();
  expect(workspaceCommand("palette")).toBeUndefined();
  expect(workspaceCommand(null)).toBeUndefined();
});

it("matches shortcuts by the physical key on Apple and non-Apple platforms", async () => {
  const apple = await load("MacIntel");
  expect(apple.matchesShortcut(key({ metaKey: true, code: "KeyK", key: "k" }), apple.workspaceShortcuts.palette)).toBe(true);
  expect(apple.matchesShortcut(key({ ctrlKey: true, code: "KeyK", key: "k" }), apple.workspaceShortcuts.palette)).toBe(false);
  const optionB = key({ metaKey: true, altKey: true, code: "KeyB", key: "∫" });
  expect(apple.matchesShortcut(optionB, apple.workspaceShortcuts.toggleInspector)).toBe(true);
  expect(apple.shortcutText(apple.workspaceShortcuts.toggleInspector)).toBe("⌥⌘B");
  expect(apple.matchesShortcut(key({ metaKey: true, code: "KeyK", key: "k", isComposing: true }), apple.workspaceShortcuts.palette)).toBe(false);
  expect(apple.matchesShortcut(key({ metaKey: true, code: "KeyL", key: "l" }), apple.workspaceShortcuts.focusComposer)).toBe(true);
  expect(apple.matchesShortcut(key({ metaKey: true, shiftKey: true, code: "KeyM", key: "M" }), apple.workspaceShortcuts.modelPicker)).toBe(true);
  expect(apple.matchesShortcut(key({ shiftKey: true, code: "Tab", key: "Tab" }), apple.shiftTabShortcut)).toBe(true);
  expect(apple.matchesShortcut(key({ metaKey: true, shiftKey: true, code: "Tab", key: "Tab" }), apple.shiftTabShortcut)).toBe(false);
  expect(apple.shortcutText(apple.shiftTabShortcut)).toBe("⇧Tab");
  expect(apple.shortcutText(apple.workspaceShortcuts.modelPicker)).toBe("⇧⌘M");
  expect(apple.shortcutText(apple.workspaceShortcuts.focusComposer)).toBe("⌘L");

  vi.resetModules();
  const win = await load("Win32");
  expect(win.matchesShortcut(key({ ctrlKey: true, code: "KeyK", key: "k" }), win.workspaceShortcuts.palette)).toBe(true);
  expect(win.matchesShortcut(key({ metaKey: true, code: "KeyK", key: "k" }), win.workspaceShortcuts.palette)).toBe(false);
  expect(win.matchesShortcut(key({ shiftKey: true, code: "Tab", key: "Tab" }), win.shiftTabShortcut)).toBe(true);
  expect(win.shortcutText(win.shiftTabShortcut)).toBe("Shift+Tab");
  expect(win.shortcutText(win.workspaceShortcuts.modelPicker)).toBe("Ctrl+Shift+M");
});

it("dispatches valid workspace commands and stops after unsubscribe", async () => {
  const { attachWorkspaceCommandListener, sendWorkspaceCommand } = await load();
  const seen: unknown[] = [];
  const off = attachWorkspaceCommandListener((command) => seen.push(command));
  sendWorkspaceCommand({ command: "inspector", panel: "files" });
  expect(seen).toEqual([{ command: "inspector", panel: "files" }]);
  off();
  sendWorkspaceCommand({ command: "palette" });
  expect(seen).toHaveLength(1);
});
