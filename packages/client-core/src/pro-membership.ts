/**
 * LinkShell is part of the iTool membership: the monthly tier (iTool site + LinkShell) and the
 * yearly tier (every iTool product) both include it. Membership is bought on itool.tech only;
 * clients just read the entitlement and send people to the buy page on desktop/web.
 */

import type { Locale } from "./i18n.js";

export type MembershipTier = "monthly" | "yearly";

export interface ProMembership {
  /** "pro": this account may use LinkShell's paid parts (the official gateway) right now. */
  plan: "free" | "pro";
  /** Which iTool membership grants it; absent when `plan` is "free". */
  tier?: MembershipTier;
  /** When LinkShell's entitlement ends; absent when `plan` is "free". */
  expiresAt?: string;
  /** True when the active entitlement comes from the 7-day sign-up trial rather than a paid order. */
  isTrial?: boolean;
  /** When the 7-day sign-up trial ends (ISO 8601), when reported by the backend. */
  trialEndsAt?: string;
  /** Whole days remaining until `expiresAt` relative to `server_time` (at least 1 while active). */
  daysRemaining?: number;
}

export interface ProMembershipOptions {
  accessToken: string;
  /** Kept for callers that pass it; the entitlement is read for the token's own user. */
  userId?: string;
  /** With both, the Supabase RPC is tried when itool.tech can't be reached. */
  supabaseUrl?: string;
  anonKey?: string;
  /** "supabase" skips itool.tech; "itool" (the default) prefers it. */
  prefer?: "itool" | "supabase";
  signal?: AbortSignal;
}

export interface ReferralSummary {
  code: string;
  invited: number;
  rewarded: number;
  earnedDays: number;
  shareUrl: string;
}

export interface ReferralOptions extends ProMembershipOptions {
  locale?: Locale;
}

export const LINKSHELL_PRODUCT = "linkshell";
export const TRIAL_DAYS = 7;
export const REFERRAL_MONTHLY_DAYS = 14;
export const REFERRAL_YEARLY_DAYS = 30;

/**
 * Locale-aware membership purchase URL for Desktop & Web (phones must NEVER link to it per App Store 3.1.1).
 * `zh` routes to `/zh/pro?from=linkshell`; `en` and `ja` route to `/en/pro?from=linkshell`.
 */
export function itoolMembershipUrl(locale: Locale = "zh"): string {
  const prefix = locale === "zh" ? "zh" : "en";
  return `https://www.itool.tech/${prefix}/pro?from=${LINKSHELL_PRODUCT}`;
}

export function itoolYearlyUpgradeUrl(locale: Locale = "zh"): string {
  return `${itoolMembershipUrl(locale)}&checkout=yearly`;
}

/**
 * Backward-compatible default URLs (Chinese locale, matching existing desktop callers).
 * Phones must not link to these (App Store rules).
 * The entitlement & referral APIs stay on the bare domain so no cross-host redirect drops Bearer tokens.
 */
export const ITOOL_MEMBERSHIP_URL = "https://www.itool.tech/zh/pro?from=linkshell";
export const ITOOL_ENTITLEMENT_URL = `https://itool.tech/api/membership/entitlement?product=${LINKSHELL_PRODUCT}`;
export const ITOOL_REFERRAL_URL = "https://itool.tech/api/membership/referral";

/**
 * iTool products a membership can unlock: yearly unlocks all of them, monthly the iTool site and LinkShell.
 * Mirrors itool-tech src/lib/membership.ts MEMBERSHIP_PRODUCTS: change them when it changes.
 */
export const MEMBERSHIP_PRODUCT_TOTAL = 7;
export const MONTHLY_PRODUCT_COUNT = 2;

/**
 * For monthly members: with `checkout=yearly`, itool.tech opens the yearly checkout once the
 * person is signed in. Like the buy page, phones must not link to it (App Store rules).
 * apps/mac mirrors this and the counts in `DesktopModel.swift` (`ITool`).
 */
export const ITOOL_YEARLY_UPGRADE_URL = `${ITOOL_MEMBERSHIP_URL}&checkout=yearly`;

/** The upgrade row monthly members see on the computer: what they have, and the way to the rest. */
export const MONTHLY_UPGRADE_COPY = {
  zh: { unlocked: `已解锁 ${MONTHLY_PRODUCT_COUNT}/${MEMBERSHIP_PRODUCT_TOTAL} 款产品`, action: "升级年度" },
  en: { unlocked: `${MONTHLY_PRODUCT_COUNT} of ${MEMBERSHIP_PRODUCT_TOTAL} products unlocked`, action: "Go yearly" },
  ja: { unlocked: `${MEMBERSHIP_PRODUCT_TOTAL} 製品中 ${MONTHLY_PRODUCT_COUNT} 製品が利用可能`, action: "年額プランへ" },
} as const;

export function monthlyUpgradeLabel(lang: keyof typeof MONTHLY_UPGRADE_COPY = "zh"): string {
  const copy = MONTHLY_UPGRADE_COPY[lang] ?? MONTHLY_UPGRADE_COPY.en;
  return `${copy.unlocked} · ${copy.action}`;
}

const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_REQUIRED = "登录已失效，请重新登录后再试";
const MALFORMED = "会员状态返回异常，请稍后重试";
const REFERRAL_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

/**
 * Why a lookup failed. `login` means the token is no good; `unavailable` and `network` say
 * nothing about the account, so callers keep what they last knew.
 */
export class MembershipError extends Error {
  constructor(message: string, readonly kind: "login" | "unavailable" | "network" | "malformed") {
    super(message);
    this.name = "MembershipError";
  }
}

export interface MembershipTierLabelOptions {
  isTrial?: boolean;
  daysRemaining?: number;
  locale?: Locale;
}

export function membershipTierLabel(
  tier: MembershipTier | undefined,
  opts?: MembershipTierLabelOptions,
): string {
  const locale: Locale = opts?.locale ?? "zh";
  if (opts?.isTrial) {
    const days = typeof opts.daysRemaining === "number" && Number.isFinite(opts.daysRemaining)
      ? Math.max(0, Math.ceil(opts.daysRemaining))
      : undefined;
    if (locale === "en") {
      return days !== undefined ? `7-day free trial · ${days}d left` : "7-day free trial";
    }
    if (locale === "ja") {
      return days !== undefined ? `7日間無料トライアル · 残り ${days} 日` : "7日間無料トライアル";
    }
    return days !== undefined ? `7 天免费试用 · 剩余 ${days} 天` : "7 天免费试用";
  }

  if (locale === "en") {
    return tier === "yearly" ? "iTool Yearly" : tier === "monthly" ? "iTool Monthly" : "iTool Membership";
  }
  if (locale === "ja") {
    return tier === "yearly" ? "iTool 年額プラン" : tier === "monthly" ? "iTool 月額プラン" : "iTool メンバーシップ";
  }
  return tier === "yearly" ? "iTool 年度会员" : tier === "monthly" ? "iTool 月度会员" : "iTool 会员";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

/**
 * The result of `itool_entitlement('linkshell')`, through either route, as LinkShell shows it.
 * `active` is the server's answer; an expiry already past the server's clock still reads as
 * free so a stale row can't grant anything.
 */
export function membershipFromEntitlement(value: unknown): ProMembership {
  const body = record(value);
  if (!body) throw new MembershipError(MALFORMED, "malformed");
  if (body.ok !== true) {
    if (body.code === "login_required") throw new MembershipError(LOGIN_REQUIRED, "login");
    throw new MembershipError(MALFORMED, "malformed");
  }
  if (body.product !== undefined && body.product !== LINKSHELL_PRODUCT) throw new MembershipError(MALFORMED, "malformed");
  if (typeof body.active !== "boolean") throw new MembershipError(MALFORMED, "malformed");
  if (!body.active) return { plan: "free" };
  const until = timestamp(body.valid_until);
  if (!Number.isFinite(until)) throw new MembershipError(MALFORMED, "malformed");
  const serverTime = timestamp(body.server_time);
  const nowMs = Number.isFinite(serverTime) ? serverTime : Date.now();
  if (until <= nowMs) return { plan: "free" };

  const tier: MembershipTier = body.tier === "yearly" ? "yearly" : "monthly";
  const daysRemaining = Math.max(1, Math.ceil((until - nowMs) / 86_400_000));
  const result: ProMembership = {
    plan: "pro",
    tier,
    expiresAt: body.valid_until as string,
    daysRemaining,
  };
  if (typeof body.is_trial === "boolean") {
    result.isTrial = body.is_trial;
  }
  if (typeof body.trial_ends_at === "string" && Number.isFinite(timestamp(body.trial_ends_at))) {
    result.trialEndsAt = body.trial_ends_at;
  }
  return result;
}

export function referralShareUrl(code: string, locale?: Locale): string {
  const normalized = code.trim().toUpperCase();
  if (locale) {
    return `${itoolMembershipUrl(locale)}&ref=${encodeURIComponent(normalized)}`;
  }
  return `https://www.itool.tech/pro?from=${LINKSHELL_PRODUCT}&ref=${encodeURIComponent(normalized)}`;
}

export function referralFromResponse(value: unknown, locale?: Locale): ReferralSummary {
  const body = record(value);
  if (!body) throw new MembershipError(MALFORMED, "malformed");
  if (body.ok !== true) {
    if (body.code === "login_required") throw new MembershipError(LOGIN_REQUIRED, "login");
    throw new MembershipError(MALFORMED, "malformed");
  }
  const rawCode = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!REFERRAL_CODE_PATTERN.test(rawCode)) {
    throw new MembershipError(MALFORMED, "malformed");
  }
  const nonNegativeInt = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const invited = nonNegativeInt(body.invited);
  const rewarded = nonNegativeInt(body.rewarded);
  const earnedDays = nonNegativeInt(body.earned_days ?? body.earnedDays);
  const shareUrl = typeof body.shareUrl === "string" && body.shareUrl.startsWith("https://")
    ? body.shareUrl
    : referralShareUrl(rawCode, locale);
  return {
    code: rawCode,
    invited,
    rewarded,
    earnedDays,
    shareUrl,
  };
}

async function request(url: string, init: RequestInit): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const response = await fetch(url, { ...init, credentials: "omit", signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (controller.signal.aborted || !(error instanceof SyntaxError)) throw error;
    }
    return { response, body };
  } catch {
    throw new MembershipError(controller.signal.aborted ? "请求超时，请稍后重试" : "网络连接失败，请检查网络后重试", "network");
  } finally {
    clearTimeout(timer);
  }
}

function checkStatus(response: Response): void {
  if (response.status === 401 || response.status === 403) throw new MembershipError(LOGIN_REQUIRED, "login");
  if (response.status === 502 || response.status === 503) throw new MembershipError("会员服务暂时不可用，请稍后重试", "unavailable");
  if (!response.ok) throw new MembershipError("暂时无法获取会员状态，请稍后重试", "unavailable");
}

async function withFallback<T>(
  options: ProMembershipOptions,
  viaItoolFn: () => Promise<T>,
  viaSupabaseFn?: () => Promise<T>,
): Promise<T> {
  if (!options.accessToken.trim()) throw new MembershipError(LOGIN_REQUIRED, "login");
  const [first, second] = options.prefer === "supabase" && viaSupabaseFn
    ? [viaSupabaseFn, viaItoolFn]
    : [viaItoolFn, viaSupabaseFn];
  try {
    return await first();
  } catch (error) {
    // Only an unreachable route earns a second try: a refused token or a real answer stands.
    if (!second || options.signal?.aborted || !(error instanceof MembershipError) || (error.kind !== "network" && error.kind !== "unavailable")) {
      throw error;
    }
    try {
      return await second();
    } catch {
      throw error;
    }
  }
}

/** itool.tech's route: reachable from networks where supabase.co is not. */
async function viaItool(options: ProMembershipOptions): Promise<ProMembership> {
  const { response, body } = await request(ITOOL_ENTITLEMENT_URL, {
    headers: { Authorization: `Bearer ${options.accessToken}` },
    signal: options.signal,
  });
  checkStatus(response);
  return membershipFromEntitlement(body);
}

async function viaSupabase(options: ProMembershipOptions & { supabaseUrl: string; anonKey: string }): Promise<ProMembership> {
  const { response, body } = await request(`${options.supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/itool_entitlement`, {
    method: "POST",
    headers: { apikey: options.anonKey, Authorization: `Bearer ${options.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_product: LINKSHELL_PRODUCT }),
    signal: options.signal,
  });
  checkStatus(response);
  return membershipFromEntitlement(body);
}

/** The entitlement is read with the user's own token; only the server can grant it. */
export async function fetchProMembership(options: ProMembershipOptions): Promise<ProMembership> {
  const supabase = options.supabaseUrl && options.anonKey
    ? { ...options, supabaseUrl: options.supabaseUrl, anonKey: options.anonKey }
    : undefined;
  return withFallback(
    options,
    () => viaItool(options),
    supabase ? () => viaSupabase(supabase) : undefined,
  );
}

async function referralViaItool(options: ReferralOptions): Promise<ReferralSummary> {
  const { response, body } = await request(ITOOL_REFERRAL_URL, {
    headers: { Authorization: `Bearer ${options.accessToken}` },
    signal: options.signal,
  });
  checkStatus(response);
  return referralFromResponse(body, options.locale);
}

async function referralViaSupabase(options: ReferralOptions & { supabaseUrl: string; anonKey: string }): Promise<ReferralSummary> {
  const { response, body } = await request(`${options.supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/itool_my_referral`, {
    method: "POST",
    headers: { apikey: options.anonKey, Authorization: `Bearer ${options.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal: options.signal,
  });
  checkStatus(response);
  return referralFromResponse(body, options.locale);
}

/**
 * Reads (or lazily creates) the signed-in user's 8-character invite code and earned reward days,
 * trying `https://itool.tech/api/membership/referral` first with Supabase RPC `itool_my_referral` fallback.
 */
export async function fetchReferralSummary(options: ReferralOptions): Promise<ReferralSummary> {
  const supabase = options.supabaseUrl && options.anonKey
    ? { ...options, supabaseUrl: options.supabaseUrl, anonKey: options.anonKey }
    : undefined;
  return withFallback(
    options,
    () => referralViaItool(options),
    supabase ? () => referralViaSupabase(supabase) : undefined,
  );
}
