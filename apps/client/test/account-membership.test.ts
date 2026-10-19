import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  session: { userId: "account-a" } as { userId: string } | undefined,
  token: vi.fn<() => Promise<string | undefined>>(),
  fetchMembership: vi.fn(),
  redeem: vi.fn(),
}));

vi.mock("../src/lib/account", () => ({
  useAccount: { getState: () => ({ session: harness.session, token: harness.token }) },
}));
vi.mock("@linkshell/client-core", () => ({ fetchProMembership: harness.fetchMembership, redeemProCode: harness.redeem }));

import { loadAccountMembership, redeemAccountCode } from "../src/lib/account-membership";

beforeEach(() => {
  vi.resetAllMocks();
  harness.session = { userId: "account-a" };
  harness.token.mockResolvedValue("fresh-user-token");
  harness.fetchMembership.mockResolvedValue({ plan: "free" });
  harness.redeem.mockResolvedValue({ expiresAt: "2027-01-01T00:00:00Z", idempotent: false });
});

describe("mobile membership account isolation", () => {
  it("uses a refreshed token and the selected account for profile reads and redemption", async () => {
    await expect(loadAccountMembership("account-a")).resolves.toEqual({ plan: "free" });
    expect(harness.fetchMembership).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "fresh-user-token", userId: "account-a" }));
    await redeemAccountCode("account-a", "IT-EXAMPLE");
    expect(harness.redeem).toHaveBeenCalledWith("fresh-user-token", "IT-EXAMPLE");
  });

  it("never submits a code when the account changes during token refresh", async () => {
    harness.token.mockImplementation(async () => {
      harness.session = { userId: "account-b" };
      return "account-b-token";
    });
    await expect(redeemAccountCode("account-a", "IT-EXAMPLE")).rejects.toThrow("账号已切换");
    expect(harness.redeem).not.toHaveBeenCalled();
  });

  it("does not query membership after signing out during token refresh", async () => {
    harness.token.mockImplementation(async () => {
      harness.session = undefined;
      return "stale-token";
    });
    await expect(loadAccountMembership("account-a")).rejects.toThrow("账号已切换");
    expect(harness.fetchMembership).not.toHaveBeenCalled();
  });

  it("asks for sign-in again when no valid token is available", async () => {
    harness.token.mockResolvedValue(undefined);
    await expect(redeemAccountCode("account-a", "IT-EXAMPLE")).rejects.toThrow("登录已失效");
    expect(harness.redeem).not.toHaveBeenCalled();
  });

  it("rejects stale UI belonging to another account before requesting a token", async () => {
    await expect(redeemAccountCode("account-b", "IT-EXAMPLE")).rejects.toThrow("账号已切换");
    expect(harness.token).not.toHaveBeenCalled();
  });
});
