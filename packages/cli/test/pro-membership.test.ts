import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lsh-pro-"));
process.env.LINKSHELL_HOME = home;
const auth = await import("../src/auth.js");
const { cachedMembership, cacheMembership, refreshMembership, redeemDesktopPro } = await import("../src/pro-membership.js");
const tokens = (userId = "u1") => ({ accessToken: `${userId}-access`, refreshToken: `${userId}-refresh`, expiresAt: Date.now() + 3_600_000, userId });
const expiry = () => new Date(Date.now() + 86_400_000).toISOString();
const redeemed = (planExpiresAt: string) => Response.json({ ok: true, valid: true, idempotent: false, months: 1, plan_expires_at: planExpiresAt, server_time: new Date().toISOString() });

beforeEach(() => {
  rmSync(join(home, "account-pro.json"), { force: true });
  auth.saveAuth(tokens());
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("desktop Pro membership", () => {
  it("reads an account-scoped private cache without network requests and expires Pro locally", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const planExpiresAt = expiry();
    cacheMembership("u1", { plan: "pro", planExpiresAt });
    expect(cachedMembership("u1")).toEqual({ plan: "pro", planExpiresAt });
    expect(cachedMembership("u2")).toEqual({ plan: "unknown", planExpiresAt: null });
    // Windows inherits NTFS ACLs instead of enforcing POSIX mode bits.
    if (process.platform !== "win32") expect(statSync(join(home, "account-pro.json")).mode & 0o777).toBe(0o600);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(planExpiresAt) + 1);
    expect(cachedMembership("u1").plan).toBe("free");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes with the signed-in user's bearer token and leaves failures unknown", async () => {
    const planExpiresAt = expiry();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([{ plan: "pro", plan_expires_at: planExpiresAt }])).mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    expect(await refreshMembership()).toEqual({ plan: "pro", planExpiresAt });
    expect(fetch.mock.calls[0]?.[0]).toContain("id=eq.u1");
    expect(fetch.mock.calls[0]?.[1]?.headers.Authorization).toBe("Bearer u1-access");
    await expect(refreshMembership()).rejects.toThrow("网络连接失败");
    expect(cachedMembership("u1").plan).toBe("unknown");
  });

  it("redeems once and persists only the confirmed expiry, never the activation code or tokens", async () => {
    const planExpiresAt = expiry();
    const fetch = vi.fn().mockResolvedValue(redeemed(planExpiresAt));
    vi.stubGlobal("fetch", fetch);
    expect(await redeemDesktopPro(" activation-secret ", "u1")).toEqual({ redemption: { userId: "u1", idempotent: false, planExpiresAt }, accountWarning: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://itool.tech/api/pro/redeem");
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body)).toEqual({ code: "activation-secret" });
    expect(cachedMembership("u1")).toEqual({ plan: "pro", planExpiresAt });
    const stored = readFileSync(join(home, "account-pro.json"), "utf8");
    expect(stored).not.toMatch(/activation-secret|u1-access|u1-refresh/);
  });

  it("refuses a stale desktop account before making a redemption request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(redeemDesktopPro("secret", "old-user")).rejects.toThrow("账号已变更");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not redeem after token refresh changes the account", async () => {
    auth.saveAuth({ ...tokens(), expiresAt: Date.now() - 1 });
    const fetch = vi.fn().mockImplementation(async () => {
      auth.saveAuth(tokens("u2"));
      return Response.json({ access_token: "refreshed", refresh_token: "new-refresh", expires_in: 3600, user: { id: "u1" } });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(redeemDesktopPro("secret", "u1")).rejects.toThrow("账号已变更");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(auth.loadAuth()?.userId).toBe("u2");
  });

  it("cannot replace a confirmed redemption with an older profile refresh", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const planExpiresAt = expiry();
    const fetch = vi.fn().mockImplementation((url: string) => url.includes("/profiles") ? pending : Promise.resolve(redeemed(planExpiresAt)));
    vi.stubGlobal("fetch", fetch);
    const refresh = refreshMembership();
    await Promise.resolve();
    await Promise.resolve();
    vi.setSystemTime(Date.now() + 10);
    await redeemDesktopPro("secret", "u1");
    finish(Response.json([{ plan: "free", plan_expires_at: null }]));
    await refresh;
    expect(cachedMembership("u1")).toEqual({ plan: "pro", planExpiresAt });
  });

  it("keeps redemption confirmation scoped to its account if the user signs out while it runs", async () => {
    const planExpiresAt = expiry();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      auth.saveAuth(tokens("u2"));
      return redeemed(planExpiresAt);
    }));
    const result = await redeemDesktopPro("secret", "u1");
    expect(result.redemption.userId).toBe("u1");
    expect(result.accountWarning).toContain("登录账号已变更");
    expect(cachedMembership("u2").plan).toBe("unknown");
  });
});
