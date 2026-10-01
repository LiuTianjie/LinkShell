import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import WebSocket from "ws";
import { ABANDON, RpcPeer, type RpcId } from "@linkshell/wire";

const execFileAsync = promisify(execFile);

// Notifications LinkShell never renders; opting out keeps the socket quiet.
const OPT_OUT_NOTIFICATIONS = [
  "account/rateLimits/updated",
  "account/updated",
  "app/list/updated",
  "fs/changed",
  "hook/started",
  "hook/completed",
  "mcpServer/startupStatus/updated",
  "rawResponse/completed",
  "rawResponseItem/completed",
  "remoteControl/status/changed",
  "skills/changed",
  "thread/goal/cleared",
  "thread/goal/updated",
];

export interface CodexAppServerOptions {
  /** Unix socket path; must stay under the ~104-byte sun_path limit. */
  socketPath: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion: string;
  log: (message: string) => void;
  onNotification: (method: string, params: unknown) => void;
  /** Server → client requests (approvals). Return ABANDON to leave one to other clients. */
  onRequest: (method: string, params: unknown, id: RpcId) => unknown;
  /** Called when the app-server process or its socket goes away unexpectedly. */
  onDown: (reason: string) => void;
}

export async function detectCodex(command = "codex", env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { env, timeout: 10_000 });
    return stdout.trim().replace(/^codex-cli\s+/, "") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Features of the installed Codex that LinkShell turns on when they exist:
 * asking the user questions outside plan mode (the phone and the TUI can both
 * answer them). A Codex that doesn't have a feature — or has retired it —
 * refuses to start when asked to enable it, so only what it lists is asked for.
 */
const WANTED_FEATURES = ["default_mode_request_user_input"];

/** The `--enable` arguments for the wanted features this Codex knows and hasn't removed. */
export async function featureArgs(command = "codex", env?: NodeJS.ProcessEnv): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(command, ["features", "list"], { env, timeout: 10_000 });
    return enableArgs(stdout);
  } catch {
    return [];
  }
}

/** From `codex features list` (name, stage, on or off per line). */
export function enableArgs(listing: string): string[] {
  const stages = new Map(
    listing.split("\n").flatMap((line): [string, string][] => {
      const match = /^(\S+)\s+(.*?)\s+(true|false)\s*$/.exec(line.trim());
      return match ? [[match[1]!, match[2]!.trim()]] : [];
    }),
  );
  return WANTED_FEATURES.filter((name) => stages.has(name) && stages.get(name) !== "removed").flatMap((name) => ["--enable", name]);
}

/**
 * Owns one `codex app-server --listen unix://…` process and a client connection
 * to it. The same socket is what `codex --remote` attaches the desktop TUI to,
 * so the TUI and LinkShell are peers on the same threads.
 *
 * The socket speaks WebSocket; permessage-deflate must be off or the upgrade is reset.
 */
export class CodexAppServer {
  private child?: ChildProcess;
  private socket?: WebSocket;
  private peer?: RpcPeer;
  private stopping = false;

  constructor(private readonly options: CodexAppServerOptions) {}

  get socketPath(): string {
    return this.options.socketPath;
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (existsSync(this.options.socketPath)) rmSync(this.options.socketPath, { force: true });
    const child = spawn(
      this.options.command ?? "codex",
      ["app-server", ...(await featureArgs(this.options.command, this.options.env)), "--listen", `unix://${this.options.socketPath}`],
      { env: this.options.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.child = child;
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.stdout?.on("data", () => {});
    const exited = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        const reason = `codex app-server exited (${signal ?? code})${stderrTail ? `: ${stderrTail.trim()}` : ""}`;
        if (!this.stopping) this.options.onDown(reason);
        reject(new Error(reason));
      });
      child.once("error", (error) => reject(error));
    });
    exited.catch(() => {});
    await Promise.race([this.connectWhenReady(), exited]);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.peer?.close("stopping");
    this.socket?.close();
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rmSync(this.options.socketPath, { force: true });
  }

  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.peer) return Promise.reject(new Error("codex app-server is not connected"));
    return this.peer.request<T>(method, params, timeoutMs);
  }

  private async connectWhenReady(): Promise<void> {
    const deadline = Date.now() + 15_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (existsSync(this.options.socketPath)) {
        try {
          await this.connect();
          return;
        } catch (error) {
          lastError = error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `codex app-server did not accept connections: ${lastError instanceof Error ? lastError.message : "timeout"}`,
    );
  }

  private async connect(): Promise<void> {
    const socket = new WebSocket(`ws+unix://${this.options.socketPath}:/`, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const peer = new RpcPeer({
      send: (text) => socket.send(text),
      onNotification: (method, params) => this.options.onNotification(method, params),
      onRequest: (method, params, id) => this.options.onRequest(method, params, id) ?? ABANDON,
      requestTimeoutMs: 60_000,
    });
    socket.on("message", (data) => peer.receive(data.toString()));
    socket.on("close", () => {
      peer.close("codex app-server connection closed");
      if (!this.stopping) this.options.onDown("codex app-server connection closed");
    });
    this.socket = socket;
    this.peer = peer;
    await peer.request("initialize", {
      clientInfo: { name: "linkshell", title: "LinkShell", version: this.options.clientVersion },
      // experimentalApi: plan mode (`collaborationMode`) and the questions Codex asks (`item/tool/requestUserInput`) need it.
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
    });
    peer.notify("initialized", {});
  }
}
