import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lsh-pro-"));
process.env.LINKSHELL_HOME = home;
const auth = await import("../src/auth.js");
const { cachedMembership, cacheMembership, refreshMembership } = await import("../src/pro-membership.js");
const tokens = (userId = "u1") => ({ accessToken: `${userId}-access`, refreshToken: `${userId}-refresh`, expiresAt: Date.now() + 3_600_000, userId });
const expiry = () => new Date(Date.now() + 86_400_000).toISOString();
const entitlement = (validUntil: string | null, tier = "monthly") => Response.json({
  ok: true, product: "linkshell", required_tier: "monthly", active: validUntil !== null, valid_until: validUntil,
  tier: validUntil ? tier : "free", member_until: validUntil, yearly_until: tier === "yearly" ? validUntil : null, server_time: new Date().toISOString(),
});

beforeEach(() => {
  rmSync(join(home, "account-pro.json"), { force: true });
  auth.saveAuth(tokens());
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("desktop membership", () => {
  it("reads an account-scoped private cache without network requests and expires it locally", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const planExpiresAt = expiry();
    cacheMembership("u1", { plan: "pro", planExpiresAt, tier: "yearly" });
    expect(cachedMembership("u1")).toEqual({ plan: "pro", planExpiresAt, tier: "yearly" });
    expect(cachedMembership("u2")).toEqual({ plan: "unknown", planExpiresAt: null, tier: null });
    // Windows inherits NTFS ACLs instead of enforcing POSIX mode bits.
    if (process.platform !== "win32") expect(statSync(join(home, "account-pro.json")).mode & 0o777).toBe(0o600);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(planExpiresAt) + 1);
    expect(cachedMembership("u1").plan).toBe("free");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads an older cache without a tier as monthly", () => {
    cacheMembership("u1", { plan: "pro", planExpiresAt: expiry() });
    expect(cachedMembership("u1").tier).toBe("monthly");
  });

  it("asks itool.tech's entitlement route with the signed-in user's bearer token", async () => {
    const planExpiresAt = expiry();
    const fetch = vi.fn().mockResolvedValueOnce(entitlement(planExpiresAt, "yearly"));
    vi.stubGlobal("fetch", fetch);
    expect(await refreshMembership()).toEqual({ plan: "pro", planExpiresAt, tier: "yearly" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://itool.tech/api/membership/entitlement?product=linkshell");
    expect(fetch.mock.calls[0]?.[1]?.headers.Authorization).toBe("Bearer u1-access");
    expect(cachedMembership("u1")).toEqual({ plan: "pro", planExpiresAt, tier: "yearly" });
  });

  it("keeps the last known state while both routes are unreachable", async () => {
    const planExpiresAt = expiry();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(entitlement(planExpiresAt)).mockRejectedValue(new Error("offline")));
    await refreshMembership();
    await expect(refreshMembership()).rejects.toThrow("网络连接失败");
    expect(cachedMembership("u1").plan).toBe("pro");
  });

  it("forgets the state when the token is refused", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(entitlement(expiry()))
      .mockResolvedValueOnce(Response.json({ ok: false, code: "login_required" }, { status: 401 })));
    await refreshMembership();
    await expect(refreshMembership()).rejects.toThrow("登录已失效");
    expect(cachedMembership("u1").plan).toBe("unknown");
  });

  it("records a non-member as free", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(entitlement(null)));
    expect(await refreshMembership()).toEqual({ plan: "free", planExpiresAt: null, tier: null });
  });

  it("never writes tokens into the cache", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(entitlement(expiry())));
    await refreshMembership();
    const file = readFileSync(join(home, "account-pro.json"), "utf8");
    expect(file).not.toContain("u1-access");
    expect(file).not.toContain("u1-refresh");
  });

  it("preserves isTrial and trialEndsAt when reported by the entitlement endpoint", async () => {
    const planExpiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: true,
      product: "linkshell",
      required_tier: "monthly",
      active: true,
      valid_until: planExpiresAt,
      tier: "yearly",
      member_until: planExpiresAt,
      yearly_until: planExpiresAt,
      trial_ends_at: planExpiresAt,
      is_trial: true,
      server_time: new Date().toISOString(),
    })));
    expect(await refreshMembership()).toEqual({
      plan: "pro",
      planExpiresAt,
      tier: "yearly",
      isTrial: true,
      trialEndsAt: planExpiresAt,
    });
    expect(cachedMembership("u1")).toEqual({
      plan: "pro",
      planExpiresAt,
      tier: "yearly",
      isTrial: true,
      trialEndsAt: planExpiresAt,
    });
  });
});
