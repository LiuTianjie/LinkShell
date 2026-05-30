// Supabase auth for the LinkShell web client. Same project as itool-tech and the
// mobile app (project ref mkbeusztkzffnzjdwmqk). Email/password flow, sessions in
// localStorage, single-flight token refresh, and the profiles.plan / isPro gate.

const SUPABASE_URL = "https://mkbeusztkzffnzjdwmqk.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rYmV1c3p0a3pmZm56amR3bXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5Nzc0NzgsImV4cCI6MjA4MTU1MzQ3OH0.2wlT6q6687Z5rpEYsdp01IQpNNl_XWv0IAfBgwPyDP0";

export { SUPABASE_URL, SUPABASE_ANON_KEY };

export interface AuthUser {
  id: string;
  email?: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  user: AuthUser;
  plan: string;
}

const SESSION_KEY = "linkshell_session";
const SESSION_VERSION = 1;

interface StoredSession {
  version: number;
  session: Session;
}

export function saveSession(session: Session): void {
  const wrapped: StoredSession = { version: SESSION_VERSION, session };
  localStorage.setItem(SESSION_KEY, JSON.stringify(wrapped));
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (parsed && parsed.version === SESSION_VERSION && parsed.session) {
      return parsed.session;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function isPro(session: Session | null): boolean {
  return session?.plan === "pro";
}

async function fetchUserPlan(
  accessToken: string,
  userId: string,
  fallbackPlan = "free",
): Promise<string> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan,plan_expires_at&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: SUPABASE_ANON_KEY,
        },
      },
    );
    if (res.ok) {
      const profiles = (await res.json()) as {
        plan: string;
        plan_expires_at: string | null;
      }[];
      if (profiles.length > 0) {
        const p = profiles[0]!;
        if (p.plan === "pro" && p.plan_expires_at && new Date(p.plan_expires_at) > new Date()) {
          return "pro";
        }
      }
      return "free"; // definitive answer from the server
    }
    return fallbackPlan; // transient HTTP failure — keep prior plan
  } catch {
    return fallbackPlan;
  }
}

export async function signIn(
  email: string,
  password: string,
): Promise<{ session: Session | null; error: string | null }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (!res.ok) {
      return { session: null, error: body.error_description || "登录失败" };
    }
    const plan = await fetchUserPlan(body.access_token, body.user.id);
    const session: Session = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      user: { id: body.user.id, email: body.user.email },
      plan,
    };
    saveSession(session);
    return { session, error: null };
  } catch (e: any) {
    return { session: null, error: e.message || "网络错误" };
  }
}

export async function signUp(
  email: string,
  password: string,
): Promise<{ session: Session | null; error: string | null }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (!res.ok) {
      return { session: null, error: body.error_description || body.msg || "注册失败" };
    }
    if (!body.access_token) {
      return { session: null, error: null }; // email confirmation required
    }
    const plan = await fetchUserPlan(body.access_token, body.user.id);
    const session: Session = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      user: { id: body.user.id, email: body.user.email },
      plan,
    };
    saveSession(session);
    return { session, error: null };
  } catch (e: any) {
    return { session: null, error: e.message || "网络错误" };
  }
}

export async function signOut(): Promise<void> {
  const session = loadSession();
  if (session) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          apikey: SUPABASE_ANON_KEY,
        },
      });
    } catch {}
  }
  clearSession();
}

let inFlightRefresh: Promise<Session | null> | null = null;

export async function refreshSession(): Promise<Session | null> {
  // Single-flight: Supabase rotates the refresh token, so two concurrent
  // refreshes race and one loses, dropping the session. Collapse callers.
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async () => {
    const current = loadSession();
    if (!current?.refreshToken) return null;
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      const plan = await fetchUserPlan(body.access_token, body.user.id, current.plan);
      const updated: Session = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        user: { id: body.user.id, email: body.user.email },
        plan,
      };
      saveSession(updated);
      return updated;
    } catch {
      return null;
    }
  })();
  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

export async function getValidSession(): Promise<Session | null> {
  const session = loadSession();
  if (!session) return null;
  if (session.expiresAt - Date.now() < 60_000) {
    return refreshSession();
  }
  return session;
}

export async function fetchApi<T>(path: string, session: Session): Promise<T | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        apikey: SUPABASE_ANON_KEY,
      },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
