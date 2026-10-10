import { spawn, type ChildProcess } from "node:child_process";
import { RpcPeer, type RpcId } from "@linkshell/wire";

export const ACP_PROTOCOL_VERSION = 1;

export class AcpProtocolError extends Error {
  constructor(version: unknown) {
    super(`这个 Agent 返回了不兼容的 ACP 协议版本（${String(version ?? "未提供")}）；当前支持 ACP ${ACP_PROTOCOL_VERSION}。请使用兼容的 Agent 版本。`);
  }
}

/** The subset of ACP `initialize` results LinkShell reads. */
export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  sessionCapabilities?: {
    list?: unknown;
    resume?: unknown;
    close?: unknown;
    fork?: unknown;
    delete?: unknown;
  };
  _meta?: Record<string, unknown>;
}

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo?: { name?: string; version?: string };
  authMethods?: { id: string; name?: string }[];
  _meta?: Record<string, unknown>;
}

export interface AcpConnectionOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  clientVersion: string;
  /** Namespace extensions implemented by this client for this adapter. */
  clientMeta?: Record<string, unknown>;
  onUpdate: (sessionId: string, update: unknown) => void;
  /** Agent → client requests (session/request_permission, …). */
  onRequest: (method: string, params: unknown, id: RpcId) => unknown;
  onCancelRequest?: (id: RpcId) => void;
  onExit: (reason: string) => void;
}

/**
 * One ACP agent subprocess: JSON-RPC 2.0 over newline-delimited stdio.
 * A single process serves every session of that agent.
 */
export class AcpConnection {
  private child?: ChildProcess;
  private peer?: RpcPeer;
  private stopping = false;
  private stderrTail = "";
  initializeResult: AcpInitializeResult = {};

  constructor(private readonly options: AcpConnectionOptions) {}

  get capabilities(): AcpAgentCapabilities {
    return this.initializeResult.agentCapabilities ?? {};
  }

  get alive(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.peer?.isClosed);
  }

  async start(): Promise<AcpInitializeResult> {
    this.stopping = false;
    const child = spawn(this.options.command, this.options.args, {
      env: this.options.env,
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const peer = new RpcPeer({
      send: (text) => {
        if (child.stdin?.writable) child.stdin.write(`${text}\n`);
      },
      onNotification: (method, params) => {
        if (method === "$/cancel_request") {
          const id = (params as { requestId?: unknown } | undefined)?.requestId;
          if (typeof id === "string" || typeof id === "number") this.options.onCancelRequest?.(id);
          return;
        }
        if (method === "_claude/sdkMessage") {
          const raw = params as { sessionId?: string; message?: { type?: string; value?: { condition?: string; iterations?: number; last_reason?: string } | null } };
          if (raw?.sessionId && raw.message?.type === "active_goal") {
            const value = raw.message.value;
            if (value === null || typeof value?.condition === "string") this.options.onUpdate(raw.sessionId, {
              sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { goal: value === null ? null : {
                objective: value.condition!.trim(), status: "active", iterations: value.iterations, lastReason: value.last_reason,
              } } } },
            });
          }
          return;
        }
        if (method !== "session/update") return;
        const payload = params as { sessionId?: unknown; update?: unknown } | undefined;
        if (typeof payload?.sessionId === "string") this.options.onUpdate(payload.sessionId, payload.update);
      },
      onRequest: (method, params, id) => this.options.onRequest(method, params, id),
      requestTimeoutMs: 0,
    });
    this.peer = peer;

    // stdout chunks can split a JSON line; only hand complete lines to the peer.
    let pending = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const end = pending.lastIndexOf("\n");
      if (end < 0) return;
      const complete = pending.slice(0, end);
      pending = pending.slice(end + 1);
      peer.receive(complete);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    const exited = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        const reason = `${this.options.command} exited (${signal ?? code})${this.stderrTail ? `: ${this.stderrTail.trim().split("\n").slice(-3).join(" | ")}` : ""}`;
        peer.close(reason);
        if (!this.stopping) this.options.onExit(reason);
        reject(new Error(reason));
      });
      child.once("error", (error) => {
        peer.close(error.message);
        reject(error);
      });
    });
    exited.catch(() => {});

    this.initializeResult = await Promise.race([
      peer.request<AcpInitializeResult>(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          // LinkShell doesn't serve files or terminals to the agent: agents use their own tools.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            // Questions for the user (Claude's AskUserQuestion, an MCP server's form) come as
            // forms to fill in. Not `url`: a page to open belongs on the computer, not on a phone.
            elicitation: { form: {} },
            // Ask adapters that support it (Claude's) to stream sub-agents' own
            // messages and tool calls, each stamped with the spawning call.
            _meta: { "subagent-transcript": true, ...this.options.clientMeta },
          },
          clientInfo: { name: "linkshell", title: "LinkShell", version: this.options.clientVersion },
        },
        30_000,
      ),
      exited,
    ]);
    // v2 is still draft and changes turn completion as well as message replay.
    // Accepting it as v1 would silently drop messages and report false idle turns.
    if (this.initializeResult.protocolVersion !== ACP_PROTOCOL_VERSION) {
      await this.stop();
      throw new AcpProtocolError(this.initializeResult.protocolVersion);
    }
    return this.initializeResult;
  }

  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.peer) return Promise.reject(new Error("agent is not running"));
    return this.peer.request<T>(method, params, timeoutMs);
  }

  notify(method: string, params: unknown): void {
    this.peer?.notify(method, params);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    this.peer?.close("stopping");
    if (!child || child.exitCode !== null) return;
    child.stdin?.end();
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
}
