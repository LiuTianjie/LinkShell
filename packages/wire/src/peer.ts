import type { RpcErrorObject, RpcId } from "./rpc.js";
import { RPC_APP_ERROR, RPC_METHOD_NOT_FOUND } from "./rpc.js";

/** An error that crosses the wire as a JSON-RPC error object. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }

  static app(appCode: string, message: string, extra?: Record<string, unknown>): RpcError {
    return new RpcError(RPC_APP_ERROR, message, { code: appCode, ...extra });
  }

  /** The `data.code` of an application error, if any. */
  get appCode(): string | undefined {
    const data = this.data as { code?: unknown } | undefined;
    return typeof data?.code === "string" ? data.code : undefined;
  }

  toObject(): RpcErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

/** Returned by a request handler to leave a request unanswered for good. */
export const ABANDON = Symbol("rpc.abandon");

export type RequestHandler = (
  method: string,
  params: unknown,
  id: RpcId,
) => unknown | Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

export interface RpcPeerOptions {
  /** Sends one serialized JSON-RPC message. */
  send: (text: string) => void;
  onRequest?: RequestHandler;
  onNotification?: NotificationHandler;
  /** Default timeout for outgoing requests; 0 disables it. */
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  method: string;
}

/**
 * Transport-agnostic JSON-RPC 2.0 peer: both sides can issue requests and
 * notifications. Feed incoming text frames to `receive()`.
 */
export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private closed = false;

  constructor(private readonly options: RpcPeerOptions) {}

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(RPC_APP_ERROR, `connection closed (${method})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject, method };
      const limit = timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
      if (limit > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(RPC_APP_ERROR, `${method} timed out after ${limit}ms`, { code: "timeout" }));
        }, limit);
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  receive(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let message: Record<string, unknown> | Record<string, unknown>[];
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (Array.isArray(message)) {
        if (!message.length || message.length > 128) {
          this.write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid JSON-RPC batch" } });
          continue;
        }
        const responses: Record<string, unknown>[] = [];
        void Promise.all(message.map((entry) => Promise.resolve(this.dispatch(entry, (response) => { responses.push(response); }))))
          .then(() => { if (responses.length) this.write(responses); });
      } else void this.dispatch(message);
    }
  }

  /** Rejects every in-flight request; later calls fail immediately. */
  close(reason = "connection closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new RpcError(RPC_APP_ERROR, `${reason} (${entry.method})`, { code: "closed" }));
      this.pending.delete(id);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  hasPendingRequest(id: RpcId): boolean { return this.pending.has(id); }

  private dispatch(message: Record<string, unknown>, respond = (response: Record<string, unknown>) => this.write(response)): void | Promise<void> {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid JSON-RPC request" } });
      return;
    }
    const id = message.id as RpcId | undefined;
    const method = typeof message.method === "string" ? message.method : undefined;

    if (method === undefined) {
      if (id === undefined) return;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      const error = message.error as RpcErrorObject | undefined;
      if (error) entry.reject(new RpcError(error.code, error.message, error.data));
      else entry.resolve(message.result);
      return;
    }

    if (id === undefined) {
      this.options.onNotification?.(method, message.params);
      return;
    }

    const handler = this.options.onRequest;
    if (!handler) {
      respond({ jsonrpc: "2.0", id, error: { code: RPC_METHOD_NOT_FOUND, message: `no handler for ${method}` } });
      return;
    }
    return Promise.resolve()
      .then(() => handler(method, message.params, id))
      .then(
        (result) => {
          if (result === ABANDON) return;
          respond({ jsonrpc: "2.0", id, result: result ?? {} });
        },
        (error: unknown) => {
          const rpcError =
            error instanceof RpcError
              ? error
              : new RpcError(RPC_APP_ERROR, error instanceof Error ? error.message : String(error), { code: "internal" });
          respond({ jsonrpc: "2.0", id, error: rpcError.toObject() });
        },
      );
  }

  private write(message: Record<string, unknown> | Record<string, unknown>[]): void {
    if (this.closed) return;
    try {
      this.options.send(JSON.stringify(message));
    } catch {
      this.close("send failed");
    }
  }
}
