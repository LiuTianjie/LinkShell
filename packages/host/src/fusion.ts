import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, networkInterfaces, tmpdir } from "node:os";
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

export interface FusionStartResult {
  port: number;
  token: string;
  hosts: string[];
}

export interface FusionShareOptions {
  /** Starts LinkShell.app as the Fusion remote; tests replace it with a fake that dials `parentSock`. */
  launch?: (app: string, args: string[]) => void;
  /** LinkShell.app's path; tests pass anything. */
  app?: () => string | undefined;
  supported?: () => boolean;
  startTimeoutMs?: number;
  readyTimeoutMs?: number;
  home?: () => string;
}

interface ReadyWaiter {
  resolve(port: number): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The host's half of Fusion: keeps `LinkShell --fusion-remote` running and hands it a fresh,
 * single-use token for every `fusion.start`. Secrets travel only over the 0600 unix socket the
 * remote process dials back on, never on its command line (visible to every local user in `ps`).
 */
export class FusionShare {
  private socket?: Socket;
  private server?: Server;
  private socketPath?: string;
  private launching?: Promise<void>;
  private starting?: Promise<FusionStartResult>;
  private waiters: ReadyWaiter[] = [];
  private failLaunch?: (error: Error) => void;
  private readonly opts: Required<Omit<FusionShareOptions, "launch" | "app" | "supported" | "home">> & FusionShareOptions;

  constructor(
    private readonly log: (message: string) => void,
    private readonly screen: Pick<ScreenShare, "access">,
    private readonly iceServers: () => string[] = () => [],
    private readonly turn: () => Promise<TurnCredentials | undefined> | undefined = () => undefined,
    options: FusionShareOptions = {},
  ) {
    this.opts = { startTimeoutMs: 15_000, readyTimeoutMs: 10_000, ...options };
  }

  async start(): Promise<FusionStartResult> {
    if (!(this.opts.supported ?? macAppSupported)()) {
      throw RpcError.app("not_supported", "融合模式目前仅支持连接到 macOS 电脑");
    }
    const app = (this.opts.app ?? shippedApp)();
    if (!app) {
      throw RpcError.app("not_supported", NO_APP);
    }
    const access = await this.screen.access(false);
    if (access.recording === false || access.control === false) {
      // Someone may be at the remote Mac: LinkShell's permission window comes up there.
      await this.screen.access(true).catch(() => undefined);
      const name = access.app || "LinkShell";
      if (access.recording === false) {
        throw RpcError.app("permission_denied", `请先在远端 Mac 的「系统设置 › 隐私与安全性 › 屏幕录制」中允许 ${name}`);
      }
      throw RpcError.app("permission_denied", `请先在远端 Mac 的「系统设置 › 隐私与安全性 › 辅助功能」中允许 ${name}，否则融合窗口无法移动、聚焦或接收输入`);
    }
    // Two starts at once would rotate the token under the first caller; they share one answer.
    this.starting ??= this.issue(app).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  stop(): void {
    const error = RpcError.app("internal", "融合模式已停止");
    this.failLaunch?.(error);
    this.rejectWaiters(error);
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
  }

  private rejectWaiters(error: Error) {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
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

  private async issue(app: string): Promise<FusionStartResult> {
    if (!this.socket || this.socket.destroyed) {
      this.launching ??= this.launch(app).finally(() => {
        this.launching = undefined;
      });
      await this.launching;
    }
    const socket = this.socket;
    if (!socket || socket.destroyed) throw RpcError.app("internal", "远端融合模式进程意外退出");
    const token = randomBytes(24).toString("base64url");
    const ice = await this.buildIceConfig();
    const ready = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(RpcError.app("internal", "远端融合模式服务没有响应，请检查远端 LinkShell 状态"));
      }, this.opts.readyTimeoutMs);
      timer.unref?.();
      this.waiters.push({ resolve, reject, timer });
    });
    socket.write(`${JSON.stringify({ t: "token", token, ice })}\n`);
    const port = await ready;
    return { port, token, hosts: reachableHostAddresses() };
  }

  private onLine(line: string) {
    let message: { t?: string; ready?: boolean; port?: number; pid?: number; message?: string };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.t === "ready" || message.ready === true) {
      const port = typeof message.port === "number" && message.port > 0 && message.port <= 65535 ? message.port : DEFAULT_FUSION_PORT;
      this.log(`[fusion] FusionRemote listening on port ${port} (pid ${message.pid ?? "?"})`);
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(port);
      }
    } else if (message.t === "error") {
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(RpcError.app("internal", message.message || "远端融合模式启动失败"));
      }
    }
  }

  private launch(app: string): Promise<void> {
    this.stop();
    const sockPath = join(tmpdir(), `linkshell-fusion-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
    const home = (this.opts.home ?? (() => process.env.LINKSHELL_HOME || join(homedir(), ".linkshell")))();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const server = createServer();
      this.server = server;
      this.socketPath = sockPath;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.failLaunch = undefined;
        if (this.server === server) {
          server.close();
          this.server = undefined;
          rmSync(sockPath, { force: true });
          this.socketPath = undefined;
        }
        reject(error);
      };
      this.failLaunch = fail;

      const timer = setTimeout(() => {
        fail(RpcError.app("internal", "远端融合模式服务启动超时，请检查远端 LinkShell 状态"));
      }, this.opts.startTimeoutMs);
      timer.unref?.();

      server.once("error", (err) => fail(err));
      server.once("connection", (client) => {
        server.close();
        this.server = undefined;
        rmSync(sockPath, { force: true });
        this.socketPath = undefined;
        if (settled) {
          client.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.failLaunch = undefined;
        this.socket = client;
        const rl = createInterface({ input: client });
        rl.on("line", (line) => this.onLine(line));
        client.on("error", () => undefined);
        client.once("close", () => {
          rl.close();
          if (this.socket === client) {
            this.socket = undefined;
            this.log("[fusion] FusionRemote exited");
            this.rejectWaiters(RpcError.app("internal", "远端融合模式进程意外退出"));
          }
        });
        resolve();
      });

      server.listen(sockPath, () => {
        try {
          chmodSync(sockPath, 0o600);
        } catch {
          // Ignore chmod errors on non-POSIX filesystems.
        }
        const args = ["--fusion-remote", "--port", String(DEFAULT_FUSION_PORT), "--parent-sock", sockPath, "--home", home];
        try {
          (this.opts.launch ?? defaultLaunch)(app, args);
        } catch (error) {
          fail(error as Error);
        }
      });
    });
  }
}

function defaultLaunch(app: string, args: string[]) {
  const child = spawn("/usr/bin/open", ["-n", "-g", "-a", app, "--args", ...args], { stdio: "ignore", detached: true });
  child.once("error", () => undefined);
  child.unref();
}
