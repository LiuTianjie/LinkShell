import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { RpcError, type RelayIceServer, type TurnCredentials } from "@linkshell/wire";
import { NO_APP, macAppSupported, shippedApp } from "./input.js";
import type { ScreenShare } from "./screen.js";

const DEFAULT_FUSION_PORT = 47391;
const EXCLUDED_IFACE_PREFIXES = ["lo", "awdl", "llw", "bridge", "anpi", "ap", "vmenet", "vnic", "docker"];

function isTailscaleCGNAT(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

/** Non-loopback IPv4 addresses of this Mac, ordered with physical LAN (`en*`) and Tailscale (`100.64/10`) first. */
export function reachableHostAddresses(): string[] {
  const found: Array<{ ip: string; score: number }> = [];
  const seen = new Set<string>();
  for (const [name, list] of Object.entries(networkInterfaces())) {
    const lower = name.toLowerCase();
    if (EXCLUDED_IFACE_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    for (const entry of list ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      const ip = entry.address;
      if (!ip || ip.startsWith("127.") || ip.startsWith("169.254.") || seen.has(ip)) continue;
      seen.add(ip);
      let score = 10;
      if (lower.startsWith("en")) score = 30;
      else if (isTailscaleCGNAT(ip)) score = 25;
      else if (lower.startsWith("utun")) score = 15;
      found.push({ ip, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return found.map((item) => item.ip);
}

export class FusionShare {
  private socket?: Socket;
  private server?: Server;
  private socketPath?: string;
  private port?: number;
  private token?: string;
  private starting?: Promise<{ port: number; token: string; hosts: string[] }>;

  constructor(
    private readonly log: (message: string) => void,
    private readonly screen: ScreenShare,
    private readonly iceServers: () => string[] = () => [],
    private readonly turn: () => Promise<TurnCredentials | undefined> | undefined = () => undefined,
  ) {}

  async start(): Promise<{ port: number; token: string; hosts: string[] }> {
    if (!macAppSupported()) {
      throw RpcError.app("not_supported", "融合模式目前仅支持连接到 macOS 电脑");
    }
    const app = shippedApp();
    if (!app) {
      throw RpcError.app("not_supported", NO_APP);
    }
    const access = await this.screen.access(false);
    if (access.recording === false) {
      await this.screen.access(true).catch(() => undefined);
      throw RpcError.app(
        "permission_denied",
        `请先在远端 Mac 的「系统设置 › 隐私与安全性 › 屏幕录制」中允许 ${access.app || "LinkShell"}`,
      );
    }
    if (this.socket && !this.socket.destroyed && this.port && this.token) {
      return { port: this.port, token: this.token, hosts: reachableHostAddresses() };
    }
    this.starting ??= this.launch(app).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  stop(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    if (this.socketPath) {
      rmSync(this.socketPath, { force: true });
      this.socketPath = undefined;
    }
    this.port = undefined;
    this.token = undefined;
  }

  private async buildIceConfig(): Promise<RelayIceServer[]> {
    const out: RelayIceServer[] = [];
    try {
      const turn = await this.turn();
      if (turn?.servers?.length) out.push(...turn.servers);
    } catch {
      // Proceed with LAN / STUN candidates if TURN lookup fails.
    }
    const stun = this.iceServers().filter(Boolean);
    if (stun.length > 0) out.push({ urls: stun });
    return out;
  }

  private async launch(app: string): Promise<{ port: number; token: string; hosts: string[] }> {
    this.stop();
    const token = randomBytes(24).toString("base64url");
    const sockPath = join(tmpdir(), `linkshell-fusion-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
    const ice = await this.buildIceConfig();

    return new Promise<{ port: number; token: string; hosts: string[] }>((resolve, reject) => {
      let settled = false;
      const server = createServer();
      this.server = server;
      this.socketPath = sockPath;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stop();
        reject(error);
      };

      const timer = setTimeout(() => {
        fail(RpcError.app("internal", "远端融合模式服务启动超时，请检查远端 LinkShell 状态"));
      }, 15_000);
      timer.unref?.();

      server.once("error", (err) => fail(err));
      server.once("connection", (client) => {
        server.close();
        this.server = undefined;
        rmSync(sockPath, { force: true });
        this.socketPath = undefined;
        this.socket = client;

        const rl = createInterface({ input: client });
        rl.once("line", (line) => {
          rl.close();
          if (settled) return;
          try {
            const parsed = JSON.parse(line) as { ready?: boolean; port?: number; pid?: number };
            const boundPort = typeof parsed.port === "number" && parsed.port > 0 && parsed.port <= 65535 ? parsed.port : DEFAULT_FUSION_PORT;
            settled = true;
            clearTimeout(timer);
            this.port = boundPort;
            this.token = token;
            this.log(`[fusion] FusionRemote ready on port ${boundPort} (pid ${parsed.pid ?? "?"})`);
            resolve({ port: boundPort, token, hosts: reachableHostAddresses() });
          } catch {
            fail(RpcError.app("internal", "远端融合模式握手响应无效"));
          }
        });

        client.on("error", () => undefined);
        client.once("close", () => {
          if (this.socket === client) {
            this.socket = undefined;
            this.port = undefined;
            this.token = undefined;
            this.log("[fusion] FusionRemote exited");
          }
          if (!settled) {
            fail(RpcError.app("internal", "远端融合模式进程意外退出"));
          }
        });
      });

      server.listen(sockPath, () => {
        try {
          chmodSync(sockPath, 0o600);
        } catch {
          // Ignore chmod errors on non-POSIX filesystems.
        }
        const args = [
          "-n",
          "-g",
          "-a",
          app,
          "--args",
          "--fusion-remote",
          "--port",
          String(DEFAULT_FUSION_PORT),
          "--token",
          token,
          "--parent-sock",
          sockPath,
        ];
        if (ice.length > 0) {
          args.push("--ice-servers", JSON.stringify(ice));
        }
        const child = spawn("/usr/bin/open", args, { stdio: "ignore", detached: true });
        child.once("error", (err) => fail(err));
        child.unref();
      });
    });
  }
}
