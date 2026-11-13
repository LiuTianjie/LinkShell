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
  expect(desktopCommand({ command: "workspace" })).toEqual({ command: "workspace" });
  expect(desktopCommand({ command: "manage" })).toEqual({ command: "manage" });
  // The menu bar names pages by title; ids work too, anything else opens the overview.
  expect(desktopCommand({ command: "manage", page: "更新" })).toEqual({ command: "manage", page: "updates" });
  expect(desktopCommand({ command: "manage", page: "usage" })).toEqual({ command: "manage", page: "usage" });
  expect(desktopCommand({ command: "manage", page: "../etc" })).toEqual({ command: "manage" });
  expect(desktopCommand({ command: "composer", target: "focus" })).toEqual({ command: "composer", target: "focus" });
  expect(desktopCommand({ command: "composer", target: "model" })).toEqual({ command: "composer", target: "model" });
  expect(desktopCommand({ command: "composer", target: "mode" })).toEqual({ command: "composer", target: "mode" });
  expect(desktopCommand({ command: "composer", target: "effort" })).toEqual({ command: "composer", target: "effort" });
  expect(desktopCommand({ command: "composer", target: "unknown" })).toBeUndefined();
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
  expect(matchesShortcut(key({ metaKey: true, code: "KeyL", key: "l" }), desktopShortcuts.focusComposer)).toBe(true);
  expect(matchesShortcut(key({ metaKey: true, shiftKey: true, code: "KeyM", key: "M" }), desktopShortcuts.modelPicker)).toBe(true);
  expect(matchesShortcut(key({ metaKey: true, shiftKey: true, code: "KeyA", key: "A" }), desktopShortcuts.modePicker)).toBe(true);
  expect(matchesShortcut(key({ metaKey: true, shiftKey: true, code: "KeyE", key: "E" }), desktopShortcuts.effortPicker)).toBe(true);
});

it("matches ⇧Tab without ⌘/Ctrl and formats both Mac and Windows labels", async () => {
  const mac = await load();
  expect(mac.matchesShortcut(key({ shiftKey: true, code: "Tab", key: "Tab" }), mac.shiftTabShortcut)).toBe(true);
  expect(mac.matchesShortcut(key({ metaKey: true, shiftKey: true, code: "Tab", key: "Tab" }), mac.shiftTabShortcut)).toBe(false);
  expect(mac.shortcutText(mac.shiftTabShortcut)).toBe("⇧Tab");
  expect(mac.shortcutText(mac.desktopShortcuts.modelPicker)).toBe("⇧⌘M");
  expect(mac.shortcutText(mac.desktopShortcuts.focusComposer)).toBe("⌘L");

  vi.resetModules();
  const win = await load("win32");
  expect(win.matchesShortcut(key({ shiftKey: true, code: "Tab", key: "Tab" }), win.shiftTabShortcut)).toBe(true);
  expect(win.shortcutText(win.shiftTabShortcut)).toBe("Shift+Tab");
  expect(win.shortcutText(win.desktopShortcuts.modelPicker)).toBe("Ctrl+Shift+M");
});

it("signals renderer-ready to Electron only after attaching the command listener", async () => {
  const events: string[] = [];
  const received: unknown[] = [];
  const target = new EventTarget();
  const origAdd = target.addEventListener.bind(target);
  vi.stubGlobal(
    "window",
    Object.assign(target, {
      __LINKSHELL_CONFIG__: { desktop: true, desktopPlatform: "darwin" },
      linkshellDesktop: {
        shell: "electron",
        platform: "darwin",
        postMessage: (msg: { action?: string }) => {
          events.push(`ipc:${msg.action}`);
          if (msg.action === "renderer-ready") {
            // Simulate Electron immediately flushing a queued startup command on renderer-ready!
            window.dispatchEvent(
              new CustomEvent("linkshell-desktop-command", {
                detail: { command: "new-session", cwd: "/work/repo" },
              }),
            );
          }
        },
      },
      addEventListener: ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type === "linkshell-desktop-command") events.push("listen");
        origAdd(type, listener, options);
      }) as typeof window.addEventListener,
    }),
  );
  const { attachDesktopCommandListener } = await import("../src/live/desktop-commands");
  const detach = attachDesktopCommandListener((cmd) => received.push(cmd));
  expect(events).toEqual(["listen", "ipc:renderer-ready"]);
  expect(received).toEqual([{ command: "new-session", cwd: "/work/repo" }]);
  detach();
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
