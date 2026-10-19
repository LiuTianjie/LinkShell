import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchProMembership, redeemProCode } from "../../client-core/src/pro-membership.js";
import { getValidToken, loadAuth, SUPABASE_ANON_KEY, SUPABASE_URL } from "./auth.js";
import { linkshellDir } from "./utils/daemon.js";

export interface DesktopMembership {
  plan: "pro" | "free" | "unknown";
  planExpiresAt: string | null;
}

const unknownMembership: DesktopMembership = { plan: "unknown", planExpiresAt: null };
const changedAccount = "登录账号已变更，请刷新账号后重试";
const cachePath = () => join(linkshellDir(), "account-pro.json");

/** Snapshot polling stays offline; the dashboard refreshes this account-scoped cache separately. */
export function cachedMembership(userId: string): DesktopMembership {
  try {
    const value = JSON.parse(readFileSync(cachePath(), "utf8"));
    if (value.userId !== userId || !["pro", "free", "unknown"].includes(value.plan)) return { ...unknownMembership };
    const expiry = typeof value.planExpiresAt === "string" && Number.isFinite(Date.parse(value.planExpiresAt)) ? value.planExpiresAt : null;
    if (value.plan === "pro" && !expiry) return { ...unknownMembership };
    return { plan: value.plan === "pro" ? expiry && Date.parse(expiry) > Date.now() ? "pro" : "free" : value.plan, planExpiresAt: expiry };
  } catch {
    return { ...unknownMembership };
  }
}

export function cacheMembership(userId: string, membership: DesktopMembership, observedAt = Date.now()): void {
  try {
    const previous = JSON.parse(readFileSync(cachePath(), "utf8"));
    // A profile request begun before redemption cannot replace its confirmed result.
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

export async function refreshMembership(): Promise<DesktopMembership> {
  const userId = loadAuth()?.userId;
  const observedAt = Date.now();
  try {
    const account = await accountToken(userId);
    const membership = await fetchProMembership({ ...account, supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
    if (loadAuth()?.userId !== account.userId) throw new Error(changedAccount);
    const result: DesktopMembership = { plan: membership.plan, planExpiresAt: membership.expiresAt ?? null };
    cacheMembership(account.userId, result, observedAt);
    return result;
  } catch (error) {
    if (userId && loadAuth()?.userId === userId) {
      try { cacheMembership(userId, unknownMembership, observedAt); } catch { /* Preserve the request's error. */ }
    }
    throw error;
  }
}

export async function redeemDesktopPro(code: string, userId: string) {
  if (!code.trim()) throw new Error("请输入激活码");
  if (Buffer.byteLength(code, "utf8") > 512) throw new Error("激活码内容过长，请检查后重试");
  const account = await accountToken(userId);
  const redeemed = await redeemProCode(account.accessToken, code);
  const redemption = { userId, idempotent: redeemed.idempotent, planExpiresAt: redeemed.expiresAt };
  let accountWarning: string | undefined;
  try {
    if (loadAuth()?.userId === userId) cacheMembership(userId, { plan: "pro", planExpiresAt: redeemed.expiresAt });
  } catch {
    accountWarning = "兑换已成功，会员状态暂未保存，请刷新会员状态";
  }
  if (loadAuth()?.userId !== userId) accountWarning = "兑换已成功，登录账号已变更，请切回兑换时的账号查看会员状态";
  return { redemption, accountWarning };
}
