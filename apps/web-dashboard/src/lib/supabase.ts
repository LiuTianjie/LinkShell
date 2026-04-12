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
  user: AuthUser;
}

const SESSION_KEY = "linkshell_session";

export function saveSession(session: Session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

export async function signIn(
  email: string,
  password: string,
): Promise<{ session: Session | null; error: string | null }> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ email, password }),
      },
    );
    const body = await res.json();
    if (!res.ok) {
      return { session: null, error: body.error_description || "Sign in failed" };
    }
    const session: Session = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      user: { id: body.user.id, email: body.user.email },
    };
    saveSession(session);
    return { session, error: null };
  } catch (e: any) {
    return { session: null, error: e.message || "Network error" };
  }
}

export async function signUp(
  email: string,
  password: string,
): Promise<{ session: Session | null; error: string | null }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (!res.ok) {
      return { session: null, error: body.error_description || body.msg || "Sign up failed" };
    }
    if (!body.access_token) {
      return { session: null, error: null }; // email confirmation needed
    }
    const session: Session = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      user: { id: body.user.id, email: body.user.email },
    };
    saveSession(session);
    return { session, error: null };
  } catch (e: any) {
    return { session: null, error: e.message || "Network error" };
  }
}

export async function signOut() {
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

export async function fetchApi<T>(
  path: string,
  session: Session,
): Promise<T | null> {
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
