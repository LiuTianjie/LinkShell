import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchProMembership, MembershipError, type MembershipTier } from "../../client-core/src/pro-membership.js";
import { getValidToken, loadAuth, SUPABASE_ANON_KEY, SUPABASE_URL } from "./auth.js";
import { linkshellDir } from "./utils/daemon.js";

export interface DesktopMembership {
  plan: "pro" | "free" | "unknown";
  planExpiresAt: string | null;
  /** The iTool membership tier behind "pro"; null otherwise. */
  tier?: MembershipTier | null;
}

const unknownMembership: DesktopMembership = { plan: "unknown", planExpiresAt: null, tier: null };
const changedAccount = "登录账号已变更，请刷新账号后重试";
const cachePath = () => join(linkshellDir(), "account-pro.json");

/** Snapshot polling stays offline; the dashboard refreshes this account-scoped cache separately. */
export function cachedMembership(userId: string): DesktopMembership {
  try {
    const value = JSON.parse(readFileSync(cachePath(), "utf8"));
    if (value.userId !== userId || !["pro", "free", "unknown"].includes(value.plan)) return { ...unknownMembership };
    const expiry = typeof value.planExpiresAt === "string" && Number.isFinite(Date.parse(value.planExpiresAt)) ? value.planExpiresAt : null;
    if (value.plan === "pro" && !expiry) return { ...unknownMembership };
    const tier: MembershipTier | null = value.tier === "yearly" || value.tier === "monthly" ? value.tier : null;
    if (value.plan !== "pro") return { plan: value.plan, planExpiresAt: expiry, tier: null };
    return Date.parse(expiry!) > Date.now() ? { plan: "pro", planExpiresAt: expiry, tier: tier ?? "monthly" } : { plan: "free", planExpiresAt: expiry, tier: null };
  } catch {
    return { ...unknownMembership };
  }
}

export function cacheMembership(userId: string, membership: DesktopMembership, observedAt = Date.now()): void {
  try {
    const previous = JSON.parse(readFileSync(cachePath(), "utf8"));
    // A slower request begun earlier cannot replace a newer observation.
    if (previous.userId === userId && previous.observedAt > observedAt) return;
  } catch { /* There may not be a prior account observation. */ }
  mkdirSync(linkshellDir(), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify({ userId, ...membership, observedAt }) + "\n", { encoding: "utf8", mode: 0o600 });
}

async function accountToken(expectedUserId?: string): Promise<{ userId: string; accessToken: string }> {
  const auth = loadAuth();
  if (!auth?.userId) throw new Error("请先登录账号");
  if (expectedUserId !== undefined && auth.userId !== expectedUserId) throw new Error(changedAccount);
  const accessToken = await getValidToken();
  const current = loadAuth();
  if (current?.userId !== auth.userId) throw new Error(changedAccount);
  if (!accessToken || current.accessToken !== accessToken) throw new Error("登录已失效，请重新登录后再试");
  return { userId: auth.userId, accessToken };
}

/**
 * CLI and desktop often run where supabase.co is blocked: itool.tech first, the RPC after.
 * `LINKSHELL_TOKEN_PROXY=off`, the switch that keeps sign-in off itool.tech, reverses the order.
 */
export async function lookupMembership(accessToken: string, signal?: AbortSignal): Promise<DesktopMembership> {
  const prefer = process.env.LINKSHELL_TOKEN_PROXY === "off" ? "supabase" : "itool";
  const membership = await fetchProMembership({ accessToken, supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, prefer, signal });
  return { plan: membership.plan, planExpiresAt: membership.expiresAt ?? null, tier: membership.tier ?? null };
}

export async function refreshMembership(): Promise<DesktopMembership> {
  const userId = loadAuth()?.userId;
  const observedAt = Date.now();
  try {
    const account = await accountToken(userId);
    const result = await lookupMembership(account.accessToken);
    if (loadAuth()?.userId !== account.userId) throw new Error(changedAccount);
    cacheMembership(account.userId, result, observedAt);
    return result;
  } catch (error) {
    // An unreachable or briefly unavailable service says nothing about the account: the last
    // known state stays. Anything else (a refused token, an odd answer) leaves it unknown.
    const transient = error instanceof MembershipError && (error.kind === "network" || error.kind === "unavailable");
    if (!transient && userId && loadAuth()?.userId === userId) {
      try { cacheMembership(userId, unknownMembership, observedAt); } catch { /* Preserve the request's error. */ }
    }
    throw error;
  }
}
