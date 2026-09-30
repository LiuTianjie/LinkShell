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
