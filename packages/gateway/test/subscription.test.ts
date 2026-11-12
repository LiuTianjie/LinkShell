import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admissionDenialMessage,
  LOGIN_REQUIRED_CODE,
  MEMBERSHIP_REQUIRED_CODE,
  MEMBERSHIP_URL,
  membershipUrl,
  requirePro,
  subscriptionFromEntitlement,
  supabaseSubscriptions,
  type SubscriptionCheck,
} from "../src/subscription.js";

const supabase = { url: "https://project.supabase.co/", anonKey: "anon", serviceRoleKey: "service" };

afterEach(() => vi.unstubAllGlobals());

describe("the gateway's membership check", () => {
  it("asks itool_entitlement_for with the service-role key, for LinkShell", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, product: "linkshell", active: true, tier: "monthly" }));
    vi.stubGlobal("fetch", fetch);
    await expect(supabaseSubscriptions(supabase)("user-1")).resolves.toEqual({ status: "active" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://project.supabase.co/rest/v1/rpc/itool_entitlement_for");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer service", apikey: "anon", "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: "user-1", p_product: "linkshell" }),
    });
  });

  it("maps the RPC's answer: active is the only thing that counts", () => {
    expect(subscriptionFromEntitlement({ ok: true, active: true, tier: "yearly" })).toEqual({ status: "active" });
    expect(subscriptionFromEntitlement({ ok: true, active: false, tier: "free" })).toEqual({ status: "inactive" });
    // A failed lookup says nothing about expiry; requirePro applies a bounded grace period.
    expect(subscriptionFromEntitlement({ ok: false, code: "unknown_product" })).toEqual({ status: "unknown", reason: "entitlement_unknown_product" });
    expect(subscriptionFromEntitlement({ ok: true })).toMatchObject({ status: "unknown" });
    expect(subscriptionFromEntitlement(null)).toMatchObject({ status: "unknown" });
    expect(subscriptionFromEntitlement([])).toMatchObject({ status: "unknown" });
  });

  it("treats a failing lookup as unknown, never as lapsed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    await expect(supabaseSubscriptions(supabase)("u")).resolves.toEqual({ status: "unknown", reason: "entitlement_lookup_http_500" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(supabaseSubscriptions(supabase)("u")).resolves.toEqual({ status: "unknown", reason: "entitlement_lookup_failed" });
    await expect(supabaseSubscriptions({ ...supabase, serviceRoleKey: "" })("u")).resolves.toMatchObject({ status: "unknown" });
  });
});

describe("membership revalidation during outages", () => {
  const machine = { role: "machine" as const, userId: "alice" };

  it("keeps a recently verified member online briefly, but repeated failures do not renew grace", async () => {
    let now = 0;
    let result: SubscriptionCheck = { status: "active" };
    const admit = requirePro(async () => result, () => {}, { enforceGrace: true, now: () => now, cacheMs: 0, graceMs: 100 });
    expect(await admit(machine)).toBeUndefined();
    result = { status: "unknown", reason: "network" };
    now = 40;
    expect(await admit(machine)).toBeUndefined();
    now = 90;
    expect(await admit(machine)).toBeUndefined();
    now = 101;
    expect(await admit(machine)).toContain("暂时无法验证");
    result = { status: "active" };
    expect(await admit(machine)).toBeUndefined();
  });

  it("bounds first-connection outage grace and never lets an outage revive a known expired membership", async () => {
    let now = 0;
    let result: SubscriptionCheck = { status: "unknown" };
    const admit = requirePro(async () => result, () => {}, { enforceGrace: true, now: () => now, cacheMs: 0, graceMs: 100 });
    expect(await admit(machine)).toBeUndefined();
    now = 101;
    expect(await admit(machine)).toContain("暂时无法验证");
    result = { status: "inactive" };
    expect(await admit(machine)).toContain("需要 iTool 会员");
    result = { status: "unknown" };
    expect(await admit(machine)).toContain("需要 iTool 会员");
    expect(await admit({ role: "device", userId: "alice" })).toBeUndefined();
  });

  it("shares in-flight and recently successful checks across connection and TURN requests", async () => {
    let finish!: (result: SubscriptionCheck) => void;
    const check = vi.fn(() => new Promise<SubscriptionCheck>((resolve) => { finish = resolve; }));
    const admit = requirePro(check, () => {}, { enforceGrace: true, now: () => 0, cacheMs: 100 });
    const first = admit(machine);
    const second = admit(machine);
    expect(check).toHaveBeenCalledTimes(1);
    finish({ status: "active" });
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(await admit(machine)).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("does not revive a known expired account after idle cache cleanup", async () => {
    let now = 0;
    let result: SubscriptionCheck = { status: "inactive" };
    const admit = requirePro(async () => result, () => {}, { enforceGrace: true, now: () => now, cacheMs: 0, graceMs: 100 });
    expect(await admit(machine)).toContain("需要 iTool 会员");
    now = 201;
    result = { status: "unknown" };
    expect(await admit(machine)).toContain("暂时无法验证");
    expect(await admit({ ...machine, userId: "new-account" })).toContain("暂时无法验证");
  });

  it("keeps the existing outage admission behavior until revalidation is explicitly enabled", async () => {
    let now = 0;
    const admit = requirePro(async () => ({ status: "unknown" }), () => {}, { now: () => now, graceMs: 100 });
    expect(await admit(machine)).toBeUndefined();
    now = 10_000;
    expect(await admit(machine)).toBeUndefined();
  });

  it("provides locale-neutral URLs, bilingual 7-day free trial hints, and localized helpers", async () => {
    expect(MEMBERSHIP_URL).toBe("https://www.itool.tech/pro?from=linkshell");
    expect(membershipUrl()).toBe("https://www.itool.tech/pro?from=linkshell");
    expect(membershipUrl("zh")).toBe("https://www.itool.tech/zh/pro?from=linkshell");
    expect(membershipUrl("en")).toBe("https://www.itool.tech/en/pro?from=linkshell");
    expect(membershipUrl("ja")).toBe("https://www.itool.tech/en/pro?from=linkshell");
    expect(LOGIN_REQUIRED_CODE).toBe("login_required");
    expect(MEMBERSHIP_REQUIRED_CODE).toBe("membership_required");

    const admit = requirePro(async () => ({ status: "inactive" }), () => {});
    const anonMessage = await admit({ role: "machine" });
    expect(anonMessage).toContain("linkshell login");
    expect(anonMessage).toContain("7 天免费试用");
    expect(anonMessage).toContain("7-day free trial");

    const lapsedMessage = await admit({ role: "machine", userId: "lapsed-user" });
    expect(lapsedMessage).toContain(MEMBERSHIP_URL);
    expect(lapsedMessage).toContain("需要 iTool 会员");
    expect(lapsedMessage).toContain("7-day free trial");

    expect(admissionDenialMessage("membership_required", "ja")).toContain("7 日間無料トライアル");
  });
});
