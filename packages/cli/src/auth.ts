import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AUTH_DIR = join(homedir(), ".linkshell");
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

/**
 * Refresh the access token using the refresh token.
 * Returns updated tokens or null if refresh failed.
 */
export async function refreshAccessToken(): Promise<AuthTokens | null> {
  const auth = loadAuth();
  if (!auth?.refreshToken) return null;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ refresh_token: auth.refreshToken }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      user: { id: string; email?: string };
    };
    const tokens: AuthTokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + body.expires_in * 1000,
      userId: body.user.id,
      email: body.user.email,
    };
    saveAuth(tokens);
    return tokens;
  } catch {
    return null;
  }
}

/**
 * Get a valid access token, refreshing if needed.
 */
export async function getValidToken(): Promise<string | null> {
  const auth = loadAuth();
  if (!auth) return null;

  // If token expires in less than 60s, refresh
  if (auth.expiresAt - Date.now() < 60_000) {
    const refreshed = await refreshAccessToken();
    return refreshed?.accessToken ?? null;
  }

  return auth.accessToken;
}
