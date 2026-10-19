import { loadAuth } from "../auth.js";
import { runLogin } from "./login.js";
import { runLogout } from "./logout.js";
import { joinGatewayAfterLogin, readHostConfig, writeHostConfig, refreshGateway } from "./host.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { standaloneBundle } from "../utils/standalone.js";
import { prepareDesktopUpdate, recoverDesktopUpdate, stopDesktopUpdateHost } from "./desktop-update.js";
import { sep, join } from "node:path";
import { ensureHostRunning, silenceSqliteWarning, withRunningHost } from "./host.js";
import { linkshellDir, readHostLaunch, readHostOwner, readPid, stopDaemonAndWait } from "../utils/daemon.js";
import { cachedMembership, redeemDesktopPro, refreshMembership } from "../pro-membership.js";

export function installationSource(path: string): "homebrew" | "npm" {
  return path.includes(`${sep}Cellar${sep}linkshell${sep}`) ? "homebrew" : "npm";
}

function desktopAccount() {
  const auth = loadAuth();
  return auth?.userId ? { state: "signed-in", email: auth.email, userId: auth.userId, ...cachedMembership(auth.userId) } : { state: "signed-out" };
}

/** A versioned, read-only snapshot. Missing sections stay unknown, never healthy. */
export async function desktopSnapshot(version: string) {
  let executable = process.argv[1]!;
  try { executable = realpathSync(executable); } catch { /* Retain the launch path for diagnosis. */ }
  const account = desktopAccount();
  const base = { account, schema: 1, cliVersion: version, home: linkshellDir(), source: standaloneBundle() ? "standalone" : installationSource(executable), executable, hostOwner: readPid("host") ? readHostOwner(readPid("host")!) ?? "external" : "none", appBundle: standaloneBundle() };
  const result = await withRunningHost(async (client) => {
    const machine = await client.call("machine.info", {}, 5000);
    const [gateway, sessions] = await Promise.all([
      client.call("gateway.status", {}, 5000),
      client.call("sessions.list", { limit: 200 }, 5000),
    ]);
    const screen = process.platform === "win32" ? await client.call("screen.access", { ask: false }, 8000).catch(() => undefined) : undefined;
    return { machine, gateway, sessions: sessions.sessions, hasMoreSessions: Boolean(sessions.nextBefore), ...(screen ? { screen } : {}) };
  });
  return result ? { ...base, status: "running", ...result } : { ...base, status: readPid("host") ? "unreachable" : "stopped" };
}

async function redemptionInput(input: AsyncIterable<string | Buffer>): Promise<{ code: string; userId: string }> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 4096) throw new Error("激活码内容过长，请检查后重试");
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value?.code === "string" && typeof value?.userId === "string" && value.userId.trim()) return { code: value.code, userId: value.userId };
  } catch { /* Never echo an input that contains the activation code. */ }
  throw new Error("激活码请求无效，请刷新账号后重试");
}

export async function runDesktop(version: string, action: string, input: AsyncIterable<string | Buffer> = process.stdin): Promise<void> {
  silenceSqliteWarning();
  try {
    if (action === "redeem-pro") {
      const { code, userId } = await redemptionInput(input);
      const result = await redeemDesktopPro(code, userId);
      if (loadAuth()?.userId === userId) {
        try {
          const gateway = await refreshGateway(15_000);
          if (gateway && gateway.status !== "online" && gateway.status !== "off") result.accountWarning ??= "兑换已成功，网关尚未连接，请稍后重新连接";
        } catch {
          result.accountWarning ??= "兑换已成功，本机服务暂未刷新，请稍后重新连接网关";
        }
      }
      // A host query failing cannot turn a confirmed redemption into a failed redemption.
      const snapshot = await desktopSnapshot(version).catch(() => {
        result.accountWarning ??= "兑换已成功，本机服务状态暂时无法读取，请稍后刷新";
        return { schema: 1, cliVersion: version, status: "unknown", account: desktopAccount() };
      });
      snapshot.account = desktopAccount();
      if (snapshot.account.state === "signed-in" && "userId" in snapshot.account && snapshot.account.userId === userId) Object.assign(snapshot.account, { plan: "pro", planExpiresAt: result.redemption.planExpiresAt });
      else result.accountWarning = "兑换已成功，登录账号已变更，请切回兑换时的账号查看会员状态";
      process.stdout.write(`${JSON.stringify({ ...snapshot, ...result })}\n`);
      return;
    }
    if (action === "account-refresh") await refreshMembership();
    else if (action === "pair" || action === "pair-qr") {
      const result = await withRunningHost(async client => {
        const gateway = await client.call("gateway.status", {});
        if (gateway.status !== "online") throw new Error("请先连接网关。官方网关需要登录 Pro 账号；自建网关可以免登录配对。");
        return client.call("pairing.start", {}, 20_000);
      });
      if (!result) throw new Error("请先启动本机服务");
      if (action === "pair-qr") {
        // Reuse the encoder already shipped for terminal pairing; the desktop draws the matrix.
        const require = createRequire(import.meta.url);
        const QRCode = require("qrcode-terminal/vendor/QRCode") as new (type: number, level: number) => { addData(text: string): void; make(): void; modules: boolean[][] };
        const qr = new QRCode(-1, 0); // M error correction, matching the Mac pairing card.
        qr.addData(result.link); qr.make();
        process.stdout.write(`${JSON.stringify({ ...result, qr: qr.modules })}\n`);
      } else process.stdout.write(`${JSON.stringify(result)}\n`);
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
    else if (action === "stop-update-host") { await stopDesktopUpdateHost(); }
    else if (action === "start") await ensureHostRunning();
    else if (action === "stop" || action === "restart") {
      const pid = readPid("host");
      const env = { ...process.env, ...(pid ? readHostLaunch(pid) : {}) };
      await stopDaemonAndWait("host", 30_000, pid ?? undefined);
      if (action === "restart") await ensureHostRunning(env);
    } else if (action !== "snapshot" && action !== "account-refresh") throw new Error("Unknown desktop action");
    process.stdout.write(`${JSON.stringify(await desktopSnapshot(version))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schema: 1, status: "unknown", error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

export async function openDesktop(): Promise<void> {
  if (process.platform === "win32") {
    const app = standaloneBundle();
    if (!app) throw new Error("请安装 LinkShell Windows 桌面版，然后从开始菜单打开 LinkShell");
    const child = spawn(join(app, "LinkShell.exe"), [], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return;
  }
  if (process.platform !== "darwin") throw new Error("LinkShell.app is available on macOS only");
  silenceSqliteWarning();
  const { shippedApp } = await import("@linkshell/host");
  const app = shippedApp();
  if (!app) throw new Error("LinkShell.app is missing; reinstall linkshell-cli with optional dependencies enabled");
  // Pass the exact Node and CLI pair: Finder's PATH need not contain the user's package manager.
  await promisify(execFile)("/usr/bin/open", ["-n", "-a", app, "--args", "--dashboard", "--cli-node", process.execPath, ...process.execArgv.flatMap((arg) => ["--cli-arg", arg]), "--cli-script", realpathSync(process.argv[1]!), "--cli-path", process.env.PATH ?? "", "--home", linkshellDir()]);
}
