import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AUTH_DIR = process.env.LINKSHELL_HOME || join(homedir(), ".linkshell");
const AUTH_FILE = join(AUTH_DIR, "auth.json");

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  userId: string;
  email?: string;
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
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(tokens, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function clearAuth(): void {
  try {
    if (existsSync(AUTH_FILE)) {
      writeFileSync(AUTH_FILE, "{}", { encoding: "utf8", mode: 0o600 });
    }
  } catch {}
}

export function isLoggedIn(): boolean {
  const auth = loadAuth();
  return auth !== null && auth.accessToken.length > 0;
}

const SUPABASE_URL = "https://mkbeusztkzffnzjdwmqk.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rYmV1c3p0a3pmZm56amR3bXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5Nzc0NzgsImV4cCI6MjA4MTU1MzQ3OH0.2wlT6q6687Z5rpEYsdp01IQpNNl_XWv0IAfBgwPyDP0";

export { SUPABASE_URL, SUPABASE_ANON_KEY };

let inflightRefresh: Promise<AuthTokens | null> | null = null;

/**
 * Refresh the access token using the refresh token.
 * Returns updated tokens or null if refresh failed.
 */
export async function refreshAccessToken(options: { signal?: AbortSignal } = {}): Promise<AuthTokens | null> {
  if (options.signal?.aborted) return null;
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
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
    // again later would make Supabase revoke the whole session.
    saveAuth(tokens);
    return options.signal?.aborted ? null : tokens;
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

// What Supabase answers for a refresh token that can never work again (reused, revoked, its
// session or user gone); anything else (rate limits, outages, proxies) may pass on a retry.
const DEAD_REFRESH_TOKEN = new Set([
  "refresh_token_already_used", "refresh_token_not_found", "session_not_found", "session_expired",
  "user_not_found", "user_banned", "invalid_grant",
]);

async function refused(res: Response): Promise<boolean> {
  if (![400, 401, 403].includes(res.status)) return false;
  try {
    const body = (await res.json()) as { error_code?: unknown; error?: unknown };
    return DEAD_REFRESH_TOKEN.has(String(body.error_code ?? body.error));
  } catch {
    return false;
  }
}

// itool.tech proxies the Supabase token exchange so clients in regions that can't reach
// supabase.co directly can still refresh. Set LINKSHELL_TOKEN_PROXY=off to skip it (kill switch).
const TOKEN_PROXY_URL = "https://itool.tech/api/linkshell/token";

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
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
}

/**
 * Tries the itool.tech proxy. Returns an outcome to act on, or null meaning the proxy itself
 * couldn't give a verdict (unreachable, 5xx, unexpected shape) so the caller should fall back to
 * Supabase directly. Only a definite `invalid_grant` from the proxy signs the account out.
 */
async function exchangeViaProxy(refreshToken: string, signal?: AbortSignal): Promise<ExchangeOutcome | null> {
  try {
    const res = await fetch(TOKEN_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: exchangeSignal(signal),
    });
    if (res.ok) return { kind: "ok", body: (await res.json()) as TokenResponse };
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    if (body.code === "invalid_grant") return { kind: "dead" };
    return null; // temporarily_unavailable, invalid_request, anything else → fall back to direct
  } catch {
    return null; // couldn't reach itool.tech → fall back to direct
  }
}

async function exchangeDirect(refreshToken: string, signal?: AbortSignal): Promise<ExchangeOutcome> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: exchangeSignal(signal),
    });
    if (res.ok) return { kind: "ok", body: (await res.json()) as TokenResponse };
    return (await refused(res)) ? { kind: "dead" } : { kind: "retryable" };
  } catch {
    return { kind: "retryable" };
  }
}

async function exchangeRefreshToken(refreshToken: string, signal?: AbortSignal): Promise<ExchangeOutcome> {
  if (process.env.LINKSHELL_TOKEN_PROXY !== "off") {
    const viaProxy = await exchangeViaProxy(refreshToken, signal);
    if (viaProxy) return viaProxy;
  }
  return exchangeDirect(refreshToken, signal);
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
