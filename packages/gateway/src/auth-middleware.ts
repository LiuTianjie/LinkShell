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

/**
 * Validate a Supabase JWT and check subscription via iTool's profiles table.
 */
async function validateToken(token: string): Promise<AuthResult> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { authenticated: false };
  }

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

    return { authenticated: true, userId: user.id, email: user.email, plan, subscribed };
  } catch {
    return { authenticated: false };
  }
}

/**
 * Server-side subscription check using service role key (no user JWT needed).
 */
export async function checkSubscriptionByUserId(
  userId: string,
): Promise<boolean> {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !key) return false;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan,plan_expires_at&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${key}`,
          apikey: SUPABASE_ANON_KEY,
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) return false;
    const profiles = (await res.json()) as {
      plan: string;
      plan_expires_at: string | null;
    }[];
    if (profiles.length === 0) return false;
    const p = profiles[0]!;
    return (
      p.plan === "pro" &&
      !!p.plan_expires_at &&
      new Date(p.plan_expires_at) > new Date()
    );
  } catch {
    return false;
  }
}

function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1];
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("auth_token");
  if (token) return token;
  return null;
}

/**
 * Validate token and return auth result (exported for /sessions/mine).
 */
export async function validateRequest(
  req: IncomingMessage,
): Promise<AuthResult | null> {
  const token = extractToken(req);
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

  const token = extractToken(req);
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

  const token = extractToken(req);
  if (!token) return null;

  const result = await validateToken(token);
  if (!result.authenticated) return null;
  if (!result.subscribed) return null;

  return result;
}
