import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDesktopUpdate, recoverDesktopUpdate, stopDesktopUpdateHost } from "../src/commands/desktop-update.js";
import { ensureHostRunning, withRunningHost } from "../src/commands/host.js";
import { readPid, readHostOwner, stopDaemonAndWait } from "../src/utils/daemon.js";
import { standaloneBundle } from "../src/utils/standalone.js";
const state = vi.hoisted(() => ({ home: "" }));
vi.mock("../src/commands/host.js", () => ({ ensureHostRunning: vi.fn(), withRunningHost: vi.fn() }));
vi.mock("../src/utils/standalone.js", () => ({ standaloneBundle: vi.fn() }));
vi.mock("../src/utils/daemon.js", () => ({ linkshellDir: () => state.home, readPid: vi.fn(), readHostOwner: vi.fn(), readHostLaunch: () => ({ LINKSHELL_GATEWAY: "off" }), stopDaemonAndWait: vi.fn() }));
const snapshot = { machine: { machineId: "same-machine", hostVersion: "2.0.0" }, gateway: { machine: { id: "same-key" }, devices: [{ id: "phone" }] } };
beforeEach(() => {
  vi.resetAllMocks(); state.home = mkdtempSync(join(tmpdir(), "linkshell-update-test-"));
  vi.mocked(standaloneBundle).mockReturnValue("/Applications/LinkShell.app");
  vi.mocked(readPid).mockReturnValue(42);
  vi.mocked(readHostOwner).mockReturnValue("/Applications/LinkShell.app");
  vi.mocked(withRunningHost).mockResolvedValue(snapshot);
});
afterEach(() => rmSync(state.home, { recursive: true, force: true }));
const marker = () => join(state.home, "desktop-update.json");
describe("standalone update recovery", () => {
  it("quiesces its failed update before rollback, retaining the recovery marker", async () => {
    await prepareDesktopUpdate(); vi.mocked(stopDaemonAndWait).mockClear();
    await stopDesktopUpdateHost();
    expect(stopDaemonAndWait).toHaveBeenCalledWith("host", 30_000, 42);
    expect(existsSync(marker())).toBe(true);
    vi.mocked(stopDaemonAndWait).mockClear(); vi.mocked(readHostOwner).mockReturnValue("/Other.app");
    await stopDesktopUpdateHost(); expect(stopDaemonAndWait).not.toHaveBeenCalled();
  });
  it("never stops or restarts a host owned by another installation", async () => {
    vi.mocked(readHostOwner).mockReturnValue(undefined);
    await prepareDesktopUpdate(); await recoverDesktopUpdate("2.0.0");
    expect(stopDaemonAndWait).not.toHaveBeenCalled(); expect(ensureHostRunning).not.toHaveBeenCalled(); expect(existsSync(marker())).toBe(false);
  });
  it("persists recovery state before stopping and removes it only after identity verification", async () => {
    vi.mocked(stopDaemonAndWait).mockImplementation(async () => { expect(JSON.parse(readFileSync(marker(), "utf8"))).toMatchObject({ machineId: "same-machine", deviceIds: ["phone"] }); return true; });
    await prepareDesktopUpdate(); await recoverDesktopUpdate("2.0.0");
    expect(ensureHostRunning).toHaveBeenCalledWith(expect.objectContaining({ LINKSHELL_GATEWAY: "off", LINKSHELL_APP_BUNDLE: "/Applications/LinkShell.app" }));
    expect(existsSync(marker())).toBe(false);
  });
  it("retains recovery state after a failed stop or failed startup", async () => {
    vi.mocked(stopDaemonAndWait).mockRejectedValue(new Error("timeout"));
    await expect(prepareDesktopUpdate()).rejects.toThrow("timeout"); expect(existsSync(marker())).toBe(true);
    vi.mocked(ensureHostRunning).mockRejectedValue(new Error("start failed"));
    await expect(recoverDesktopUpdate("2.0.0")).rejects.toThrow("start failed"); expect(existsSync(marker())).toBe(true);
  });
  it("rejects identity changes and retains the marker", async () => {
    await prepareDesktopUpdate();
    vi.mocked(withRunningHost).mockResolvedValue({ ...snapshot, machine: { ...snapshot.machine, machineId: "different" } });
    await expect(recoverDesktopUpdate("2.0.0")).rejects.toThrow("身份或配对"); expect(existsSync(marker())).toBe(true);
  });
  it("does not take over an external host appearing during update", async () => {
    await prepareDesktopUpdate(); vi.mocked(readHostOwner).mockReturnValue("/Other.app");
    await expect(recoverDesktopUpdate("2.0.0")).rejects.toThrow("另一套安装"); expect(ensureHostRunning).not.toHaveBeenCalled();
  });
});
