import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  session: { userId: "account-a" } as { userId: string } | undefined,
  token: vi.fn<() => Promise<string | undefined>>(),
  fetchMembership: vi.fn(),
}));

vi.mock("../src/lib/account", () => ({
  useAccount: { getState: () => ({ session: harness.session, token: harness.token }) },
}));
vi.mock("@linkshell/client-core", () => ({ fetchProMembership: harness.fetchMembership }));

import { loadAccountMembership } from "../src/lib/account-membership";

beforeEach(() => {
  vi.resetAllMocks();
  harness.session = { userId: "account-a" };
  harness.token.mockResolvedValue("fresh-user-token");
  harness.fetchMembership.mockResolvedValue({ plan: "free" });
});

describe("mobile membership account isolation", () => {
  it("reads the entitlement with a refreshed token for the selected account", async () => {
    await expect(loadAccountMembership("account-a")).resolves.toEqual({ plan: "free" });
    expect(harness.fetchMembership).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "fresh-user-token", userId: "account-a" }));
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
    await expect(loadAccountMembership("account-a")).rejects.toThrow("登录已失效");
    expect(harness.fetchMembership).not.toHaveBeenCalled();
  });

  it("rejects stale UI belonging to another account before requesting a token", async () => {
    await expect(loadAccountMembership("account-b")).rejects.toThrow("账号已切换");
    expect(harness.token).not.toHaveBeenCalled();
  });
});

describe("the phone sells nothing", () => {
  // App Store 3.1.1 rules: no purchase link, no itool.tech/pro, no checkout=, no code entry, no price on the phone.
  const screen = readFileSync(resolve(import.meta.dirname, "../src/components/account-membership.tsx"), "utf8");
  it("has no link, purchase URL, code entry or price", () => {
    expect(screen).not.toMatch(/Linking|openURL|TextInput|ITOOL_MEMBERSHIP_URL|itool\.tech\/pro|checkout=|https?:\/\/|¥|\$[0-9]|激活码|链动/);
  });
});
