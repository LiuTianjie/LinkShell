import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentFraming } from "./provider-resolver.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export class JsonRpcStdioTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = "";

  constructor(
    private readonly command: string,
    private readonly framing: AgentFraming,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onRequest: (method: string, params: unknown) => Promise<unknown> | unknown,
    private readonly onExit: (message: string) => void,
  ) {}

  start(cwd: string): void {
    if (this.child) return;
    this.child = spawn(this.command, {
      cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      const trimmed = chunk.trim();
      if (trimmed) process.stderr.write(`[agent:stderr] ${trimmed}\n`);
    });
    this.child.on("error", (error) => this.failAll(error.message));
    this.child.on("exit", (code, signal) => {
      this.failAll(`ACP agent exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    });
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.child || this.child.stdin.destroyed) {
      return Promise.reject(new Error("ACP agent is not running"));
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(message);
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill("SIGTERM");
    this.failAll("ACP transport stopped");
  }

  private write(message: JsonRpcMessage): void {
    const raw = JSON.stringify(message);
    if (this.framing === "newline") {
      this.child?.stdin.write(`${raw}\n`);
      return;
    }
    this.child?.stdin.write(`Content-Length: ${Buffer.byteLength(raw, "utf8")}\r\n\r\n${raw}`);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.length > 0) {
      const contentLengthMatch = this.buffer.match(/^Content-Length:\s*(\d+)\r?\n/i);
      if (contentLengthMatch) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        const altHeaderEnd = this.buffer.indexOf("\n\n");
        const end = headerEnd >= 0 ? headerEnd + 4 : altHeaderEnd >= 0 ? altHeaderEnd + 2 : -1;
        if (end < 0) return;
        const length = Number(contentLengthMatch[1]);
        if (this.buffer.length < end + length) return;
        const raw = this.buffer.slice(end, end + length);
        this.buffer = this.buffer.slice(end + length);
        this.dispatch(raw);
        continue;
      }

      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (raw) this.dispatch(raw);
    }
  }

  private dispatch(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const response = message as JsonRpcResponse;
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
      return;
    }

    if ("method" in message && "id" in message) {
      Promise.resolve(this.onRequest(message.method, message.params))
        .then((result) => this.write({ jsonrpc: "2.0", id: message.id, result }))
        .catch((error) => {
          this.write({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
      return;
    }

    if ("method" in message) {
      this.onNotification(message.method, message.params);
    }
  }

  private failAll(message: string): void {
    this.onExit(message);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}
