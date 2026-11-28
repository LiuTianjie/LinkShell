import {
  fetchProMembership,
  fetchReferralSummary,
  type Locale,
  type ProMembership,
  type ReferralSummary,
} from "@linkshell/client-core";

// Unified iTool Core account backend (shared with iTool, CLI, desktop, and mobile).
const CORE_URL = "https://api.itool.tech";
const CORE_PUBLIC_KEY = "itool-core";
export const WEB_ACCOUNT_STORAGE_KEY = "linkshell.web.account.v2";

const CALLBACK_PARAM = "linkshell-auth-callback";
const POPUP_REQUEST_KEY = "linkshell.web.oauth.popup.v1";
const LOGIN_TIMEOUT = 5 * 60_000;

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

type AuthChangeListener = (
  event: string,
  session: WebAccountSession | null,
) => void;

export interface WebAccountAuth {
  getSession(): Promise<{
    data: { session: WebAccountSession | null };
    error: Error | null;
  }>;
  refreshSession(): Promise<{
    data: { session: WebAccountSession | null };
    error: Error | null;
  }>;
  signInWithPassword(params: {
    email: string;
    password: string;
  }): Promise<{
    data: { session: WebAccountSession | null };
    error: Error | null;
  }>;
  signOut(options?: {
    scope?: "local" | "global";
  }): Promise<{ error: Error | null }>;
  signInWithOAuth(params: {
    provider: "github" | "google";
    options: { redirectTo: string; skipBrowserRedirect?: boolean };
  }): Promise<{
    data: { url: string | null; flowId: string | null };
    error: Error | null;
  }>;
  exchangeCodeForSession(
    code: string,
    options?: { flowId?: string },
  ): Promise<{
    data: { session: WebAccountSession | null };
    error: Error | null;
  }>;
  onAuthStateChange(listener: AuthChangeListener): {
    data: { subscription: { unsubscribe(): void } };
  };
}

export interface WebAccountClient {
  auth: WebAccountAuth;
}

function accountConfig(): { supabaseUrl: string; anonKey: string } {
  const configured =
    typeof window !== "undefined"
      ? window.__LINKSHELL_CONFIG__?.account
      : undefined;
  return {
    supabaseUrl: (configured?.url ?? CORE_URL).replace(/\/+$/, ""),
    anonKey: configured?.anonKey ?? CORE_PUBLIC_KEY,
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
  const access_token =
    typeof obj.access_token === "string" ? obj.access_token : "";
  const refresh_token =
    typeof obj.refresh_token === "string" ? obj.refresh_token : "";
  const user =
    obj.user && typeof obj.user === "object"
      ? (obj.user as WebAccountUser)
      : null;
  if (!access_token || !refresh_token || !user?.id) return null;
  const expires_in =
    typeof obj.expires_in === "number" ? obj.expires_in : 3600;
  const expires_at =
    typeof obj.expires_at === "number"
      ? obj.expires_at
      : decodeJwtExp(access_token) ||
        Math.floor(Date.now() / 1000) + expires_in;
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
    const raw = window.localStorage.getItem(WEB_ACCOUNT_STORAGE_KEY);
    if (!raw) return null;
    return normalizeSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeStoredSession(session: WebAccountSession | null): void {
  try {
    if (session) {
      window.localStorage.setItem(
        WEB_ACCOUNT_STORAGE_KEY,
        JSON.stringify(session),
      );
    } else {
      window.localStorage.removeItem(WEB_ACCOUNT_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable
  }
}

function errorFromPayload(status: number, payload: unknown): Error {
  const obj =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const inner =
    obj?.error && typeof obj.error === "object"
      ? (obj.error as Record<string, unknown>)
      : null;
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

async function createPkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  let verifier = "";
  for (let i = 0; i < bytes.length; i += 1) {
    verifier += alphabet[bytes[i]! % alphabet.length]!;
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  let binary = "";
  for (let i = 0; i < digest.length; i += 1) {
    binary += String.fromCharCode(digest[i]!);
  }
  const challenge = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

function createCoreWebClient(baseUrl: string): WebAccountClient {
  const listeners = new Set<AuthChangeListener>();
  const verifiers = new Map<string, string>();
  let inFlightRefresh: Promise<{
    data: { session: WebAccountSession | null };
    error: Error | null;
  }> | null = null;

  const emit = (event: string, session: WebAccountSession | null) => {
    for (const listener of listeners) {
      try {
        listener(event, session);
      } catch {
        // Ignore subscriber errors
      }
    }
  };

  if (
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function"
  ) {
    window.addEventListener("storage", (event) => {
      if (event.key !== WEB_ACCOUNT_STORAGE_KEY) return;
      const next = readStoredSession();
      emit(next ? "SIGNED_IN" : "SIGNED_OUT", next);
    });
  }

  const timedFetch = (path: string, init: RequestInit) => {
    const signal = init.signal;
    return fetch(`${baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(30_000),
      ]),
    });
  };

  const runExclusiveRefresh = async <T>(work: () => Promise<T>): Promise<T> => {
    const locks =
      typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks?.request) {
      return locks.request("linkshell.web.account.refresh", () => work());
    }
    return work();
  };

  const refreshSession = async (): Promise<{
    data: { session: WebAccountSession | null };
    error: Error | null;
  }> => {
    if (inFlightRefresh) return inFlightRefresh;
    inFlightRefresh = runExclusiveRefresh(async () => {
      const current = readStoredSession();
      if (!current?.refresh_token) {
        return {
          data: { session: null },
          error: new Error("登录已失效，请重新登录"),
        };
      }
      // Another tab may have already rotated the token while we waited for the lock.
      if (current.expires_at * 1000 > Date.now() + 120_000) {
        return { data: { session: current }, error: null };
      }
      try {
        const res = await timedFetch("/auth/v1/token?grant_type=refresh_token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: current.refresh_token }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const latest = readStoredSession();
          if (
            latest &&
            latest.user.id === current.user.id &&
            latest.refresh_token !== current.refresh_token
          ) {
            emit("TOKEN_REFRESHED", latest);
            return { data: { session: latest }, error: null };
          }
          if (res.status === 400 || res.status === 401) {
            if (latest?.refresh_token === current.refresh_token) {
              writeStoredSession(null);
              emit("SIGNED_OUT", null);
            }
          }
          return {
            data: { session: null },
            error: errorFromPayload(res.status, body),
          };
        }
        const next = normalizeSession(body);
        if (!next) {
          return {
            data: { session: null },
            error: new Error("会话刷新失败，请重试"),
          };
        }
        const latest = readStoredSession();
        if (
          !latest ||
          latest.user.id !== current.user.id ||
          next.user.id !== current.user.id
        ) {
          return {
            data: { session: null },
            error: new Error("账号状态已更新，请重试"),
          };
        }
        if (latest.refresh_token !== current.refresh_token) {
          emit("TOKEN_REFRESHED", latest);
          return { data: { session: latest }, error: null };
        }
        writeStoredSession(next);
        emit("TOKEN_REFRESHED", next);
        return { data: { session: next }, error: null };
      } catch (error) {
        const latest = readStoredSession();
        if (
          latest &&
          latest.user.id === current.user.id &&
          latest.refresh_token !== current.refresh_token
        ) {
          emit("TOKEN_REFRESHED", latest);
          return { data: { session: latest }, error: null };
        }
        return {
          data: { session: null },
          error:
            error instanceof Error ? error : new Error("网络异常，请重试"),
        };
      }
    }).finally(() => {
      inFlightRefresh = null;
    });
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
          if (!res.ok) {
            return {
              data: { session: null },
              error: errorFromPayload(res.status, body),
            };
          }
          const session = normalizeSession(body);
          if (!session) {
            return {
              data: { session: null },
              error: new Error("登录未完成，请重试"),
            };
          }
          writeStoredSession(session);
          emit("SIGNED_IN", session);
          return { data: { session }, error: null };
        } catch (error) {
          return {
            data: { session: null },
            error:
              error instanceof Error ? error : new Error("网络异常，请重试"),
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
          data: {
            url: `${baseUrl}/auth/v1/authorize?${params.toString()}`,
            flowId,
          },
          error: null,
        };
      },

      async exchangeCodeForSession(code, options) {
        const flowId = options?.flowId;
        const verifier = flowId ? verifiers.get(flowId) : undefined;
        if (flowId) verifiers.delete(flowId);
        if (!verifier) {
          return {
            data: { session: null },
            error: new Error("无法验证登录请求，请重试。"),
          };
        }
        try {
          const res = await timedFetch("/auth/v1/token?grant_type=pkce", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok) {
            return {
              data: { session: null },
              error: errorFromPayload(res.status, body),
            };
          }
          const session = normalizeSession(body);
          if (!session) {
            return {
              data: { session: null },
              error: new Error("登录未完成，请重试。"),
            };
          }
          writeStoredSession(session);
          emit("SIGNED_IN", session);
          return { data: { session }, error: null };
        } catch (error) {
          return {
            data: { session: null },
            error:
              error instanceof Error ? error : new Error("网络异常，请重试"),
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

let cachedClient: { url: string; instance: WebAccountClient } | undefined;

export function accountClient(): WebAccountClient {
  const { supabaseUrl } = accountConfig();
  if (!cachedClient || cachedClient.url !== supabaseUrl) {
    cachedClient = {
      url: supabaseUrl,
      instance: createCoreWebClient(supabaseUrl),
    };
  }
  return cachedClient.instance;
}

export function resetWebAccountClientForTests(): void {
  cachedClient = undefined;
}

function assertAccount(userId: string | undefined, expectedUserId: string): void {
  if (!userId) throw new Error("登录已失效，请重新登录");
  if (userId !== expectedUserId) {
    throw new Error("账号已切换，请在当前账户下重新操作");
  }
}

export async function accountToken(
  expectedUserId?: string,
): Promise<string | undefined> {
  const auth = accountClient().auth;
  const { data, error } = await auth.getSession();
  if (error) throw error;
  if (expectedUserId !== undefined) {
    assertAccount(data.session?.user.id, expectedUserId);
  }
  if (!data.session) return undefined;
  if ((data.session.expires_at ?? 0) * 1000 > Date.now() + 120_000) {
    return data.session.access_token;
  }
  const next = await auth.refreshSession();
  if (next.error) throw next.error;
  if (!next.data.session) throw new Error("登录已失效，请重新登录");
  if (expectedUserId !== undefined) {
    assertAccount(next.data.session.user.id, expectedUserId);
  }
  return next.data.session.access_token;
}

async function currentAccountSession(
  expectedUserId: string,
): Promise<WebAccountSession> {
  const { data, error } = await accountClient().auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("登录已失效，请重新登录");
  assertAccount(data.session.user.id, expectedUserId);
  return data.session;
}

async function boundAccountToken(expectedUserId: string): Promise<string> {
  const accessToken = await accountToken(expectedUserId);
  const session = await currentAccountSession(expectedUserId);
  if (!accessToken || session.access_token !== accessToken) {
    throw new Error("账号状态已更新，请重试");
  }
  return accessToken;
}

export async function accountMembership(
  expectedUserId: string,
): Promise<ProMembership> {
  const accessToken = await boundAccountToken(expectedUserId);
  const membership = await fetchProMembership({
    ...accountConfig(),
    accessToken,
    userId: expectedUserId,
  });
  await currentAccountSession(expectedUserId);
  return membership;
}

export async function accountReferral(
  expectedUserId: string,
  locale?: Locale,
): Promise<ReferralSummary> {
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

type OAuthResult = { type: "result"; code?: string; error?: string };

function callbackURL(): string {
  const url = new URL(window.location.origin);
  // Reuse the project's existing loopback allowlist for local browser verification.
  if (url.hostname === "127.0.0.1") url.pathname = "/linkshell/callback";
  else url.searchParams.set(CALLBACK_PARAM, "1");
  return url.href;
}

function panel(target: Window, message: string): void {
  target.document.title = "LinkShell 登录";
  const main = target.document.createElement("main");
  main.style.cssText =
    "max-width:400px;margin:18vh auto;padding:32px;font:14px system-ui;line-height:1.65";
  const title = target.document.createElement("h1");
  title.textContent = "LinkShell 登录";
  const text = target.document.createElement("p");
  text.textContent = message;
  const close = target.document.createElement("button");
  close.textContent = "关闭窗口";
  close.style.cssText =
    "height:32px;padding:0 12px;border-radius:6px;cursor:pointer";
  close.onclick = () => target.close();
  main.append(title, text, close);
  target.document.body.replaceChildren(main);
}

/** Call inside the click handler, before awaiting any connection or authentication work. */
export async function signInWithAccountOAuth(
  auth: WebAccountAuth,
  provider: "github" | "google",
  options: {
    signal: AbortSignal;
    onAuthorizeUrl?: (url: string) => void;
    onExchanging?: () => void;
  },
): Promise<void> {
  if (options.signal.aborted) throw new Error("已取消登录");
  if (typeof BroadcastChannel === "undefined") {
    throw new Error("此浏览器不支持登录窗口，请升级浏览器或使用邮箱登录。");
  }
  const popup = window.open(
    "about:blank",
    "_blank",
    "popup,width=520,height=720",
  );
  if (!popup) {
    throw new Error("登录窗口被浏览器拦截，请允许弹出窗口后重试。");
  }
  const requestId = crypto.randomUUID();
  let channel: BroadcastChannel;
  try {
    // This storage belongs to the popup's origin and survives the provider round trip.
    // The URL stays fixed so production can allow precisely one callback, without wildcards.
    popup.sessionStorage.setItem(POPUP_REQUEST_KEY, requestId);
    popup.opener = null;
    panel(
      popup,
      `正在打开 ${provider === "google" ? "Google" : "GitHub"} 登录…`,
    );
    channel = new BroadcastChannel(`linkshell.oauth.${requestId}`);
  } catch (error) {
    popup.close();
    throw error;
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let exchanging = false;
    let flowId: string | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", cancel);
      channel.close();
      popup.close();
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => {
      // Code exchange persists the session; it cannot be undone by aborting UI work.
      if (!exchanging) finish(new Error("已取消登录"));
    };
    const timeout = setTimeout(
      () => finish(new Error("等待登录超时，请重试。")),
      LOGIN_TIMEOUT,
    );
    // COOP can make a live provider popup report closed. Only cancellation, a callback or
    // the deadline ends the wait; BroadcastChannel still works after that isolation change.
    options.signal.addEventListener("abort", cancel, { once: true });
    channel.onmessage = (event: MessageEvent<OAuthResult>) => {
      const result = event.data;
      if (settled || exchanging || !result || result.type !== "result") return;
      if (typeof result.error === "string") {
        channel.postMessage({ type: "received" });
        finish(new Error(result.error));
        return;
      }
      if (typeof result.code !== "string" || !result.code || !flowId) return;
      exchanging = true;
      clearTimeout(timeout);
      channel.postMessage({ type: "received" });
      options.onExchanging?.();
      void auth.exchangeCodeForSession(result.code, { flowId }).then(
        ({ data, error }) => {
          if (error) finish(error);
          else if (!data.session) finish(new Error("登录未完成，请重试。"));
          else finish();
        },
        finish,
      );
    };
    void auth
      .signInWithOAuth({
        provider,
        options: {
          redirectTo: callbackURL(),
          skipBrowserRedirect: true,
        },
      })
      .then(({ data, error }) => {
        if (settled) return;
        if (error) {
          finish(error);
          return;
        }
        if (!data.url) {
          finish(new Error("无法打开登录页面，请重试。"));
          return;
        }
        if (!data.flowId) {
          finish(new Error("无法验证登录请求，请重试。"));
          return;
        }
        flowId = data.flowId;
        options.onAuthorizeUrl?.(data.url);
        popup.location.replace(data.url);
      })
      .catch(finish);
  });
}

/** Run before the workspace boots: the popup must never claim its connection or exchange PKCE. */
export function handleAccountOAuthCallback(): boolean {
  if (typeof window === "undefined" || !window.location?.href) return false;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return false;
  }
  const officialCallback =
    url.pathname === "/" && url.searchParams.get(CALLBACK_PARAM) === "1";
  const localCallback =
    url.hostname === "127.0.0.1" && url.pathname === "/linkshell/callback";
  if (!officialCallback && !localCallback) return false;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error") ?? fragment.get("error");
  // No authorization code or provider error remains in the address bar or referrer.
  window.history.replaceState(null, "", "/");
  const requestId = window.sessionStorage.getItem(POPUP_REQUEST_KEY);
  window.sessionStorage.removeItem(POPUP_REQUEST_KEY);
  if (
    !requestId ||
    !/^[0-9a-f-]{36}$/.test(requestId) ||
    typeof BroadcastChannel === "undefined"
  ) {
    panel(window, "登录请求已失效，请关闭此窗口，返回工作台重试。");
    return true;
  }
  const channel = new BroadcastChannel(`linkshell.oauth.${requestId}`);
  panel(window, "正在返回工作台…");
  const timeout = setTimeout(() => {
    channel.close();
    panel(window, "工作台未响应，请关闭此窗口，返回工作台重新登录。");
  }, 10_000);
  channel.onmessage = (event: MessageEvent) => {
    if ((event.data as { type?: string } | undefined)?.type !== "received") {
      return;
    }
    clearTimeout(timeout);
    channel.close();
    panel(window, "已返回工作台，可以关闭此窗口。");
    window.close();
  };
  const result: OAuthResult = error
    ? {
        type: "result",
        error:
          error === "access_denied"
            ? "登录已取消，请重试。"
            : "登录未完成，请重试。",
      }
    : code
      ? { type: "result", code }
      : { type: "result", error: "登录回调不完整，请重试。" };
  channel.postMessage(result);
  return true;
}
