import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchProMembership, fetchReferralSummary, type Locale } from "@linkshell/client-core";
import { desktopAccount, isDesktop } from "./desktop";

// Unified iTool Core account backend (shared with iTool, CLI, desktop, and mobile).
const SUPABASE_URL = "https://api.itool.tech";
const SUPABASE_ANON_KEY = "itool-core";

let client: SupabaseClient | undefined;
function accountConfig() {
  return {
    supabaseUrl: window.__LINKSHELL_CONFIG__?.account?.url ?? SUPABASE_URL,
    anonKey: window.__LINKSHELL_CONFIG__?.account?.anonKey ?? SUPABASE_ANON_KEY,
  };
}
export function accountClient() {
  if (isDesktop) throw new Error("桌面端使用 LinkShell 的系统浏览器登录");
  const { supabaseUrl, anonKey } = accountConfig();
  return (client ??= createClient(supabaseUrl, anonKey, {
    global: {
      fetch: (input, init) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        return fetch(input, {
          ...init,
          // Abort the request itself: an abandoned PKCE exchange must not sign in later.
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
        });
      },
    },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // The dedicated popup returns only its code; the initiating tab owns the PKCE verifier.
      detectSessionInUrl: false,
      flowType: "pkce",
      storageKey: "linkshell.web.account.v2",
    },
  }));
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
