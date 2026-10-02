import type { GatewayOptions } from "./relay.js";

// The official gateway is a subscription service. Whether an account is Pro is
// read from iTool's `profiles` table, with the service-role key: the gateway
// asks on its own behalf, not with the user's token.

export interface SubscriptionCheck {
  /** "unknown": the lookup itself failed, which says nothing about the account. */
  status: "active" | "inactive" | "unknown";
  reason?: string;
}

export type CheckSubscription = (userId: string) => Promise<SubscriptionCheck>;

export function supabaseSubscriptions(supabase: { url: string; anonKey: string; serviceRoleKey: string }): CheckSubscription {
  return async (userId) => {
    if (!supabase.url || !supabase.anonKey) return { status: "unknown", reason: "missing_supabase_config" };
    if (!supabase.serviceRoleKey) return { status: "unknown", reason: "missing_service_role_key" };
    try {
      const response = await fetch(`${supabase.url}/rest/v1/profiles?id=eq.${userId}&select=plan,plan_expires_at&limit=1`, {
        headers: { Authorization: `Bearer ${supabase.serviceRoleKey}`, apikey: supabase.anonKey },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { status: "unknown", reason: `profile_lookup_http_${response.status}` };
      const profiles = (await response.json()) as { plan: string; plan_expires_at: string | null }[];
      const profile = profiles[0];
      if (!profile) return { status: "unknown", reason: "profile_not_found" };
      const active = profile.plan === "pro" && !!profile.plan_expires_at && new Date(profile.plan_expires_at) > new Date();
      return { status: active ? "active" : "inactive" };
    } catch {
      return { status: "unknown", reason: "profile_lookup_failed" };
    }
  };
}

/**
 * The official gateway's rule for who may connect: a computer needs an active
 * Pro account. Devices only reach computers they're paired with or share an
 * account with, so they need nothing more.
 */
export function requirePro(check: CheckSubscription, warn: (message: string) => void): NonNullable<GatewayOptions["admit"]> {
  return async ({ role, userId }) => {
    if (role !== "machine") return undefined;
    if (!userId) return "官方网关需要登录 Pro 账号：在电脑上运行 linkshell login";
    const subscription = await check(userId);
    // A lookup failure isn't a lapsed subscription; don't lock people out over it.
    if (subscription.status === "inactive") return "官方网关需要 Pro 订阅：https://liutianjie.github.io/LinkShell/pricing/";
    if (subscription.status === "unknown") warn(`subscription check unavailable (${subscription.reason}); admitting ${userId}`);
    return undefined;
  };
}
