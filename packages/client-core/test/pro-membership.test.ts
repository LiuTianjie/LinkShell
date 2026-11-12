import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchProMembership,
  fetchReferralSummary,
  ITOOL_ENTITLEMENT_URL,
  ITOOL_MEMBERSHIP_URL,
  ITOOL_REFERRAL_URL,
  ITOOL_YEARLY_UPGRADE_URL,
  itoolMembershipUrl,
  itoolYearlyUpgradeUrl,
  MEMBERSHIP_PRODUCT_TOTAL,
  MONTHLY_PRODUCT_COUNT,
  monthlyUpgradeLabel,
  MembershipError,
  membershipFromEntitlement,
  membershipTierLabel,
  referralFromResponse,
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
  ok: true,
  product: "linkshell",
  required_tier: "monthly",
  active: true,
  valid_until: validUntil,
  tier: "monthly",
  member_until: validUntil,
  yearly_until: null,
  server_time: now,
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
  it("maps an active monthly or yearly membership to Pro with its tier, expiry, and daysRemaining", () => {
    expect(membershipFromEntitlement(entitlement)).toEqual({
      plan: "pro",
      tier: "monthly",
      expiresAt: validUntil,
      daysRemaining: 31,
    });
    const yearly = {
      ...entitlement,
      tier: "yearly",
      yearly_until: "2027-10-19T10:00:00.000Z",
      valid_until: "2027-10-19T10:00:00.000Z",
    };
    expect(membershipFromEntitlement(yearly)).toEqual({
      plan: "pro",
      tier: "yearly",
      expiresAt: "2027-10-19T10:00:00.000Z",
      daysRemaining: 365,
    });
  });

  it("parses 7-day trial fields (is_trial, trial_ends_at) and computes remaining days accurately", () => {
    const trialEnds = "2026-10-26T10:00:00.000Z";
    const trial = {
      ...entitlement,
      tier: "yearly",
      valid_until: trialEnds,
      yearly_until: trialEnds,
      is_trial: true,
      trial_ends_at: trialEnds,
    };
    expect(membershipFromEntitlement(trial)).toEqual({
      plan: "pro",
      tier: "yearly",
      expiresAt: trialEnds,
      isTrial: true,
      trialEndsAt: trialEnds,
      daysRemaining: 7,
    });

    // 36 hours left -> rounds up to 2 days remaining
    const twoDaysLeft = {
      ...trial,
      valid_until: "2026-10-20T22:00:00.000Z",
      trial_ends_at: "2026-10-20T22:00:00.000Z",
    };
    expect(membershipFromEntitlement(twoDaysLeft).daysRemaining).toBe(2);

    // Paid user after trial ended has isTrial: false
    const paidAfterTrial = {
      ...entitlement,
      is_trial: false,
      trial_ends_at: "2026-10-10T10:00:00.000Z",
    };
    expect(membershipFromEntitlement(paidAfterTrial)).toMatchObject({
      plan: "pro",
      isTrial: false,
      trialEndsAt: "2026-10-10T10:00:00.000Z",
    });
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
    for (const body of [
      null,
      [],
      { ok: false, code: "unknown_product" },
      { ...entitlement, active: "yes" },
      { ...entitlement, product: "other" },
      { ...entitlement, valid_until: "garbage" },
    ]) {
      expect(() => membershipFromEntitlement(body)).toThrow(expect.objectContaining({ kind: "malformed" }));
    }
  });

  it("formats tier labels and locale-aware URLs across zh, en, and ja", () => {
    expect(membershipTierLabel("monthly")).toBe("iTool 月度会员");
    expect(membershipTierLabel("yearly")).toBe("iTool 年度会员");
    expect(membershipTierLabel("monthly", { locale: "en" })).toBe("iTool Monthly");
    expect(membershipTierLabel("yearly", { locale: "ja" })).toBe("iTool 年額プラン");
    expect(membershipTierLabel("yearly", { isTrial: true, daysRemaining: 5, locale: "zh" })).toBe("7 天免费试用 · 剩余 5 天");
    expect(membershipTierLabel("yearly", { isTrial: true, daysRemaining: 5, locale: "en" })).toBe("7-day free trial · 5d left");
    expect(membershipTierLabel("yearly", { isTrial: true, daysRemaining: 5, locale: "ja" })).toBe("7日間無料トライアル · 残り 5 日");

    expect(ITOOL_MEMBERSHIP_URL).toBe("https://www.itool.tech/zh/pro?from=linkshell");
    expect(ITOOL_YEARLY_UPGRADE_URL).toBe("https://www.itool.tech/zh/pro?from=linkshell&checkout=yearly");
    expect(itoolMembershipUrl("zh")).toBe("https://www.itool.tech/zh/pro?from=linkshell");
    expect(itoolMembershipUrl("en")).toBe("https://www.itool.tech/en/pro?from=linkshell");
    expect(itoolMembershipUrl("ja")).toBe("https://www.itool.tech/en/pro?from=linkshell");
    expect(itoolYearlyUpgradeUrl("en")).toBe("https://www.itool.tech/en/pro?from=linkshell&checkout=yearly");
    expect(itoolYearlyUpgradeUrl("ja")).toBe("https://www.itool.tech/en/pro?from=linkshell&checkout=yearly");

    expect(monthlyUpgradeLabel()).toBe("已解锁 2/7 款产品 · 升级年度");
    expect(monthlyUpgradeLabel("en")).toBe("2 of 7 products unlocked · Go yearly");
    expect(monthlyUpgradeLabel("ja")).toContain("2");
    expect([MONTHLY_PRODUCT_COUNT, MEMBERSHIP_PRODUCT_TOTAL]).toEqual([2, 7]);
  });
});

describe("fetchProMembership", () => {
  it("asks itool.tech with only the user's bearer token", async () => {
    respond(entitlement);
    await expect(fetchProMembership(options)).resolves.toEqual({
      plan: "pro",
      tier: "monthly",
      expiresAt: validUntil,
      daysRemaining: 31,
    });
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

describe("fetchReferralSummary & referralFromResponse", () => {
  const referralBody = {
    ok: true,
    code: "ab2c3d4e",
    invited: 4,
    rewarded: 2,
    earned_days: 44,
  };

  it("parses referral summary from itool.tech API and builds localized shareUrl", async () => {
    respond(referralBody);
    const summary = await fetchReferralSummary({ ...options, locale: "en" });
    expect(summary).toEqual({
      code: "AB2C3D4E",
      invited: 4,
      rewarded: 2,
      earnedDays: 44,
      shareUrl: "https://www.itool.tech/en/pro?from=linkshell&ref=AB2C3D4E",
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(ITOOL_REFERRAL_URL);
  });

  it("falls back to Supabase RPC itool_my_referral when itool.tech is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    respond(referralBody);
    const summary = await fetchReferralSummary(options);
    expect(summary.code).toBe("AB2C3D4E");
    expect(summary.earnedDays).toBe(44);
    expect(summary.shareUrl).toBe("https://www.itool.tech/pro?from=linkshell&ref=AB2C3D4E");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://project.supabase.co/rest/v1/rpc/itool_my_referral");
  });

  it("rejects invalid referral codes or login_required responses", () => {
    expect(() => referralFromResponse({ ok: false, code: "login_required" })).toThrow(expect.objectContaining({ kind: "login" }));
    expect(() => referralFromResponse({ ok: true, code: "INVALID1" })).toThrow(expect.objectContaining({ kind: "malformed" }));
  });
});
