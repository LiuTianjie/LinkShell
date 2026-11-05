import { afterEach, describe, expect, it, vi } from "vitest";
import { subscriptionFromEntitlement, supabaseSubscriptions } from "../src/subscription.js";

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
    // Anything that isn't an answer about the account admits, as a failed lookup always has.
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
