import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KeepAwakeManager,
  WINDOWS_KEEP_AWAKE_SCRIPT,
  keepAwakeCommand,
  readKeepAwakeMode,
  writeKeepAwakeMode,
  type KeepAwakeSignals,
} from "../src/keep-awake.js";
import { parseLinuxPowerSupplies, parseMacBattery } from "../src/machine-metrics.js";
import { startHost } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ls-keep-awake-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Smart On-Demand Keep-Awake & Battery Telemetry", () => {
  it("defaults to smart mode and preserves existing config.json keys when persisting mode", () => {
    const home = tempHome();
    expect(readKeepAwakeMode(home)).toBe("smart");

    writeFileSync(join(home, "config.json"), JSON.stringify({ gateway: "https://gateway.itool.tech", setup: "done" }));
    expect(readKeepAwakeMode(home)).toBe("smart");

    writeKeepAwakeMode(home, "always");
    expect(readKeepAwakeMode(home)).toBe("always");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual({
      gateway: "https://gateway.itool.tech",
      setup: "done",
      keepAwake: "always",
    });

    writeKeepAwakeMode(home, "off");
    expect(readKeepAwakeMode(home)).toBe("off");
  });

  it("uses display-sleep-safe OS idle assertions on macOS, Linux, and Windows", () => {
    const mac = keepAwakeCommand("darwin", 4242);
    expect(mac).toEqual({ command: "/usr/bin/caffeinate", args: ["-i", "-w", "4242"] });
    expect(mac?.args).not.toContain("-d");

    const linux = keepAwakeCommand("linux", 4242);
    expect(linux?.command).toBe("systemd-inhibit");
    expect(linux?.args).toContain("--what=idle");
    expect(linux?.args).not.toContain("infinity");
    expect(linux?.args.slice(-3)).toEqual(["sh", "-c", "read _"]);
    expect(linux?.stdinPipe).toBe(true);

    const win = keepAwakeCommand("win32", 4242);
    expect(win?.command).toBe("powershell.exe");
    expect(win?.stdinPipe).toBe(true);
    expect(WINDOWS_KEEP_AWAKE_SCRIPT).toContain("0x80000001");
    expect(WINDOWS_KEEP_AWAKE_SCRIPT).not.toContain("0x80000003");
  });

  it("acquires and releases assertions across smart, always, and off modes", () => {
    const home = tempHome();
    let signals: KeepAwakeSignals = {};
    let spawns = 0;
    let releases = 0;

    const manager = new KeepAwakeManager({
      home,
      signals: () => signals,
      platform: "darwin",
      pid: 9999,
      spawnAssertion: () => {
        spawns++;
        let alive = true;
        return {
          get alive() {
            return alive;
          },
          release() {
            if (alive) {
              alive = false;
              releases++;
            }
          },
        };
      },
    });

    manager.start();
    expect(manager.status()).toEqual({ mode: "smart", active: false });
    expect(spawns).toBe(0);

    // Running session triggers smart assertion.
    signals = { sessionActive: true };
    manager.reconcile();
    expect(manager.status()).toEqual({ mode: "smart", active: true, reason: "session_active" });
    expect(spawns).toBe(1);

    // Switching from sessionActive to goalActive keeps existing assertion without respawning.
    signals = { goalActive: true };
    manager.reconcile();
    expect(manager.status()).toEqual({ mode: "smart", active: true, reason: "goal_active" });
    expect(spawns).toBe(1);

    // Remote connection or active screen also holds assertion.
    signals = { remoteConnected: true };
    manager.reconcile();
    expect(manager.status()).toEqual({ mode: "smart", active: true, reason: "remote_connected" });

    signals = { screenActive: true };
    manager.reconcile();
    expect(manager.status()).toEqual({ mode: "smart", active: true, reason: "screen_active" });

    // Idle releases cleanly.
    signals = {};
    manager.reconcile();
    expect(manager.status()).toEqual({ mode: "smart", active: false });
    expect(releases).toBe(1);

    // Always mode holds even while idle.
    expect(manager.setMode("always")).toEqual({ mode: "always", active: true, reason: "always" });
    expect(spawns).toBe(2);

    // Off mode releases immediately even when work is active.
    signals = { sessionActive: true };
    expect(manager.setMode("off")).toEqual({ mode: "off", active: false });
    expect(releases).toBe(2);

    // Back to smart acquires while work is active, then stop() releases cleanly.
    expect(manager.setMode("smart")).toEqual({ mode: "smart", active: true, reason: "session_active" });
    expect(spawns).toBe(3);
    manager.stop();
    expect(releases).toBe(3);
  });

  it("parses macOS pmset and Linux /sys/class/power_supply battery readings accurately", () => {
    expect(
      parseMacBattery(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=12345)\t24%; discharging; 1:18 remaining present: true\n",
      ),
    ).toEqual({ onBattery: true, percent: 24, charging: false });

    expect(
      parseMacBattery(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=12345)\t88%; charging; 0:31 remaining present: true\n",
      ),
    ).toEqual({ onBattery: false, percent: 88, charging: true });

    expect(
      parseMacBattery(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=12345)\t80%; AC attached; not charging present: true\n",
      ),
    ).toEqual({ onBattery: false, percent: 80, charging: false });

    // Desktop Macs without InternalBattery or unrelated command outputs return undefined.
    expect(parseMacBattery("Now drawing from 'AC Power'\n")).toBeUndefined();
    expect(parseMacBattery("Mach Virtual Memory Statistics: (page size of 16384 bytes)\n")).toBeUndefined();

    expect(
      parseLinuxPowerSupplies([
        { name: "AC", type: "Mains\n", online: "0\n" },
        { name: "BAT0", type: "Battery\n", status: "Discharging\n", capacity: "42\n" },
      ]),
    ).toEqual({ onBattery: true, percent: 42, charging: false });

    expect(
      parseLinuxPowerSupplies([
        { name: "ADP1", type: "Mains\n", online: "1\n" },
        { name: "BAT0", type: "Battery\n", status: "Charging\n", capacity: "91\n" },
      ]),
    ).toEqual({ onBattery: false, percent: 91, charging: true });

    expect(parseLinuxPowerSupplies([{ name: "AC", type: "Mains\n", online: "1\n" }])).toBeUndefined();
  });

  it("exposes machine.keepAwake RPC and reflects mode in machine.metrics", async () => {
    const home = tempHome();
    let activeCount = 0;
    const host = await startHost({
      home,
      version: "test",
      drivers: () => [],
      discoveryIntervalMs: 0,
      log: () => {},
      spawnKeepAwakeAssertion: () => {
        activeCount++;
        let alive = true;
        return {
          get alive() {
            return alive;
          },
          release() {
            if (alive) {
              alive = false;
              activeCount--;
            }
          },
        };
      },
    });
    const client = await connectHost(host.paths.hostSocket);
    try {
      const initial = await client.call("machine.keepAwake", {});
      expect(initial).toEqual({ mode: "smart", active: false });

      const always = await client.call("machine.keepAwake", { mode: "always" });
      expect(always).toEqual({ mode: "always", active: true, reason: "always" });
      expect(activeCount).toBe(1);

      const metrics = await client.call("machine.metrics", {});
      expect(metrics.keepAwake).toEqual({ mode: "always", active: true, reason: "always" });

      const off = await client.call("machine.keepAwake", { mode: "off" });
      expect(off).toEqual({ mode: "off", active: false });
      expect(activeCount).toBe(0);
    } finally {
      client.close();
      await host.stop();
    }
  });
});
