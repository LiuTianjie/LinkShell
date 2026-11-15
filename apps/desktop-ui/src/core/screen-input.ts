/**
 * Turning the page's mouse and keyboard into a remote computer's input: what the remote screen
 * and Fusion's windows share. Pure functions, so the Fusion hub page needs none of the workspace.
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

export interface ModifierKeyState {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function remoteModifiers(
  event: ModifierKeyState,
  local: ScreenPlatform,
  remote: ScreenPlatform,
): Modifier[] {
  const across = local !== remote && local !== "other" && remote !== "other";
  const held = new Set<Modifier>();
  if (event.metaKey) held.add(across ? "ctrl" : "cmd");
  if (event.ctrlKey) held.add(across && local === "windows" ? "cmd" : "ctrl");
  if (event.altKey) held.add("alt");
  if (event.shiftKey) held.add("shift");
  return [...held];
}

const NAMED_KEYS: Record<string, string> = {
  Enter: "return",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "escape",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Delete: "delete",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

const SYMBOL_CODES: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

export interface KeyCodeState {
  key: string;
  code: string;
}

export function namedKey(event: KeyCodeState): string | undefined {
  if (NAMED_KEYS[event.key]) return NAMED_KEYS[event.key];
  return /^F([1-9]|1[0-2])$/.test(event.key) ? event.key.toLowerCase() : undefined;
}

export function shortcutKey(event: KeyCodeState): string | undefined {
  const named = namedKey(event);
  if (named) return named;
  if (event.code === "Space" || event.key === " ") return "space";
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  if (SYMBOL_CODES[event.code]) return SYMBOL_CODES[event.code];
  return /^[\x21-\x7e]$/.test(event.key) ? event.key : undefined;
}

export function textInput(text: string): ScreenInput[] {
  const out: ScreenInput[] = [];
  let piece = "";
  const flush = () => {
    if (piece) out.push({ t: "text", s: piece });
    piece = "";
  };
  for (const character of text.replace(/\r\n/g, "\n")) {
    if (character === "\n" || character === "\r" || character === "\t") {
      flush();
      out.push({ t: "key", k: character === "\t" ? "tab" : "return" });
      continue;
    }
    if (piece.length + character.length > 4000) flush();
    piece += character;
  }
  flush();
  return out;
}

export function mouseButton(button: number): "left" | "right" | undefined {
  return button === 0 ? "left" : button === 2 ? "right" : undefined;
}

export function wheelPixels(event: {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}): { dx: number; dy: number } {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  const bound = (value: number) => Math.max(-2000, Math.min(2000, value));
  return {
    dx: bound(-event.deltaX * unit),
    dy: bound(-event.deltaY * unit),
  };
}

export class ClickCounter {
  private last?: { button: string; at: number; x: number; y: number; count: number };

  constructor(
    private readonly intervalMs = 500,
    private readonly slopPx = 5,
  ) {}

  /** The click count for a press at (x, y) in CSS pixels. */
  down(button: string, x: number, y: number, at: number): number {
    const last = this.last;
    const repeat =
      last !== undefined &&
      last.button === button &&
      at - last.at <= this.intervalMs &&
      Math.hypot(x - last.x, y - last.y) <= this.slopPx;
    const count = repeat ? Math.min(3, last.count + 1) : 1;
    this.last = { button, at, x, y, count };
    return count;
  }

  /** The count the matching release carries. */
  current(button: string): number {
    return this.last?.button === button ? this.last.count : 1;
  }
}

