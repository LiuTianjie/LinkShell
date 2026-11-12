import type { GatewayOptions } from "./relay.js";

// The official gateway is part of the iTool membership: any active member (monthly or yearly)
// has LinkShell. The gateway asks iTool's `itool_entitlement_for(uid, 'linkshell')` with the
// service-role key, on its own behalf, not with the user's token.

// Locale-neutral www URL: itool.tech routes /pro to /zh/pro or /en/pro from the browser's locale.
export const MEMBERSHIP_URL = "https://www.itool.tech/pro?from=linkshell";

export type GatewayLocale = "zh" | "en" | "ja";
export type AdmissionDenialCode = "login_required" | "membership_required" | "temporarily_unavailable";

export const LOGIN_REQUIRED_CODE: AdmissionDenialCode = "login_required";
export const MEMBERSHIP_REQUIRED_CODE: AdmissionDenialCode = "membership_required";

export function membershipUrl(locale?: GatewayLocale): string {
  if (locale === "zh") return "https://www.itool.tech/zh/pro?from=linkshell";
  if (locale === "en" || locale === "ja") return "https://www.itool.tech/en/pro?from=linkshell";
  return MEMBERSHIP_URL;
}

export function admissionDenialMessage(code: AdmissionDenialCode, locale?: GatewayLocale): string {
  const url = membershipUrl(locale);
  switch (code) {
    case "login_required":
      if (locale === "zh") return "官方网关需要登录账号（新账号注册享 7 天免费试用）：在电脑上运行 linkshell login";
      if (locale === "en") return "Official gateway requires sign-in (new accounts include a 7-day free trial): run linkshell login";
      if (locale === "ja") return "公式ゲートウェイの利用にはログインが必要です（新規登録で 7 日間無料トライアル）：PC で linkshell login を実行してください";
      return "官方网关需要登录账号（新账号注册享 7 天免费试用）：在电脑上运行 linkshell login · Official gateway requires sign-in (new accounts include a 7-day free trial): run linkshell login";
    case "membership_required":
      if (locale === "zh") return `官方网关需要 iTool 会员（新账号注册享 7 天免费试用）：${url}`;
      if (locale === "en") return `Official gateway requires an iTool membership (new accounts include a 7-day free trial): ${url}`;
      if (locale === "ja") return `公式ゲートウェイには iTool メンバーシップが必要です（新規アカウントは 7 日間無料トライアル付き）：${url}`;
      return `官方网关需要 iTool 会员（新账号注册享 7 天免费试用）：${url} · Official gateway requires an iTool membership (7-day free trial on new accounts)`;
    case "temporarily_unavailable":
      if (locale === "zh") return "暂时无法验证 iTool 会员，请稍后重试";
      if (locale === "en") return "Unable to verify iTool membership right now; please try again shortly";
      if (locale === "ja") return "現在 iTool メンバーシップを確認できません。しばらくしてから再度お試しください";
      return "暂时无法验证 iTool 会员，请稍后重试 · Unable to verify iTool membership right now; please try again shortly";
  }
}

export interface SubscriptionCheck {
  /** "unknown": the lookup itself failed, which says nothing about the account. */
  status: "active" | "inactive" | "unknown";
  reason?: string;
}

export type CheckSubscription = (userId: string) => Promise<SubscriptionCheck>;

/** The RPC's jsonb answer, as the gateway reads it. */
export function subscriptionFromEntitlement(value: unknown): SubscriptionCheck {
  const body = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!body) return { status: "unknown", reason: "entitlement_malformed" };
  if (body.ok !== true) return { status: "unknown", reason: `entitlement_${typeof body.code === "string" ? body.code : "refused"}` };
  if (typeof body.active !== "boolean") return { status: "unknown", reason: "entitlement_malformed" };
  return { status: body.active ? "active" : "inactive" };
}

export function supabaseSubscriptions(supabase: { url: string; anonKey: string; serviceRoleKey: string }): CheckSubscription {
  return async (userId) => {
    if (!supabase.url || !supabase.anonKey) return { status: "unknown", reason: "missing_supabase_config" };
    if (!supabase.serviceRoleKey) return { status: "unknown", reason: "missing_service_role_key" };
    try {
      const response = await fetch(`${supabase.url.replace(/\/$/, "")}/rest/v1/rpc/itool_entitlement_for`, {
        method: "POST",
        headers: { Authorization: `Bearer ${supabase.serviceRoleKey}`, apikey: supabase.anonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ p_user: userId, p_product: "linkshell" }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { status: "unknown", reason: `entitlement_lookup_http_${response.status}` };
      return subscriptionFromEntitlement(await response.json());
    } catch {
      return { status: "unknown", reason: "entitlement_lookup_failed" };
    }
  };
}

/**
 * The official gateway's rule for who may connect: a computer needs an active
 * iTool membership. Devices only reach computers they're paired with or share an
 * account with, so they need nothing more.
 */
export function requirePro(
  check: CheckSubscription,
  warn: (message: string) => void,
  options: { enforceGrace?: boolean; cacheMs?: number; graceMs?: number; now?: () => number; locale?: GatewayLocale } = {},
): NonNullable<GatewayOptions["admit"]> {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 60_000;
  const graceMs = options.graceMs ?? 60 * 60_000;
  const startedAt = now();
  let pruneAt = startedAt + graceMs;
  const accounts = new Map<string, {
    checkedAt: number;
    result?: SubscriptionCheck;
    lastKnown?: "active" | "inactive";
    graceFrom?: number;
    pending?: Promise<SubscriptionCheck>;
  }>();
  return async ({ role, userId }) => {
    if (role !== "machine") return undefined;
    if (!userId) return admissionDenialMessage(LOGIN_REQUIRED_CODE, options.locale);
    // Roll out revalidation explicitly; a code upgrade alone must preserve the
    // existing admission behavior during a Supabase/network incident.
    if (!options.enforceGrace) {
      const subscription = await check(userId);
      if (subscription.status === "inactive") return admissionDenialMessage(MEMBERSHIP_REQUIRED_CODE, options.locale);
      if (subscription.status === "unknown") warn(`subscription check unavailable (${subscription.reason}); admitting ${userId}`);
      return undefined;
    }
    if (now() >= pruneAt) {
      for (const [id, entry] of accounts) {
        if (!entry.pending && now() - entry.checkedAt >= graceMs && (entry.graceFrom === undefined || now() - entry.graceFrom >= graceMs)) accounts.delete(id);
      }
      pruneAt = now() + Math.max(1, Math.min(graceMs, 60_000));
    }
    let account = accounts.get(userId);
    if (!account) {
      account = { checkedAt: -Infinity };
      accounts.set(userId, account);
    }
    if (!account.result || now() - account.checkedAt >= cacheMs) {
      const entry = account;
      // A computer's connection, periodic check and TURN request can arrive together.
      entry.pending ??= check(userId).catch((): SubscriptionCheck => ({ status: "unknown", reason: "entitlement_lookup_failed" }))
        .then((result) => {
          entry.checkedAt = now();
          entry.result = result;
          if (result.status !== "unknown") {
            entry.lastKnown = result.status;
            entry.graceFrom = result.status === "active" ? entry.checkedAt : undefined;
          } else {
            // A fresh gateway also tolerates a brief outage. Repeated failures must not
            // restart this window, or reconnecting would grant membership forever.
            // Bootstrap grace belongs to this gateway start, not each new cache entry.
            // This also makes pruning idle accounts safe: an unknown result cannot
            // regain grace after a known-expired account's entry has been evicted.
            entry.graceFrom ??= startedAt;
            warn(`subscription check unavailable (${result.reason}); ${entry.lastKnown !== "inactive" && now() - entry.graceFrom < graceMs ? "admitting" : "refusing"} ${userId}`);
          }
          return result;
        }).finally(() => { entry.pending = undefined; });
      await entry.pending;
    }
    if (account.result?.status === "active") return undefined;
    if (account.result?.status === "inactive" || account.lastKnown === "inactive") {
      return admissionDenialMessage(MEMBERSHIP_REQUIRED_CODE, options.locale);
    }
    if (account.graceFrom !== undefined && now() - account.graceFrom < graceMs) return undefined;
    return admissionDenialMessage("temporarily_unavailable", options.locale);
  };
}
