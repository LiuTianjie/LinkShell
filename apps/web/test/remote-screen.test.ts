import { describe, expect, it } from "vitest";
import {
  chosenScreenWidth,
  fittedRect,
  fittedScreenWidth,
  namedKey,
  pictureFraction,
  remoteModifiers,
  screenPlatform,
  shortcutKey,
  snappedRect,
  textInput,
  wheelPixels,
} from "../src/live/screen-input";
import { ScreenGate } from "../src/live/screen-gate";
import { askFullscreen, fullscreenShown, idleFullscreen, windowFullscreen } from "../src/live/screen-fullscreen";
import { remoteShortcuts, shortcutSign } from "../src/live/screen-shortcuts";

const held = (keys: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...keys });

describe("keys and modifiers for the remote computer", () => {
  it("keeps the modifiers between two Macs", () => {
    expect(remoteModifiers(held({ metaKey: true, shiftKey: true }), "mac", "mac")).toEqual(["cmd", "shift"]);
    expect(remoteModifiers(held({ ctrlKey: true, altKey: true }), "mac", "mac")).toEqual(["ctrl", "alt"]);
  });
  it("swaps the shortcut key between a Mac and Windows, both ways", () => {
    // ⌘C on this Mac copies on the Windows computer: Ctrl+C there.
    expect(remoteModifiers(held({ metaKey: true }), "mac", "windows")).toEqual(["ctrl"]);
    // Ctrl+C on Windows copies on a Mac: ⌘C there.
    expect(remoteModifiers(held({ ctrlKey: true }), "windows", "mac")).toEqual(["cmd"]);
    expect(remoteModifiers(held({ metaKey: true }), "windows", "mac")).toEqual(["ctrl"]);
  });
  it("names the keys the computer knows", () => {
    expect(namedKey({ key: "Enter", code: "Enter" })).toBe("return");
    expect(namedKey({ key: "ArrowLeft", code: "ArrowLeft" })).toBe("left");
    expect(namedKey({ key: "F12", code: "F12" })).toBe("f12");
    expect(namedKey({ key: "a", code: "KeyA" })).toBeUndefined();
  });
  it("names a shortcut's key by its keycap, unshifted", () => {
    expect(shortcutKey({ key: "c", code: "KeyC" })).toBe("c");
    // ⌥ changes what the key types; the key is still C.
    expect(shortcutKey({ key: "ç", code: "KeyC" })).toBe("c");
    // ⇧⌘4: the key is 4, not $.
    expect(shortcutKey({ key: "$", code: "Digit4" })).toBe("4");
    expect(shortcutKey({ key: "{", code: "BracketLeft" })).toBe("[");
    expect(shortcutKey({ key: " ", code: "Space" })).toBe("space");
    expect(shortcutKey({ key: "Meta", code: "MetaLeft" })).toBeUndefined();
  });
  it("types text in pieces, with line breaks and tabs as keys", () => {
    expect(textInput("a\nb\tc")).toEqual([{ t: "text", s: "a" }, { t: "key", k: "return" }, { t: "text", s: "b" }, { t: "key", k: "tab" }, { t: "text", s: "c" }]);
    expect(textInput("x\r\ny")).toEqual([{ t: "text", s: "x" }, { t: "key", k: "return" }, { t: "text", s: "y" }]);
    const long = textInput("字".repeat(4001) + "😀".repeat(3000));
    expect(long.every((event) => event.t !== "text" || event.s.length <= 4000)).toBe(true);
    // Never between the halves of a surrogate pair.
    expect(long.every((event) => event.t !== "text" || !/[\uD800-\uDBFF]$/.test(event.s))).toBe(true);
    expect(long.map((event) => event.t === "text" ? event.s : "").join("")).toBe("字".repeat(4001) + "😀".repeat(3000));
  });
  it("turns the wheel into the computer's pixels", () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 30, deltaMode: 0 })).toEqual({ dx: -0, dy: -30 });
    expect(wheelPixels({ deltaX: 2, deltaY: 0, deltaMode: 1 })).toEqual({ dx: -32, dy: -0 });
    expect(wheelPixels({ deltaX: 0, deltaY: 1e6, deltaMode: 0 }).dy).toBe(-2000);
  });
  it("knows a computer by its platform", () => {
    expect(screenPlatform("darwin")).toBe("mac");
    expect(screenPlatform("win32")).toBe("windows");
    expect(screenPlatform("linux")).toBe("other");
    expect(screenPlatform(undefined)).toBe("other");
  });
});

describe("the picture's place and size", () => {
  it("fits and centres the picture", () => {
    expect(fittedRect({ width: 1920, height: 1080 }, { width: 1000, height: 1000 })).toEqual({ x: 0, y: 218.75, width: 1000, height: 562.5 });
    expect(fittedRect({ width: 0, height: 0 }, { width: 10, height: 10 }).width).toBe(0);
  });
  it("puts the box on whole device pixels", () => {
    expect(snappedRect({ x: 0.3, y: 10.26, width: 999.7, height: 562.4 }, 2)).toEqual({ x: 0.5, y: 10.5, width: 999.5, height: 562.5 });
  });
  it("maps a point to the picture, and outside it only when clamped", () => {
    const rect = { x: 100, y: 50, width: 800, height: 450 };
    expect(pictureFraction(rect, 500, 275)).toEqual({ x: 0.5, y: 0.5 });
    expect(pictureFraction(rect, 50, 275)).toBeUndefined();
    expect(pictureFraction(rect, 50, 600, true)).toEqual({ x: 0, y: 1 });
  });
  it("asks for the narrowest width that covers the pixels shown", () => {
    // A 1200-point-wide stage on a 2× display shows 2400 pixels.
    expect(fittedScreenWidth({ width: 1200, height: 800 }, 2)).toBe(2560);
    // Full screen on a 1728 × 1117 display, a 16:10 picture: limited by the height.
    expect(fittedScreenWidth({ width: 1728, height: 1117 }, 2, 1.6)).toBe(3840);
    expect(fittedScreenWidth({ width: 900, height: 600 }, 1)).toBe(1280);
    // Past 2× the extra pixels are not asked for.
    expect(fittedScreenWidth({ width: 1000, height: 700 }, 3)).toBe(2560);
  });
  it("lets a chosen clarity override the fitted width", () => {
    expect(chosenScreenWidth("auto", 2560)).toBe(2560);
    expect(chosenScreenWidth("1280", 2560)).toBe(1280);
    expect(chosenScreenWidth("native", 1280)).toBe(3840);
  });
});

describe("the configuration gate", () => {
  it("opens input only with the acknowledged generation", () => {
    const gate = new ScreenGate();
    expect(gate.allowsInput).toBe(false);
    expect(gate.capabilities({ t: "capabilities", version: 1, configure: true, pause: true })).toBe(true);
    const request = gate.request({ display: 0, width: 2560, maxFps: 60, paused: false });
    expect(request).toMatchObject({ t: "screen.configure", requestId: 1, width: 2560 });
    expect(gate.allowsInput).toBe(false);
    // An older acknowledgement changes nothing.
    expect(gate.configured({ t: "configured", requestId: 0, display: 0, paused: false, generation: 3 })).toBe(false);
    expect(gate.configured({ t: "configured", requestId: 1, display: 0, paused: false, generation: 3, width: 2560 })).toBe(true);
    expect(gate.allowsInput).toBe(true);
    expect(gate.stamp({ t: "move" })).toEqual({ t: "move", screenGeneration: 3 });
  });
  it("closes input while paused", () => {
    const gate = new ScreenGate();
    gate.capabilities({ version: 1, configure: true, pause: true });
    gate.request({ display: 0, width: 1920, maxFps: 60, paused: true });
    gate.configured({ requestId: 1, display: 0, paused: true, generation: 1 });
    expect(gate.allowsInput).toBe(false);
  });
  it("waits for the reapplied configuration after the picture moves to the socket", () => {
    const gate = new ScreenGate();
    gate.capabilities({ version: 1, configure: true, pause: true });
    gate.request({ display: 0, width: 1920, maxFps: 60, paused: false });
    gate.configured({ requestId: 1, display: 0, paused: false, generation: 1 });
    // The host says its capabilities again and reapplies request 1 with a new generation.
    expect(gate.capabilities({ version: 1, configure: true, pause: true })).toBe(false);
    expect(gate.allowsInput).toBe(false);
    expect(gate.configured({ requestId: 1, display: 0, paused: false, generation: 2 })).toBe(true);
    expect(gate.stamp({})).toEqual({ screenGeneration: 2 });
  });
  it("lets an older host's input through unstamped", () => {
    const gate = new ScreenGate();
    gate.assumeLegacy();
    expect(gate.allowsInput).toBe(true);
    expect(gate.stamp({ t: "key" })).toEqual({ t: "key" });
  });
  it("reports a failed configuration only for the awaited request", () => {
    const gate = new ScreenGate();
    gate.capabilities({ version: 1, configure: true });
    gate.request({ display: 1, width: 1920, maxFps: 60, paused: false });
    expect(gate.failed({ requestId: 7, message: "x" })).toBeUndefined();
    expect(gate.failed({ requestId: 1, message: "显示器已断开" })).toBe("显示器已断开");
  });
});

describe("full screen", () => {
  it("shows the picture alone only once the window is full screen", () => {
    let { next, request } = askFullscreen(idleFullscreen, true);
    expect(request).toBe(true);
    expect(fullscreenShown(next)).toBe(false);
    next = windowFullscreen(next, true);
    expect(fullscreenShown(next)).toBe(true);
    ({ next, request } = askFullscreen(next, false));
    expect(request).toBe(false);
    // Out of the picture at once; the window follows.
    expect(fullscreenShown(next)).toBe(false);
    expect(windowFullscreen(next, false)).toEqual(idleFullscreen);
  });
  it("ends with the window, however the window left", () => {
    const entered = windowFullscreen(askFullscreen(idleFullscreen, true).next, true);
    expect(fullscreenShown(windowFullscreen(entered, false))).toBe(false);
  });
  it("takes the window's own full screen while the screen is the page on show", () => {
    expect(fullscreenShown(windowFullscreen(idleFullscreen, true, true))).toBe(true);
    expect(fullscreenShown(windowFullscreen(idleFullscreen, true, false))).toBe(false);
  });
  it("doesn't ask the window again when it is already full screen", () => {
    const window = windowFullscreen(idleFullscreen, true, false);
    const { next, request } = askFullscreen(window, true);
    expect(request).toBeUndefined();
    expect(fullscreenShown(next)).toBe(true);
  });
});

describe("shortcuts this computer would keep", () => {
  it("writes them as the remote computer does", () => {
    const mac = remoteShortcuts("mac").flatMap((group) => group.items);
    expect(shortcutSign(mac.find((item) => item.name === "强制退出")!, "mac")).toBe("⌥⌘Esc");
    const windows = remoteShortcuts("windows").flatMap((group) => group.items);
    expect(shortcutSign(windows.find((item) => item.name === "任务管理器")!, "windows")).toBe("Ctrl+Shift+Esc");
  });
});
