import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreWindowBounds } from "../dist/main/window-bounds.js";
import { CommandQueue } from "../dist/main/command-queue.js";
import { badgeCount, parseNotification, shouldNotify } from "../dist/main/notify.js";
import { localizeUpdaterMessage, normalizeMainLocale, translateMain } from "../dist/main/locale.js";
import { isOpenPathApp, openPathPlan } from "../dist/main/open-path.js";

const MIN = { width: 940, height: 640 };
const FALLBACK = { width: 1280, height: 820 };
const laptop = { x: 0, y: 25, width: 1512, height: 920 };
const external = { x: 1512, y: 0, width: 2560, height: 1415 };

test("a frame saved on an unplugged monitor is centered on the remaining one, not restored off screen", () => {
  const saved = { x: 2000, y: 200, width: 1600, height: 1000 };
  assert.deepEqual(restoreWindowBounds(saved, [laptop, external], MIN, FALLBACK), { x: 2000, y: 200, width: 1600, height: 1000, maximized: false });
  const restored = restoreWindowBounds(saved, [laptop], MIN, FALLBACK);
  assert.equal(restored.x, undefined);
  assert.equal(restored.y, undefined);
  assert.ok(restored.width <= laptop.width && restored.height <= laptop.height);
});

test("a frame partly off its display is pulled back and shrunk to fit; a title row out of reach is not trusted", () => {
  const shifted = restoreWindowBounds({ x: 1200, y: 25, width: 1300, height: 900 }, [laptop], MIN, FALLBACK);
  assert.equal(shifted.x, laptop.width - 1300);
  assert.equal(shifted.y, 25);
  const titleAbove = restoreWindowBounds({ x: 100, y: -500, width: 1000, height: 800 }, [laptop], MIN, FALLBACK);
  assert.equal(titleAbove.x, undefined);
});

test("missing or broken saved state falls back to the default size and keeps the maximized flag", () => {
  assert.deepEqual(restoreWindowBounds(undefined, [laptop], MIN, FALLBACK), { width: 1280, height: 820, maximized: false });
  assert.deepEqual(restoreWindowBounds({ x: "a", width: 10, height: Number.NaN, maximized: true }, [laptop], MIN, FALLBACK), { width: 940, height: 820, maximized: true });
});

test("commands queued before the page is ready arrive in order; navigation keeps only its latest form", () => {
  const queue = new CommandQueue(4);
  queue.push({ command: "manage", page: "updates" });
  queue.push({ command: "close-tab" });
  queue.push({ command: "close-tab" });
  queue.push({ command: "open-session", computerKey: "a", sessionId: "1" });
  queue.push({ command: "manage", page: "settings" });
  queue.push({ command: "open-session", computerKey: "b", sessionId: "2" });
  assert.deepEqual(queue.drain(), [
    { command: "close-tab" },
    { command: "manage", page: "settings" },
    { command: "open-session", computerKey: "b", sessionId: "2" },
  ]);
  assert.equal(queue.size, 0);
  for (let index = 0; index < 10; index++) queue.push({ command: "fusion-like", index });
  assert.equal(queue.size, 4);
  assert.equal(queue.drain()[0].index, 6);
});

test("notifications only for someone who isn't looking, and only when allowed", () => {
  assert.equal(shouldNotify({ supported: true, enabled: true, focused: false, visible: true }), true);
  assert.equal(shouldNotify({ supported: true, enabled: true, focused: true, visible: false }), true);
  assert.equal(shouldNotify({ supported: true, enabled: true, focused: true, visible: true }), false);
  assert.equal(shouldNotify({ supported: true, enabled: false, focused: false, visible: false }), false);
  assert.equal(shouldNotify({ supported: false, enabled: true, focused: false, visible: false }), false);
});

test("a notification message is bounded and needs its session to be clickable", () => {
  const parsed = parseNotification({ id: "s1", title: "x".repeat(500), body: "line\nbreak", computerKey: "desktop:local", sessionId: "s1" });
  assert.equal(parsed.title.length, 120);
  assert.equal(parsed.body, "line break");
  assert.equal(parseNotification({ id: "s1", title: "t", body: "b", computerKey: "", sessionId: "s1" }), undefined);
  assert.equal(badgeCount(3.7), 3);
  assert.equal(badgeCount(-2), 0);
  assert.equal(badgeCount("3"), undefined);
});

test("the native shell's words follow the page's language, including Sparkle's progress", () => {
  assert.equal(normalizeMainLocale("en"), "en");
  assert.equal(normalizeMainLocale("fr"), undefined);
  assert.equal(translateMain("zh", "menu.settings"), "设置…");
  assert.equal(translateMain("en", "update.to", { version: "1.2.3" }), "Update to 1.2.3…");
  assert.equal(translateMain("ja", "menu.settings"), "設定…");
  assert.equal(localizeUpdaterMessage("en", "可更新至 LinkShell 0.11.0"), "LinkShell 0.11.0 is available");
  assert.equal(localizeUpdaterMessage("zh", "可更新至 LinkShell 0.11.0"), "可更新至 LinkShell 0.11.0");
  assert.equal(localizeUpdaterMessage("en", "something new"), "something new");
});

test("open-in-editor never goes through a shell and accepts only the allow-listed apps", () => {
  assert.equal(isOpenPathApp("xcode"), true);
  assert.equal(isOpenPathApp("bash -c rm"), false);
  assert.deepEqual(openPathPlan("darwin", "xcode", "/tmp/a b;rm -rf"), { kind: "spawn", file: "/usr/bin/open", args: ["-a", "Xcode", "--", "/tmp/a b;rm -rf"] });
  assert.deepEqual(openPathPlan("darwin", "reveal", "/tmp"), { kind: "reveal" });
  assert.deepEqual(openPathPlan("linux", "vscode", "/tmp/a b"), { kind: "url", url: "vscode://file/tmp/a%20b" });
  assert.throws(() => openPathPlan("win32", "xcode", "C:\\x"));
});
