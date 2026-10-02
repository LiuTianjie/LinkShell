import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { inputEvent } from "../src/input.js";
import { VIEWER_LOGIC, viewerPage } from "../src/screen-viewer.js";

interface Logic {
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
const logic = new Function(`${VIEWER_LOGIC}; return { fromGray, stripTime, lateness, summary, synced, ownEcho, laneOf, keyboardIsUp, pieces, typingOf, keyKnown, modsOf, comboSign, cleanShortcuts };`)() as Logic;

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
