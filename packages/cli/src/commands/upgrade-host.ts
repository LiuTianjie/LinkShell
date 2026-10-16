import type { GatewayStatus, MachineInfo } from "@linkshell/wire";
import { ensureHostRunning, resolveGateway, withRunningHost } from "./host.js";
import * as daemon from "../utils/daemon.js";

interface HostSnapshot {
  machine: MachineInfo;
  gateway: GatewayStatus;
}

function checkIdentity(before: HostSnapshot, after: HostSnapshot): void {
  if (after.machine.machineId !== before.machine.machineId) throw new Error("The restarted host has a different machine identity.");
  if (before.gateway.machine && after.gateway.machine?.id !== before.gateway.machine.id) throw new Error("The restarted host has different gateway keys.");
  if (before.gateway.account && after.gateway.account?.userId !== before.gateway.account.userId) throw new Error("The restarted host has not rejoined its account.");
  if (before.gateway.devices.some((device) => !after.gateway.devices.some((saved) => saved.id === device.id))) {
    throw new Error("The restarted host is missing a previously paired device.");
  }
}

/** Runs in the installed CLI, including when a second upgrade repairs an older host. */
export async function upgradeRunningHost(version: string): Promise<void> {
  const before = await withRunningHost(async (client) => ({
    machine: await client.call("machine.info", {}, 3000),
    gateway: await client.call("gateway.status", {}, 3000),
  }));
  if (!before) {
    process.stderr.write(`  Host is stopped; its next start will use ${version}.\n`);
    return;
  }
  if (before.machine.hostVersion !== version) {
    const pid = daemon.readPid("host");
    if (!pid) throw new Error("The running host has no PID file; could not restart it safely.");
    const env = { ...process.env, ...daemon.readHostLaunch(pid) };
    // Older hosts did not save launch options. Keep even an environment-only
    // gateway choice while continuing to use the same home, keys and login.
    if ((before.gateway.url ?? "off") !== (resolveGateway(daemon.linkshellDir()) ?? "off")) {
      env.LINKSHELL_GATEWAY = before.gateway.url ?? "off";
    }
    process.stderr.write(`  Restarting host ${before.machine.hostVersion} → ${version} (running agent turns will stop)...\n`);
    await daemon.stopDaemonAndWait("host", 30_000, pid);
    await ensureHostRunning(env);
  }

  const after = await withRunningHost(async (client) => {
    const machine = await client.call("machine.info", {}, 3000);
    if (machine.hostVersion !== version) throw new Error(`Host is still ${machine.hostVersion}; expected ${version}.`);
    let gateway = await client.call("gateway.status", {}, 3000);
    if (before.gateway.url) {
      const deadline = Date.now() + 30_000;
      while (gateway.status !== "online" && gateway.status !== "off" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        gateway = await client.call("gateway.status", {}, 3000);
      }
      if (gateway.url !== before.gateway.url) throw new Error("The restarted host is connected to a different gateway.");
      if (gateway.status !== "online") {
        throw new Error(`Host ${version} started, but its gateway is ${gateway.status}${gateway.error ? `: ${gateway.error.message}` : ""}. It will keep retrying automatically.`);
      }
    }
    return { machine, gateway };
  });
  if (!after) throw new Error(`Host ${version} stopped before its update could be verified; see ${daemon.getLogFile("host")}`);
  checkIdentity(before, after);
  process.stderr.write(`  Host ${version} is running. Your login and pairings are kept; clients reconnect automatically.\n`);
}
