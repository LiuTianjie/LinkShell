import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { RpcError, type AcpMcpServer, type RpcId } from "@linkshell/wire";

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
type Pending = { id: RpcId; token?: unknown; resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };
type Server = { child: ChildProcessWithoutNullStreams; sessionId?: string; pending: Map<RpcId, Pending>; buffer: string; decoder: StringDecoder; stopped: boolean };

/** An explicitly configured local MCP server, exposed through one ACP server ID. */
export class AcpMcpBridge {
  private readonly servers = new Map<string, Server>();
  constructor(private readonly options: {
    env: NodeJS.ProcessEnv;
    notify(params: unknown): void;
    request(sessionId: string | undefined, method: string, params: unknown, id: RpcId): Promise<unknown>;
  }) {}

  open(config: Extract<AcpMcpServer, { type: "acp" }>, cwd: string): string {
    if (this.servers.size >= 64) throw RpcError.app("busy", "请先关闭不用的 MCP 服务");
    const serverId = randomUUID();
    const child = spawn(config.command, config.args, { cwd, env: { ...this.options.env, ...config.env }, detached: process.platform !== "win32", stdio: "pipe" });
    const server: Server = { child, pending: new Map(), buffer: "", decoder: new StringDecoder("utf8"), stopped: false };
    this.servers.set(serverId, server);
    child.stdout.on("data", (data: Buffer) => {
      server.buffer += server.decoder.write(data);
      if (Buffer.byteLength(server.buffer) > 32 * 1024 * 1024) { this.fail(server, new Error("MCP 消息过大")); child.kill(); return; }
      let newline: number;
      while ((newline = server.buffer.indexOf("\n")) >= 0) {
        const line = server.buffer.slice(0, newline); server.buffer = server.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { void this.receive(serverId, server, obj(JSON.parse(line))).catch(() => {}); }
        catch { this.fail(server, new Error("MCP 服务返回了无效的 JSON")); }
      }
    });
    // Drain diagnostic output without recording credentials or arbitrary tool data.
    child.stderr.resume();
    child.stdin.on("error", (error) => this.fail(server, error));
    child.once("error", (error) => this.fail(server, error));
    child.once("exit", () => this.fail(server, new Error("MCP 服务已退出")));
    return serverId;
  }

  bind(ids: string[], sessionId: string): void { for (const id of ids) { const server = this.servers.get(id); if (server) server.sessionId = sessionId; } }

  async request(raw: unknown, signal: AbortSignal): Promise<unknown> {
    const p = obj(raw), server = typeof p.serverId === "string" ? this.servers.get(p.serverId) : undefined;
    if (!server || server.stopped || typeof p.method !== "string" || (typeof p.requestId !== "number" && typeof p.requestId !== "string")) throw new RpcError(-32602, "未知的 ACP MCP 服务或请求");
    if ([...server.pending.values()].some((entry) => entry.id === p.requestId)) throw new RpcError(-32602, "MCP 请求 ID 仍在使用中");
    if (signal.aborted) throw new RpcError(-32800, "请求已取消");
    const id = p.requestId;
    const params = obj(p.params), meta = obj(params._meta), token = meta.progressToken;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.write(server, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "ACP request cancelled" } });
        server.pending.delete(id); reject(new RpcError(-32800, "请求已取消"));
      };
      signal.addEventListener("abort", abort, { once: true });
      server.pending.set(id, { id: p.requestId as RpcId, token, resolve, reject, cleanup: () => signal.removeEventListener("abort", abort) });
      this.write(server, { jsonrpc: "2.0", id: p.requestId, method: p.method, ...(p.params == null ? {} : { params }) });
    });
  }

  private async receive(serverId: string, server: Server, message: Json): Promise<void> {
    if (typeof message.method === "string") {
      if (typeof message.id === "string" || typeof message.id === "number") {
        try {
          const result = await this.options.request(server.sessionId, message.method, message.params, `mcp:${serverId}:${message.id}`);
          this.write(server, { jsonrpc: "2.0", id: message.id, result });
        } catch (error) {
          this.write(server, { jsonrpc: "2.0", id: message.id, error: error instanceof RpcError ? error.toObject() : { code: -32603, message: "MCP 客户端请求失败" } });
        }
        return;
      }
      const token = obj(message.params).progressToken;
      const recipients = token === undefined ? [...server.pending.values()] : [...server.pending.values()].filter((pending) => pending.token === token);
      for (const pending of recipients) this.options.notify({ serverId, requestId: pending.id, method: message.method,
        ...(message.params == null ? {} : { params: message.params }) });
      return;
    }
    const pending = typeof message.id === "string" || typeof message.id === "number" ? server.pending.get(message.id) : undefined;
    if (!pending) return;
    server.pending.delete(message.id as RpcId); pending.cleanup();
    pending.resolve(Object.hasOwn(message, "result") ? { result: message.result } : { error: message.error });
  }

  private write(server: Server, message: Json): void { if (!server.stopped) server.child.stdin.write(JSON.stringify(message) + "\n"); }
  private fail(server: Server, error: Error): void {
    if (server.stopped) return;
    server.stopped = true;
    for (const pending of server.pending.values()) { pending.cleanup(); pending.reject(error); }
    server.pending.clear();
  }
  async close(sessionId?: string, ids?: string[]): Promise<void> {
    for (const [id, server] of this.servers) {
      if (sessionId && server.sessionId !== sessionId) continue;
      if (ids && !ids.includes(id)) continue;
      this.servers.delete(id); this.fail(server, new Error("MCP 服务已关闭"));
      const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== "win32" && server.child.pid) process.kill(-server.child.pid, signal); else server.child.kill(signal); } catch { /* Already exited. */ } };
      if (server.child.exitCode !== null) { kill("SIGKILL"); continue; }
      kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { kill("SIGKILL"); resolve(); }, 1500);
        server.child.once("exit", () => { clearTimeout(timer); kill("SIGKILL"); resolve(); });
      });
    }
  }
}
