import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHostRunning, withRunningHost } from "./host.js";
import { linkshellDir, readHostLaunch, readHostOwner, readPid, stopDaemonAndWait } from "../utils/daemon.js";
import { standaloneBundle } from "../utils/standalone.js";

type Marker = {
  schema: 1;
  app: string;
  machineId: string;
  gatewayKey?: string;
  deviceIds: string[];
  env: NodeJS.ProcessEnv;
};
const markerPath = () => join(linkshellDir(), "desktop-update.json");

/** Called only after the desktop's explicit install confirmation. External hosts are left alone. */
export async function prepareDesktopUpdate(): Promise<void> {
  const app = standaloneBundle();
  if (!app) throw new Error("只有独立 App 可以协调自身更新");
  if (existsSync(markerPath())) throw new Error("上次更新尚未恢复，请先重新打开 LinkShell");
  const pid = readPid("host");
  if (!pid || readHostOwner(pid) !== app) return;
  const before = await withRunningHost(async (client) => ({
    machine: await client.call("machine.info", {}, 5000),
    gateway: await client.call("gateway.status", {}, 5000),
  }));
  if (!before) throw new Error("无法确认正在运行的服务状态，更新已暂停");
  const marker: Marker = { schema: 1, app, machineId: before.machine.machineId, gatewayKey: before.gateway.machine?.id, deviceIds: before.gateway.devices.map((d) => d.id), env: readHostLaunch(pid) };
  mkdirSync(linkshellDir(), { recursive: true });
  const temporary = `${markerPath()}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
  renameSync(temporary, markerPath());
  // Keep the recovery marker even on a failed stop; never allow bundle replacement after this fails.
  await stopDaemonAndWait("host", 30_000, pid);
}

/** New app and canceled update both run this, using their own bundled runtime and preserved settings. */
export async function recoverDesktopUpdate(version: string): Promise<void> {
  if (!existsSync(markerPath())) return;
  const marker = JSON.parse(readFileSync(markerPath(), "utf8")) as Marker;
  const app = standaloneBundle();
  if (!app || marker.schema !== 1 || marker.app !== app) return;
  const pid = readPid("host");
  if (pid && readHostOwner(pid) !== app) throw new Error("另一套安装正在运行，未自动替换该服务。请先停止它，再重试恢复。");
  await ensureHostRunning({ ...process.env, ...marker.env, LINKSHELL_APP_BUNDLE: app });
  const after = await withRunningHost(async (client) => ({
    machine: await client.call("machine.info", {}, 5000),
    gateway: await client.call("gateway.status", {}, 5000),
  }));
  if (!after || after.machine.hostVersion !== version) throw new Error("新版 Host 尚未就绪，请查看日志并重试恢复");
  if (after.machine.machineId !== marker.machineId || (marker.gatewayKey && after.gateway.machine?.id !== marker.gatewayKey) || marker.deviceIds.some((id) => !after.gateway.devices.some((device) => device.id === id))) {
    throw new Error("恢复后的身份或配对信息不一致；保留恢复记录，请查看日志");
  }
  unlinkSync(markerPath());
}
