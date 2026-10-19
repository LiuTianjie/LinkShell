import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopSnapshot, runDesktop } from "../src/commands/desktop.js";
import { ensureHostRunning, withRunningHost } from "../src/commands/host.js";
import { loadAuth } from "../src/auth.js";
import { runLogin } from "../src/commands/login.js";
import { joinGatewayAfterLogin } from "../src/commands/host.js";
import { readPid, stopDaemonAndWait } from "../src/utils/daemon.js";
import { cachedMembership, redeemDesktopPro, refreshMembership } from "../src/pro-membership.js";
import { refreshGateway } from "../src/commands/host.js";
import { Readable } from "node:stream";

vi.mock("../src/auth.js", () => ({ loadAuth: vi.fn() }));
vi.mock("../src/pro-membership.js", () => ({ cachedMembership: vi.fn(), redeemDesktopPro: vi.fn(), refreshMembership: vi.fn() }));
vi.mock("../src/commands/login.js", () => ({ runLogin: vi.fn() }));
vi.mock("../src/commands/host.js", () => ({ joinGatewayAfterLogin: vi.fn(), refreshGateway: vi.fn(), readHostConfig: vi.fn(), writeHostConfig: vi.fn(), ensureHostRunning: vi.fn(), withRunningHost: vi.fn(), silenceSqliteWarning: vi.fn() }));
vi.mock("../src/utils/daemon.js", () => ({ linkshellDir: () => "/isolated", readPid: vi.fn(), readHostOwner: vi.fn(), readHostLaunch: () => ({}), stopDaemonAndWait: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks(); process.exitCode = 0;
  vi.mocked(cachedMembership).mockReturnValue({ plan: "unknown", planExpiresAt: null });
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

describe("native desktop snapshots", () => {
  it("generates pairing without requiring account login", async () => {
    const offer = { code: "123456", link: "linkshell://pair?test", expiresAt: 1234, gateway: "wss://self.example" };
    const call = vi.fn().mockResolvedValueOnce({ status: "online" }).mockResolvedValueOnce(offer);
    vi.mocked(withRunningHost).mockImplementation(async use => use({ call } as never));
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "pair");
    expect(call).toHaveBeenCalledWith("pairing.start", {}, 20_000);
    expect(JSON.parse(String(out.mock.calls[0][0]))).toEqual(offer);
    expect(runLogin).not.toHaveBeenCalled();
  });
  it("explains the gateway prerequisite without starting pairing offline", async () => {
    const call = vi.fn().mockResolvedValue({ status: "off" });
    vi.mocked(withRunningHost).mockImplementation(async use => use({ call } as never));
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "pair");
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(out.mock.calls[0][0])).error).toContain("自建网关");
    expect(process.exitCode).toBe(1);
  });
  it("fetches filtered usage without starting or restarting services", async () => {
    const call = vi.fn().mockResolvedValue({ totals: { totalTokens: 123 } });
    vi.mocked(withRunningHost).mockImplementation(async use => use({ call } as never));
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "usage-30-claude");
    expect(call).toHaveBeenCalledWith("usage.summary", { days: 30, agent: "claude" }, 120_000);
    expect(JSON.parse(String(out.mock.calls[0][0]))).toEqual({ totals: { totalTokens: 123 } });
    expect(ensureHostRunning).not.toHaveBeenCalled();
  });
  it("passes custom agent IDs through the desktop usage action", async () => {
    const call = vi.fn().mockResolvedValue({ totals: { totalTokens: 7 } });
    vi.mocked(withRunningHost).mockImplementation(async use => use({ call } as never));
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "usage-7-custom-acp");
    expect(call).toHaveBeenCalledWith("usage.summary", { days: 7, agent: "custom-acp" }, 120_000);
  });
  it("rejects invalid usage filters before making an RPC call", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "usage-999-all");
    expect(withRunningHost).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
  it("includes account identity while keeping credentials out of the UI snapshot", async () => {
    vi.mocked(loadAuth).mockReturnValue({ userId: "u1", email: "me@example.com", accessToken: "secret-access", refreshToken: "secret-refresh", expiresAt: 1 });
    const snapshot = await desktopSnapshot("1.0.0");
    expect(snapshot.account).toEqual({ state: "signed-in", userId: "u1", email: "me@example.com", plan: "unknown", planExpiresAt: null });
    expect(JSON.stringify(snapshot)).not.toContain("secret-");
    expect(refreshMembership).not.toHaveBeenCalled();
  });
  it("reads activation codes only from stdin and preserves success when the host refresh fails", async () => {
    const planExpiresAt = "2027-01-01T00:00:00.000Z";
    vi.mocked(loadAuth).mockReturnValue({ userId: "u1", accessToken: "secret-token", refreshToken: "refresh", expiresAt: 1 });
    vi.mocked(redeemDesktopPro).mockResolvedValue({ redemption: { userId: "u1", idempotent: false, planExpiresAt }, accountWarning: undefined });
    vi.mocked(refreshGateway).mockRejectedValue(new Error("offline"));
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "redeem-pro", Readable.from([JSON.stringify({ code: "activation-secret", userId: "u1" })]));
    expect(redeemDesktopPro).toHaveBeenCalledWith("activation-secret", "u1");
    const result = JSON.parse(String(out.mock.calls[0]?.[0]));
    expect(result.account).toMatchObject({ userId: "u1", plan: "pro", planExpiresAt });
    expect(result.accountWarning).toContain("兑换已成功");
    expect(result.redemption).toMatchObject({ idempotent: false, planExpiresAt });
    expect(JSON.stringify(result)).not.toMatch(/activation-secret|secret-token/);
    expect(process.exitCode).toBe(0);
  });
  it("keeps confirmed redemption available even if the host snapshot fails", async () => {
    vi.mocked(loadAuth).mockReturnValue({ userId: "u1", accessToken: "secret-token", refreshToken: "refresh", expiresAt: 1 });
    vi.mocked(redeemDesktopPro).mockResolvedValue({ redemption: { userId: "u1", idempotent: true, planExpiresAt: "2027-01-01T00:00:00Z" }, accountWarning: undefined });
    vi.mocked(withRunningHost).mockRejectedValue(new Error("host unavailable"));
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "redeem-pro", Readable.from(['{"code":"secret","userId":"u1"}']));
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({ status: "unknown", account: { plan: "pro" }, redemption: { idempotent: true }, accountWarning: expect.stringContaining("兑换已成功") });
    expect(process.exitCode).toBe(0);
  });
  it("rejects malformed redemption input without echoing secrets or calling the API", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "redeem-pro", Readable.from(['{"code":"activation-secret"}']));
    expect(String(out.mock.calls[0]?.[0])).not.toContain("activation-secret");
    expect(redeemDesktopPro).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
  it("refreshes membership only through the explicit account action", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "account-refresh");
    expect(refreshMembership).toHaveBeenCalledTimes(1);
    expect(ensureHostRunning).not.toHaveBeenCalled();
  });
  it("does not connect the gateway when login times out", async () => {
    vi.mocked(runLogin).mockResolvedValue(null);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "login");
    expect(joinGatewayAfterLogin).not.toHaveBeenCalled();
    expect(JSON.parse(String(out.mock.calls[0][0])).error).toContain("登录未完成");
  });
  it("applies the verified account to the running gateway after login", async () => {
    vi.mocked(runLogin).mockResolvedValue({ success: true, plan: "pro", email: "me@example.com", userId: "u1", accessToken: "secret" });
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "login");
    expect(joinGatewayAfterLogin).toHaveBeenCalledWith("pro");
    expect(String(out.mock.calls[0][0])).not.toContain("secret");
  });
  it("does not start a stopped host or invent healthy sections", async () => {
    vi.mocked(withRunningHost).mockResolvedValue(undefined);
    vi.mocked(readPid).mockReturnValue(null);
    const value = await desktopSnapshot("1.0.0");
    expect(value.status).toBe("stopped");
    expect(value).not.toHaveProperty("gateway");
    expect(ensureHostRunning).not.toHaveBeenCalled();
  });
  it("distinguishes a live but unreachable process", async () => {
    vi.mocked(withRunningHost).mockResolvedValue(undefined);
    vi.mocked(readPid).mockReturnValue(123);
    expect((await desktopSnapshot("1.0.0")).status).toBe("unreachable");
  });
  it("preserves pagination so the UI cannot claim a complete session count", async () => {
    const call = vi.fn(async (method: string) => method === "machine.info" ? { hostVersion: "1.0.0" } : method === "gateway.status" ? { status: "off", devices: [] } : { sessions: [{ id: "running" }], nextBefore: 5 });
    vi.mocked(withRunningHost).mockImplementation(async (use) => use({ call } as never));
    const value = await desktopSnapshot("1.0.0");
    expect(value).toMatchObject({ status: "running", hasMoreSessions: true, sessions: [{ id: "running" }], gateway: { status: "off" } });
  });
  it("reports a failed query as unknown instead of reusing a green snapshot", async () => {
    vi.mocked(withRunningHost).mockRejectedValue(new Error("RPC disconnected"));
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "snapshot");
    expect(JSON.parse(String(out.mock.calls[0][0]))).toMatchObject({ status: "unknown", error: "RPC disconnected" });
    expect(process.exitCode).toBe(1);
  });
  it("rejects unrecognized actions before mutating service state", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "delete");
    expect(stopDaemonAndWait).not.toHaveBeenCalled();
    expect(ensureHostRunning).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
