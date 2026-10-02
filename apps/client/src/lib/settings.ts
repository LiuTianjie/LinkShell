import Storage from "expo-sqlite/kv-store";

const HOST_URL_KEY = "host.url";

/** The development default: a host started with `linkshell host --dev-port 7878` on this Mac. */
export const DEFAULT_HOST_URL = process.env.EXPO_PUBLIC_LINKSHELL_HOST ?? "ws://127.0.0.1:7878";

function read(key: string): string | null {
  try {
    return Storage.getItemSync(key);
  } catch {
    return null;
  }
}

export function loadHostUrl(): string {
  return read(HOST_URL_KEY) || DEFAULT_HOST_URL;
}

export function saveHostUrl(url: string): void {
  try {
    Storage.setItemSync(HOST_URL_KEY, url);
  } catch {
    // Settings are a convenience; the app still works with the default.
  }
}

/** Accepts "192.168.1.5:7878", "ws://…" or "wss://…" and returns a WebSocket URL, or null. */
export function normalizeHostUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^wss?:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return null;
    return withScheme.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const SCREEN_MODE_KEY = "screen.mode";

/** How the screen viewer treats touches: watching only, or moving the computer's pointer. */
export type ScreenMode = "view" | "trackpad" | "touch";

/** The mode last chosen in the screen viewer; watching only until one is. */
export function loadScreenMode(): ScreenMode {
  const stored = read(SCREEN_MODE_KEY);
  return stored === "trackpad" || stored === "touch" ? stored : "view";
}

export function saveScreenMode(mode: ScreenMode): void {
  try {
    Storage.setItemSync(SCREEN_MODE_KEY, mode);
  } catch {
    // As above: the viewer starts watching only.
  }
}

const SCREEN_SHORTCUTS_KEY = "screen.shortcuts";
const SHORTCUT_MODIFIERS = ["ctrl", "alt", "shift", "cmd"] as const;
// The keys the computer knows by name (apps/mac, Keys.swift).
const SHORTCUT_KEY = /^(?:[a-z0-9\-=[\]\\;',./`]|return|tab|space|backspace|escape|left|right|down|up|delete|home|end|pageup|pagedown|f(?:[1-9]|1[0-2]))$/;

/** A key combination the user added to the screen viewer's shortcuts: a name, a key, its modifiers. */
export interface ScreenShortcut {
  name: string;
  k: string;
  m: (typeof SHORTCUT_MODIFIERS)[number][];
}

/** What the viewer page sent, or what was kept: only the shortcuts the computer would take, 24 at most. */
export function screenShortcuts(value: unknown): ScreenShortcut[] {
  const kept: ScreenShortcut[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (kept.length === 24) break;
    if (!entry || typeof entry !== "object") continue;
    const { name, k, m } = entry as { name?: unknown; k?: unknown; m?: unknown };
    if (typeof k !== "string" || !SHORTCUT_KEY.test(k) || typeof name !== "string" || !name.trim()) continue;
    kept.push({ name: [...name.trim()].slice(0, 16).join(""), k, m: SHORTCUT_MODIFIERS.filter((modifier) => Array.isArray(m) && m.includes(modifier)) });
  }
  return kept;
}

/**
 * The user's own shortcuts in the screen viewer. Kept here and handed to the page, because the page has
 * nowhere to keep them: its address (a port on loopback) is another one every time.
 */
export function loadScreenShortcuts(): ScreenShortcut[] {
  try {
    return screenShortcuts(JSON.parse(read(SCREEN_SHORTCUTS_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveScreenShortcuts(shortcuts: ScreenShortcut[]): void {
  try {
    Storage.setItemSync(SCREEN_SHORTCUTS_KEY, JSON.stringify(shortcuts));
  } catch {
    // As above: the viewer then has only the shortcuts it comes with.
  }
}
