/**
 * What the desktop window's mouse and keyboard become on the remote computer. The events are the
 * host's (`inputEvent` in packages/host/src/input.ts) and the Mac app's (InputEvent.swift); key
 * names are the ones Keys.swift knows. Kept free of the DOM so it can be tested on its own.
 */

export type Modifier = "cmd" | "shift" | "alt" | "ctrl";
export type ScreenPlatform = "mac" | "windows" | "other";
export type ScreenInput =
  | { t: "move"; x: number; y: number }
  | { t: "down" | "up"; b: "left" | "right"; n?: number; m?: Modifier[] }
  | { t: "scroll"; dx: number; dy: number; m?: Modifier[] }
  | { t: "key"; k: string; m?: Modifier[] }
  | { t: "text"; s: string };

export function screenPlatform(value: string | undefined): ScreenPlatform {
  return value === "darwin" ? "mac" : value === "win32" ? "windows" : "other";
}

interface ModifierState { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/**
 * The modifiers held, as the remote computer's. Between a Mac and Windows the hand's shortcut key
 * is a different key: ⌘C on a Mac is Ctrl+C on Windows, and Ctrl+C on Windows is ⌘C on a Mac, so
 * across the two the shortcut key is swapped (⌘ ↔ Ctrl; the Windows key becomes ⌃).
 */
export function remoteModifiers(event: ModifierState, local: ScreenPlatform, remote: ScreenPlatform): Modifier[] {
  const across = local !== remote && local !== "other" && remote !== "other";
  const held = new Set<Modifier>();
  if (event.metaKey) held.add(across ? "ctrl" : "cmd");
  if (event.ctrlKey) held.add(across && local === "windows" ? "cmd" : "ctrl");
  if (event.altKey) held.add("alt");
  if (event.shiftKey) held.add("shift");
  return [...held];
}

const NAMED: Record<string, string> = {
  Enter: "return", Backspace: "backspace", Tab: "tab", Escape: "escape",
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
  Delete: "delete", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
};
/** Symbol keys by where they are, named by what they type unshifted on a US keyboard. */
const SYMBOLS: Record<string, string> = {
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";",
  Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
};

interface KeyState { key: string; code: string }

/** A key that is not text (Return, the arrows, F1–F12, …), by its name; undefined for any other. */
export function namedKey(event: KeyState): string | undefined {
  if (NAMED[event.key]) return NAMED[event.key];
  return /^F([1-9]|1[0-2])$/.test(event.key) ? event.key.toLowerCase() : undefined;
}

/**
 * The key a shortcut is made with. A letter is the one its key types here, as on the keycap
 * (another layout puts letters elsewhere, and the computer finds the key that types it there).
 * A digit or symbol is named by its key, unshifted: ⇧⌘4 is "4" with ⇧, not "$". Undefined for a
 * modifier pressed alone, or a key the computer has no name for.
 */
export function shortcutKey(event: KeyState): string | undefined {
  const named = namedKey(event);
  if (named) return named;
  if (event.code === "Space" || event.key === " ") return "space";
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  if (SYMBOLS[event.code]) return SYMBOLS[event.code];
  return /^[\x21-\x7e]$/.test(event.key) ? event.key : undefined;
}

/** Text typed here, as the events that type it there: line breaks and tabs are keys, the rest at most 4000 UTF-16 units a piece. */
export function textInput(text: string): ScreenInput[] {
  const out: ScreenInput[] = [];
  let piece = "";
  const flush = () => { if (piece) out.push({ t: "text", s: piece }); piece = ""; };
  for (const character of text.replace(/\r\n/g, "\n")) {
    if (character === "\n" || character === "\r" || character === "\t") {
      flush();
      out.push({ t: "key", k: character === "\t" ? "tab" : "return" });
      continue;
    }
    // Never between the two halves of a surrogate pair: `for … of` walks whole code points.
    if (piece.length + character.length > 4000) flush();
    piece += character;
  }
  flush();
  return out;
}

export function mouseButton(button: number): "left" | "right" | undefined {
  return button === 0 ? "left" : button === 2 ? "right" : undefined;
}

export interface Rect { x: number; y: number; width: number; height: number }

/** Where a picture of this size sits in the stage: as large as it fits, centred. */
export function fittedRect(picture: { width: number; height: number }, stage: { width: number; height: number }): Rect {
  if (!(picture.width > 0 && picture.height > 0 && stage.width > 0 && stage.height > 0)) return { x: 0, y: 0, width: 0, height: 0 };
  // The side that fills the stage is the stage's own, exactly; only the other is scaled.
  const wide = stage.width / stage.height < picture.width / picture.height;
  const width = wide ? stage.width : picture.width * (stage.height / picture.height);
  const height = wide ? picture.height * (stage.width / picture.width) : stage.height;
  return { x: (stage.width - width) / 2, y: (stage.height - height) / 2, width, height };
}

/**
 * The box on whole device pixels: one that falls between two of them is resampled by the
 * compositor, which costs the remote computer's text its edges.
 */
export function snappedRect(rect: Rect, ratio: number): Rect {
  const grid = ratio > 0 ? ratio : 1;
  const snap = (value: number) => Math.round(value * grid) / grid;
  return { x: snap(rect.x), y: snap(rect.y), width: snap(rect.width), height: snap(rect.height) };
}

export const FULLSCREEN_TOP_SNAP_LIMIT = 96;

/** A point of the stage as a fraction of the picture; undefined outside it unless `clamp` or `topEdgeSnap`. */
export function pictureFraction(rect: Rect, x: number, y: number, clamp = false, topEdgeSnap = false): { x: number; y: number } | undefined {
  if (!(rect.width > 0 && rect.height > 0)) return undefined;
  const u = (x - rect.x) / rect.width, v = (y - rect.y) / rect.height;
  const bound = (value: number) => Math.min(1, Math.max(0, value));
  if (!clamp && (u < 0 || u > 1 || v < 0 || v > 1)) {
    if (topEdgeSnap && rect.y > 0 && rect.y <= FULLSCREEN_TOP_SNAP_LIMIT && y >= 0 && y <= rect.y && u >= 0 && u <= 1) {
      return { x: +bound(u).toFixed(5), y: 0 };
    }
    return undefined;
  }
  return { x: +bound(u).toFixed(5), y: +bound(v).toFixed(5) };
}

/** The widths the picture is asked for: steps, so that a window being resized doesn't renegotiate it at every pixel. */
export const SCREEN_WIDTHS = [1280, 1600, 1920, 2560, 3200, 3840] as const;
/** The host's and the Mac app's widest (`VIDEO_WIDEST`): a 5K display is sent at 3840. */
export const WIDEST_SCREEN = 3840;

/**
 * The narrowest picture that still covers the device pixels it is shown on. Wider is spent on
 * pixels nobody sees, and at a given bitrate each extra pixel is a softer one; narrower is
 * scaled up and blurs text. `aspect` (the picture's width over its height, once known) decides
 * whether the stage's width or its height is the one the picture fills.
 */
export function fittedScreenWidth(stage: { width: number; height: number }, ratio: number, aspect?: number): number {
  const shown = aspect && aspect > 0 ? Math.min(stage.width, stage.height * aspect) : stage.width;
  // Past 2× the extra pixels cost more in bitrate than they return in detail.
  const target = Math.max(0, shown) * Math.min(Math.max(ratio || 1, 1), 2);
  return SCREEN_WIDTHS.find((width) => width >= target * 0.97) ?? WIDEST_SCREEN;
}

/** A stored clarity choice ("auto", "1280", …, "native") as the width to ask for. */
export function chosenScreenWidth(choice: string, fitted: number): number {
  if (choice === "native") return WIDEST_SCREEN;
  const width = Number(choice);
  return Number.isInteger(width) && width >= 640 ? Math.min(width, WIDEST_SCREEN) : fitted;
}

/** A wheel's turn in the pixels the computer scrolls by; positive is towards the top and the left, as the computer counts it. */
export function wheelPixels(event: { deltaX: number; deltaY: number; deltaMode: number }): { dx: number; dy: number } {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  const bound = (value: number) => Math.max(-2000, Math.min(2000, value));
  return { dx: bound(-event.deltaX * unit), dy: bound(-event.deltaY * unit) };
}
