import type { IncomingMessage, ServerResponse } from "node:http";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "true";

export { AUTH_REQUIRED };

interface AuthResult {
  authenticated: boolean;
  userId?: string;
  email?: string;
  plan?: string;
}

/**
 * Validate a Supabase JWT by calling the /auth/v1/user endpoint.
 * This is simpler and more reliable than local JWT verification
 * since it also checks token revocation.
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

    const user = (await res.json()) as {
      id: string;
      email?: string;
    };

    // Check subscription status
    let plan = "free";
    try {
      const subRes = await fetch(
        `${SUPABASE_URL}/rest/v1/linkshell_subscriptions?user_id=eq.${user.id}&status=eq.active&select=plan&limit=1`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: SUPABASE_ANON_KEY,
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (subRes.ok) {
        const subs = (await subRes.json()) as { plan: string }[];
        if (subs.length > 0) plan = subs[0]!.plan;
      }
    } catch {}

    return {
      authenticated: true,
      userId: user.id,
      email: user.email,
      plan,
    };
  } catch {
    return { authenticated: false };
  }
}

function extractToken(req: IncomingMessage): string | null {
  // Check Authorization header
  const auth = req.headers.authorization;
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1];
  }

  // Check query parameter
  const url = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("auth_token");
  if (token) return token;

  return null;
}

/**
 * Auth middleware for the premium gateway.
 * Returns true if the request is allowed to proceed.
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
    res.end(JSON.stringify({ error: "Authentication required" }));
    return null;
  }

  const result = await validateToken(token);
  if (!result.authenticated) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid or expired token" }));
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

  return validateToken(token);
}
