// Long-lived client device token (returned by POST /pairings/claim, 7-day TTL
// on the gateway). Stored in localStorage; reused across reconnects so the
// gateway keeps recognizing this browser as an owner of its claimed sessions.

const KEY = "linkshell_device_token";

let cached: string | null = null;

function uuid(): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function getDeviceToken(): string | null {
  if (cached) return cached;
  try {
    cached = localStorage.getItem(KEY);
  } catch {
    cached = null;
  }
  return cached;
}

export function ensureDeviceToken(): string {
  const existing = getDeviceToken();
  if (existing) return existing;
  const token = uuid();
  setDeviceToken(token);
  return token;
}

export function setDeviceToken(token: string): void {
  cached = token;
  try {
    localStorage.setItem(KEY, token);
  } catch {}
}

/** Stable per-browser client id so controller identity survives reconnects. */
const DEVICE_ID_KEY = "linkshell_device_id";
let cachedDeviceId: string | null = null;

export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = uuid();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    cachedDeviceId = id;
  } catch {
    cachedDeviceId = uuid();
  }
  return cachedDeviceId;
}
