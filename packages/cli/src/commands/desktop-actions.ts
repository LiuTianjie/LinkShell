import { createRequire } from "node:module";
import { loadAuth } from "../auth.js";
import { refreshMembership } from "../pro-membership.js";
import { linkshellDir, readHostLaunch, readPid, stopDaemonAndWait } from "../utils/daemon.js";
import { gatewayChoice } from "./desktop.js";
import { prepareDesktopUpdate, recoverDesktopUpdate, stopDesktopUpdateHost } from "./desktop-update.js";
import {
  ensureHostRunning,
  followAccountGateway,
  readHostConfig,
  refreshGateway,
  withRunningHost,
  writeHostConfig,
} from "./host.js";
import { applyAccessPassword } from "./password.js";

export type DesktopSidecarActionResult =
  | { kind: "snapshot" }
  | { kind: "json"; payload: unknown };

/**
 * Runs desktop management actions in-process inside the warm Workspace Sidecar,
 * eliminating per-click Node CLI cold starts (and Windows Defender scan latency).
 */
export async function runDesktopSidecarAction(
  version: string,
  name: string,
  input: Record<string, unknown> = {},
): Promise<DesktopSidecarActionResult> {
  switch (name) {
    case "startup": {
      try { await recoverDesktopUpdate(version); }
      catch (error) { throw new Error(`服务恢复需要处理：${error instanceof Error ? error.message : String(error)}`); }
      const running = await withRunningHost(async (client) => {
        await client.call("machine.info", {}, 5_000);
        return true;
      }).catch(() => false);
      if (!running && !readPid("host")) {
        try { await ensureHostRunning(); }
        catch (error) { throw new Error(`后台服务启动失败：${error instanceof Error ? error.message : String(error)}`); }
      }
      return { kind: "snapshot" };
    }
    case "start":
      await ensureHostRunning();
      return { kind: "snapshot" };
    case "stop":
    case "restart": {
      const pid = readPid("host");
      const env = { ...process.env, ...(pid ? readHostLaunch(pid) : {}) };
      await stopDaemonAndWait("host", 30_000, pid ?? undefined);
      if (name === "restart") await ensureHostRunning(env);
      return { kind: "snapshot" };
    }
    case "recover-update":
      await recoverDesktopUpdate(version);
      return { kind: "snapshot" };
    case "prepare-update":
      await prepareDesktopUpdate();
      return { kind: "snapshot" };
    case "stop-update-host":
      await stopDesktopUpdateHost();
      return { kind: "snapshot" };
    case "account-refresh":
      await followAccountGateway((await refreshMembership()).plan);
      return { kind: "snapshot" };
    case "connect-gateway": {
      if (!loadAuth()?.userId) throw new Error("请先登录账号。");
      if (process.env.LINKSHELL_GATEWAY) throw new Error("网关由启动环境指定，请移除 LINKSHELL_GATEWAY 后重新打开 App。");
      const config = readHostConfig(linkshellDir());
      delete config.gateway;
      writeHostConfig(linkshellDir(), config);
      await ensureHostRunning();
      await refreshGateway(15_000);
      return { kind: "snapshot" };
    }
    case "set-gateway": {
      if (process.env.LINKSHELL_GATEWAY) throw new Error("网关由启动环境指定，请移除 LINKSHELL_GATEWAY 后重新打开 App。");
      const gateway = gatewayChoice(input.gateway);
      writeHostConfig(linkshellDir(), { ...readHostConfig(linkshellDir()), gateway });
      await ensureHostRunning();
      await refreshGateway(15_000);
      return { kind: "snapshot" };
    }
    case "set-password": {
      const password = input.password;
      if (typeof password !== "string" || password.length < 4 || password.length > 128) {
        throw new Error("密码需要 4 到 128 位");
      }
      await applyAccessPassword(password);
      return { kind: "snapshot" };
    }
    case "remove-password":
      await applyAccessPassword(undefined);
      return { kind: "snapshot" };
    case "pair":
    case "pair-qr": {
      const result = await withRunningHost(async (client) => {
        const gateway = await client.call("gateway.status", {});
        if (gateway.status !== "online") {
          throw new Error("请先连接网关。官方网关需要登录 iTool 会员账号；自建网关可以免登录配对。");
        }
        return client.call("pairing.start", {}, 20_000);
      });
      if (!result) throw new Error("请先启动本机服务");
      if (name === "pair-qr") {
        const require = createRequire(import.meta.url);
        const QRCode = require("qrcode-terminal/vendor/QRCode") as new (
          type: number,
          level: number,
        ) => { addData(text: string): void; make(): void; modules: boolean[][] };
        const qr = new QRCode(-1, 0);
        qr.addData(result.link);
        qr.make();
        return { kind: "json", payload: { ...result, qr: qr.modules } };
      }
      return { kind: "json", payload: result };
    }
    case "usage": {
      const days = Number(input.days);
      const agent = typeof input.agent === "string" ? input.agent : "all";
      if (![1, 7, 30].includes(days) || !/^[A-Za-z0-9_.-]{1,128}$/.test(agent)) {
        throw new Error("无效的用量筛选条件");
      }
      const result = await withRunningHost((client) =>
        client.call("usage.summary", { days: days as 1 | 7 | 30, agent }, 120_000),
      );
      if (!result) throw new Error("请先启动本机服务");
      return { kind: "json", payload: result };
    }
    default:
      throw new Error("不支持的操作");
  }
}
