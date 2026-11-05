import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchProMembership,
  ITOOL_ENTITLEMENT_URL,
  ITOOL_MEMBERSHIP_URL,
  MembershipError,
  membershipFromEntitlement,
  membershipTierLabel,
} from "../src/pro-membership.js";

const now = "2026-10-19T10:00:00.000Z";
const validUntil = "2026-11-19T10:00:00.000Z";
const options = {
  supabaseUrl: "https://project.supabase.co/",
  anonKey: "public-anon-key",
  accessToken: "user-access-token",
  userId: "user-id",
};
const entitlement = {
  ok: true, product: "linkshell", required_tier: "monthly", active: true, valid_until: validUntil,
  tier: "monthly", member_until: validUntil, yearly_until: null, server_time: now,
};
const fetchMock = vi.fn<typeof fetch>();

function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("entitlement mapping", () => {
  it("maps an active monthly or yearly membership to Pro with its tier and LinkShell's expiry", () => {
    expect(membershipFromEntitlement(entitlement)).toEqual({ plan: "pro", tier: "monthly", expiresAt: validUntil });
    const yearly = { ...entitlement, tier: "yearly", yearly_until: "2027-10-19T10:00:00.000Z", valid_until: "2027-10-19T10:00:00.000Z" };
    expect(membershipFromEntitlement(yearly)).toEqual({ plan: "pro", tier: "yearly", expiresAt: "2027-10-19T10:00:00.000Z" });
  });

  it.each([
    { ...entitlement, active: false, tier: "free", valid_until: null },
    { ...entitlement, active: false, valid_until: "2026-09-01T00:00:00.000Z" },
    { ...entitlement, valid_until: now },
    { ...entitlement, valid_until: "2026-10-01T00:00:00.000Z" },
  ])("does not grant Pro for an inactive or already-ended entitlement: %j", (body) => {
    expect(membershipFromEntitlement(body)).toEqual({ plan: "free" });
  });

  it("uses the server clock, not the device's", () => {
    vi.setSystemTime(new Date("2030-01-01"));
    expect(membershipFromEntitlement(entitlement).plan).toBe("pro");
  });

  it("reads login_required as a sign-in problem and anything unexpected as malformed", () => {
    expect(() => membershipFromEntitlement({ ok: false, code: "login_required" })).toThrow(expect.objectContaining({ kind: "login" }));
    for (const body of [null, [], { ok: false, code: "unknown_product" }, { ...entitlement, active: "yes" }, { ...entitlement, product: "other" }, { ...entitlement, valid_until: "garbage" }]) {
      expect(() => membershipFromEntitlement(body)).toThrow(expect.objectContaining({ kind: "malformed" }));
    }
  });

  it("names the tiers in Chinese", () => {
    expect(membershipTierLabel("monthly")).toBe("iTool 月度会员");
    expect(membershipTierLabel("yearly")).toBe("iTool 年度会员");
    expect(ITOOL_MEMBERSHIP_URL).toBe("https://itool.tech/pro?from=linkshell");
  });
});

describe("fetchProMembership", () => {
  it("asks itool.tech with only the user's bearer token", async () => {
    respond(entitlement);
    await expect(fetchProMembership(options)).resolves.toEqual({ plan: "pro", tier: "monthly", expiresAt: validUntil });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ITOOL_ENTITLEMENT_URL);
    expect(url).toBe("https://itool.tech/api/membership/entitlement?product=linkshell");
    expect(init).toMatchObject({ credentials: "omit", headers: { Authorization: `Bearer ${options.accessToken}` } });
    expect(init?.method).toBeUndefined();
  });

  it("calls the Supabase RPC directly when asked to prefer it", async () => {
    respond(entitlement);
    await fetchProMembership({ ...options, prefer: "supabase" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://project.supabase.co/rest/v1/rpc/itool_entitlement");
    expect(init).toMatchObject({
      method: "POST",
      headers: { apikey: options.anonKey, Authorization: `Bearer ${options.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_product: "linkshell" }),
    });
  });

  it.each([502, 503])("falls back to the other route when one is unavailable (%i)", async (status) => {
    respond({ ok: false, code: "temporarily_unavailable" }, status);
    respond(entitlement);
    await expect(fetchProMembership(options)).resolves.toMatchObject({ plan: "pro" });
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/rest/v1/rpc/itool_entitlement");
  });

  it("falls back when itool.tech can't be reached, and keeps the first error if both fail", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    respond(entitlement);
    await expect(fetchProMembership(options)).resolves.toMatchObject({ plan: "pro" });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(fetchProMembership(options)).rejects.toThrow("网络连接失败");
  });

  it("does not retry elsewhere after a refused token or a real answer", async () => {
    respond({ ok: false, code: "login_required" }, 401);
    await expect(fetchProMembership(options)).rejects.toThrow("登录已失效");
    respond({ ...entitlement, active: false, tier: "free", valid_until: null });
    await expect(fetchProMembership(options)).resolves.toEqual({ plan: "free" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("without Supabase settings, reports an unavailable service as such", async () => {
    respond({ ok: false, code: "temporarily_unavailable" }, 503);
    const error = await fetchProMembership({ accessToken: "t" }).catch((reason) => reason);
    expect(error).toBeInstanceOf(MembershipError);
    expect(error.kind).toBe("unavailable");
  });

  it("rejects a missing token before sending anything", async () => {
    await expect(fetchProMembership({ ...options, accessToken: " " })).rejects.toThrow("登录已失效");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds a stalled request and aborts it", async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const result = expect(fetchProMembership({ accessToken: "t" })).rejects.toThrow("请求超时");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });
});
