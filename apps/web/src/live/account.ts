import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchProMembership, redeemProCode } from "@linkshell/client-core";
import { desktopAccount, isDesktop } from "./desktop";

// The same public Supabase project as the CLI and mobile app.
const SUPABASE_URL = "https://mkbeusztkzffnzjdwmqk.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rYmV1c3p0a3pmZm56amR3bXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5Nzc0NzgsImV4cCI6MjA4MTU1MzQ3OH0.2wlT6q6687Z5rpEYsdp01IQpNNl_XWv0IAfBgwPyDP0";

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

export async function redeemAccountProCode(
  expectedUserId: string,
  code: string,
) {
  const accessToken = await boundAccountToken(expectedUserId);
  const redemption = await redeemProCode(accessToken, code);
  await currentAccountSession(expectedUserId);
  return redemption;
}
