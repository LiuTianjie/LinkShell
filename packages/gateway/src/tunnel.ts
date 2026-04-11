import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import {
  createEnvelope,
  serializeEnvelope,
} from "@linkshell/protocol";
import type { SessionManager } from "./sessions.js";
import type { TokenManager } from "./tokens.js";

const TUNNEL_TIMEOUT = 30_000;
const MAX_TUNNEL_BODY = 10 * 1024 * 1024; // 10MB

export interface PendingTunnelRequest {
  res: ServerResponse;
  headersSent: boolean;
  timeout: ReturnType<typeof setTimeout>;
}

export interface PendingTunnelWs {
  ws: WebSocket;
}

// Module-level maps keyed by requestId
const pendingRequests = new Map<string, PendingTunnelRequest>();
const pendingWsSockets = new Map<string, PendingTunnelWs>();

// Track requestIds per session for cleanup on host disconnect
const sessionRequests = new Map<string, Set<string>>();

function trackRequest(sessionId: string, requestId: string): void {
  let set = sessionRequests.get(sessionId);
  if (!set) {
    set = new Set();
    sessionRequests.set(sessionId, set);
  }
  set.add(requestId);
}

function untrackRequest(sessionId: string, requestId: string): void {
  const set = sessionRequests.get(sessionId);
  if (set) {
    set.delete(requestId);
    if (set.size === 0) sessionRequests.delete(sessionId);
  }
}

function extractToken(req: IncomingMessage, url: URL): string | null {
  // Check Authorization header
  const auth = req.headers.authorization;
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1];
  }
  // Check query param
  const qToken = url.searchParams.get("token");
  if (qToken) return qToken;
  // Check cookie (token-only cookie)
  const cookie = req.headers.cookie;
  if (cookie) {
    const match = cookie.match(/lsh_token=([^;]+)/);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Parse lsh_tunnel cookie: "sessionId:port:token" */
export function parseTunnelCookie(req: IncomingMessage): { sessionId: string; port: number; token: string } | null {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  const match = cookie.match(/lsh_tunnel=([^;]+)/);
  if (!match?.[1]) return null;
  const parts = decodeURIComponent(match[1]).split(":");
  if (parts.length < 3) return null;
  const sessionId = parts[0]!;
  const port = Number(parts[1]);
  const token = parts.slice(2).join(":"); // token may contain colons
  if (!sessionId || isNaN(port) || port < 1 || port > 65535 || !token) return null;
  return { sessionId, port, token };
}

function errorResponse(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "text/plain",
    "access-control-allow-origin": "*",
  });
  res.end(message);
}

export function parseTunnelPath(pathname: string): { sessionId: string; port: number; path: string } | null {
  const match = pathname.match(/^\/tunnel\/([^/]+)\/(\d+)(\/.*)?$/);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return {
    sessionId: match[1]!,
    port,
    path: match[3] || "/",
  };
}

export async function handleTunnelRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionManager,
  tokens: TokenManager,
  parsed: { sessionId: string; port: number; path: string },
  url: URL,
  preAuthToken?: string,
): Promise<void> {
  const { sessionId, port, path } = parsed;

  // Auth
  const token = preAuthToken || extractToken(req, url);
  if (!token || !tokens.owns(token, sessionId)) {
    errorResponse(res, 401, "Unauthorized");
    return;
  }

  // Set auth cookie for subsequent sub-resource requests (root path so /_next/... etc. are covered)
  const cookieVal = encodeURIComponent(`${sessionId}:${port}:${token}`);
  res.setHeader("Set-Cookie", `lsh_tunnel=${cookieVal}; Path=/; HttpOnly; SameSite=Lax`);

  // Validate session & host
  const session = sessions.get(sessionId);
  if (!session || !session.host || session.host.socket.readyState !== session.host.socket.OPEN) {
    errorResponse(res, 502, "Host not connected");
    return;
  }

  const requestId = randomUUID();
  const method = req.method ?? "GET";

  // Read request body
  let body: string | null = null;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_TUNNEL_BODY) {
        errorResponse(res, 413, "Request body too large");
        return;
      }
      chunks.push(buf);
    }
    if (chunks.length > 0) {
      body = Buffer.concat(chunks).toString("base64");
    }
  }

  // Build forwarded headers (strip hop-by-hop)
  const headers: Record<string, string> = {};
  const skipHeaders = new Set(["host", "connection", "upgrade", "transfer-encoding", "keep-alive"]);
  for (const [key, val] of Object.entries(req.headers)) {
    if (!skipHeaders.has(key) && typeof val === "string") {
      headers[key] = val;
    }
  }

  // Reconstruct URL with query string
  const fullUrl = path + (url.search || "");

  // Register pending request
  const pending: PendingTunnelRequest = {
    res,
    headersSent: false,
    timeout: setTimeout(() => {
      pendingRequests.delete(requestId);
      untrackRequest(sessionId, requestId);
      errorResponse(res, 504, "Tunnel request timed out");
    }, TUNNEL_TIMEOUT),
  };
  pendingRequests.set(requestId, pending);
  trackRequest(sessionId, requestId);

  // Send tunnel.request to host
  const envelope = createEnvelope({
    type: "tunnel.request",
    sessionId,
    payload: {
      requestId,
      method,
      url: fullUrl,
      headers,
      body,
      port,
    },
  });
  session.host.socket.send(serializeEnvelope(envelope));

  // Handle client disconnect
  req.on("close", () => {
    const p = pendingRequests.get(requestId);
    if (p) {
      clearTimeout(p.timeout);
      pendingRequests.delete(requestId);
      untrackRequest(sessionId, requestId);
    }
  });
}

export function handleTunnelResponse(payload: {
  requestId: string;
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isFinal: boolean;
}): void {
  const pending = pendingRequests.get(payload.requestId);
  if (!pending) return;

  if (!pending.headersSent) {
    // Merge CORS headers
    const responseHeaders: Record<string, string> = {
      ...payload.headers,
      "access-control-allow-origin": "*",
    };
    pending.res.writeHead(payload.statusCode, responseHeaders);
    pending.headersSent = true;
  }

  // Write body chunk
  if (payload.body) {
    pending.res.write(Buffer.from(payload.body, "base64"));
  }

  if (payload.isFinal) {
    clearTimeout(pending.timeout);
    pendingRequests.delete(payload.requestId);
    pending.res.end();
  }
}

export function handleTunnelWsData(payload: {
  requestId: string;
  data: string;
  isBinary: boolean;
}): void {
  const pending = pendingWsSockets.get(payload.requestId);
  if (!pending) return;
  const buf = Buffer.from(payload.data, "base64");
  pending.ws.send(payload.isBinary ? buf : buf.toString("utf8"));
}

export function handleTunnelWsClose(payload: {
  requestId: string;
  code?: number;
  reason?: string;
}): void {
  const pending = pendingWsSockets.get(payload.requestId);
  if (!pending) return;
  pending.ws.close(payload.code ?? 1000, payload.reason ?? "");
  pendingWsSockets.delete(payload.requestId);
}

export function registerTunnelWs(requestId: string, ws: WebSocket): void {
  pendingWsSockets.set(requestId, { ws });
}

export function removeTunnelWs(requestId: string): void {
  pendingWsSockets.delete(requestId);
}

export function cleanupSessionTunnels(sessionId: string): void {
  const requestIds = sessionRequests.get(sessionId);
  if (!requestIds) return;
  for (const rid of requestIds) {
    const pending = pendingRequests.get(rid);
    if (pending) {
      clearTimeout(pending.timeout);
      errorResponse(pending.res, 502, "Host disconnected");
      pendingRequests.delete(rid);
    }
    const ws = pendingWsSockets.get(rid);
    if (ws) {
      ws.ws.close(1001, "Host disconnected");
      pendingWsSockets.delete(rid);
    }
  }
  sessionRequests.delete(sessionId);
}

export function handleTunnelWsUpgrade(
  ws: WebSocket,
  parsed: { sessionId: string; port: number; path: string },
  url: URL,
  sessions: SessionManager,
  tokens: TokenManager,
): void {
  const { sessionId, port, path } = parsed;

  // Auth from query param or cookie in upgrade request
  const token = url.searchParams.get("token");
  if (!token || !tokens.owns(token, sessionId)) {
    ws.close(4001, "Unauthorized");
    return;
  }

  const session = sessions.get(sessionId);
  if (!session || !session.host || session.host.socket.readyState !== session.host.socket.OPEN) {
    ws.close(4002, "Host not connected");
    return;
  }

  const requestId = randomUUID();
  const fullUrl = path + (url.search || "");

  // Register this WS so host responses route here
  registerTunnelWs(requestId, ws);
  trackRequest(sessionId, requestId);

  // Send tunnel.request with upgrade header to host
  const envelope = createEnvelope({
    type: "tunnel.request",
    sessionId,
    payload: {
      requestId,
      method: "GET",
      url: fullUrl,
      headers: { "upgrade": "websocket" },
      body: null,
      port,
    },
  });
  session.host.socket.send(serializeEnvelope(envelope));

  // Forward data from browser WS to host
  ws.on("message", (data: Buffer | string) => {
    const s = sessions.get(sessionId);
    if (!s?.host || s.host.socket.readyState !== s.host.socket.OPEN) return;
    const isBinary = typeof data !== "string";
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    const fwd = createEnvelope({
      type: "tunnel.ws.data",
      sessionId,
      payload: {
        requestId,
        data: buf.toString("base64"),
        isBinary,
      },
    });
    s.host.socket.send(serializeEnvelope(fwd));
  });

  ws.on("close", (code, reason) => {
    removeTunnelWs(requestId);
    untrackRequest(sessionId, requestId);
    const s = sessions.get(sessionId);
    if (!s?.host || s.host.socket.readyState !== s.host.socket.OPEN) return;
    const fwd = createEnvelope({
      type: "tunnel.ws.close",
      sessionId,
      payload: {
        requestId,
        code,
        reason: reason?.toString() || "",
      },
    });
    s.host.socket.send(serializeEnvelope(fwd));
  });
}
