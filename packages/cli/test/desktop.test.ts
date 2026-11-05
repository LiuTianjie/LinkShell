import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopSnapshot, runDesktop } from "../src/commands/desktop.js";
import { ensureHostRunning, withRunningHost } from "../src/commands/host.js";
import { loadAuth } from "../src/auth.js";
import { runLogin } from "../src/commands/login.js";
import { loginWithOAuth, loginWithPassword, openInBrowser } from "../src/commands/sign-in.js";
import { followAccountGateway, joinGatewayAfterLogin } from "../src/commands/host.js";
import { readPid, stopDaemonAndWait } from "../src/utils/daemon.js";
import { cachedMembership, refreshMembership } from "../src/pro-membership.js";
import { Readable } from "node:stream";

vi.mock("../src/auth.js", () => ({ loadAuth: vi.fn() }));
vi.mock("../src/pro-membership.js", () => ({ cachedMembership: vi.fn(), refreshMembership: vi.fn() }));
vi.mock("../src/commands/login.js", () => ({ runLogin: vi.fn() }));
vi.mock("../src/commands/sign-in.js", () => ({ loginWithPassword: vi.fn(), loginWithOAuth: vi.fn(), openInBrowser: vi.fn(), OAUTH_PROVIDERS: ["github", "google"] }));
vi.mock("../src/commands/host.js", () => ({ followAccountGateway: vi.fn(), joinGatewayAfterLogin: vi.fn(), refreshGateway: vi.fn(), readHostConfig: vi.fn(), writeHostConfig: vi.fn(), ensureHostRunning: vi.fn(), withRunningHost: vi.fn(), silenceSqliteWarning: vi.fn() }));
vi.mock("../src/utils/daemon.js", () => ({ linkshellDir: () => "/isolated", readPid: vi.fn(), readHostOwner: vi.fn(), readHostLaunch: () => ({}), stopDaemonAndWait: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks(); process.exitCode = 0;
  vi.mocked(cachedMembership).mockReturnValue({ plan: "unknown", planExpiresAt: null });
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

describe("native desktop snapshots", () => {
  it("adds a bounded QR matrix for native pairing without changing the normal offer", async () => {
    const offer = { code: "123456", link: "linkshell://pair?test", expiresAt: 1234, gateway: "wss://self.example" };
    const call = vi.fn().mockResolvedValueOnce({ status: "online" }).mockResolvedValueOnce(offer);
    vi.mocked(withRunningHost).mockImplementation(async use => use({ call } as never));
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "pair-qr");
    const result = JSON.parse(String(out.mock.calls[0][0]));
    expect(result).toMatchObject(offer);
    expect(result.qr.length).toBeGreaterThanOrEqual(21);
    expect(result.qr.length).toBeLessThanOrEqual(177);
    expect(result.qr.every((row: unknown[]) => row.length === result.qr.length && row.every(cell => typeof cell === "boolean"))).toBe(true);
    expect(runLogin).not.toHaveBeenCalled();
  });
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
  it("no longer accepts activation codes: membership is bought on itool.tech", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "redeem-pro", Readable.from(['{"code":"activation-secret","userId":"u1"}']));
    expect(String(out.mock.calls[0]?.[0])).not.toContain("activation-secret");
    expect(process.exitCode).toBe(1);
  });
  it("refreshes membership only through the explicit account action", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.mocked(refreshMembership).mockResolvedValue({ plan: "pro", planExpiresAt: null });
    await runDesktop("1.0.0", "account-refresh");
    expect(refreshMembership).toHaveBeenCalledTimes(1);
    expect(ensureHostRunning).not.toHaveBeenCalled();
    // A Pro account's computer joins the official gateway without the user finding a button.
    expect(followAccountGateway).toHaveBeenCalledWith("pro");
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
  it("signs in with the email and password given on stdin, and never prints them", async () => {
    vi.mocked(loginWithPassword).mockResolvedValue({ success: true, plan: "free", email: "me@example.com", userId: "u1", accessToken: "secret" });
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "login-password", Readable.from([JSON.stringify({ email: "me@example.com", password: "hunter2-secret" })]));
    expect(loginWithPassword).toHaveBeenCalledWith({ email: "me@example.com", password: "hunter2-secret" });
    expect(joinGatewayAfterLogin).toHaveBeenCalledWith("free");
    expect(out.mock.calls.join("")).not.toMatch(/hunter2|secret/);
    vi.mocked(loginWithPassword).mockClear();
    out.mockClear();
    await runDesktop("1.0.0", "login-password", Readable.from(['{"email":"me@example.com"}']));
    expect(loginWithPassword).not.toHaveBeenCalled();
    expect(JSON.parse(String(out.mock.calls[0]![0])).error).toBe("请输入邮箱和密码。");
    expect(process.exitCode).toBe(1);
  });
  it("prints the provider's link before the result of a GitHub or Google sign-in", async () => {
    vi.mocked(loginWithOAuth).mockImplementation(async ({ open }) => {
      await open?.("https://example.supabase.co/auth/v1/authorize?provider=google");
      return { success: true, plan: "pro", email: "me@example.com", userId: "u1", accessToken: "secret" };
    });
    vi.mocked(withRunningHost).mockResolvedValue(undefined);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runDesktop("1.0.0", "login-oauth", Readable.from([]), { provider: "google" });
    const lines = out.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
    expect(lines[0]).toEqual({ event: "authorize", provider: "google", url: "https://example.supabase.co/auth/v1/authorize?provider=google" });
    expect(lines.at(-1)).toMatchObject({ schema: 1, status: "stopped" });
    expect(openInBrowser).toHaveBeenCalledWith("https://example.supabase.co/auth/v1/authorize?provider=google");
    expect(joinGatewayAfterLogin).toHaveBeenCalledWith("pro");
    out.mockClear();
    await runDesktop("1.0.0", "login-oauth", Readable.from([]), { provider: "gitlab" });
    expect(JSON.parse(String(out.mock.calls[0]![0])).error).toBe("不支持的登录方式");
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

describe("the gateway the window chose", () => {
  it("keeps off and an address of one's own, and refuses what isn't a gateway", async () => {
    const { gatewayChoice } = await import("../src/commands/desktop.js");
    expect(gatewayChoice("off")).toBe("off");
    expect(gatewayChoice(" wss://gw.example.com/ ")).toBe("wss://gw.example.com");
    expect(gatewayChoice("https://gw.example.com:8787")).toBe("https://gw.example.com:8787");
    expect(gatewayChoice("ws://192.168.1.5:8787")).toBe("ws://192.168.1.5:8787");
    expect(() => gatewayChoice("")).toThrow("请输入网关地址");
    expect(() => gatewayChoice("gw.example.com")).toThrow("格式不正确");
    expect(() => gatewayChoice("ftp://gw.example.com")).toThrow("wss://");
    expect(() => gatewayChoice("wss://me:secret@gw.example.com")).toThrow("用户名或密码");
  });
});
