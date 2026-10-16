import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureHostRunning, resolveGateway, withRunningHost } from "../src/commands/host.js";
import { readHostLaunch, readPid, stopDaemonAndWait } from "../src/utils/daemon.js";
import { upgradeRunningHost } from "../src/commands/upgrade-host.js";

vi.mock("../src/commands/host.js", () => ({ ensureHostRunning: vi.fn(), resolveGateway: vi.fn(), withRunningHost: vi.fn() }));
vi.mock("../src/utils/daemon.js", () => ({ readHostLaunch: vi.fn(), readPid: vi.fn(), stopDaemonAndWait: vi.fn(), linkshellDir: () => "/isolated/home", getLogFile: () => "/isolated/home/host.log" }));

const gateway = () => ({ status: "online", url: "wss://gateway.example", machine: { id: "key-1" }, account: { userId: "u1" }, devices: [{ id: "phone-1" }] });
const snapshot = (version: string) => ({ machine: { machineId: "m1", hostVersion: version }, gateway: gateway() });
let before: ReturnType<typeof snapshot> | undefined;
let after: ReturnType<typeof snapshot>;
let started: boolean;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  before = snapshot("1.0.0");
  after = snapshot("2.0.0");
  started = false;
  vi.mocked(readPid).mockReturnValue(1234);
  vi.mocked(readHostLaunch).mockReturnValue({ LINKSHELL_DEV_PORT: "7878", LINKSHELL_MACHINE_NAME: "My computer" });
  vi.mocked(resolveGateway).mockReturnValue("wss://gateway.example");
  vi.mocked(stopDaemonAndWait).mockResolvedValue(true);
  vi.mocked(ensureHostRunning).mockImplementation(async () => { started = true; return "/isolated/home/run/host.sock"; });
  vi.mocked(withRunningHost).mockImplementation(async (use) => {
    const state = started ? after : before;
    if (!state) return undefined;
    return use({ call: async (method: string) => method === "machine.info" ? state.machine : state.gateway } as never);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("switching to the installed host", () => {
  it("waits for the old process to exit and keeps launch settings", async () => {
    let finish!: (stopped: boolean) => void;
    vi.mocked(stopDaemonAndWait).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const upgrade = upgradeRunningHost("2.0.0");
    await vi.waitFor(() => expect(stopDaemonAndWait).toHaveBeenCalled());
    expect(ensureHostRunning).not.toHaveBeenCalled();
    finish(true);
    await upgrade;
    expect(ensureHostRunning).toHaveBeenCalledWith(expect.objectContaining({ LINKSHELL_DEV_PORT: "7878", LINKSHELL_MACHINE_NAME: "My computer" }));
  });

  it("preserves a legacy host's environment-only gateway", async () => {
    vi.mocked(resolveGateway).mockReturnValue(undefined);
    await upgradeRunningHost("2.0.0");
    expect(ensureHostRunning).toHaveBeenCalledWith(expect.objectContaining({ LINKSHELL_GATEWAY: "wss://gateway.example" }));
  });

  it("does not start a stopped host or interrupt one already on this version", async () => {
    before = undefined;
    await upgradeRunningHost("2.0.0");
    before = snapshot("2.0.0");
    await upgradeRunningHost("2.0.0");
    expect(stopDaemonAndWait).not.toHaveBeenCalled();
    expect(ensureHostRunning).not.toHaveBeenCalled();
  });

  it("does not launch another host when shutdown times out", async () => {
    vi.mocked(stopDaemonAndWait).mockRejectedValue(new Error("shutdown timed out"));
    await expect(upgradeRunningHost("2.0.0")).rejects.toThrow("shutdown timed out");
    expect(ensureHostRunning).not.toHaveBeenCalled();
  });

  it("waits for the existing gateway account to reconnect", async () => {
    vi.useFakeTimers();
    after.gateway.status = "connecting";
    const upgrade = upgradeRunningHost("2.0.0");
    await vi.advanceTimersByTimeAsync(500);
    after.gateway.status = "online";
    await vi.advanceTimersByTimeAsync(250);
    await upgrade;
  });

  it.each([
    ["old version", (next: typeof after) => { next.machine.hostVersion = "1.0.0"; }, "expected 2.0.0"],
    ["different machine", (next: typeof after) => { next.machine.machineId = "other"; }, "different machine identity"],
    ["different keys", (next: typeof after) => { next.gateway.machine.id = "other"; }, "different gateway keys"],
    ["different account", (next: typeof after) => { next.gateway.account.userId = "other"; }, "rejoined its account"],
    ["lost pairing", (next: typeof after) => { next.gateway.devices = []; }, "missing a previously paired device"],
    ["different gateway", (next: typeof after) => { next.gateway.url = "wss://other.example"; }, "different gateway"],
  ])("rejects a host with %s", async (_name, change, error) => {
    change(after);
    await expect(upgradeRunningHost("2.0.0")).rejects.toThrow(error);
  });
});
