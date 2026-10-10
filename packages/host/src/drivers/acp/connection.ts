import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { ndJsonStream, type AnyWireMessage } from "@agentclientprotocol/sdk/experimental/v2";
import WebSocket from "ws";
import { RpcPeer, type RpcId } from "@linkshell/wire";

export const ACP_PROTOCOL_VERSION = 1;
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const supported = (value: unknown) => value !== undefined && value !== null && value !== false;

export class AcpProtocolError extends Error {
  constructor(version: unknown, requested = ACP_PROTOCOL_VERSION) {
    super(`这个 Agent 返回了不兼容的 ACP 协议版本（${String(version ?? "未提供")}）；当前启用 ACP ${requested === 2 ? "1 / 2" : "1"}。请使用兼容的 Agent 版本。`);
  }
}

/** Both versions normalize their capability names here, never their wire semantics. */
export interface AcpAgentCapabilities {
  sessions?: boolean;
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean; stdio?: boolean; acp?: boolean };
  sessionCapabilities?: { list?: unknown; resume?: unknown; close?: unknown; fork?: unknown; delete?: unknown; additionalDirectories?: unknown };
  auth?: { logout?: unknown };
  providers?: unknown;
  nes?: unknown;
  positionEncoding?: string;
  _meta?: Record<string, unknown>;
}
export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo?: { name?: string; version?: string };
  authMethods?: { id: string; name?: string; description?: string; type?: string; args?: string[]; env?: Record<string, string> }[];
  _meta?: Record<string, unknown>;
}
export interface AcpConnectionOptions {
  command: string;
  args: string[];
  transport?: { type: "http" | "websocket"; url: string; headers?: Record<string, string> };
  protocolVersion?: 1 | 2;
  experimental?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  clientVersion: string;
  clientMeta?: Record<string, unknown>;
  onUpdate: (sessionId: string, update: unknown) => void;
  onRequest: (method: string, params: unknown, id: RpcId) => unknown;
  onNotification?: (method: string, params: unknown) => void;
  onCancelRequest?: (id: RpcId) => void;
  onExit: (reason: string) => void;
}

/** One version-negotiated ACP connection. Native credentials remain owned by the agent. */
export class AcpConnection {
  private child?: ChildProcess;
  private peer?: RpcPeer;
  private reader?: ReadableStreamDefaultReader<AnyWireMessage>;
  private writer?: WritableStreamDefaultWriter<AnyWireMessage>;
  private stopping = false;
  private closed = false;
  private stderrTail = "";
  initializeResult: AcpInitializeResult = {};
  constructor(private readonly options: AcpConnectionOptions) {}
  get capabilities(): AcpAgentCapabilities { return this.initializeResult.agentCapabilities ?? {}; }
  get alive(): boolean { return !!this.peer && !this.closed && !this.peer.isClosed; }
  get protocolVersion(): 1 | 2 { return this.initializeResult.protocolVersion === 2 ? 2 : 1; }

  async start(): Promise<AcpInitializeResult> {
    this.stopping = false; this.closed = false; this.stderrTail = "";
    const remote = this.options.transport;
    let stream;
    if (remote) {
      const url = new URL(remote.url);
      if (!(remote.type === "http" ? ["http:", "https:"] : ["ws:", "wss:"]).includes(url.protocol)) throw new Error("ACP 服务地址的协议不匹配");
      stream = remote.type === "http"
        ? createHttpStream(remote.url, { headers: remote.headers, maxMessageBytes: 32 * 1024 * 1024 })
        : createWebSocketStream<AnyWireMessage>(remote.url, { headers: remote.headers, WebSocket });
    } else {
      const child = spawn(this.options.command, this.options.args, { env: this.options.env, cwd: this.options.cwd, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      // The SDK codec decodes incrementally: JSON lines and UTF-8 characters may
      // both span stdout buffers. The same codec accepts v2 JSON-RPC batches.
      stream = ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>, { maxMessageBytes: 32 * 1024 * 1024 });
      const stderr = new StringDecoder("utf8");
      child.stderr?.on("data", (chunk: Buffer) => { this.stderrTail = (this.stderrTail + stderr.write(chunk)).slice(-4000); });
      child.once("exit", (code, signal) => this.lost(`${this.options.command} exited (${signal ?? code})${this.stderrTail ? `: ${this.stderrTail.trim().split("\n").slice(-3).join(" | ")}` : ""}`));
      child.once("error", (error) => this.lost(error.message));
    }
    this.reader = stream.readable.getReader();
    this.writer = stream.writable.getWriter() as WritableStreamDefaultWriter<AnyWireMessage>;
    const peer = new RpcPeer({
      send: (text) => { void this.writer!.write(JSON.parse(text) as AnyWireMessage).catch((error: unknown) => this.lost(String(error))); },
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params, id) => this.options.onRequest(method, params, id),
      requestTimeoutMs: 0,
    });
    this.peer = peer;
    void this.read().catch((error: unknown) => this.lost(String(error)));
    const version = this.options.protocolVersion ?? 1;
    const info = { name: "linkshell", title: "LinkShell", version: this.options.clientVersion };
    const auth = { terminal: remote ? false : true };
    const elicitation = { form: {}, url: {} };
    const editor = this.options.experimental !== false ? { nes: { jump: {}, searchAndReplace: {} }, positionEncodings: ["utf-16", "utf-8", "utf-32"] } : {};
    const capabilities = { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth, elicitation,
      session: { notices: {}, compaction: {}, configOptions: { boolean: {} } },
      ...(this.options.experimental !== false ? { subagents: {}, plan: {} } : {}), ...editor,
      _meta: { "subagent-transcript": true, ...this.options.clientMeta } };
    const raw = await peer.request<Json>("initialize", {
      protocolVersion: version,
      clientCapabilities: capabilities, clientInfo: info,
      // Keeping the v1 fields in this first request lets a v1-only agent negotiate
      // down without losing the client's v1 capabilities. Later messages are version-specific.
      ...(version === 2 ? { info, capabilities: { auth: remote ? {} : { terminal: {} }, elicitation, ...editor } } : {}),
    }, 30_000);
    if (raw.protocolVersion !== 1 && !(version === 2 && raw.protocolVersion === 2)) {
      await this.stop(); throw new AcpProtocolError(raw.protocolVersion, version);
    }
    if (raw.protocolVersion === 2) {
      const caps = object(raw.capabilities), session = object(caps.session), prompt = object(session.prompt), mcp = object(session.mcp);
      this.initializeResult = {
        protocolVersion: 2, agentInfo: object(raw.info), _meta: object(raw._meta),
        agentCapabilities: {
          sessions: supported(caps.session),
          loadSession: false,
          promptCapabilities: { image: supported(prompt.image), audio: supported(prompt.audio), embeddedContext: supported(prompt.embeddedContext) },
          mcpCapabilities: { http: supported(mcp.http), stdio: supported(mcp.stdio), acp: supported(mcp.acp), sse: false },
          sessionCapabilities: supported(caps.session) ? { list: {}, resume: {}, close: {}, fork: session.fork, delete: session.delete, additionalDirectories: session.additionalDirectories } : {},
          auth: supported(caps.auth) ? object(caps.auth) : undefined, providers: caps.providers, nes: caps.nes, positionEncoding: typeof caps.positionEncoding === "string" ? caps.positionEncoding : undefined, _meta: object(caps._meta),
        },
        authMethods: (Array.isArray(raw.authMethods) ? raw.authMethods : []).map((entry) => { const method = object(entry); return { ...method, id: String(method.methodId), env: Array.isArray(method.env) ? Object.fromEntries(method.env.map((entry) => [object(entry).name, object(entry).value])) : undefined }; }),
      };
    } else this.initializeResult = raw as AcpInitializeResult;
    return this.initializeResult;
  }

  private async read(): Promise<void> {
    const reader = this.reader!;
    while (!this.closed) {
      const { value, done } = await reader.read();
      if (done) { this.lost("ACP connection closed"); return; }
      this.peer?.receive(JSON.stringify(value));
    }
  }
  private notification(method: string, params: unknown): void {
    const raw = object(params);
    if (method === "$/cancel_request") {
      if (typeof raw.requestId === "string" || typeof raw.requestId === "number") this.options.onCancelRequest?.(raw.requestId);
      return;
    }
    if (method === "_claude/sdkMessage") {
      const message = object(raw.message), value = message.value;
      if (typeof raw.sessionId === "string" && message.type === "active_goal" && (value === null || typeof object(value).condition === "string")) this.options.onUpdate(raw.sessionId, {
        sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { goal: value === null ? null : { objective: String(object(value).condition).trim(), status: "active", iterations: object(value).iterations, lastReason: object(value).last_reason } } } },
      });
      return;
    }
    if (method === "session/update" && typeof raw.sessionId === "string") this.options.onUpdate(raw.sessionId, raw.update);
    else this.options.onNotification?.(method, params);
  }
  private lost(reason: string): void {
    if (this.closed) return;
    this.closed = true; this.peer?.close(reason);
    if (!this.stopping) this.options.onExit(reason);
  }
  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.peer) return Promise.reject(new Error("agent is not running"));
    return this.peer.request<T>(method, params, timeoutMs);
  }
  hasPendingRequest(id: RpcId): boolean { return this.peer?.hasPendingRequest(id) ?? false; }
  notify(method: string, params: unknown): void { this.peer?.notify(method, params); }
  async stop(): Promise<void> {
    this.stopping = true; this.closed = true; this.peer?.close("stopping");
    void this.reader?.cancel().catch(() => {});
    void this.writer?.close().catch(() => {});
    const child = this.child; this.child = undefined;
    if (!child || child.exitCode !== null) return;
    child.stdin?.end(); child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
