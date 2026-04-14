import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchWithTimeout } from "../utils/fetch-with-timeout";

const SUPABASE_URL = "https://mkbeusztkzffnzjdwmqk.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rYmV1c3p0a3pmZm56amR3bXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5Nzc0NzgsImV4cCI6MjA4MTU1MzQ3OH0.2wlT6q6687Z5rpEYsdp01IQpNNl_XWv0IAfBgwPyDP0";

export { SUPABASE_URL, SUPABASE_ANON_KEY };

const AUTH_STORAGE_KEY = "@linkshell/auth";

export interface AuthUser {
  id: string;
  email?: string;
  plan: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: AuthUser;
}

async function saveSession(session: AuthSession): Promise<void> {
  await AsyncStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

export async function loadSession(): Promise<AuthSession | null> {
  try {
    const raw = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthSession;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await AsyncStorage.removeItem(AUTH_STORAGE_KEY);
}

async function fetchUserPlan(accessToken: string, userId: string): Promise<string> {
  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan,plan_expires_at&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: SUPABASE_ANON_KEY,
        },
      },
      5_000,
    );
    if (res.ok) {
      const profiles = (await res.json()) as { plan: string; plan_expires_at: string | null }[];
      if (profiles.length > 0) {
        const p = profiles[0]!;
        if (p.plan === "pro" && p.plan_expires_at && new Date(p.plan_expires_at) > new Date()) {
          return "pro";
        }
      }
    }
  } catch {}
  return "free";
}

export async function signUp(
  email: string,
  password: string,
): Promise<{ session: AuthSession | null; error: string | null }> {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    }, 10_000);
    const body = await res.json() as any;
    if (!res.ok) {
      return { session: null, error: body.error_description || body.msg || "Sign up failed" };
    }
    if (!body.access_token) {
      return { session: null, error: null }; // email confirmation required
    }
    const plan = await fetchUserPlan(body.access_token, body.user.id);
    const session: AuthSession = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      user: { id: body.user.id, email: body.user.email, plan },
    };
    await saveSession(session);
    return { session, error: null };
  } catch (e) {
    return { session: null, error: e instanceof Error ? e.message : "Network error" };
  }
}

export async function signIn(
  email: string,
  password: string,
): Promise<{ session: AuthSession | null; error: string | null }> {
  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ email, password }),
      },
      10_000,
    );
    const body = await res.json() as any;
    if (!res.ok) {
      return { session: null, error: body.error_description || body.msg || "Sign in failed" };
    }
    const plan = await fetchUserPlan(body.access_token, body.user.id);
    const session: AuthSession = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      user: { id: body.user.id, email: body.user.email, plan },
    };
    await saveSession(session);
    return { session, error: null };
  } catch (e) {
    return { session: null, error: e instanceof Error ? e.message : "Network error" };
  }
}

export async function signOut(): Promise<void> {
  const session = await loadSession();
  if (session) {
    try {
      await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          apikey: SUPABASE_ANON_KEY,
        },
      }, 5_000);
    } catch {}
  }
  await clearSession();
}

export async function refreshSession(): Promise<AuthSession | null> {
  const session = await loadSession();
  if (!session?.refreshToken) return null;

  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      },
      10_000,
    );
    if (!res.ok) return null;
    const body = await res.json() as any;
    const plan = await fetchUserPlan(body.access_token, body.user.id);
    const updated: AuthSession = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      user: { id: body.user.id, email: body.user.email, plan },
    };
    await saveSession(updated);
    return updated;
  } catch {
    return null;
  }
}

/**
 * Register a device token with the user's account.
 */
export async function registerDeviceToken(
  deviceToken: string,
  deviceName: string,
  platform: string,
): Promise<void> {
  const session = await loadSession();
  if (!session) return;

  try {
    await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/linkshell_device_tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        apikey: SUPABASE_ANON_KEY,
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        user_id: session.user.id,
        token: deviceToken,
        device_name: deviceName,
        platform,
      }),
    }, 5_000);
  } catch {}
}

/**
 * Get a valid session, refreshing token if needed.
 */
export async function getValidSession(): Promise<AuthSession | null> {
  const session = await loadSession();
  if (!session) return null;

  // If token expires in less than 60s, refresh
  if (session.expiresAt - Date.now() < 60_000) {
    return refreshSession();
  }

  return session;
}

/**
 * Fetch official gateways list.
 */
export interface OfficialGateway {
  url: string;
  name: string;
  region: string | null;
}

export async function fetchOfficialGateways(): Promise<OfficialGateway[]> {
  const session = await getValidSession();
  if (!session) return [];

  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/linkshell_official_gateways?enabled=eq.true&select=url,name,region`,
      {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          apikey: SUPABASE_ANON_KEY,
        },
      },
      5_000,
    );
    if (res.ok) {
      return (await res.json()) as OfficialGateway[];
    }
  } catch {}
  return [];
}

/**
 * Fetch user's sessions on an official gateway.
 */
export async function fetchMySessions(
  gatewayUrl: string,
): Promise<
  {
    id: string;
    state: string;
    hasHost: boolean;
    clientCount: number;
    provider: string | null;
    hostname: string | null;
    projectName: string | null;
    lastActivity: number;
  }[]
> {
  const session = await getValidSession();
  if (!session) return [];

  try {
    const res = await fetchWithTimeout(`${gatewayUrl}/sessions/mine`, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
      },
    }, 5_000);
    if (res.ok) {
      const body = (await res.json()) as { sessions: any[] };
      return body.sessions ?? [];
    }
  } catch {}
  return [];
}
