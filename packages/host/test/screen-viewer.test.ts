import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { inputEvent } from "../src/input.js";
import { VIEWER_LOGIC, viewerPage } from "../src/screen-viewer.js";

type Rect = { x: number; y: number; w: number; h: number };

interface Logic {
  interactionViewport(viewport: Rect, insets: { top: number; right: number; bottom: number; left: number }, divisions: Array<{ x: number; y: number; width: number; height: number; active: boolean }>, preferred: { x: number; y: number } | null): Rect;
  controlsMorph(progress: number, anchor: Rect, ball: Rect): Rect & { radius: number; shellOpacity: number; barOpacity: number; orbOpacity: number; contentScale: number };
  sheetPresentation(progress: number, width: number, height: number, dock: "left" | "right" | "top" | "bottom"): { x: number; y: number; opacity: number };
  presentationSpring(current: Rect, velocity: Rect, target: Rect, seconds: number, frequency?: number): { current: Rect; velocity: Rect; settled: boolean };
  presentationFlip(from: Rect | null, to: Rect, reduceMotion: boolean): { x: number; y: number; sx: number; sy: number } | null;
  usableViewport(v: Rect, insets: { top: number; right: number; bottom: number; left: number }): Rect;
  anchoredPanel(safe: Rect, picture: Rect, anchor: Rect, width: number, height: number): Rect;
  containedBox(safe: Rect, width: number, height: number, x: number, y: number, gap?: number): Rect;
  fromGray(gray: number): number;
  stripTime(pixels: ArrayLike<number>): number | undefined;
  lateness(shownAt: number, time: number): number | undefined;
  summary(samples: number[]): { n: number; min: number | null; p50: number | null; p95: number | null; max: number | null };
  synced(clock: { trip: number; offset: number }, sent: number, back: number, now: number): { trip: number; offset: number };
  ownEcho(trail: { x: number; y: number; t: number }[], x: number, y: number, now: number): boolean;
  laneOf(kind: string, placed: boolean, held: boolean, tied: boolean): "input" | "pointer";
  keyboardIsUp(known: { focused: boolean; asked: number; said?: boolean; shrunk?: boolean; live: boolean }): boolean;
  pieces(text: string, most: number): string[];
  typingOf(text: string, most: number): ({ t: "text"; s: string } | { t: "key"; k: string })[];
  keyKnown(k: unknown): boolean;
  modsOf(names: unknown): string[];
  comboSign(k: string, m: string[]): string;
  cleanShortcuts(list: unknown): { name: string; k: string; m: string[] }[];
}

// The page's own text, run as the page runs it.
const logic = new Function(`${VIEWER_LOGIC}; return { interactionViewport, controlsMorph, sheetPresentation, presentationSpring, presentationFlip, usableViewport, containedBox, anchoredPanel, fromGray, stripTime, lateness, summary, synced, ownEcho, laneOf, keyboardIsUp, pieces, typingOf, keyKnown, modsOf, comboSign, cleanShortcuts };`)() as Logic;

/** A clock strip as the app draws it (apps/mac/README.md, Measuring), one pixel a cell. */
function strip(time: number, white = 255, black = 0): Uint8Array {
  const gray = time ^ (time >> 1);
  const cells = [1, 0, ...Array.from({ length: 16 }, (_, bit) => (gray >> (15 - bit)) & 1), 0, 1];
  return Uint8Array.from(cells.flatMap((on) => [on ? white : black, on ? white : black, on ? white : black, 255]));
}

describe("the viewer page", () => {
  const page = viewerPage();
  const script = /<script>([\s\S]*)<\/script>/.exec(page)![1]!;

  it("has a script that parses, with both ways of getting the picture in it", () => {
    expect(() => new Script(script)).not.toThrow();
    for (const id of ["screen", "video", "pointer", "status"]) expect(page).toContain(`id="${id}"`);
    for (const word of ["VideoDecoder", "RTCPeerConnection", "rtc.answer", "rtc.ice", "rtc.failed", "jitterBufferTarget", "playoutDelayHint"]) expect(script).toContain(word);
    // The video must play where it is, without sound, without being asked.
    expect(page).toMatch(/<video id="video"[^>]*\bautoplay\b[^>]*\bplaysinline\b[^>]*\bmuted\b/);
  });

  it("has the keyboard's fields, the shortcuts and the box text is written in, and the words it says to the app", () => {
    for (const id of ["typing", "shortcut", "keys", "quick", "quickkey", "composekey", "sheet", "actions", "maker", "makerkey", "makername", "composer", "words", "pasteclip", "sendwords", "sendreturn"])
      expect(page).toContain(`id="${id}"`);
    for (const said of ['type: "keyboard"', 'type: "shortcuts"', 'type: "clipboard"', "linkshellKeyboard", "linkshellClipboard", "linkshellChrome"]) expect(script).toContain(said);
    // The script is one template: a backtick in it would have ended it.
    expect(script).not.toContain("`");
  });

  it("never takes its script from anywhere else", () => {
    expect(page).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|url\(\s*["']?https?:/);
  });
});

describe("reading the clock strip", () => {
  it("undoes the Gray code for every time there is", () => {
    for (let time = 0; time < 65536; time++) if (logic.fromGray(time ^ (time >> 1)) !== time) throw new Error(`${time} read back as ${logic.fromGray(time ^ (time >> 1))}`);
  });

  it("reads the time off a strip, washed out by the encoder or not", () => {
    for (const time of [0, 1, 255, 256, 12345, 32768, 65535]) {
      expect(logic.stripTime(strip(time))).toBe(time);
      expect(logic.stripTime(strip(time, 200, 60))).toBe(time);
    }
  });

  it("reads nothing where there is no strip", () => {
    expect(logic.stripTime(new Uint8Array(80).fill(128))).toBeUndefined();
    expect(logic.stripTime(strip(4242, 140, 100))).toBeUndefined();
  });

  it("says how old a frame is, across the clock's turn and not beyond half a minute", () => {
    expect(logic.lateness(1_790_000_000_000 + 21.34, 1_790_000_000_000 % 65536)).toBe(21.3);
    // Written just before the 16 bits came round, shown just after.
    expect(logic.lateness(65536 * 7 + 10, 65530)).toBe(16);
    // A frame "from the future" is a misreading, not a negative wait.
    expect(logic.lateness(65536 * 7 + 100, 150)).toBeUndefined();
    expect(logic.lateness(65536 * 7 + 31000, 0)).toBeUndefined();
  });

  it("sums a second's readings up", () => {
    expect(logic.summary([])).toEqual({ n: 0, min: null, p50: null, p95: null, max: null });
    expect(logic.summary([30, 10, 20])).toEqual({ n: 3, min: 10, p50: 20, p95: 30, max: 30 });
    const hundred = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(logic.summary(hundred)).toEqual({ n: 100, min: 1, p50: 50, p95: 95, max: 100 });
  });

  it("sets its clock by the answer that came back quickest", () => {
    let clock = { trip: Infinity, offset: 0 };
    clock = logic.synced(clock, 1000, 1040, 6020);
    expect(clock).toEqual({ trip: 40, offset: 5000 });
    // A slower answer says less.
    expect(logic.synced(clock, 2000, 2200, 7300)).toBe(clock);
    expect(logic.synced(clock, 3000, 3004, 8002)).toEqual({ trip: 4, offset: 5000 });
  });
});

describe("the pointer drawn over a video", () => {
  const trail = [
    { x: 0.5, y: 0.5, t: 1000 },
    { x: 0.52, y: 0.5, t: 1016 },
    { x: 0.54, y: 0.51, t: 1033 },
  ];

  it("knows its own moves when the computer says them back", () => {
    expect(logic.ownEcho(trail, 0.5, 0.5, 1100)).toBe(true);
    // The computer's pointer stands on whole points: a little off what was sent is still it.
    expect(logic.ownEcho(trail, 0.5207, 0.4993, 1100)).toBe(true);
  });

  it("takes anything else as someone else's doing", () => {
    expect(logic.ownEcho(trail, 0.53, 0.505, 1100)).toBe(false);
    expect(logic.ownEcho(trail, 0.2, 0.2, 1100)).toBe(false);
    expect(logic.ownEcho([], 0.5, 0.5, 1100)).toBe(false);
  });

  it("forgets where it was after a second", () => {
    expect(logic.ownEcho(trail, 0.5, 0.5, 2001)).toBe(false);
    expect(logic.ownEcho(trail, 0.54, 0.51, 2001)).toBe(true);
  });
});

describe("which channel an event goes on", () => {
  it("is the one that keeps order, for everything that must arrive", () => {
    for (const kind of ["down", "up", "key", "text"]) {
      for (const placed of [false, true]) for (const held of [false, true]) expect(logic.laneOf(kind, placed, held, false)).toBe("input");
    }
  });

  it("is the one that doesn't wait, for a pointer on its way and for the wheel", () => {
    expect(logic.laneOf("move", false, false, false)).toBe("pointer");
    expect(logic.laneOf("scroll", false, false, false)).toBe("pointer");
  });

  it("keeps a position with what happens at it", () => {
    // The move sent for a press, a release, a turn of the wheel: in order, just ahead of it.
    expect(logic.laneOf("move", true, false, false)).toBe("input");
    // The wheel's first turn at a new place, and the rest of that gesture.
    expect(logic.laneOf("scroll", true, false, false)).toBe("input");
    expect(logic.laneOf("scroll", false, false, true)).toBe("input");
    // A drag: every position, and the wheel while a button is down.
    expect(logic.laneOf("move", false, true, false)).toBe("input");
    expect(logic.laneOf("scroll", false, true, false)).toBe("input");
  });
});

describe("whether the phone's keyboard is up", () => {
  const long = 60_000;

  it("is not, without a field that has the focus", () => {
    expect(logic.keyboardIsUp({ focused: false, asked: 100, said: true, live: true })).toBe(false);
  });

  it("is taken to be on its way for a moment after it was asked for, whatever the app still says", () => {
    expect(logic.keyboardIsUp({ focused: true, asked: 300, said: false, live: false })).toBe(true);
    expect(logic.keyboardIsUp({ focused: true, asked: 999, said: false, live: true })).toBe(true);
  });

  it("is what the app says, where there is an app to say it", () => {
    expect(logic.keyboardIsUp({ focused: true, asked: long, said: true, live: true })).toBe(true);
    // The phone took the keyboard down and left the field its focus: the page is no longer the one the keys go to.
    expect(logic.keyboardIsUp({ focused: true, asked: long, said: false, live: false })).toBe(false);
    // No keyboard on the screen, and yet the keys come here: a real keyboard's.
    expect(logic.keyboardIsUp({ focused: true, asked: long, said: false, live: true })).toBe(true);
  });

  it("goes by the window's height in a browser that has been seen to make room for a keyboard", () => {
    expect(logic.keyboardIsUp({ focused: true, asked: long, shrunk: true, live: true })).toBe(true);
    expect(logic.keyboardIsUp({ focused: true, asked: long, shrunk: false, live: true })).toBe(false);
  });

  it("goes by the focus where that is all there is: the field's, and the page's", () => {
    expect(logic.keyboardIsUp({ focused: true, asked: long, live: true })).toBe(true);
    expect(logic.keyboardIsUp({ focused: true, asked: long, live: false })).toBe(false);
  });
});

describe("text sent whole", () => {
  it("goes in pieces no longer than an event may be, never cut through a character", () => {
    expect(logic.pieces("", 4)).toEqual([]);
    expect(logic.pieces("abc", 4)).toEqual(["abc"]);
    expect(logic.pieces("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    // Two UTF-16 units each: three would be cut through the second.
    expect(logic.pieces("😀😀😀", 3)).toEqual(["😀", "😀", "😀"]);
    expect(logic.pieces("a😀b", 3)).toEqual(["a😀", "b"]);
    const long = "汉字".repeat(4500);
    const cut = logic.pieces(long, 4000);
    expect(cut.map((piece) => piece.length)).toEqual([4000, 4000, 1000]);
    expect(cut.join("")).toBe(long);
  });

  it("is typed a line at a time, with the return key between the lines", () => {
    expect(logic.typingOf("", 4000)).toEqual([]);
    expect(logic.typingOf("你好 ok", 4000)).toEqual([{ t: "text", s: "你好 ok" }]);
    expect(logic.typingOf("一\n二\r\n\n三\n", 4000)).toEqual([
      { t: "text", s: "一" },
      { t: "key", k: "return" },
      { t: "text", s: "二" },
      { t: "key", k: "return" },
      { t: "key", k: "return" },
      { t: "text", s: "三" },
      { t: "key", k: "return" },
    ]);
    expect(logic.typingOf("abcdef\ngh", 4)).toEqual([{ t: "text", s: "abcd" }, { t: "text", s: "ef" }, { t: "key", k: "return" }, { t: "text", s: "gh" }]);
  });

  it("has nothing in it the computer would refuse", () => {
    for (const event of logic.typingOf("x".repeat(9001) + "\n" + "😀".repeat(3000), 4000)) expect(inputEvent.safeParse(event).success).toBe(true);
  });
});

describe("shortcuts", () => {
  it("knows the keys the computer knows by name", () => {
    for (const k of ["a", "z", "0", "9", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`", "return", "tab", "space", "backspace", "escape", "left", "right", "down", "up", "delete", "home", "end", "pageup", "pagedown", "f1", "f12"])
      expect(logic.keyKnown(k), k).toBe(true);
    for (const k of ["", "A", "ab", "f0", "f13", "enter", "cmd", "é", "toString", "constructor", 5, null, undefined]) expect(logic.keyKnown(k), String(k)).toBe(false);
  });

  it("writes a shortcut as a Mac does", () => {
    expect(logic.comboSign("c", ["cmd"])).toBe("⌘C");
    expect(logic.comboSign("z", ["cmd", "shift"])).toBe("⇧⌘Z");
    expect(logic.comboSign("escape", ["cmd", "alt"])).toBe("⌥⌘Esc");
    expect(logic.comboSign("q", ["cmd", "ctrl"])).toBe("⌃⌘Q");
    expect(logic.comboSign("up", ["ctrl"])).toBe("⌃↑");
    expect(logic.comboSign("`", ["cmd"])).toBe("⌘`");
    expect(logic.comboSign("f5", [])).toBe("F5");
    expect(logic.comboSign("space", ["ctrl", "alt", "shift", "cmd"])).toBe("⌃⌥⇧⌘Space");
  });

  it("keeps of the user's own only what the computer would take", () => {
    expect(logic.cleanShortcuts(undefined)).toEqual([]);
    expect(logic.cleanShortcuts("[]")).toEqual([]);
    expect(
      logic.cleanShortcuts([
        { name: " 开终端 ", k: "j", m: ["cmd", "ctrl", "alt", "cmd", "hyper"] },
        { name: "", k: "f5", m: [] },
        { k: "t", m: "cmd" },
        { name: "no such key", k: "enter", m: ["cmd"] },
        { name: 7, k: "k", m: ["shift"] },
        null,
        "c",
      ]),
    ).toEqual([
      { name: "开终端", k: "j", m: ["ctrl", "alt", "cmd"] },
      { name: "F5", k: "f5", m: [] },
      { name: "T", k: "t", m: [] },
      { name: "⇧K", k: "k", m: ["shift"] },
    ]);
    // A name is 16 characters at most, counted as characters; a list, 24 shortcuts.
    expect(logic.cleanShortcuts([{ name: "😀".repeat(20), k: "a", m: [] }])[0]!.name).toBe("😀".repeat(16));
    expect(logic.cleanShortcuts(Array.from({ length: 30 }, () => ({ name: "x", k: "x", m: ["cmd"] })))).toHaveLength(24);
    // Cleaned once, it stays as it is.
    const once = logic.cleanShortcuts([{ name: "", k: "return", m: ["cmd"] }]);
    expect(logic.cleanShortcuts(once)).toEqual(once);
  });

  it("makes only key events the computer would take", () => {
    for (const { k, m } of logic.cleanShortcuts([{ name: "a", k: "`", m: ["cmd"] }, { name: "b", k: "pagedown", m: ["ctrl", "alt", "shift", "cmd"] }, { name: "c", k: "f12", m: [] }]))
      expect(inputEvent.safeParse({ t: "key", k, m: m.length ? m : undefined }).success).toBe(true);
  });
});


describe("viewer controls in changing windows", () => {
  it.each([
    ["open landscape with system chrome on the right", 950, 660, { top: 0, right: 88, bottom: 0, left: 0 }],
    ["open portrait with the status area above", 660, 950, { top: 66, right: 0, bottom: 34, left: 0 }],
    ["closed with a keyboard", 390, 300, { top: 0, right: 0, bottom: 0, left: 0 }],
    ["short landscape with a left camera", 844, 190, { top: 0, right: 0, bottom: 21, left: 59 }],
  ])("keeps an oversized toolbar and menu inside %s", (_, width, height, insets) => {
    const safe = logic.usableViewport({ x: 0, y: 0, w: width as number, h: height as number }, insets as { top: number; right: number; bottom: number; left: number });
    for (const [w, h, x, y] of [[288, 52, 1000, -100], [52, 288, -100, 1000], [248, 340, 1000, 1000]]) {
      const box = logic.containedBox(safe, w!, h!, x!, y!);
      expect(box.x).toBeGreaterThanOrEqual(safe.x + 8);
      expect(box.y).toBeGreaterThanOrEqual(safe.y + 8);
      expect(box.x + box.w).toBeLessThanOrEqual(safe.x + safe.w - 8);
      expect(box.y + box.h).toBeLessThanOrEqual(safe.y + safe.h - 8);
    }
  });
});


describe("anchored screen controls", () => {
  const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  it.each([
    { name: "ordinary phone", width: 390, height: 844, insets: { top: 59, right: 0, bottom: 34, left: 0 }, horizontal: false },
    { name: "Duo landscape with right chrome", width: 950, height: 670, insets: { top: 0, right: 70, bottom: 0, left: 0 }, horizontal: true },
    { name: "Duo portrait", width: 670, height: 950, insets: { top: 66, right: 0, bottom: 34, left: 0 }, horizontal: false },
    { name: "Duo landscape with left chrome", width: 950, height: 670, insets: { top: 0, right: 0, bottom: 0, left: 70 }, horizontal: true },
  ])("uses available black space for the mode menu on $name", ({ width, height, insets, horizontal }) => {
    const safe = logic.usableViewport({ x: 0, y: 0, w: width, h: height }, insets);
    const scale = Math.min(safe.w / 1920, safe.h / 1080);
    const picture = { x: safe.x + (safe.w - 1920 * scale) / 2, y: safe.y + (safe.h - 1080 * scale) / 2, w: 1920 * scale, h: 1080 * scale };
    const anchor = { x: safe.x + safe.w - 146 - 16, y: safe.y + safe.h - 52 - 16, w: 146, h: 52 };
    const panel = logic.anchoredPanel(safe, picture, anchor, horizontal ? 468 : 232, horizontal ? 66 : 168);
    expect(overlap(panel, picture)).toBe(0);
    expect(overlap(panel, anchor)).toBe(0);
    expect(panel.x).toBeGreaterThanOrEqual(safe.x + 8);
    expect(panel.y).toBeGreaterThanOrEqual(safe.y + 8);
    expect(panel.x + panel.w).toBeLessThanOrEqual(safe.x + safe.w - 8);
    expect(panel.y + panel.h).toBeLessThanOrEqual(safe.y + safe.h - 8);
  });

  it("keeps a connection panel reachable when the keyboard leaves little height", () => {
    const safe = logic.usableViewport({ x: 0, y: 0, w: 740, h: 180 }, { top: 0, right: 0, bottom: 0, left: 59 });
    const anchor = { x: 59 + 8, y: 8, w: 52, h: 164 };
    const panel = logic.anchoredPanel(safe, safe, anchor, 232, 340);
    expect(panel.h).toBe(164);
    expect(panel.y).toBe(8);
    expect(overlap(panel, anchor)).toBe(0);
    expect(panel.x + panel.w).toBeLessThanOrEqual(732);
  });

  it("keeps connection statistics out of the control-mode menu", () => {
    const page = viewerPage();
    expect(page).toContain('id="info" role="button" aria-label="连接信息"');
    expect(page.indexOf('id="connection"')).toBeGreaterThan(page.indexOf('id="menu"'));
    expect(page.indexOf('id="status"')).toBeGreaterThan(page.indexOf('id="connection"'));
    expect(page).toContain("不操作电脑");
    expect(page).toContain("点按画面直接操作");
  });
});

/** Exercise the shipped layout function, keeping its DOM state between every resize. */
function changingViewer() {
  const source = /function layout\(\) \{[\s\S]*?\n\}\n\nfunction place/.exec(viewerPage())![0].replace(/\n\nfunction place$/, "");
  return new Function(`${VIEWER_LOGIC}
    function element(kind) {
      const classes = new Set();
      return {
        style: {}, scrollLeft: 0, scrollTop: 0,
        classList: { contains: (name) => classes.has(name), toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); } },
        get offsetWidth() { return kind === 'bar' ? (classes.has('side') ? 52 : 146) : parseFloat(this.style.width) || 232; },
        get offsetHeight() { return kind === 'bar' ? (classes.has('side') ? 146 : 52) : kind === 'menu' ? (classes.has('horizontal') ? 66 : 168) : 100; }
      };
    }
    const presentation = { active: false }, animatePresentation = () => {}, controls = { preferred: null };
    const layoutControls = (_, anchor) => anchor, drawPopover = () => {};
    let sheetTransition = null, sheetDock;
    let v, chrome = { insets: {}, clear: null }, seen = { w: 0, h: 0, follows: false };
    const viewport = () => v, fieldFocused = () => false, place = () => {};
    const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
    const document = { activeElement: null, documentElement: { style: { setProperty() {} } } }, naming = {};
    const bar = element('bar'), menu = element('menu'), connection = element('connection');
    const sheet = element('sheet'), composer = element('composer'), keys = element('keys'), toast = element('toast'), words = { style: {}, scrollHeight: 44 };
    const video = element('video'), canvas = element('canvas');
    const content = { w: 1920, h: 1080 }, pan = { x: 0, y: 0 };
    let area = {}, shown = {}, zoom = 1, fit = 1, live = true, composerOpen = false, keysOpen = false, sheetOpen = false;
    ${source}
    return (next, insets, open = 'menu', fontScale = 1, fullscreen = false, divisions = [], preferred = null) => {
      v = next; chrome.insets = insets; chrome.fontScale = fontScale; chrome.fullscreen = fullscreen; chrome.divisions = divisions; controls.preferred = preferred;
      sheetOpen = open === 'sheet'; keysOpen = open === 'keys'; composerOpen = open === 'composer';
      menu.classList.toggle('gone', open !== 'menu'); connection.classList.toggle('gone', true);
      layout();
      return { area: { ...area }, shown: { ...shown }, bar: { ...bar.style }, menu: { ...menu.style }, sheet: { ...sheet.style }, keys: { ...keys.style }, composer: { ...composer.style }, video: { ...video.style }, horizontal: menu.classList.contains('horizontal') };
    };
  `)() as (viewport: Rect, insets: { top: number; right: number; bottom: number; left: number }, open?: string, fontScale?: number, fullscreen?: boolean, divisions?: Array<{ x: number; y: number; width: number; height: number; active: boolean }>, preferred?: { u: number; v: number } | null) => {
    area: Rect; shown: Rect; bar: Record<string, string>; menu: Record<string, string>; sheet: Record<string, string>; keys: Record<string, string>; composer: Record<string, string>; video: Record<string, string>; horizontal: boolean;
  };
}

describe("continuous screen layout changes", () => {
  it("keeps authored control sizes when system text size changes", () => {
    const run = changingViewer();
    const viewport = { x: 0, y: 0, w: 950, h: 670 }, insets = { top: 0, right: 70, bottom: 0, left: 0 };
    const initial = run(viewport, insets, 'menu', 1);
    const menu = run(viewport, insets, 'menu', 2);
    expect(menu.horizontal).toBe(initial.horizontal);
    expect(menu.menu).toEqual(initial.menu);
    const typing = run({ ...viewport, h: 300 }, insets, 'keys', 2);
    expect(typing.area.h).toBe(244);
  });

  it("returns to the same video and controls after rotating, folding, typing, and reopening", () => {
    const run = changingViewer();
    const expanded = { x: 0, y: 0, w: 950, h: 670 }, rightChrome = { top: 0, right: 70, bottom: 0, left: 0 };
    const first = run(expanded, rightChrome);
    expect(first.horizontal).toBe(true);
    const portrait = run({ x: 0, y: 0, w: 670, h: 950 }, { top: 66, right: 0, bottom: 34, left: 0 });
    expect(portrait.area.h).toBe(850);
    const closed = run({ x: 0, y: 0, w: 390, h: 844 }, { top: 59, right: 0, bottom: 34, left: 0 }, 'sheet');
    expect(parseFloat(closed.sheet.width!)).toBeLessThanOrEqual(390);
    expect(closed.horizontal).toBe(false);
    const typing = run({ x: 0, y: 0, w: 390, h: 300 }, { top: 0, right: 0, bottom: 0, left: 0 }, 'keys');
    expect(typing.area.h).toBe(244);
    run({ x: 0, y: 0, w: 950, h: 670 }, { top: 0, right: 0, bottom: 0, left: 70 }, 'sheet');
    const reopened = run(expanded, rightChrome);
    expect(reopened.shown).toEqual(first.shown);
    expect(reopened.video).toEqual(first.video);
    expect(reopened.bar).toEqual(first.bar);
    expect(reopened.menu).toEqual(first.menu);
    expect(reopened.horizontal).toBe(true);
  });
});

describe("live fullscreen motion", () => {
  it.each([
    [{ x: 0, y: 82, w: 880, h: 495 }, { x: 0, y: 30, w: 950, h: 534 }],
    [{ x: 0, y: 30, w: 950, h: 534 }, { x: 0, y: 82, w: 880, h: 495 }],
    [{ x: 14, y: 58, w: 913, h: 513.5 }, { x: 0, y: 82, w: 880, h: 495 }],
  ])("maps the new live picture onto its previous visible rectangle", (from, to) => {
    const flip = logic.presentationFlip(from, to, false)!;
    expect(to.x * flip.sx + flip.x).toBeCloseTo(from.x);
    expect(to.y * flip.sy + flip.y).toBeCloseTo(from.y);
    expect(to.w * flip.sx).toBeCloseTo(from.w);
    expect(to.h * flip.sy).toBeCloseTo(from.h);
  });

  it("settles a light spring without large overshoot and consistently across frame rates", () => {
    const start = { x: 0, y: 72, w: 440, h: 247.5 }, target = { x: 0, y: 42, w: 475, h: 267.2 };
    let current = start, velocity = { x: 0, y: 0, w: 0, h: 0 }, settled = false;
    for (let frame = 0; frame < 27; frame++) {
      const next = logic.presentationSpring(current, velocity, target, 1 / 60);
      current = next.current; velocity = next.velocity; settled = next.settled;
      expect(current.y).toBeGreaterThan(41);
      expect(current.y).toBeLessThanOrEqual(72);
    }
    expect(settled).toBe(true);
    let sixty = { current: start, velocity: { x: 0, y: 0, w: 0, h: 0 }, settled: false };
    let oneTwenty = sixty;
    for (let i = 0; i < 12; i++) sixty = logic.presentationSpring(sixty.current, sixty.velocity, target, 1 / 60);
    for (let i = 0; i < 24; i++) oneTwenty = logic.presentationSpring(oneTwenty.current, oneTwenty.velocity, target, 1 / 120);
    expect(sixty.current.y).toBeCloseTo(oneTwenty.current.y, 8);
    expect(sixty.velocity.y).toBeCloseTo(oneTwenty.velocity.y, 8);
  });

  it("does not animate reduced motion or an unloaded picture", () => {
    const rect = { x: 0, y: 0, w: 950, h: 534 };
    expect(logic.presentationFlip(rect, rect, true)).toBeNull();
    expect(logic.presentationFlip(null, rect, false)).toBeNull();
    expect(logic.presentationFlip({ ...rect, w: 0 }, rect, false)).toBeNull();
  });

  it("keeps position and velocity on reversal and safe-inset retargeting, then respects reduced motion", () => {
    const source = /const reducedMotion = matchMedia\("\(prefers-reduced-motion: reduce\)"\);[\s\S]*?window.linkshellPresent = beginPresentation;/.exec(viewerPage())![0];
    const motion = new Function(`${VIEWER_LOGIC}
      const timers = new Map(), frames = new Map(), released = [];
      let serial = 0, reducedListener;
      const media = { matches: false, addEventListener: (_, fn) => { reducedListener = fn; } };
      const matchMedia = () => media, setTimeout = (fn) => { timers.set(++serial, fn); return serial; }, clearTimeout = (id) => timers.delete(id);
      const requestAnimationFrame = (fn) => { frames.set(++serial, fn); return serial; }, cancelAnimationFrame = (id) => frames.delete(id);
      const window = {}, document = {}, app = true, chrome = { fullscreen: false }, content = { w: 1920 };
      const stage = { classList: { add() {}, remove() {} } };
      const sheetClasses = new Set(['gone']);
      const sheet = { style: {}, offsetWidth: 320, offsetHeight: 400, classList: { contains: (name) => sheetClasses.has(name), toggle(name, on) { if (on) sheetClasses.add(name); else sheetClasses.delete(name); } } }; let sheetOpen = false;
      const bar = { animate: () => ({ cancel() {} }) }, picture = { style: {} };
      const armControlsIdle = () => {}, wake = () => {}, closeMenu = () => {}, endOne = () => {}, act = (event) => released.push(event);
      let mouseHeld = 'left', gesture = {}, lastTap = {}, shown = { x: 0, y: 80, w: 880, h: 495 }, live = true;
      const video = { getBoundingClientRect: () => ({ left: shown.x, top: shown.y, width: shown.w, height: shown.h }) };
      const touches = new Map();
      ${source}
      return {
        start: beginPresentation,
        panel(open) { beginSheetTransition(open); sheetOpen = open; sheet.classList.toggle('gone', !sheetOpen && !sheetTransition); animatePresentation(); },
        resize(to) { shown = to; animatePresentation(); },
        tick(time) { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)); },
        setFull(value) { chrome.fullscreen = value; },
        reduced() { media.matches = true; reducedListener(); },
        state() { return { active: presentation.active, current: { ...presentation.current }, velocity: { ...presentation.velocity }, released, transform: picture.style.transform, panel: sheetTransition ? { ...sheetTransition } : null, panelHidden: sheet.classList.contains("gone") }; }
      };
    `)() as {
      start(full: boolean): void; panel(open: boolean): void; resize(to: Rect): void; setFull(full: boolean): void;
      tick(time: number): void; reduced(): void; state(): { active: boolean; current: Rect; velocity: Rect; released: unknown[]; transform: string; panel: { progress: number; velocity: number; target: number } | null; panelHidden: boolean };
    };
    const small = { x: 0, y: 80, w: 880, h: 495 }, large = { x: 0, y: 20, w: 950, h: 534 };
    motion.start(true);
    motion.resize(large);
    motion.tick(0); motion.tick(16); motion.tick(48);
    expect(motion.state().released).toEqual([{ t: "up", b: "left" }]);
    const moving = motion.state();
    expect(moving.velocity.y).toBeLessThan(0);
    motion.setFull(true);
    motion.start(false);
    motion.resize(small);
    expect(motion.state().current).toEqual(moving.current);
    expect(motion.state().velocity).toEqual(moving.velocity);
    motion.resize({ ...small, y: 84 });
    expect(motion.state().velocity).toEqual(moving.velocity);
    for (let time = 64; time < 700; time += 16) motion.tick(time);
    expect(motion.state().active).toBe(false);
    expect(motion.state().transform).toBe("");
    motion.panel(true);
    motion.resize({ x: 0, y: 10, w: 600, h: 337.5 });
    motion.tick(720); motion.tick(752);
    const opening = motion.state().panel!;
    expect(opening.progress).toBeGreaterThan(0);
    expect(opening.progress).toBeLessThan(1);
    motion.panel(false);
    motion.resize(large);
    expect(motion.state().panel!.progress).toBe(opening.progress);
    expect(motion.state().panel!.velocity).toBe(opening.velocity);
    expect(motion.state().panelHidden).toBe(false);
    for (let time = 768; time < 1400; time += 16) motion.tick(time);
    expect(motion.state().panelHidden).toBe(true);
    expect(motion.state().panel).toBeNull();
    motion.setFull(false);
    motion.start(true);
    motion.resize(large);
    motion.reduced();
    expect(motion.state().active).toBe(false);
  });
});


describe("shortcut sheet motion", () => {
  it.each(["left", "right", "top", "bottom"] as const)("slides through the %s edge and stays mounted while returning", (dock) => {
    const hidden = logic.sheetPresentation(0, 320, 400, dock);
    const halfway = logic.sheetPresentation(0.5, 320, 400, dock);
    const open = logic.sheetPresentation(1, 320, 400, dock);
    expect(open.x).toBeCloseTo(0);
    expect(open.y).toBeCloseTo(0);
    expect(open.opacity).toBe(1);
    expect(hidden.opacity).toBe(0);
    expect(halfway.x).toBe(hidden.x / 2);
    expect(halfway.y).toBe(hidden.y / 2);
    expect(halfway.opacity).toBe(0.5);
    if (dock === "bottom" || dock === "top") expect(Math.abs(hidden.y)).toBeGreaterThan(400);
    else expect(Math.abs(hidden.x)).toBeGreaterThan(320);
  });
});


describe("immersive screen area and safe controls", () => {
  it.each([
    { viewport: { x: 0, y: 0, w: 950, h: 670 }, insets: { top: 60, right: 88, bottom: 34, left: 16 } },
    { viewport: { x: 0, y: 0, w: 670, h: 950 }, insets: { top: 66, right: 0, bottom: 34, left: 0 } },
    { viewport: { x: 0, y: 0, w: 844, h: 390 }, insets: { top: 0, right: 0, bottom: 21, left: 59 } },
  ])("fits the full desktop into $viewport while controls avoid $insets", ({ viewport, insets }) => {
    const run = changingViewer();
    const normal = run(viewport, insets);
    const immersive = run(viewport, insets, 'menu', 1, true);
    const safe = logic.usableViewport(viewport, insets);
    expect(normal.area).toEqual(safe);
    expect(immersive.area).toEqual(viewport);
    expect(immersive.shown.w / immersive.shown.h).toBeCloseTo(1920 / 1080);
    expect(immersive.shown.w).toBeCloseTo(Math.min(viewport.w, viewport.h * 1920 / 1080));
    expect(immersive.shown.x + immersive.shown.w / 2).toBeCloseTo(viewport.x + viewport.w / 2);
    expect(immersive.shown.y + immersive.shown.h / 2).toBeCloseTo(viewport.y + viewport.h / 2);
    for (const style of [immersive.bar, immersive.menu]) {
      expect(parseFloat(style.left!)).toBeGreaterThanOrEqual(safe.x + 8);
      expect(parseFloat(style.top!)).toBeGreaterThanOrEqual(safe.y + 8);
      expect(parseFloat(style.left!)).toBeLessThan(safe.x + safe.w - 8);
      expect(parseFloat(style.top!)).toBeLessThan(safe.y + safe.h - 8);
    }
  });

  it("reserves only the actual shortcut panel when fully immersed", () => {
    const run = changingViewer();
    const insets = { top: 60, right: 88, bottom: 34, left: 16 };
    const landscape = run({ x: 0, y: 0, w: 950, h: 670 }, insets, 'sheet', 1, true);
    expect(landscape.area.y).toBe(0);
    expect(landscape.area.h).toBe(670);
    expect(landscape.area.x).toBeGreaterThan(parseFloat(landscape.sheet.left!) + parseFloat(landscape.sheet.width!));
    expect(landscape.area.x + landscape.area.w).toBe(950);
    const portrait = run({ x: 0, y: 0, w: 670, h: 950 }, { top: 66, right: 0, bottom: 34, left: 0 }, 'sheet', 1, true);
    expect(portrait.area.x).toBe(0);
    expect(portrait.area.y).toBe(0);
    expect(portrait.area.w).toBe(670);
    expect(portrait.area.h).toBeLessThan(parseFloat(portrait.sheet.top!));
  });
});

/** Drive the shipped UI controller with a deterministic animation clock and local pointer events. */
function viewerControls() {
  const page = viewerPage(), start = page.indexOf("// Scalar springs drive controls");
  const source = page.slice(start, page.indexOf("\nfunction layout() {", start));
  const wake = /function wake\(\) \{[\s\S]*?\n\}/.exec(page)![0];
  return new Function(`${VIEWER_LOGIC}
    let now = 0, serial = 0;
    const frames = new Map(), timers = new Map(), reducedListeners = [], documentListeners = [];
    const requestAnimationFrame = (fn) => { frames.set(++serial, fn); return serial; }, cancelAnimationFrame = id => frames.delete(id);
    const setTimeout = (fn, delay) => { timers.set(++serial, { at: now + delay, fn }); return serial; }, clearTimeout = id => timers.delete(id);
    const reducedMotion = { matches: false, addEventListener: (_, fn) => reducedListeners.push(fn) };
    const document = { hidden: false, fullscreenElement: null, addEventListener: (_, fn) => documentListeners.push(fn) };
    const app = true, chrome = { fullscreen: false, keyboard: false }, presentation = { active: false };
    let keysOpen = false, sheetOpen = false, sheetTransition = null, composerOpen = false;
    const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
    function element(id, width = 44, height = 44) {
      const classes = new Set(id === 'menu' || id === 'connection' ? ['gone'] : []), events = new Map();
      return { style: { left: '700px', top: '500px' }, offsetWidth: width, offsetHeight: height,
        classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
        addEventListener: (name, fn) => events.set(name, fn),
        setPointerCapture() {}, releasePointerCapture() {},
        emit: (name, x, y) => events.get(name)?.({ pointerId: 1, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} }),
        getBoundingClientRect() { const left = parseFloat(this.style.left), top = parseFloat(this.style.top); return { left, top, width, height, right: left + width, bottom: top + height }; }
      };
    }
    const bar = element('bar', 146, 52), controlShell = element('shell'), orb = element('orb'), menu = element('menu', 232, 168), connection = element('connection', 232, 100);
    const mode = element('mode'), info = element('info'), $ = id => id === 'mode' ? mode : info;
    let safe = { x: 0, y: 0, w: 880, h: 650 }; const viewport = () => safe; let anchor = { x: 718, y: 582, w: 146, h: 52 };
    function layout() { const preferred = controls.preferred ? { x: safe.x + controls.preferred.u * safe.w, y: safe.y + controls.preferred.v * safe.h } : null; layoutControls(interactionViewport(safe, chrome.insets || { top: 0, right: 0, bottom: 0, left: 0 }, chrome.divisions, preferred), anchor); for (const panel of [menu, connection]) if (!panel.classList.contains('gone')) drawPopover(panel); }
    ${source}
    ${wake}
    layout();
    return {
      set(values) { if ('divisions' in values) chrome.divisions = values.divisions; if ('fullscreen' in values) chrome.fullscreen = values.fullscreen; if ('keyboard' in values) chrome.keyboard = values.keyboard; if ('sheet' in values) sheetOpen = values.sheet; if ('presenting' in values) presentation.active = values.presenting; layout(); armControlsIdle(); },
      advance(ms) { const end = now + ms; while (now < end) { now = Math.min(end, now + 16); for (const [id, timer] of [...timers]) if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.fn(); } for (const [id, fn] of [...frames]) if (frames.has(id)) { frames.delete(id); fn(now); } } },
      popup(kind, open) { presentPopover(kind === 'mode' ? menu : connection, open); },
      press(down) { pressFeedback(mode, down); },
      orb(name, x = 780, y = 610) { orb.emit(name, x, y); },
      resize(next) { safe = next; layout(); },
      reduced(value) { reducedMotion.matches = value; reducedListeners.forEach(fn => fn()); },
      background(hidden) { document.hidden = hidden; documentListeners.forEach(fn => fn()); },
      wake,
      state() { return { value: controls.value, velocity: controlSprings.get(controls)?.velocity ?? 0, target: controls.target, visibility: controls.visibility, shell: { ...controlShell.style }, barOpacity: Number(bar.style.opacity), drag: !!controls.drag, pressed: pressedControls.size, orb: { ...controls.orb }, orbOpacity: Number(orb.style.opacity), modeScale: mode.style.scale, menu: { hidden: menu.classList.contains('gone'), target: popoverMotions.get(menu)?.target, opacity: menu.style.opacity, transform: menu.style.transform }, info: { hidden: connection.classList.contains('gone'), opacity: connection.style.opacity, transform: connection.style.transform }, springs: controlSprings.size }; }
    };
  `)() as {
    set(values: { divisions?: Array<{ x: number; y: number; width: number; height: number; active: boolean }>; fullscreen?: boolean; keyboard?: boolean; sheet?: boolean; presenting?: boolean }): void;
    advance(ms: number): void; popup(kind: "mode" | "info", open: boolean): void; press(down: boolean): void;
    orb(name: string, x?: number, y?: number): void; resize(safe: Rect): void; reduced(value: boolean): void; background(hidden: boolean): void; wake(): void;
    state(): { value: number; velocity: number; target: number; visibility: number; shell: Record<string, string>; barOpacity: number; drag: boolean; pressed: number; orb: Rect; orbOpacity: number; modeScale: string; menu: { hidden: boolean; target?: number; opacity: string; transform: string }; info: { hidden: boolean; opacity: string; transform: string }; springs: number };
  };
}

describe("viewer control motion and idle orb", () => {
  it("clears a backgrounded drag and resumes the idle countdown when the page returns", () => {
    const ui = viewerControls();
    ui.set({ fullscreen: true }); ui.advance(3600);
    ui.orb('pointerdown'); ui.orb('pointermove', 700, 500);
    expect(ui.state().drag).toBe(true);
    ui.background(true);
    expect(ui.state().drag).toBe(false);
    expect(ui.state().pressed).toBe(0);
    ui.background(false);
    expect(ui.state().target).toBe(0);
    ui.orb('pointerdown'); ui.orb('pointerup'); ui.advance(700);
    ui.background(true); ui.advance(5000);
    expect(ui.state().target).toBe(1);
    ui.background(false);
    expect(ui.state().target).toBe(1);
    ui.advance(2999);
    expect(ui.state().target).toBe(1);
    ui.advance(701);
    expect(ui.state().target).toBe(0);
    expect(ui.state().value).toBe(0);
  });

  it("shows a press even when the tap ends before the first animation frame", () => {
    const ui = viewerControls();
    ui.press(true);
    ui.press(false);
    ui.advance(32);
    expect(Number(ui.state().modeScale)).toBeLessThan(0.96);
    expect(Number(ui.state().modeScale)).toBeGreaterThan(0.9);
    ui.advance(500);
    expect(ui.state().modeScale).toBe('');
  });

  it("animates both popovers in and out, and reverses an in-flight close without flashing", () => {
    const ui = viewerControls();
    ui.popup('mode', true);
    expect(ui.state().menu.hidden).toBe(false);
    expect(Number(ui.state().menu.opacity)).toBe(0);
    ui.advance(80);
    expect(Number(ui.state().menu.opacity)).toBeGreaterThan(0);
    expect(Number(ui.state().menu.opacity)).toBeLessThan(1);
    ui.popup('mode', false);
    expect(ui.state().menu.hidden).toBe(false);
    ui.advance(40);
    const closing = ui.state().menu.opacity;
    ui.popup('mode', true);
    expect(ui.state().menu.opacity).toBe(closing);
    ui.advance(500);
    expect(ui.state().menu.transform).toBe('');
    ui.popup('mode', false);
    ui.popup('info', true);
    expect(ui.state().info.hidden).toBe(false);
    ui.advance(500);
    expect(ui.state().menu.hidden).toBe(true);
    expect(ui.state().info.transform).toBe('');
    ui.popup('info', false);
    expect(ui.state().info.hidden).toBe(false);
    ui.advance(500);
    expect(ui.state().info.hidden).toBe(true);
  });

  it("collapses only after three fullscreen idle seconds and expands when the orb is tapped", () => {
    const ui = viewerControls();
    ui.advance(5000);
    expect(ui.state().target).toBe(1);
    ui.set({ fullscreen: true });
    ui.advance(2999);
    expect(ui.state().target).toBe(1);
    ui.advance(501);
    expect(ui.state().value).toBeCloseTo(0);
    expect(ui.state().orbOpacity).toBeCloseTo(0.3);
    ui.orb('pointerdown'); ui.orb('pointerup');
    expect(ui.state().target).toBe(1);
    ui.advance(500);
    expect(ui.state().value).toBeCloseTo(1);
    ui.set({ fullscreen: false });
    ui.advance(5000);
    expect(ui.state().value).toBe(1);
    expect(ui.state().orbOpacity).toBe(0);
  });

  it("keeps tools available during popovers, keyboard, shortcuts and held gestures, then rearms", () => {
    const ui = viewerControls();
    ui.set({ fullscreen: true });
    ui.popup('info', true); ui.advance(5000);
    expect(ui.state().target).toBe(1);
    ui.popup('info', false); ui.advance(500);
    ui.set({ keyboard: true }); ui.advance(5000);
    expect(ui.state().target).toBe(1);
    ui.set({ keyboard: false, sheet: true }); ui.advance(5000);
    expect(ui.state().target).toBe(1);
    ui.set({ sheet: false }); ui.press(true); ui.advance(5000);
    expect(ui.state().target).toBe(1);
    expect(Number(ui.state().modeScale)).toBeCloseTo(0.92);
    ui.press(false); ui.advance(3500);
    expect(ui.state().target).toBe(0);
  });

  it("keeps orb dragging local and clamped, and clears gestures on capture loss or rotation", () => {
    const ui = viewerControls();
    ui.set({ fullscreen: true }); ui.advance(3500);
    ui.orb('pointerdown'); ui.orb('pointermove', -100, -100);
    expect(ui.state().orb.x).toBeGreaterThanOrEqual(8);
    expect(ui.state().orb.y).toBeGreaterThanOrEqual(8);
    ui.orb('lostpointercapture', -100, -100);
    expect(ui.state().drag).toBe(false);
    expect(ui.state().pressed).toBe(0);
    expect(ui.state().target).toBe(0);
    ui.orb('pointerdown'); ui.orb('pointermove', 1000, 1000);
    ui.resize({ x: 59, y: 20, w: 331, h: 500 });
    expect(ui.state().drag).toBe(false);
    expect(ui.state().pressed).toBe(0);
    expect(ui.state().orb.x).toBeGreaterThanOrEqual(67);
    expect(ui.state().orb.x + 44).toBeLessThanOrEqual(382);
    expect(ui.state().orb.y + 44).toBeLessThanOrEqual(512);
  });

  it("finishes immediately for reduced motion and can reverse the toolbar collapse", () => {
    const ui = viewerControls();
    ui.set({ fullscreen: true }); ui.advance(3080);
    expect(ui.state().value).toBeGreaterThan(0);
    expect(ui.state().value).toBeLessThan(1);
    const before = ui.state().value;
    ui.wake();
    expect(ui.state().value).toBe(before);
    ui.advance(500);
    ui.reduced(true);
    ui.popup('mode', true);
    expect(ui.state().menu.transform).toBe('');
    ui.popup('mode', false);
    expect(ui.state().menu.hidden).toBe(true);
    ui.advance(3000);
    expect(ui.state().value).toBe(0);
    expect(ui.state().springs).toBe(0);
  });
});


describe("one continuous glass control surface", () => {
  it("morphs the same rectangle into a 32-point circle and fades only at the end", () => {
    const anchor = { x: 700, y: 580, w: 146, h: 52 }, ball = { x: 751, y: 584, w: 44, h: 44 };
    const expanded = logic.controlsMorph(1, anchor, ball), collapsed = logic.controlsMorph(0, anchor, ball);
    expect({ x: expanded.x, y: expanded.y, w: expanded.w, h: expanded.h }).toEqual(anchor);
    expect({ x: collapsed.x, y: collapsed.y, w: collapsed.w, h: collapsed.h, radius: collapsed.radius }).toEqual({ x: 757, y: 590, w: 32, h: 32, radius: 16 });
    expect(collapsed.shellOpacity).toBeCloseTo(0.3);
    for (const progress of [1, 0.8, 0.5, 0.3]) expect(logic.controlsMorph(progress, anchor, ball).shellOpacity).toBeCloseTo(1);
    expect(logic.controlsMorph(0.15, anchor, ball).shellOpacity).toBeCloseTo(0.65);
    expect(viewerPage()).toContain('<div id="control-shell" class="glass" aria-hidden="true"></div>');
    expect(viewerPage()).toContain('<div id="bar">');
    expect(viewerPage()).not.toContain('<div id="bar" class="glass">');
  });

  it("keeps the current shell shape when collapse is rapidly reversed", () => {
    const ui = viewerControls();
    ui.set({ fullscreen: true }); ui.advance(3048);
    const midway = ui.state().shell;
    expect(parseFloat(midway.width!)).toBeGreaterThan(32);
    expect(parseFloat(midway.width!)).toBeLessThan(146);
    expect(Number(midway.opacity)).toBe(1);
    ui.wake();
    expect(ui.state().shell).toEqual(midway);
    ui.advance(700);
    expect(ui.state().shell.width).toBe('146px');
    expect(ui.state().shell.height).toBe('52px');
  });

  it("hides and restores the shared background together with its tools for shortcuts", () => {
    const ui = viewerControls();
    ui.set({ fullscreen: true, sheet: true });
    ui.advance(80);
    expect(Number(ui.state().shell.opacity)).toBeGreaterThan(0);
    expect(Number(ui.state().shell.opacity)).toBeLessThan(1);
    expect(Number(ui.state().shell.opacity)).toBeCloseTo(ui.state().barOpacity);
    ui.advance(500);
    expect(Number(ui.state().shell.opacity)).toBe(0);
    expect(ui.state().barOpacity).toBe(0);
    ui.set({ sheet: false }); ui.advance(80);
    expect(Number(ui.state().shell.opacity)).toBeCloseTo(ui.state().barOpacity);
    ui.advance(500);
    expect(Number(ui.state().shell.opacity)).toBe(1);
    expect(ui.state().shell.width).toBe('146px');
  });
});


describe("readable glass morph timing", () => {
  it("keeps a distinct intermediate capsule before becoming a ball and preserves velocity on reversal", () => {
    const ui = viewerControls();
    ui.set({ fullscreen: true }); ui.advance(3100);
    const moving = ui.state();
    expect(parseFloat(moving.shell.width!)).toBeGreaterThan(65);
    expect(parseFloat(moving.shell.width!)).toBeLessThan(110);
    expect(moving.velocity).toBeLessThan(0);
    ui.wake();
    expect(ui.state().velocity).toBe(moving.velocity);
    expect(ui.state().shell).toEqual(moving.shell);
    ui.advance(16);
    expect(ui.state().value).toBeLessThan(moving.value);
    ui.advance(700);
    expect(ui.state().shell.width).toBe('146px');
  });

  it("uses about a quarter second for the visible shape change and finishes its spring tail", () => {
    const ui = viewerControls();
    ui.set({ fullscreen: true }); ui.advance(3200);
    expect(parseFloat(ui.state().shell.width!)).toBeGreaterThan(34);
    ui.advance(100);
    expect(parseFloat(ui.state().shell.width!)).toBeLessThan(34);
    ui.advance(300);
    expect(ui.state().shell.width).toBe('32px');
    expect(ui.state().springs).toBe(0);
  });

  it.each([17, 22])("keeps the %s spring consistent at 60 and 120 fps", (frequency) => {
    const initial = { current: { x: 1, y: 0, w: 1, h: 1 }, velocity: { x: 0, y: 0, w: 0, h: 0 }, settled: false };
    const target = { x: 0, y: 0, w: 1, h: 1 };
    let sixty = initial, oneTwenty = initial;
    for (let i = 0; i < 12; i++) sixty = logic.presentationSpring(sixty.current, sixty.velocity, target, 1 / 60, frequency);
    for (let i = 0; i < 24; i++) oneTwenty = logic.presentationSpring(oneTwenty.current, oneTwenty.velocity, target, 1 / 120, frequency);
    expect(sixty.current.x).toBeCloseTo(oneTwenty.current.x, 10);
    expect(sixty.velocity.x).toBeCloseTo(oneTwenty.velocity.x, 10);
  });
});


describe("controls avoid active fold divisions", () => {
  const viewport = { x: 0, y: 0, w: 900, h: 650 };
  const insets = { top: 30, right: 60, bottom: 20, left: 10 };
  const vertical = { x: 438, y: 0, width: 24, height: 650, active: true };
  const horizontal = { x: 0, y: 310, width: 900, height: 24, active: true };

  it("chooses the reachable right or bottom pane, or the pane last used", () => {
    expect(logic.interactionViewport(viewport, insets, [vertical], null)).toEqual({ x: 462, y: 30, w: 378, h: 600 });
    expect(logic.interactionViewport(viewport, insets, [vertical], { x: 100, y: 100 })).toEqual({ x: 10, y: 30, w: 428, h: 600 });
    expect(logic.interactionViewport(viewport, insets, [horizontal], null)).toEqual({ x: 10, y: 334, w: 830, h: 296 });
    expect(logic.interactionViewport(viewport, insets, [horizontal], { x: 100, y: 100 })).toEqual({ x: 10, y: 30, w: 830, h: 280 });
    expect(logic.interactionViewport(viewport, insets, [{ ...vertical, active: false }], null)).toEqual(logic.usableViewport(viewport, insets));
    expect(logic.interactionViewport({ ...viewport, h: 240 }, insets, [horizontal], null)).toEqual(logic.usableViewport({ ...viewport, h: 240 }, insets));
    expect(logic.interactionViewport({ ...viewport, x: 10, y: 20 }, insets, [vertical], null)).toEqual({ x: 472, y: 50, w: 378, h: 600 });
  });

  it.each([vertical, horizontal])("keeps the picture full-size while toolbar and popover fit a single pane", (division) => {
    const run = changingViewer();
    const current = run(viewport, insets, 'menu', 1, true, [division]);
    const region = logic.interactionViewport(viewport, insets, [division], null);
    expect(current.area).toEqual(viewport);
    expect(current.shown.w / current.shown.h).toBeCloseTo(1920 / 1080);
    for (const control of [current.bar, current.menu]) {
      expect(parseFloat(control.left!)).toBeGreaterThanOrEqual(region.x + 8);
      expect(parseFloat(control.top!)).toBeGreaterThanOrEqual(region.y + 8);
    }
    expect(parseFloat(current.menu.left!) + parseFloat(current.menu.width!)).toBeLessThanOrEqual(region.x + region.w - 8);
  });

  it.each(['sheet', 'keys', 'composer'])("places %s in the selected pane without spanning the hinge", (panel) => {
    for (const division of [vertical, horizontal]) {
      for (const preferred of [null, { u: 0.1, v: 0.1 }]) {
        const run = changingViewer();
        const current = run(viewport, insets, panel, 1, true, [division], preferred);
        const point = preferred ? { x: preferred.u * viewport.w, y: preferred.v * viewport.h } : null;
        const region = logic.interactionViewport(viewport, insets, [division], point);
        const style = panel === 'sheet' ? current.sheet : panel === 'keys' ? current.keys : current.composer;
        const height = panel === 'composer' ? 100 : parseFloat(style.height!);
        expect(parseFloat(style.left!)).toBeGreaterThanOrEqual(region.x);
        expect(parseFloat(style.top!)).toBeGreaterThanOrEqual(region.y);
        expect(parseFloat(style.left!) + parseFloat(style.width!)).toBeLessThanOrEqual(region.x + region.w);
        expect(parseFloat(style.top!) + height).toBeLessThanOrEqual(region.y + region.h);
        expect(current.shown.w / current.shown.h).toBeCloseTo(1920 / 1080);
      }
    }
  });

  it("lets a dragged orb switch panes but never leaves its hit target in the fold", () => {
    const ui = viewerControls();
    const division = { x: 430, y: 0, width: 20, height: 650, active: true };
    ui.set({ fullscreen: true, divisions: [division] }); ui.advance(3700);
    let ball = ui.state().orb;
    expect(ball.x).toBeGreaterThanOrEqual(458);
    ui.orb('pointerdown', ball.x + 22, ball.y + 22);
    ui.orb('pointermove', 100, 200);
    ui.orb('pointerup', 100, 200);
    ball = ui.state().orb;
    expect(ball.x + 44).toBeLessThanOrEqual(422);
    ui.orb('pointerdown', ball.x + 22, ball.y + 22);
    ui.orb('pointermove', 770, 250);
    ui.orb('pointerup', 770, 250);
    expect(ui.state().orb.x).toBeGreaterThanOrEqual(458);
    expect(ui.state().drag).toBe(false);
    expect(ui.state().pressed).toBe(0);
  });
});

it("moves the orb between tabletop panes and preserves its position when unfolded", () => {
  const ui = viewerControls();
  const division = { x: 0, y: 310, width: 880, height: 24, active: true };
  ui.set({ fullscreen: true, divisions: [division] }); ui.advance(3700);
  let ball = ui.state().orb;
  expect(ball.y).toBeGreaterThanOrEqual(342);
  ui.orb('pointerdown', ball.x + 22, ball.y + 22);
  ui.orb('pointermove', 100, 100);
  ui.orb('pointerup', 100, 100);
  ball = ui.state().orb;
  expect(ball.y + 44).toBeLessThanOrEqual(302);
  ui.set({ divisions: [{ ...division, active: false }] });
  expect(ui.state().orb.x).toBeCloseTo(ball.x);
  expect(ui.state().orb.y).toBeCloseTo(ball.y);
});
