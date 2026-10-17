import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopSnapshot, runDesktop } from "../src/commands/desktop.js";
import { ensureHostRunning, withRunningHost } from "../src/commands/host.js";
import { loadAuth } from "../src/auth.js";
import { runLogin } from "../src/commands/login.js";
import { joinGatewayAfterLogin } from "../src/commands/host.js";
import { readPid, stopDaemonAndWait } from "../src/utils/daemon.js";

vi.mock("../src/auth.js", () => ({ loadAuth: vi.fn() }));
vi.mock("../src/commands/login.js", () => ({ runLogin: vi.fn() }));
vi.mock("../src/commands/host.js", () => ({ joinGatewayAfterLogin: vi.fn(), refreshGateway: vi.fn(), readHostConfig: vi.fn(), writeHostConfig: vi.fn(), ensureHostRunning: vi.fn(), withRunningHost: vi.fn(), silenceSqliteWarning: vi.fn() }));
vi.mock("../src/utils/daemon.js", () => ({ linkshellDir: () => "/isolated", readPid: vi.fn(), readHostOwner: vi.fn(), readHostLaunch: () => ({}), stopDaemonAndWait: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); process.exitCode = 0; });
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

describe("native desktop snapshots", () => {
  it("includes account identity while keeping credentials out of the UI snapshot", async () => {
    vi.mocked(loadAuth).mockReturnValue({ userId: "u1", email: "me@example.com", accessToken: "secret-access", refreshToken: "secret-refresh", expiresAt: 1 });
    const snapshot = await desktopSnapshot("1.0.0");
    expect(snapshot.account).toEqual({ state: "signed-in", userId: "u1", email: "me@example.com" });
    expect(JSON.stringify(snapshot)).not.toContain("secret-");
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
