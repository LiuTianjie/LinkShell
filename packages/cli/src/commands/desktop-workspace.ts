import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { Readable } from "node:stream";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { localWebSocket } from "@linkshell/host/local-transport";
import { isMethodName, machineInfoSchema, rpcMessageSchema, type MachineEntry } from "@linkshell/wire";
import { getValidToken, loadAuth } from "../auth.js";
import { runLogin } from "./login.js";
import { runLogout } from "./logout.js";
import { followAccountGateway, refreshGateway, silenceSqliteWarning } from "./host.js";
import { DesktopClientState, validStorageKey } from "./desktop-workspace-state.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PROXY_BYTES = 40 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".json": "application/json",
};

interface LocalComputer {
  key: "desktop:local";
  gateway: "desktop:local";
  machine: MachineEntry;
}

export interface DesktopWorkspace {
  url: string;
  stop(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new HttpError(415, "请求需要使用 JSON 格式");
  }
  if (Number(request.headers["content-length"]) > MAX_REQUEST_BYTES) throw new HttpError(413, "偏好内容过长");
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_REQUEST_BYTES) throw new HttpError(413, "偏好内容过长");
    chunks.push(bytes);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Request contents may contain private drafts; never echo them. */ }
  throw new HttpError(400, "无效的 JSON 请求");
}

async function loadAssets(directory: string): Promise<Map<string, Buffer>> {
  if (!isAbsolute(directory)) throw new Error("桌面工作台资源目录必须使用绝对路径");
  const assets = new Map<string, Buffer>();
  const root = await realpath(directory);
  const walk = async (path: string, prefix = "") => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(path, entry.name), `${prefix}/${entry.name}`);
      else if (entry.isFile()) assets.set(`${prefix}/${entry.name}`, await readFile(join(path, entry.name)));
    }
  };
  await walk(root);
  if (!assets.has("/index.html")) throw new Error("桌面工作台资源缺失，请重新安装 LinkShell");
  return assets;
}

async function localComputer(target: string, upstreams: Set<WebSocket>): Promise<LocalComputer | undefined> {
  // Query the existing socket directly: discovering this computer never starts a host.
  return new Promise((resolve) => {
    const client = localWebSocket(target, 1_500, { maxPayload: MAX_PROXY_BYTES });
    upstreams.add(client);
    const finish = (computer?: LocalComputer) => {
      clearTimeout(timeout);
      resolve(computer);
      client.terminate();
    };
    const timeout = setTimeout(() => finish(), 3_000);
    client.on("error", () => finish());
    client.on("close", () => { upstreams.delete(client); clearTimeout(timeout); resolve(undefined); });
    client.on("open", () => client.send(JSON.stringify({ jsonrpc: "2.0", id: "desktop-info", method: "machine.info", params: {} })));
    client.on("message", (raw) => {
      try {
        const response: unknown = JSON.parse(raw.toString());
        if (!response || typeof response !== "object" || !("id" in response) || response.id !== "desktop-info") return;
        const parsed = machineInfoSchema.safeParse("result" in response ? response.result : undefined);
        if (!parsed.success) { finish(); return; }
        const info = parsed.data;
        finish({
          key: "desktop:local", gateway: "desktop:local",
          machine: {
            id: info.machineId, name: info.hostname.replace(/\.local$/, ""), platform: info.platform,
            // Local transport uses the host's Unix socket or Windows named pipe.
            signKey: "", boxKey: "", online: true, via: "paired",
          },
        });
      } catch { finish(); }
    });
  });
}

async function account(signal: AbortSignal) {
  const accessToken = await getValidToken({ signal });
  const current = loadAuth();
  if (!current?.userId) return {};
  return {
    userId: current.userId, email: current.email,
    ...(accessToken && current.accessToken === accessToken ? { accessToken } : {}),
  };
}

/** The running host follows a login or logout made here at once, as one made in the app does. */
async function accountChanged(plan?: "pro" | "free"): Promise<void> {
  try {
    if (!(plan && await followAccountGateway(plan))) await refreshGateway(5_000);
  } catch { /* The account itself changed; the host catches up on its next refresh. */ }
}

function proxyHost(client: WebSocket, target: string, upstreams: Set<WebSocket>): void {
  const host = localWebSocket(target, 3_000, { maxPayload: MAX_PROXY_BYTES });
  upstreams.add(host);
  let pending: string[] = [];
  let pendingBytes = 0;
  const fail = (code: number, reason: string) => {
    if (client.readyState === WebSocket.OPEN) client.close(code, reason);
    host.terminate();
    pending = [];
  };
  const forward = (text: string) => {
    if (host.bufferedAmount + Buffer.byteLength(text) > MAX_PROXY_BYTES) {
      fail(1013, "连接繁忙，请重试");
    } else host.send(text, (error) => { if (error) fail(1011, "本机连接已断开"); });
  };
  client.on("message", (raw, binary) => {
    if (binary) { fail(1008, "不支持此消息格式"); return; }
    const text = raw.toString();
    let message;
    try { message = rpcMessageSchema.safeParse(JSON.parse(text)); }
    catch { fail(1008, "无效的 RPC 请求"); return; }
    if (!message.success || typeof message.data.method !== "string") {
      fail(1008, "无效的 RPC 请求"); return;
    }
    const { method, id } = message.data;
    // Unix clients include privileged native-agent shims; this browser is only a normal client.
    if (method.startsWith("desktop.") || !isMethodName(method)) {
      if (id !== undefined && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "不支持此操作" } }));
      }
      return;
    }
    if (host.readyState === WebSocket.CONNECTING) {
      pendingBytes += Buffer.byteLength(text);
      if (pendingBytes > MAX_PROXY_BYTES) { fail(1013, "连接繁忙，请重试"); return; }
      pending.push(text);
    } else if (host.readyState === WebSocket.OPEN) forward(text);
  });
  host.on("open", () => {
    if (client.readyState !== WebSocket.OPEN) { host.terminate(); return; }
    for (const text of pending) {
      if (host.readyState !== WebSocket.OPEN) break;
      forward(text);
    }
    pending = [];
    pendingBytes = 0;
  });
  host.on("message", (data, binary) => {
    if (client.readyState !== WebSocket.OPEN) return;
    const size = Array.isArray(data) ? data.reduce((total, part) => total + part.length, 0) : data.byteLength;
    if (client.bufferedAmount + size > MAX_PROXY_BYTES) { fail(1013, "连接繁忙，请重试"); return; }
    client.send(data, { binary }, (error) => { if (error) host.terminate(); });
  });
  host.on("error", () => fail(1013, "本机服务未运行，请在本机服务中启动"));
  host.on("close", () => {
    upstreams.delete(host);
    pending = [];
    if (client.readyState === WebSocket.OPEN) client.close(1013, "本机服务已断开");
  });
  client.on("error", () => host.terminate());
  client.on("close", () => { pending = []; host.terminate(); });
}

/** A capability-protected UI server owned by the native application's lifetime. */
export async function startDesktopWorkspace(options: { assets: string; home?: string; hostSocket?: string }): Promise<DesktopWorkspace> {
  silenceSqliteWarning();
  const home = options.home ?? process.env.LINKSHELL_HOME ?? join(homedir(), ".linkshell");
  const assets = await loadAssets(options.assets);
  const state = await DesktopClientState.open(home);
  const hostSocket = options.hostSocket ?? (await import("@linkshell/host")).hostPaths(home).hostSocket;
  const capability = randomBytes(32).toString("base64url");
  const secret = Buffer.from(capability);
  const hasToken = (value: string | undefined): boolean => {
    const supplied = Buffer.from(value ?? "");
    return supplied.length === secret.length && timingSafeEqual(supplied, secret);
  };
  let workspaceOrigin = "";
  let workspaceHost = "";
  let previewOrigin = "";
  let previewHost = "";
  let login: Promise<Awaited<ReturnType<typeof runLogin>>> | undefined;
  let loginAbort: AbortController | undefined;
  let stopping: Promise<void> | undefined;
  const peers = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PROXY_BYTES });
  const upstreams = new Set<WebSocket>();
  const sockets = new Set<Socket>();
  const accountAbort = new AbortController();

  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host;
    if (host !== workspaceHost && host !== previewHost) throw new HttpError(403, "来源不受信任");
    if (!request.url?.startsWith("/") || request.url.startsWith("//")) throw new HttpError(400, "无效的请求地址");
    const url = new URL(request.url, workspaceOrigin);
    const path = url.pathname;
    if (host === previewHost) {
      // A preview service worker can only ever own this other origin and /preview/ scope.
      if (!path.startsWith("/preview/")) throw new HttpError(404, "未找到资源");
    } else {
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== workspaceOrigin) throw new HttpError(403, "来源不受信任");
      if (path.startsWith("/desktop/")) {
        if (!hasToken(request.headers.authorization?.replace(/^Bearer /, "")) ||
            !request.headers.authorization?.startsWith("Bearer ")) throw new HttpError(401, "桌面连接已过期，请重新打开工作台");
        // Same-origin GET fetches omit Origin. Mutations always send it in WebKit.
        if (!["GET", "HEAD"].includes(request.method ?? "") && origin !== workspaceOrigin) throw new HttpError(403, "来源不受信任");
        if (request.method === "GET" && path === "/desktop/bootstrap") {
          json(response, 200, { ...state.snapshot(), localComputer: await localComputer(hostSocket, upstreams) }); return;
        }
        if (request.method === "GET" && path === "/desktop/local") {
          json(response, 200, { computer: await localComputer(hostSocket, upstreams) }); return;
        }
        if (request.method === "GET" && path === "/desktop/account") {
          json(response, 200, await account(accountAbort.signal)); return;
        }
        if (request.method === "PUT" && path === "/desktop/storage") {
          const input = await body(request);
          if (!validStorageKey(input.key) || !Object.hasOwn(input, "value")) throw new HttpError(400, "无效的偏好内容");
          try { await state.set(input.key, input.value); }
          catch { throw new HttpError(507, "桌面偏好保存失败，请检查可用空间或缩短内容"); }
          json(response, 200, { ok: true }); return;
        }
        if (request.method === "POST" && path === "/desktop/login") {
          if (!login) {
            loginAbort = new AbortController();
            login = runLogin({ signal: loginAbort.signal }).finally(() => { login = undefined; loginAbort = undefined; });
          }
          const result = await login;
          if (!result?.success) throw new HttpError(409, "登录未完成，请重试");
          await accountChanged(result.plan);
          json(response, 200, await account(accountAbort.signal)); return;
        }
        if (request.method === "POST" && path === "/desktop/logout") {
          loginAbort?.abort();
          await login;
          await runLogout();
          await accountChanged();
          json(response, 200, {}); return;
        }
        throw new HttpError(404, "未找到操作");
      }
      // Never install a preview service worker in the identity-bearing workspace origin.
      if (path.startsWith("/preview/")) throw new HttpError(404, "未找到资源");
    }
    if (!["GET", "HEAD"].includes(request.method ?? "")) throw new HttpError(405, "不支持此请求方法");
    const assetPath = path === "/" ? "/index.html" : path;
    const content = path === "/config.js" ? Buffer.from(`window.__LINKSHELL_CONFIG__ = ${JSON.stringify({ desktop: true, desktopPlatform: process.platform, deployment: "official", previewOrigin })};\n`) : assets.get(assetPath);
    if (!content) throw new HttpError(404, "未找到资源");
    response.writeHead(200, {
      "content-type": MIME[extname(assetPath)] ?? "application/octet-stream", "content-length": content.byteLength,
      "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      ...(host === workspaceHost ? { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : content);
  };
  const server = createServer((request, response) => {
    void serve(request, response).catch((error: unknown) => {
      json(response, error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : "桌面工作台暂时无法完成操作，请重试" });
    });
  });
  server.requestTimeout = 6 * 60_000;
  server.headersTimeout = 10_000;
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, socket, head) => {
    let url: URL;
    try { url = new URL(request.url ?? "", workspaceOrigin); }
    catch { socket.destroy(); return; }
    if (request.headers.host !== workspaceHost || request.headers.origin !== workspaceOrigin ||
        !request.url?.startsWith("/") || request.url.startsWith("//") || url.pathname !== "/desktop/host" ||
        !hasToken(url.searchParams.get("token") ?? undefined)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
    }
    peers.handleUpgrade(request, socket, head, (client) => proxyHost(client, hostSocket, upstreams));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("桌面工作台无法启动");
  workspaceHost = `127.0.0.1:${address.port}`;
  previewHost = `localhost:${address.port}`;
  workspaceOrigin = `http://${workspaceHost}`;
  previewOrigin = `http://${previewHost}`;
  return {
    url: `${workspaceOrigin}/#desktop=${capability}`,
    stop() {
      return stopping ??= (async () => {
        accountAbort.abort();
        loginAbort?.abort();
        for (const client of peers.clients) client.terminate();
        for (const upstream of upstreams) upstream.terminate();
        for (const socket of sockets) socket.destroy();
        await Promise.all([
          new Promise<void>((resolve) => server.close(() => resolve())),
          new Promise<void>((resolve) => peers.close(() => resolve())),
          state.flush(),
        ]);
      })();
    },
  };
}

export async function runDesktopWorkspace(assets: string, input: Readable = process.stdin): Promise<void> {
  let close!: () => void;
  const ended = new Promise<void>((resolve) => { close = resolve; });
  input.once("end", close);
  input.once("close", close);
  input.once("error", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  input.resume();
  if (input.readableEnded || input.destroyed) close();
  let workspace: DesktopWorkspace | undefined;
  try {
    workspace = await startDesktopWorkspace({ assets });
    process.stdout.write(`${JSON.stringify({ url: workspace.url })}\n`);
    await ended;
  } finally {
    input.off("end", close); input.off("close", close); input.off("error", close);
    input.pause();
    process.off("SIGINT", close); process.off("SIGTERM", close);
    await workspace?.stop();
  }
}
