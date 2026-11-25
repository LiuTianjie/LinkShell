import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AUTH_DIR = process.env.LINKSHELL_HOME || join(homedir(), ".linkshell");
const AUTH_FILE = join(AUTH_DIR, "auth.json");
const LOCK_FILE = join(AUTH_DIR, "auth.lock");
const LOCK_STALE_MS = 20_000;
const LOCK_WAIT_MS = 12_000;
const LOCK_POLL_MS = 50;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  userId: string;
  email?: string;
}

function ensureAuthDir(): void {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(AUTH_DIR, 0o700); } catch {}
  }
}

function writeAuthFileAtomic(content: string): void {
  ensureAuthDir();
  const tmp = join(AUTH_DIR, `auth.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      try { chmodSync(tmp, 0o600); } catch {}
    }
    renameSync(tmp, AUTH_FILE);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

export function loadAuth(): AuthTokens | null {
  try {
    if (!existsSync(AUTH_FILE)) return null;
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as AuthTokens;
    if (!data.accessToken || !data.refreshToken) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveAuth(tokens: AuthTokens): void {
  writeAuthFileAtomic(JSON.stringify(tokens, null, 2) + "\n");
}

export function clearAuth(): void {
  try {
    if (existsSync(AUTH_FILE)) {
      writeAuthFileAtomic("{}");
    }
  } catch {}
}

export function isLoggedIn(): boolean {
  const auth = loadAuth();
  return auth !== null && auth.accessToken.length > 0;
}

const SUPABASE_URL = "https://api.itool.tech";
const SUPABASE_ANON_KEY = "itool-core";

export { SUPABASE_URL, SUPABASE_ANON_KEY };

let inflightRefresh: Promise<AuthTokens | null> | null = null;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Serializes refresh across the host daemon, desktop sidecar, and CLI processes sharing
 * `~/.linkshell/auth.json` so two processes never send the same rotating refresh token at once.
 */
async function acquireRefreshLock(signal?: AbortSignal): Promise<(() => void) | "aborted" | null> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    if (signal?.aborted) return "aborted";
    try {
      ensureAuthDir();
      const fd = openSync(LOCK_FILE, "wx", 0o600);
      try { writeFileSync(fd, `${process.pid}:${Date.now()}\n`, "utf8"); } catch {}
      try { closeSync(fd); } catch {}
      return () => { try { unlinkSync(LOCK_FILE); } catch {} };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") return null;
      try {
        if (Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(LOCK_FILE);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return null;
      await sleep(LOCK_POLL_MS, signal);
    }
  }
}

/**
 * Refresh the access token using the refresh token.
 * Returns updated tokens or null if refresh failed.
 */
export async function refreshAccessToken(options: { signal?: AbortSignal } = {}): Promise<AuthTokens | null> {
  if (options.signal?.aborted) return null;
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    const initial = loadAuth();
    if (!initial?.refreshToken) return null;
    if (initial.expiresAt - Date.now() >= 60_000) return initial;

    const lock = await acquireRefreshLock(options.signal);
    if (lock === "aborted") return null;
    try {
      // Re-read after acquiring the cross-process lock: another process may have rotated it.
      const auth = loadAuth();
      if (!auth?.refreshToken) return null;
      if (auth.expiresAt - Date.now() >= 60_000) return auth;

      const outcome = await exchangeRefreshToken(auth.refreshToken, options.signal);
      if (outcome.kind === "dead") return signedOutElsewhere(auth);
      if (outcome.kind === "retryable") return rotatedElsewhere(auth);
      const body = outcome.body;
      const tokens: AuthTokens = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + body.expires_in * 1000,
        userId: body.user.id,
        email: body.user.email ?? auth.email,
      };
      // A login or logout may finish while the refresh is in flight.
      const current = loadAuth();
      if (tokens.userId !== auth.userId || current?.userId !== auth.userId) return null;
      if (current.refreshToken !== auth.refreshToken) return rotatedElsewhere(auth);
      // Saved even when the caller gave up: the old refresh token is spent now, and presenting it
      // again later would make the auth service revoke the whole session.
      saveAuth(tokens);
      return options.signal?.aborted ? null : tokens;
    } finally {
      lock?.();
    }
  })().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

/**
 * The desktop app, the host and the workspace each refresh the same account; whichever loses
 * the race finds the winner's tokens on disk rather than giving up on a signed-in account.
 */
function rotatedElsewhere(previous: AuthTokens): AuthTokens | null {
  const current = loadAuth();
  return current && current.userId === previous.userId && current.refreshToken !== previous.refreshToken &&
    current.expiresAt - Date.now() >= 60_000 ? current : null;
}

// What the auth service answers for a refresh token that can never work again (reused, revoked, its
// session or user gone); anything else (rate limits, outages, proxies) may pass on a retry.
const DEAD_REFRESH_TOKEN = new Set([
  "refresh_token_already_used", "refresh_token_not_found", "session_not_found", "session_expired",
  "user_not_found", "user_banned", "invalid_grant", "invalid_refresh_token", "invalid_session",
]);

async function refused(res: Response): Promise<boolean> {
  if (![400, 401, 403].includes(res.status)) return false;
  try {
    const body = (await res.json()) as { error_code?: unknown; error?: unknown; code?: unknown };
    const nested = body.error && typeof body.error === "object" ? (body.error as { code?: unknown }).code : undefined;
    return DEAD_REFRESH_TOKEN.has(String(nested ?? body.error_code ?? body.code ?? body.error));
  } catch {
    return false;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string; email?: string };
}

type ExchangeOutcome =
  | { kind: "ok"; body: TokenResponse }
  | { kind: "dead" } // the refresh token can never work again → sign out
  | { kind: "retryable" }; // outage, network, rate limit → keep the tokens and try again later

function exchangeSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
}

async function exchangeRefreshToken(refreshToken: string, signal?: AbortSignal): Promise<ExchangeOutcome> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: exchangeSignal(signal),
    });
    if (res.ok) {
      const body = (await res.json()) as Partial<TokenResponse>;
      if (typeof body.access_token !== "string" || !body.access_token || typeof body.refresh_token !== "string" ||
          !body.refresh_token || typeof body.user?.id !== "string") return { kind: "retryable" };
      return { kind: "ok", body: body as TokenResponse };
    }
    return (await refused(res)) ? { kind: "dead" } : { kind: "retryable" };
  } catch {
    return { kind: "retryable" };
  }
}

/**
 * The account was signed out on the server. Keeping its dead tokens would leave every client
 * showing a signed-in account that nothing can use, so this computer signs out too.
 */
function signedOutElsewhere(previous: AuthTokens): AuthTokens | null {
  const rotated = rotatedElsewhere(previous);
  if (rotated) return rotated;
  if (loadAuth()?.refreshToken === previous.refreshToken) clearAuth();
  return null;
}

/**
 * Get a valid access token, refreshing if needed.
 */
export async function getValidToken(options: { signal?: AbortSignal } = {}): Promise<string | null> {
  if (options.signal?.aborted) return null;
  const auth = loadAuth();
  if (!auth) return null;

  // If token expires in less than 120s, refresh
  if (auth.expiresAt - Date.now() < 120_000) {
    const refreshed = await refreshAccessToken(options);
    return refreshed?.accessToken ?? null;
  }

  return auth.accessToken;
}

/**
 * The access token on hand right now, without ever blocking on the network. Returns whatever is
 * saved (even if expired), and kicks off a background refresh when it is close to expiring. The
 * gateway keeps a peer's account binding when an expired token is presented, so a stale token here
 * still connects — the point is that a slow or unreachable Supabase can't stall the handshake.
 */
export function getCachedToken(): string | null {
  const auth = loadAuth();
  if (!auth) return null;
  if (auth.expiresAt - Date.now() < 120_000) void refreshAccessToken().catch(() => {});
  return auth.accessToken;
}
