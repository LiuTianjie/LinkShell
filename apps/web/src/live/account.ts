import { fetchProMembership, fetchReferralSummary, type Locale } from "@linkshell/client-core";
import { desktopAccount, isDesktop } from "./desktop";

// Unified iTool Core account backend (shared with iTool, CLI, desktop, and mobile).
const CORE_URL = "https://api.itool.tech";
const CORE_PUBLIC_KEY = "itool-core";
const STORAGE_KEY = "linkshell.web.account.v2";

export interface WebAccountUser {
  id: string;
  email?: string;
}

export interface WebAccountSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in?: number;
  token_type?: string;
  user: WebAccountUser;
}

type AuthChangeListener = (event: string, session: WebAccountSession | null) => void;

export interface WebAccountAuth {
  getSession(): Promise<{ data: { session: WebAccountSession | null }; error: Error | null }>;
  refreshSession(): Promise<{ data: { session: WebAccountSession | null }; error: Error | null }>;
  signInWithPassword(params: { email: string; password: string }): Promise<{
    data: { session: WebAccountSession | null };
    error: Error | null;
  }>;
  signOut(options?: { scope?: "local" | "global" }): Promise<{ error: Error | null }>;
  signInWithOAuth(params: {
    provider: "github" | "google";
    options: { redirectTo: string; skipBrowserRedirect?: boolean };
  }): Promise<{ data: { url: string | null; flowId: string | null }; error: Error | null }>;
  exchangeCodeForSession(
    code: string,
    options?: { flowId?: string },
  ): Promise<{ data: { session: WebAccountSession | null }; error: Error | null }>;
  onAuthStateChange(listener: AuthChangeListener): { data: { subscription: { unsubscribe(): void } } };
}

export interface WebAccountClient {
  auth: WebAccountAuth;
}

function accountConfig() {
  return {
    supabaseUrl: (window.__LINKSHELL_CONFIG__?.account?.url ?? CORE_URL).replace(/\/+$/, ""),
    anonKey: window.__LINKSHELL_CONFIG__?.account?.anonKey ?? CORE_PUBLIC_KEY,
  };
}

function decodeJwtExp(token: string): number {
  try {
    const part = token.split(".")[1];
    if (!part) return 0;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof parsed.exp === "number" ? parsed.exp : 0;
  } catch {
    return 0;
  }
}

function normalizeSession(raw: unknown): WebAccountSession | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const access_token = typeof obj.access_token === "string" ? obj.access_token : "";
  const refresh_token = typeof obj.refresh_token === "string" ? obj.refresh_token : "";
  const user = obj.user && typeof obj.user === "object" ? (obj.user as WebAccountUser) : null;
  if (!access_token || !refresh_token || !user?.id) return null;
  const expires_in = typeof obj.expires_in === "number" ? obj.expires_in : 3600;
  const expires_at =
    typeof obj.expires_at === "number"
      ? obj.expires_at
      : decodeJwtExp(access_token) || Math.floor(Date.now() / 1000) + expires_in;
  return {
    access_token,
    refresh_token,
    expires_at,
    expires_in,
    token_type: typeof obj.token_type === "string" ? obj.token_type : "bearer",
    user: { id: user.id, email: user.email },
  };
}

function readStoredSession(): WebAccountSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeStoredSession(session: WebAccountSession | null): void {
  try {
    if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable
  }
}

function errorFromPayload(status: number, payload: unknown): Error {
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const inner = obj?.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : null;
  const message =
    (typeof inner?.message === "string" && inner.message) ||
    (typeof obj?.error_description === "string" && obj.error_description) ||
    (typeof obj?.msg === "string" && obj.msg) ||
    (typeof obj?.message === "string" && obj.message) ||
    `登录请求失败 (${status})`;
  const err = new Error(message) as Error & { status?: number; code?: string };
  err.status = status;
  if (typeof inner?.code === "string") err.code = inner.code;
  else if (typeof obj?.error_code === "string") err.code = obj.error_code;
  else if (typeof obj?.code === "string") err.code = obj.code;
  return err;
}

async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  let verifier = "";
  for (let i = 0; i < bytes.length; i += 1) verifier += alphabet[bytes[i] % alphabet.length];
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (let i = 0; i < digest.length; i += 1) binary += String.fromCharCode(digest[i]);
  const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

function createCoreWebClient(baseUrl: string): WebAccountClient {
  const listeners = new Set<AuthChangeListener>();
  const verifiers = new Map<string, string>();
  let inFlightRefresh: Promise<{ data: { session: WebAccountSession | null }; error: Error | null }> | null = null;

  const emit = (event: string, session: WebAccountSession | null) => {
    for (const listener of listeners) {
      try {
        listener(event, session);
      } catch {
        // Ignore subscriber errors
      }
    }
  };

  if (typeof window.addEventListener === "function") {
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY) return;
      const next = readStoredSession();
      emit(next ? "SIGNED_IN" : "SIGNED_OUT", next);
    });
  }

  const timedFetch = (path: string, init: RequestInit) => {
    const signal = init.signal;
    return fetch(`${baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
    });
  };

  const refreshSession = async (): Promise<{
    data: { session: WebAccountSession | null };
    error: Error | null;
  }> => {
    if (inFlightRefresh) return inFlightRefresh;
    inFlightRefresh = (async () => {
      const current = readStoredSession();
      if (!current?.refresh_token) {
        return { data: { session: null }, error: new Error("登录已失效，请重新登录") };
      }
      try {
        const res = await timedFetch("/auth/v1/token?grant_type=refresh_token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: current.refresh_token }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          if (res.status === 400 || res.status === 401) {
            writeStoredSession(null);
            emit("SIGNED_OUT", null);
          }
          return { data: { session: null }, error: errorFromPayload(res.status, body) };
        }
        const next = normalizeSession(body);
        if (!next) return { data: { session: null }, error: new Error("会话刷新失败，请重试") };
        writeStoredSession(next);
        emit("TOKEN_REFRESHED", next);
        return { data: { session: next }, error: null };
      } catch (error) {
        return {
          data: { session: null },
          error: error instanceof Error ? error : new Error("网络异常，请重试"),
        };
      } finally {
        inFlightRefresh = null;
      }
    })();
    return inFlightRefresh;
  };

  return {
    auth: {
      async getSession() {
        return { data: { session: readStoredSession() }, error: null };
      },

      refreshSession,

      async signInWithPassword({ email, password }) {
        try {
          const res = await timedFetch("/auth/v1/token?grant_type=password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok) return { data: { session: null }, error: errorFromPayload(res.status, body) };
          const session = normalizeSession(body);
          if (!session) return { data: { session: null }, error: new Error("登录未完成，请重试") };
          writeStoredSession(session);
          emit("SIGNED_IN", session);
          return { data: { session }, error: null };
        } catch (error) {
          return {
            data: { session: null },
            error: error instanceof Error ? error : new Error("网络异常，请重试"),
          };
        }
      },

      async signOut({ scope = "local" } = {}) {
        const current = readStoredSession();
        if (current?.access_token) {
          try {
            await timedFetch(`/auth/v1/logout?scope=${scope}`, {
              method: "POST",
              headers: { Authorization: `Bearer ${current.access_token}` },
            });
          } catch {
            // Always finish local sign-out even if offline.
          }
        }
        writeStoredSession(null);
        emit("SIGNED_OUT", null);
        return { error: null };
      },

      async signInWithOAuth({ provider, options }) {
        const { verifier, challenge } = await createPkcePair();
        const flowId = crypto.randomUUID();
        verifiers.set(flowId, verifier);
        const params = new URLSearchParams({
          provider,
          redirect_to: options.redirectTo,
          code_challenge: challenge,
          code_challenge_method: "s256",
        });
        return {
          data: { url: `${baseUrl}/auth/v1/authorize?${params.toString()}`, flowId },
          error: null,
        };
      },

      async exchangeCodeForSession(code, options) {
        const flowId = options?.flowId;
        const verifier = flowId ? verifiers.get(flowId) : undefined;
        if (flowId) verifiers.delete(flowId);
        if (!verifier) {
          return { data: { session: null }, error: new Error("无法验证登录请求，请重试。") };
        }
        try {
          const res = await timedFetch("/auth/v1/token?grant_type=pkce", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok) return { data: { session: null }, error: errorFromPayload(res.status, body) };
          const session = normalizeSession(body);
          if (!session) return { data: { session: null }, error: new Error("登录未完成，请重试。") };
          writeStoredSession(session);
          emit("SIGNED_IN", session);
          return { data: { session }, error: null };
        } catch (error) {
          return {
            data: { session: null },
            error: error instanceof Error ? error : new Error("网络异常，请重试"),
          };
        }
      },

      onAuthStateChange(listener) {
        listeners.add(listener);
        return {
          data: {
            subscription: {
              unsubscribe() {
                listeners.delete(listener);
              },
            },
          },
        };
      },
    },
  };
}

let client: WebAccountClient | undefined;

export function accountClient(): WebAccountClient {
  if (isDesktop) throw new Error("桌面端使用 LinkShell 的系统浏览器登录");
  const { supabaseUrl } = accountConfig();
  return (client ??= createCoreWebClient(supabaseUrl));
}
function assertAccount(userId: string | undefined, expectedUserId: string) {
  if (!userId) throw new Error("登录已失效，请重新登录");
  if (userId !== expectedUserId)
    throw new Error("账号已切换，请在当前账户下重新操作");
}

export async function accountToken(expectedUserId?: string) {
  if (isDesktop) {
    const account = await desktopAccount();
    if (expectedUserId !== undefined) assertAccount(account.userId, expectedUserId);
    return account.accessToken;
  }
  const auth = accountClient().auth;
  const { data, error } = await auth.getSession();
  if (error) throw error;
  if (expectedUserId !== undefined)
    assertAccount(data.session?.user.id, expectedUserId);
  if (!data.session) return undefined;
  if ((data.session.expires_at ?? 0) * 1000 > Date.now() + 120_000)
    return data.session.access_token;
  const next = await auth.refreshSession();
  if (next.error) throw next.error;
  if (!next.data.session) throw new Error("登录已失效，请重新登录");
  if (expectedUserId !== undefined)
    assertAccount(next.data.session.user.id, expectedUserId);
  return next.data.session.access_token;
}

async function currentAccountSession(expectedUserId: string) {
  if (isDesktop) {
    const account = await desktopAccount();
    assertAccount(account.userId, expectedUserId);
    if (!account.accessToken) throw new Error("登录已失效，请重新登录");
    return { access_token: account.accessToken };
  }
  const { data, error } = await accountClient().auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("登录已失效，请重新登录");
  assertAccount(data.session.user.id, expectedUserId);
  return data.session;
}

async function boundAccountToken(expectedUserId: string) {
  const accessToken = await accountToken(expectedUserId);
  const session = await currentAccountSession(expectedUserId);
  if (!accessToken || session.access_token !== accessToken)
    throw new Error("账号状态已更新，请重试");
  return accessToken;
}

export async function accountMembership(expectedUserId: string) {
  const accessToken = await boundAccountToken(expectedUserId);
  const membership = await fetchProMembership({
    ...accountConfig(),
    accessToken,
    userId: expectedUserId,
  });
  await currentAccountSession(expectedUserId);
  return membership;
}

export async function accountReferral(expectedUserId: string, locale?: Locale) {
  const accessToken = await boundAccountToken(expectedUserId);
  const referral = await fetchReferralSummary({
    ...accountConfig(),
    accessToken,
    userId: expectedUserId,
    locale,
  });
  await currentAccountSession(expectedUserId);
  return referral;
}
