import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket as NetSocket } from "node:net";

export interface RemotePortRequestPayload {
  reqId: string;
  computerKey: string;
  port: number;
  method: string;
  path: string;
  headers: [string, string][];
  bodyBase64: string;
}

export interface RemotePortProxyOptions {
  dispatch: (payload: RemotePortRequestPayload) => boolean;
  idleMs?: number;
  requestTimeoutMs?: number;
  maxRequestBodyBytes?: number;
}

interface ProxyEntry {
  key: string;
  computerKey: string;
  remotePort: number;
  localPort: number;
  server: HttpServer;
  sockets: Set<NetSocket>;
  idleTimer?: NodeJS.Timeout;
}

interface PendingRequest {
  reqId: string;
  proxyKey: string;
  remotePort: number;
  localPort: number;
  method: string;
  res: ServerResponse;
  timer: NodeJS.Timeout;
}

const DEFAULT_IDLE_MS = 15 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

export function normalizePreviewSubPath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const cleaned = raw.replace(/[\r\n]+/g, "").trim();
  if (!cleaned) return "/";
  if (/^https?:\/\//i.test(cleaned)) {
    try {
      const parsed = new URL(cleaned);
      const sub = `${parsed.pathname || "/"}${parsed.search}${parsed.hash}`;
      return sub.startsWith("/") ? sub : `/${sub}`;
    } catch {
      return "/";
    }
  }
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}

export function validatePreviewPort(raw: unknown, forbiddenPort?: number): number {
  const port = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("无效的预览端口号");
  }
  if (forbiddenPort && port === forbiddenPort) {
    throw new Error("不允许打开工作台内部服务端口");
  }
  return port;
}

function rewriteLoopbackLocation(value: string, remotePort: number, localPort: number): string {
  const pattern = new RegExp(`^http://(?:127\\.0\\.0\\.1|localhost):${remotePort}(?=[/?#]|$)`, "i");
  return value.replace(pattern, `http://127.0.0.1:${localPort}`);
}

function normalizeReplyHeaders(raw: unknown): [string, string][] {
  if (Array.isArray(raw)) {
    const out: [string, string][] = [];
    for (const pair of raw) {
      if (Array.isArray(pair) && pair.length >= 2) {
        out.push([String(pair[0]), String(pair[1])]);
      }
    }
    return out;
  }
  if (raw && typeof raw === "object") {
    const out: [string, string][] = [];
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item !== undefined) out.push([key, String(item)]);
        }
      } else if (val !== undefined) {
        out.push([key, String(val)]);
      }
    }
    return out;
  }
  return [];
}

function writePlainError(res: ServerResponse, status: number, message: string, headOnly = false) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(message, "utf8");
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-length", String(body.byteLength));
  }
  res.end(headOnly ? undefined : body);
}

/**
 * Ephemeral loopback (`127.0.0.1:0`) HTTP bridges for opening remote-host ports in the user's
 * system browser (`[↗ 外部打开]`). Each `(computerKey, remotePort)` pair shares one server so
 * relative asset, API, and redirect URLs keep working across navigations, and tears down after
 * 15 minutes of inactivity or on app quit.
 */
export class RemotePortProxyManager {
  private readonly dispatch: (payload: RemotePortRequestPayload) => boolean;
  private readonly idleMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRequestBodyBytes: number;
  private readonly proxies = new Map<string, ProxyEntry>();
  private readonly inflight = new Map<string, Promise<number>>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: RemotePortProxyOptions) {
    this.dispatch = options.dispatch;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  }

  get activeProxyCount(): number {
    return this.proxies.size;
  }

  async ensureProxy(computerKey: string, remotePort: number): Promise<number> {
    const normalizedComputer = computerKey.trim();
    if (!normalizedComputer || normalizedComputer === "desktop:local") {
      throw new Error("本地计算机端口无需启动远程代理");
    }
    const validPort = validatePreviewPort(remotePort);
    const key = `${normalizedComputer}\n${validPort}`;

    const existing = this.proxies.get(key);
    if (existing && existing.server.listening) {
      this.touchIdle(existing);
      return existing.localPort;
    }

    const creating = this.inflight.get(key);
    if (creating) return creating;

    const promise = this.startProxy(key, normalizedComputer, validPort).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  reply(params: Record<string, unknown>): { ok: boolean } {
    const reqId = typeof params.reqId === "string" ? params.reqId : "";
    if (!reqId) return { ok: false };
    const item = this.pending.get(reqId);
    if (!item) return { ok: false };
    this.pending.delete(reqId);
    clearTimeout(item.timer);

    const owner = this.proxies.get(item.proxyKey);
    if (owner) this.touchIdle(owner);

    const { res } = item;
    if (res.writableEnded || res.destroyed) return { ok: false };

    const rawStatus = typeof params.status === "number" ? Math.trunc(params.status) : undefined;
    const errorText = typeof params.error === "string" && params.error.trim() ? params.error.trim() : undefined;

    if (rawStatus === undefined || rawStatus < 100 || rawStatus > 599) {
      writePlainError(res, 502, errorText ?? "远程端口请求失败", item.method === "HEAD");
      return { ok: true };
    }

    const bodyBuffer =
      typeof params.bodyBase64 === "string" && params.bodyBase64.length > 0
        ? Buffer.from(params.bodyBase64, "base64")
        : errorText && rawStatus >= 500
          ? Buffer.from(errorText, "utf8")
          : Buffer.alloc(0);

    const grouped = new Map<string, { name: string; values: string[] }>();
    for (const [rawName, rawValue] of normalizeReplyHeaders(params.headers)) {
      const name = rawName.trim();
      const lower = name.toLowerCase();
      if (!name || HOP_BY_HOP_HEADERS.has(lower)) continue;
      if (/[\r\n]/.test(name) || /[\r\n]/.test(rawValue)) continue;
      const value =
        lower === "location" ? rewriteLoopbackLocation(rawValue, item.remotePort, item.localPort) : rawValue;
      const bucket = grouped.get(lower);
      if (bucket) bucket.values.push(value);
      else grouped.set(lower, { name, values: [value] });
    }

    res.statusCode = rawStatus;
    for (const { name, values } of grouped.values()) {
      res.setHeader(name, values.length === 1 ? values[0]! : values);
    }

    const bodylessStatus = rawStatus === 204 || rawStatus === 304 || (rawStatus >= 100 && rawStatus < 200);
    if (!bodylessStatus) {
      res.setHeader("content-length", String(bodyBuffer.byteLength));
    }
    if (bodylessStatus || item.method === "HEAD") {
      res.end();
    } else {
      res.end(bodyBuffer);
    }
    return { ok: true };
  }

  stopAll(): void {
    for (const key of Array.from(this.proxies.keys())) {
      this.stopProxy(key);
    }
    for (const [reqId, item] of this.pending) {
      this.pending.delete(reqId);
      clearTimeout(item.timer);
      writePlainError(item.res, 502, "远程端口代理已关闭", item.method === "HEAD");
    }
  }

  private startProxy(key: string, computerKey: string, remotePort: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const sockets = new Set<NetSocket>();
      let entry: ProxyEntry | undefined;

      const server = createHttpServer((req, res) => {
        if (!entry) {
          writePlainError(res, 502, "远程端口代理尚未就绪");
          return;
        }
        this.handleHttpRequest(entry, req, res);
      });

      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });

      const onStartupError = (err: Error) => {
        reject(err);
      };
      server.once("error", onStartupError);

      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", onStartupError);
        const addr = server.address() as AddressInfo | null;
        if (!addr || typeof addr.port !== "number") {
          server.close();
          reject(new Error("无法绑定本地回环预览端口"));
          return;
        }
        entry = {
          key,
          computerKey,
          remotePort,
          localPort: addr.port,
          server,
          sockets,
        };
        server.on("close", () => {
          const current = this.proxies.get(key);
          if (current?.server === server) {
            if (current.idleTimer) clearTimeout(current.idleTimer);
            this.proxies.delete(key);
          }
        });
        this.proxies.set(key, entry);
        this.touchIdle(entry);
        resolve(addr.port);
      });
    });
  }

  private handleHttpRequest(entry: ProxyEntry, req: IncomingMessage, res: ServerResponse): void {
    this.touchIdle(entry);
    const method = (req.method ?? "GET").toUpperCase();
    const path = normalizePreviewSubPath(req.url);

    const headers: [string, string][] = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      headers.push([req.rawHeaders[i]!, req.rawHeaders[i + 1]!]);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > this.maxRequestBodyBytes) {
        aborted = true;
        writePlainError(res, 413, "请求体超过远程端口预览上限 (32 MB)", method === "HEAD");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", () => {
      aborted = true;
    });

    req.on("end", () => {
      if (aborted || res.writableEnded || res.destroyed) return;
      this.touchIdle(entry);
      const body = chunks.length > 0 ? Buffer.concat(chunks, totalBytes) : Buffer.alloc(0);
      const reqId = randomUUID();

      const timer = setTimeout(() => {
        const pending = this.pending.get(reqId);
        if (!pending) return;
        this.pending.delete(reqId);
        writePlainError(pending.res, 502, "远程端口响应超时", pending.method === "HEAD");
      }, this.requestTimeoutMs);
      timer.unref?.();

      this.pending.set(reqId, {
        reqId,
        proxyKey: entry.key,
        remotePort: entry.remotePort,
        localPort: entry.localPort,
        method,
        res,
        timer,
      });

      res.on("close", () => {
        const pending = this.pending.get(reqId);
        if (!pending) return;
        this.pending.delete(reqId);
        clearTimeout(pending.timer);
      });

      const dispatched = this.dispatch({
        reqId,
        computerKey: entry.computerKey,
        port: entry.remotePort,
        method,
        path,
        headers,
        bodyBase64: body.toString("base64"),
      });

      if (!dispatched) {
        this.pending.delete(reqId);
        clearTimeout(timer);
        writePlainError(res, 502, "LinkShell 工作台窗口未就绪，无法转发远程端口请求", method === "HEAD");
      }
    });
  }

  private touchIdle(entry: ProxyEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.stopProxy(entry.key);
    }, this.idleMs);
    entry.idleTimer.unref?.();
  }

  private stopProxy(key: string): void {
    const entry = this.proxies.get(key);
    if (!entry) return;
    this.proxies.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    for (const [reqId, item] of this.pending) {
      if (item.proxyKey !== key) continue;
      this.pending.delete(reqId);
      clearTimeout(item.timer);
      writePlainError(item.res, 502, "远程端口代理已关闭", item.method === "HEAD");
    }
    entry.server.close();
    for (const socket of entry.sockets) {
      socket.destroy();
    }
    entry.sockets.clear();
  }
}
