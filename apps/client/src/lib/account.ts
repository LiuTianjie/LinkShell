import { create } from "zustand";
import { deleteSecret, readSecret, writeSecret } from "./secure";

// The iTool account (Supabase auth, shared with iTool and `linkshell login`).
// Signing in lets the phone reach every computer signed in to the same account
// without pairing. The anon key is public by design.

const SUPABASE_URL = "https://mkbeusztkzffnzjdwmqk.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rYmV1c3p0a3pmZm56amR3bXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5Nzc0NzgsImV4cCI6MjA4MTU1MzQ3OH0.2wlT6q6687Z5rpEYsdp01IQpNNl_XWv0IAfBgwPyDP0";
const KEY = "linkshell.account.v2";

export const SIGN_UP_URL = "https://itool.tech/en/auth/linkshell";

export interface AccountSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  email?: string;
}

interface AccountState {
  session?: AccountSession;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** A valid access token, refreshed when close to expiry; undefined when signed out. */
  token(): Promise<string | undefined>;
}

async function auth(path: string, body: unknown): Promise<AccountSession> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = String(json.error_description ?? json.msg ?? json.message ?? "登录失败");
    throw new Error(/invalid login credentials/i.test(message) ? "邮箱或密码不对" : /email not confirmed/i.test(message) ? "邮箱还没有验证，请先查收验证邮件" : message);
  }
  const user = json.user as { id: string; email?: string };
  return {
    accessToken: String(json.access_token),
    refreshToken: String(json.refresh_token),
    expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    userId: user.id,
    email: user.email,
  };
}

let refreshing: Promise<AccountSession | undefined> | undefined;

export const useAccount = create<AccountState>((set, get) => ({
  session: readSecret<AccountSession>(KEY),
  async signIn(email, password) {
    const session = await auth("token?grant_type=password", { email: email.trim(), password });
    writeSecret(KEY, session);
    set({ session });
  },
  async signOut() {
    await deleteSecret(KEY);
    set({ session: undefined });
  },
  async token() {
    const session = get().session;
    if (!session) return undefined;
    if (session.expiresAt - Date.now() > 120_000) return session.accessToken;
    refreshing ??= auth("token?grant_type=refresh_token", { refresh_token: session.refreshToken })
      .then((next) => {
        writeSecret(KEY, next);
        set({ session: next });
        return next;
      })
      .catch(() => undefined)
      .finally(() => {
        refreshing = undefined;
      });
    return (await refreshing)?.accessToken;
  },
}));
