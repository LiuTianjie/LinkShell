import type { IncomingMessage, ServerResponse } from "node:http";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "true";

export { AUTH_REQUIRED, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY };

export interface AuthResult {
  authenticated: boolean;
  userId?: string;
  email?: string;
  plan?: string;
  subscribed?: boolean;
}

export interface SubscriptionCheckResult {
  status: "active" | "inactive" | "unknown";
  reason?: string;
}

export function canReadSessionDetail(input: {
  authRequired: boolean;
  authenticatedUserId?: string;
  sessionUserId?: string;
  tokenOwns: boolean;
}): boolean {
  if (input.tokenOwns) return true;
  return Boolean(
    input.authRequired &&
    input.authenticatedUserId &&
    input.sessionUserId &&
    input.authenticatedUserId === input.sessionUserId,
  );
}

/**
 * Short-TTL in-memory cache of successful token validations, so repeated
 * requests/WS upgrades with the same token don't hit Supabase on every call
 * (and an attacker can't amplify load with many pending 5s fetches as easily).
 */
interface CachedAuth {
  result: AuthResult;
  expiresAt: number;
}
const tokenAuthCache = new Map<string, CachedAuth>();
const TOKEN_CACHE_TTL = 45_000; // 45s

function getCachedAuth(token: string): AuthResult | null {
  const entry = tokenAuthCache.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokenAuthCache.delete(token);
    return null;
  }
  return entry.result;
}

function setCachedAuth(token: string, result: AuthResult): void {
  // Only cache successful authentications — never pin a failure.
  if (!result.authenticated) return;
  tokenAuthCache.set(token, { result, expiresAt: Date.now() + TOKEN_CACHE_TTL });
  if (tokenAuthCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of tokenAuthCache) {
      if (now > v.expiresAt) tokenAuthCache.delete(k);
    }
  }
}

/**
 * Validate a Supabase JWT and check subscription via iTool's profiles table.
 */
async function validateToken(token: string): Promise<AuthResult> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { authenticated: false };
  }

  const cached = getCachedAuth(token);
  if (cached) return cached;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) return { authenticated: false };

    const user = (await res.json()) as { id: string; email?: string };

    // Check subscription from iTool's profiles table
    let plan = "free";
    let subscribed = false;
    try {
      const profileRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=plan,plan_expires_at&limit=1`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: SUPABASE_ANON_KEY,
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (profileRes.ok) {
        const profiles = (await profileRes.json()) as {
          plan: string;
          plan_expires_at: string | null;
        }[];
        if (profiles.length > 0) {
          const p = profiles[0]!;
          plan = p.plan;
          subscribed =
            p.plan === "pro" &&
            !!p.plan_expires_at &&
            new Date(p.plan_expires_at) > new Date();
        }
      }
    } catch {}

    const authResult: AuthResult = {
      authenticated: true,
      userId: user.id,
      email: user.email,
      plan,
      subscribed,
    };
    setCachedAuth(token, authResult);
    return authResult;
  } catch {
    return { authenticated: false };
  }
}

/**
 * Server-side subscription check using service role key (no user JWT needed).
 * Returns "unknown" for configuration or network failures so active sessions
 * are not disconnected because of a transient verification problem.
 */
export async function checkSubscriptionByUserId(
  userId: string,
): Promise<SubscriptionCheckResult> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { status: "unknown", reason: "missing_supabase_config" };
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return { status: "unknown", reason: "missing_service_role_key" };
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan,plan_expires_at&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) return { status: "unknown", reason: `profile_lookup_http_${res.status}` };
    const profiles = (await res.json()) as {
      plan: string;
      plan_expires_at: string | null;
    }[];
    if (profiles.length === 0) return { status: "unknown", reason: "profile_not_found" };
    const p = profiles[0]!;
    const active =
      p.plan === "pro" &&
      !!p.plan_expires_at &&
      new Date(p.plan_expires_at) > new Date();
    return { status: active ? "active" : "inactive" };
  } catch {
    return { status: "unknown", reason: "profile_lookup_failed" };
  }
}

export function extractAuthToken(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("auth_token");
  if (token) return token;
  const auth = req.headers.authorization;
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Validate token and return auth result (exported for /sessions/mine).
 */
export async function validateRequest(
  req: IncomingMessage,
): Promise<AuthResult | null> {
  const token = extractAuthToken(req);
  if (!token) return null;
  const result = await validateToken(token);
  return result.authenticated ? result : null;
}

/**
 * Auth middleware for premium gateway HTTP endpoints.
 * Rejects non-subscribers with a message pointing to itool.tech.
 */
export async function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AuthResult | null> {
  if (!AUTH_REQUIRED) {
    return { authenticated: true };
  }

  const token = extractAuthToken(req);
  if (!token) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "auth_required", message: "Authentication required" }));
    return null;
  }

  const result = await validateToken(token);
  if (!result.authenticated) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_token", message: "Invalid or expired token" }));
    return null;
  }

  if (!result.subscribed) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "subscription_required",
        message: "Pro subscription required. Subscribe at https://itool.tech",
      }),
    );
    return null;
  }

  return result;
}

/**
 * Check auth for WebSocket upgrade requests.
 * Returns AuthResult or null if unauthorized.
 */
export async function checkWsAuth(
  req: IncomingMessage,
): Promise<AuthResult | null> {
  if (!AUTH_REQUIRED) {
    return { authenticated: true };
  }

  const token = extractAuthToken(req);
  if (!token) return null;

  const result = await validateToken(token);
  if (!result.authenticated) return null;
  if (!result.subscribed) return null;

  return result;
}
