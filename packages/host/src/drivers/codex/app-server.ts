import type { ChildProcess } from "node:child_process";
import { spawnAgent as spawn, probeAgent as execFileAsync, stopAgent } from "../../process.js";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { ABANDON, RpcPeer, type RpcId } from "@linkshell/wire";
import { macAppCodexCandidates, windowsDesktopCodexCandidates } from "./installation.js";


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
];

export interface CodexConnectionOptions {
  /** Unix socket path; must stay under the ~104-byte sun_path limit. */
  socketPath: string;
  clientVersion: string;
  onNotification: (method: string, params: unknown) => void;
  /** Server → client requests (approvals). Return ABANDON to leave one to other clients. */
  onRequest: (method: string, params: unknown, id: RpcId) => unknown;
  /** Called when the app-server process or its socket goes away unexpectedly. */
  onDown: (reason: string) => void;
}

export interface CodexAppServerOptions extends CodexConnectionOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
}

/**
 * Where Codex's own background server listens: the one a plain `codex` in a
 * terminal starts and talks to (`codex app-server daemon`), unless it is run
 * with `--no-daemon` or with configuration overrides.
 */
export function sharedServerSocket(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");
}

/** A client connection to an app-server socket. The socket speaks WebSocket; permessage-deflate must be off or the upgrade is reset. */
async function openConnection(options: CodexConnectionOptions, closing: () => boolean): Promise<{ socket: WebSocket; peer: RpcPeer }> {
  const socket = new WebSocket(`ws+unix://${options.socketPath}:/`, { perMessageDeflate: false, handshakeTimeout: 10_000 });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const peer = new RpcPeer({
    send: (text) => socket.send(text),
    onNotification: (method, params) => options.onNotification(method, params),
    onRequest: (method, params, id) => options.onRequest(method, params, id) ?? ABANDON,
    requestTimeoutMs: 60_000,
  });
  socket.on("message", (data) => peer.receive(data.toString()));
  let ready = false;
  socket.on("close", () => {
    peer.close("codex app-server connection closed");
    if (ready && !closing()) options.onDown("codex app-server connection closed");
  });
  // A failure after the handshake arrives as "close" too; this only keeps it from being thrown.
  socket.on("error", () => {});
  try {
    await peer.request("initialize", {
      clientInfo: { name: "linkshell", title: "LinkShell", version: options.clientVersion },
      // experimentalApi: plan mode (`collaborationMode`) and the questions Codex asks (`item/tool/requestUserInput`) need it.
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  peer.notify("initialized", {});
  ready = true;
  return { socket, peer };
}

export async function detectCodex(command = "codex", env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { env, timeout: 10_000 });
    return stdout.trim().replace(/^codex-cli\s+/, "") || undefined;
  } catch {
    return undefined;
  }
}

/** Keep the detected command for every subsequent call, including restarts and auth. */
export async function findCodex(command?: string, env: NodeJS.ProcessEnv = process.env): Promise<{ command: string; version: string } | undefined> {
  const bundled = process.platform === "win32" ? windowsDesktopCodexCandidates(env) : process.platform === "darwin" ? macAppCodexCandidates(env.HOME) : [];
  const candidates = command !== undefined ? [command] : ["codex", ...bundled];
  for (const candidate of candidates) {
    const version = await detectCodex(candidate, env);
    if (version) return { command: candidate, version };
  }
  return undefined;
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
    if (process.platform !== "win32" && existsSync(this.options.socketPath)) rmSync(this.options.socketPath, { force: true });
    const child = spawn(
      this.options.command ?? "codex",
      ["app-server", ...(await featureArgs(this.options.command, this.options.env)), "--listen", process.platform === "win32" ? "stdio://" : `unix://${this.options.socketPath}`],
      { env: this.options.env, windowsHide: true, stdio: [process.platform === "win32" ? "pipe" : "ignore", "pipe", "pipe"] },
    );
    this.child = child;
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    if (process.platform !== "win32") child.stdout?.on("data", () => {});
    const exited = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        const reason = `codex app-server exited (${signal ?? code})${stderrTail ? `: ${stderrTail.trim()}` : ""}`;
        this.peer?.close(reason);
        if (!this.stopping) this.options.onDown(reason);
        reject(new Error(reason));
      });
      child.once("error", (error) => reject(error));
    });
    exited.catch(() => {});
    await Promise.race([process.platform === "win32" ? this.connectStdio(child) : this.connectWhenReady(), exited]);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.peer?.close("stopping");
    this.socket?.close();
    const child = this.child;
    this.child = undefined;
    if (child) await stopAgent(child);
    if (process.platform !== "win32") rmSync(this.options.socketPath, { force: true });
  }

  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.peer) return Promise.reject(new Error("codex app-server is not connected"));
    return this.peer.request<T>(method, params, timeoutMs);
  }

  private async connectStdio(child: ChildProcess): Promise<void> {
    const peer = new RpcPeer({
      send: text => {
        // App-server's JSONL transport omits the JSON-RPC version field.
        const message = JSON.parse(text) as Record<string, unknown>;
        delete message.jsonrpc;
        child.stdin!.write(`${JSON.stringify(message)}\n`);
      },
      onNotification: this.options.onNotification,
      onRequest: (method, params, id) => this.options.onRequest(method, params, id) ?? ABANDON,
      requestTimeoutMs: 60_000,
    });
    this.peer = peer;
    child.stdin!.on("error", error => peer.close(error.message));
    createInterface({ input: child.stdout! }).on("line", line => peer.receive(line));
    await peer.request("initialize", {
      clientInfo: { name: "linkshell", title: "LinkShell", version: this.options.clientVersion },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
    }, 15_000);
    peer.notify("initialized", {});
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
    const { socket, peer } = await openConnection(this.options, () => this.stopping);
    this.socket = socket;
    this.peer = peer;
  }
}

/**
 * A client connection to Codex's own background server, which this host
 * neither starts nor stops. A thread that lives there (opened by a plain
 * `codex`) can't be loaded anywhere else, but any number of clients can be on
 * it there: joining it is how the phone and that terminal share a thread.
 */
export class CodexSharedServer {
  private socket?: WebSocket;
  private peer?: RpcPeer;
  private connecting?: Promise<boolean>;
  private closing = false;

  constructor(private readonly options: CodexConnectionOptions) {}

  /** Connects if that server is running; false when it isn't (it is never started from here). */
  connect(): Promise<boolean> {
    if (this.peer) return Promise.resolve(true);
    if (!existsSync(this.options.socketPath)) return Promise.resolve(false);
    this.closing = false;
    this.connecting ??= openConnection({ ...this.options, onDown: (reason) => this.dropped(reason) }, () => this.closing)
      .then(({ socket, peer }) => {
        this.socket = socket;
        this.peer = peer;
        return true;
      })
      .catch(() => false)
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.peer) return Promise.reject(new Error("Codex's background server is not connected"));
    return this.peer.request<T>(method, params, timeoutMs);
  }

  close(): void {
    this.closing = true;
    this.peer?.close("stopping");
    this.socket?.close();
    this.peer = undefined;
    this.socket = undefined;
  }

  private dropped(reason: string): void {
    this.peer = undefined;
    this.socket = undefined;
    this.options.onDown(reason);
  }
}
