import { loadAuth } from "../auth.js";
import { runLogin } from "./login.js";
import { runLogout } from "./logout.js";
import { joinGatewayAfterLogin, readHostConfig, writeHostConfig, refreshGateway } from "./host.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { standaloneBundle } from "../utils/standalone.js";
import { prepareDesktopUpdate, recoverDesktopUpdate } from "./desktop-update.js";
import { sep } from "node:path";
import { ensureHostRunning, silenceSqliteWarning, withRunningHost } from "./host.js";
import { linkshellDir, readHostLaunch, readHostOwner, readPid, stopDaemonAndWait } from "../utils/daemon.js";

export function installationSource(path: string): "homebrew" | "npm" {
  return path.includes(`${sep}Cellar${sep}linkshell${sep}`) ? "homebrew" : "npm";
}

/** A versioned, read-only snapshot. Missing sections stay unknown, never healthy. */
export async function desktopSnapshot(version: string) {
  let executable = process.argv[1]!;
  try { executable = realpathSync(executable); } catch { /* Retain the launch path for diagnosis. */ }
  const auth = loadAuth();
  const account = auth?.userId ? { state: "signed-in", email: auth.email, userId: auth.userId } : { state: "signed-out" };
  const base = { account, schema: 1, cliVersion: version, home: linkshellDir(), source: standaloneBundle() ? "standalone" : installationSource(executable), executable, hostOwner: readPid("host") ? readHostOwner(readPid("host")!) ?? "external" : "none", appBundle: standaloneBundle() };
  const result = await withRunningHost(async (client) => {
    const machine = await client.call("machine.info", {}, 5000);
    const [gateway, sessions] = await Promise.all([
      client.call("gateway.status", {}, 5000),
      client.call("sessions.list", { limit: 200 }, 5000),
    ]);
    return { machine, gateway, sessions: sessions.sessions, hasMoreSessions: Boolean(sessions.nextBefore) };
  });
  return result ? { ...base, status: "running", ...result } : { ...base, status: readPid("host") ? "unreachable" : "stopped" };
}

export async function runDesktop(version: string, action: string): Promise<void> {
  silenceSqliteWarning();
  try {
    if (action === "pair") {
      const result = await withRunningHost(async client => {
        const gateway = await client.call("gateway.status", {});
        if (gateway.status !== "online") throw new Error("请先连接网关。官方网关需要登录 Pro 账号；自建网关可以免登录配对。");
        return client.call("pairing.start", {}, 20_000);
      });
      if (!result) throw new Error("请先启动本机服务");
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (action.startsWith("usage-")) {
      const match = /^usage-(1|7|30)-(.{1,128})$/.exec(action);
      if (!match) throw new Error("无效的用量筛选条件");
      const result = await withRunningHost(client => client.call("usage.summary", { days: Number(match[1]) as 1 | 7 | 30, agent: match[2]! }, 120_000));
      if (!result) throw new Error("请先启动本机服务");
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (action === "login") {
      const result = await runLogin();
      if (!result) throw new Error("登录未完成或已超时，请重试。");
      await joinGatewayAfterLogin(result.plan);
    }
    else if (action === "logout") await runLogout();
    else if (action === "connect-gateway") {
      if (!loadAuth()?.userId) throw new Error("请先登录账号。");
      if (process.env.LINKSHELL_GATEWAY) throw new Error("网关由启动环境指定，请移除 LINKSHELL_GATEWAY 后重新打开 App。");
      const config = readHostConfig(linkshellDir());
      delete config.gateway;
      writeHostConfig(linkshellDir(), config);
      await ensureHostRunning();
      await refreshGateway(15_000);
    }
    else if (action === "prepare-update") { await prepareDesktopUpdate(); }
    else if (action === "recover-update") { await recoverDesktopUpdate(version); }
    else if (action === "start") await ensureHostRunning();
    else if (action === "stop" || action === "restart") {
      const pid = readPid("host");
      const env = { ...process.env, ...(pid ? readHostLaunch(pid) : {}) };
      await stopDaemonAndWait("host", 30_000, pid ?? undefined);
      if (action === "restart") await ensureHostRunning(env);
    } else if (action !== "snapshot") throw new Error("Unknown desktop action");
    process.stdout.write(`${JSON.stringify(await desktopSnapshot(version))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schema: 1, status: "unknown", error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

export async function openDesktop(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("LinkShell.app is available on macOS only");
  silenceSqliteWarning();
  const { shippedApp } = await import("@linkshell/host");
  const app = shippedApp();
  if (!app) throw new Error("LinkShell.app is missing; reinstall linkshell-cli with optional dependencies enabled");
  // Pass the exact Node and CLI pair: Finder's PATH need not contain the user's package manager.
  await promisify(execFile)("/usr/bin/open", ["-n", "-a", app, "--args", "--dashboard", "--cli-node", process.execPath, ...process.execArgv.flatMap((arg) => ["--cli-arg", arg]), "--cli-script", realpathSync(process.argv[1]!), "--cli-path", process.env.PATH ?? "", "--home", linkshellDir()]);
}
