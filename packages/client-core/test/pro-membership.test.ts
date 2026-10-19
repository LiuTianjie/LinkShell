import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchProMembership, redeemProCode } from "../src/pro-membership.js";

const now = "2026-10-19T10:00:00.000Z";
const expiresAt = "2026-11-19T10:00:00.000Z";
const options = {
  supabaseUrl: "https://project.supabase.co/",
  anonKey: "public-anon-key",
  accessToken: "user-access-token",
  userId: "user-id",
};
const redeemed = { ok: true, valid: true, idempotent: false, months: 1, plan_expires_at: expiresAt, server_time: now };
const fetchMock = vi.fn<typeof fetch>();

function respond(body: unknown, status = 200, headers?: HeadersInit) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers }));
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

describe("Pro membership profile", () => {
  it("reads only the current user's profile with their bearer token and the public API key", async () => {
    respond([{ plan: "pro", plan_expires_at: expiresAt }]);
    await expect(fetchProMembership(options)).resolves.toEqual({ plan: "pro", expiresAt });
    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/rest/v1/profiles");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ select: "plan,plan_expires_at", id: "eq.user-id", limit: "1" });
    expect(init).toMatchObject({
      credentials: "omit",
      headers: { apikey: options.anonKey, Authorization: `Bearer ${options.accessToken}` },
    });
    expect(init?.body).toBeUndefined();
    expect(init?.method).toBeUndefined();
  });

  it.each([
    [],
    [{ plan: "free", plan_expires_at: expiresAt }],
    [{ plan: "pro", plan_expires_at: "2026-10-18T10:00:00.000Z" }],
    [{ plan: "pro", plan_expires_at: now }],
    [{ plan: "pro", plan_expires_at: null }],
    [{ plan: "pro", plan_expires_at: "invalid date" }],
  ].map((profile) => [profile]))("does not grant Pro for an absent, free, or expired profile: %j", async (profile) => {
    respond(profile);
    await expect(fetchProMembership(options)).resolves.toEqual({ plan: "free" });
  });

  it("uses the server clock when the device clock is wrong", async () => {
    vi.setSystemTime(new Date("2030-01-01"));
    respond([{ plan: "pro", plan_expires_at: expiresAt }], 200, { date: new Date(now).toUTCString() });
    await expect(fetchProMembership(options)).resolves.toEqual({ plan: "pro", expiresAt });
  });

  it.each([401, 403])("reports authentication failure rather than showing a free account (%i)", async (status) => {
    respond({ message: "expired token" }, status);
    await expect(fetchProMembership(options)).rejects.toThrow("登录已失效");
  });

  it("does not turn an unavailable or malformed profile response into a free membership", async () => {
    respond({ message: "database unavailable" }, 503);
    await expect(fetchProMembership(options)).rejects.toThrow("暂时无法获取会员状态");
    respond({ plan: "pro", plan_expires_at: expiresAt });
    await expect(fetchProMembership(options)).rejects.toThrow("会员状态返回异常");
  });
});

describe("Pro activation codes", () => {
  it.each([false, true])("trusts a complete server grant, including an idempotent retry (%s)", async (idempotent) => {
    respond({ ...redeemed, idempotent });
    await expect(redeemProCode(options.accessToken, "  some-code  ")).resolves.toEqual({ expiresAt, idempotent });
    expect(fetchMock).toHaveBeenCalledWith("https://itool.tech/api/pro/redeem", expect.objectContaining({
      method: "POST",
      credentials: "omit",
      headers: { Authorization: `Bearer ${options.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "some-code" }),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "malformed_request", "激活码格式不正确"],
    [401, "login_required", "登录已失效"],
    [413, "request_too_large", "激活码内容过长"],
    [422, "invalid_or_unavailable", "激活码无效或已不可用"],
    [429, "rate_limited", "操作太频繁"],
    [503, "temporarily_unavailable", "兑换服务暂时不可用"],
  ] as const)("translates the %i %s rejection", async (status, code, message) => {
    respond({ ok: false, code, message: "untrusted server details" }, status);
    await expect(redeemProCode(options.accessToken, "code")).rejects.toThrow(message);
  });

  it("keeps authentication errors useful even if an intermediary replaces the JSON body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    await expect(redeemProCode(options.accessToken, "code")).rejects.toThrow("登录已失效");
  });

  it.each([
    { ...redeemed, ok: false },
    { ...redeemed, valid: false },
    { ...redeemed, idempotent: undefined },
    { ...redeemed, months: undefined },
    { ...redeemed, plan_expires_at: null },
    { ...redeemed, plan_expires_at: "invalid date" },
    { ...redeemed, plan_expires_at: now },
    { ...redeemed, server_time: undefined },
    { ok: true },
    null,
  ])("never reports activation for an unconfirmed or expired grant: %j", async (body) => {
    respond(body);
    await expect(redeemProCode(options.accessToken, "code")).rejects.toThrow("兑换结果尚未确认");
  });

  it("asks for a new code when a previously redeemed code's membership has expired", async () => {
    respond({ ...redeemed, plan_expires_at: "2026-09-19T10:00:00.000Z", idempotent: true });
    await expect(redeemProCode(options.accessToken, "used-code")).rejects.toThrow("此激活码已兑换且权益已到期，请使用新的激活码");
  });

  it("does not depend on the device clock to validate the server's grant", async () => {
    vi.setSystemTime(new Date("2030-01-01"));
    respond(redeemed);
    await expect(redeemProCode(options.accessToken, "code")).resolves.toEqual({ expiresAt, idempotent: false });
  });

  it("rejects missing authentication and empty codes before sending any request", async () => {
    await expect(redeemProCode("", "code")).rejects.toThrow("登录已失效");
    await expect(redeemProCode(options.accessToken, " \n ")).rejects.toThrow("请输入激活码");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports network errors without exposing request details or pretending activation succeeded", async () => {
    fetchMock.mockRejectedValueOnce(new Error("request containing a secret failed"));
    await expect(redeemProCode(options.accessToken, "code")).rejects.toThrow("网络连接失败，请检查网络后重试");
  });

  it("bounds a stalled request and aborts it", async () => {
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const result = expect(redeemProCode(options.accessToken, "code")).rejects.toThrow("请求超时");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("also times out when headers arrive but the response body stalls", async () => {
    let response: Response | undefined;
    fetchMock.mockImplementationOnce(async (_url, init) => {
      response = new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      }));
      return response;
    });
    const result = expect(redeemProCode(options.accessToken, "code")).rejects.toThrow("请求超时，请稍后重试");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(response?.bodyUsed).toBe(true);
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });
});
