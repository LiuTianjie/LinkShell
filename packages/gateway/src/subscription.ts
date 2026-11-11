import type { GatewayOptions } from "./relay.js";

// The official gateway is part of the iTool membership: any active member (monthly or yearly)
// has LinkShell. The gateway asks iTool's `itool_entitlement_for(uid, 'linkshell')` with the
// service-role key, on its own behalf, not with the user's token.

// www and a locale up front: the bare domain costs two redirects. Chinese, like the message it ends.
export const MEMBERSHIP_URL = "https://www.itool.tech/zh/pro?from=linkshell";

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
export function requirePro(check: CheckSubscription, warn: (message: string) => void): NonNullable<GatewayOptions["admit"]> {
  return async ({ role, userId }) => {
    if (role !== "machine") return undefined;
    if (!userId) return "官方网关需要登录 iTool 会员账号：在电脑上运行 linkshell login";
    const subscription = await check(userId);
    // A lookup failure isn't a lapsed subscription; don't lock people out over it.
    if (subscription.status === "inactive") return `官方网关需要 iTool 会员：${MEMBERSHIP_URL}`;
    if (subscription.status === "unknown") warn(`subscription check unavailable (${subscription.reason}); admitting ${userId}`);
    return undefined;
  };
}
