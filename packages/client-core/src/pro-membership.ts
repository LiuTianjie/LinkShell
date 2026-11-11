/**
 * LinkShell is part of the iTool membership: the monthly tier (iTool site + LinkShell) and the
 * yearly tier (every iTool product) both include it. Membership is bought on itool.tech only;
 * clients just read the entitlement and send people to the buy page.
 */

export type MembershipTier = "monthly" | "yearly";

export interface ProMembership {
  /** "pro": this account may use LinkShell's paid parts (the official gateway) right now. */
  plan: "free" | "pro";
  /** Which iTool membership grants it; absent when `plan` is "free". */
  tier?: MembershipTier;
  /** When LinkShell's entitlement ends; absent when `plan` is "free". */
  expiresAt?: string;
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

export const LINKSHELL_PRODUCT = "linkshell";
/**
 * The only place a membership is bought. Phones must not link to it (App Store rules).
 * www and a locale up front: the bare domain costs two redirects (308 to www, 307 to a locale).
 * Chinese, like the rest of the computer UI. The entitlement API below stays on the bare domain:
 * it is exempt from those redirects, and a cross-host redirect would drop the bearer token.
 */
export const ITOOL_MEMBERSHIP_URL = "https://www.itool.tech/zh/pro?from=linkshell";
export const ITOOL_ENTITLEMENT_URL = `https://itool.tech/api/membership/entitlement?product=${LINKSHELL_PRODUCT}`;

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
} as const;

export function monthlyUpgradeLabel(lang: keyof typeof MONTHLY_UPGRADE_COPY = "zh"): string {
  const copy = MONTHLY_UPGRADE_COPY[lang];
  return `${copy.unlocked} · ${copy.action}`;
}

const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_REQUIRED = "登录已失效，请重新登录后再试";
const MALFORMED = "会员状态返回异常，请稍后重试";

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

export function membershipTierLabel(tier: MembershipTier | undefined): string {
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
  if (until <= (Number.isFinite(serverTime) ? serverTime : Date.now())) return { plan: "free" };
  // An active entitlement always comes from a paid tier; monthly is the least it can be.
  const tier: MembershipTier = body.tier === "yearly" ? "yearly" : "monthly";
  return { plan: "pro", tier, expiresAt: body.valid_until as string };
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
  if (!options.accessToken.trim()) throw new MembershipError(LOGIN_REQUIRED, "login");
  const supabase = options.supabaseUrl && options.anonKey ? { ...options, supabaseUrl: options.supabaseUrl, anonKey: options.anonKey } : undefined;
  const [first, second] = options.prefer === "supabase" && supabase
    ? [() => viaSupabase(supabase), () => viaItool(options)]
    : [() => viaItool(options), supabase ? () => viaSupabase(supabase) : undefined];
  try {
    return await first();
  } catch (error) {
    // Only an unreachable route earns a second try: a refused token or a real answer stands.
    if (!second || options.signal?.aborted || !(error instanceof MembershipError) || (error.kind !== "network" && error.kind !== "unavailable")) throw error;
    try {
      return await second();
    } catch {
      throw error;
    }
  }
}
