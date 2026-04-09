import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import {
  createEnvelope,
  serializeEnvelope,
  PROTOCOL_VERSION,
} from "@linkshell/protocol";
import { z, ZodError } from "zod";
import { SessionManager } from "./sessions.js";
import { PairingManager } from "./pairings.js";
import { TokenManager } from "./tokens.js";
import { handleSocketMessage } from "./relay.js";

const port = Number(process.env.PORT ?? 8787);
const logLevel = (process.env.LOG_LEVEL ?? "info") as
  | "debug"
  | "info"
  | "warn"
  | "error";
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level: "debug" | "info" | "warn" | "error", msg: string): void {
  if (LOG_LEVELS[level] >= LOG_LEVELS[logLevel]) {
    process.stdout.write(`[gateway:${level}] ${msg}\n`);
  }
}

const sessionManager = new SessionManager();
const pairingManager = new PairingManager();
const tokenManager = new TokenManager();

const PING_INTERVAL = 20_000;
const MAX_BODY_SIZE = 4096;
const MAX_WS_MESSAGE_SIZE = 50 * 1024 * 1024; // 50MB (supports base64 image uploads)
const PAIRING_RATE_LIMIT_MAX = Number(process.env.PAIRING_RATE_LIMIT_MAX ?? 30);
const PAIRING_RATE_LIMIT_WINDOW_MS = Number(
  process.env.PAIRING_RATE_LIMIT_WINDOW_MS ?? 60_000,
);
const WS_CONNECT_RATE_LIMIT_MAX = Number(
  process.env.WS_CONNECT_RATE_LIMIT_MAX ?? 20,
);
const WS_CONNECT_RATE_LIMIT_WINDOW_MS = Number(
  process.env.WS_CONNECT_RATE_LIMIT_WINDOW_MS ?? 60_000,
);

// ── Rate limiter ────────────────────────────────────────────────────

class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private maxHits: number,
    private windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.maxHits;
  }
}

const pairingLimiter = new RateLimiter(
  PAIRING_RATE_LIMIT_MAX,
  PAIRING_RATE_LIMIT_WINDOW_MS,
);
const wsConnectLimiter = new RateLimiter(
  WS_CONNECT_RATE_LIMIT_MAX,
  WS_CONNECT_RATE_LIMIT_WINDOW_MS,
);

function isLoopbackIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

function isRateLimitBypassed(ip: string): boolean {
  return isLoopbackIp(ip);
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

// ── CORS ────────────────────────────────────────────────────────────

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ── HTTP API ────────────────────────────────────────────────────────

const createPairingBody = z.object({ sessionId: z.string().optional() });
const claimPairingBody = z.object({
  pairingCode: z.string().length(6),
  deviceToken: z.string().min(1).optional(),
});

const server = createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    await handleRequest(req, res);
  } catch (err) {
    if (err instanceof ZodError) {
      json(res, 400, {
        error: "invalid_message",
        message: err.errors[0]?.message ?? "Validation failed",
      });
    } else if (err instanceof BodyTooLargeError) {
      json(res, 413, {
        error: "body_too_large",
        message: "Request body exceeds limit",
      });
    } else if (err instanceof SyntaxError) {
      json(res, 400, { error: "invalid_json", message: "Malformed JSON" });
    } else {
      process.stderr.write(`[gateway] unhandled error: ${err}\n`);
      json(res, 500, {
        error: "internal_error",
        message: "Internal server error",
      });
    }
  }
});

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const method = req.method ?? "GET";
  const ip = getClientIp(req);

  // Health check
  if (method === "GET" && url.pathname === "/healthz") {
    json(res, 200, { ok: true });
    return;
  }

  // Create pairing
  if (method === "POST" && url.pathname === "/pairings") {
    if (!isRateLimitBypassed(ip) && !pairingLimiter.allow(ip)) {
      json(res, 429, { error: "rate_limited", message: "Too many requests" });
      return;
    }
    const body = createPairingBody.parse(await readJson(req));
    const record = pairingManager.create(body.sessionId);
    json(res, 201, {
      sessionId: record.sessionId,
      pairingCode: record.pairingCode,
      expiresAt: new Date(record.expiresAt).toISOString(),
    });
    return;
  }

  // Claim pairing
  if (method === "POST" && url.pathname === "/pairings/claim") {
    if (!isRateLimitBypassed(ip) && !pairingLimiter.allow(ip)) {
      json(res, 429, { error: "rate_limited", message: "Too many requests" });
      return;
    }
    const body = claimPairingBody.parse(await readJson(req));
    const result = pairingManager.claim(body.pairingCode);
    if ("error" in result) {
      json(res, result.status, { error: result.error });
      return;
    }
    const token = tokenManager.register(body.deviceToken);
    tokenManager.bind(token, result.sessionId);
    json(res, 200, { sessionId: result.sessionId, deviceToken: token });
    return;
  }

  // Session list
  if (method === "GET" && url.pathname === "/sessions") {
    const token = extractBearerToken(req);
    const allowedIds = token && tokenManager.validate(token)
      ? tokenManager.getSessionIds(token)
      : new Set<string>();
    const sessions = sessionManager
      .listActive()
      .filter((s) => allowedIds.has(s.id))
      .map((s) => ({
        id: s.id,
        state: s.state,
        hasHost: !!s.host,
        clientCount: s.clients.size,
        controllerId: s.controllerId ?? null,
        lastActivity: s.lastActivity,
        createdAt: s.createdAt,
        provider: s.provider ?? null,
        hostname: s.hostname ?? null,
        platform: s.platform ?? null,
      }));
    json(res, 200, { sessions });
    return;
  }

  // Session detail
  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
  if (method === "GET" && sessionMatch) {
    const token = extractBearerToken(req);
    const targetId = sessionMatch[1]!;
    if (!token || !tokenManager.owns(token, targetId)) {
      json(res, 401, {
        error: "unauthorized",
        message: "Valid device token required",
      });
      return;
    }
    const summary = sessionManager.getSummary(targetId);
    if (!summary) {
      json(res, 404, { error: "session_not_found" });
      return;
    }
    json(res, 200, summary);
    return;
  }

  // Pairing status (for CLI polling)
  const pairingMatch = url.pathname.match(/^\/pairings\/(\d{6})\/status$/);
  if (method === "GET" && pairingMatch) {
    const result = pairingManager.getStatus(pairingMatch[1]!);
    if ("error" in result) {
      json(res, result.httpStatus, { error: result.error });
      return;
    }
    json(res, 200, result);
    return;
  }

  json(res, 404, { error: "not_found" });
}

// ── WebSocket ───────────────────────────────────────────────────────

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WS_MESSAGE_SIZE,
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const ip = getClientIp(request);
  if (!isRateLimitBypassed(ip) && !wsConnectLimiter.allow(ip)) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request, url);
  });
});

wss.on(
  "connection",
  (socket: WebSocket, _request: IncomingMessage, url: URL) => {
    const sessionId = url.searchParams.get("sessionId");
    const role = url.searchParams.get("role") as "host" | "client" | null;

    if (!sessionId || !role || (role !== "host" && role !== "client")) {
      socket.close(1008, "missing sessionId or role");
      return;
    }

    const deviceId = url.searchParams.get("deviceId") ?? randomUUID();

    if (role === "client") {
      const token = url.searchParams.get("token");
      if (!token || !tokenManager.owns(token, sessionId)) {
        socket.close(4001, "unauthorized");
        return;
      }
    }

    const device = {
      socket,
      role,
      deviceId,
      connectedAt: Date.now(),
    };

    if (role === "host") {
      // Check if this is a reconnect (session already exists with clients)
      const existingSession = sessionManager.get(sessionId);
      const isReconnect =
        existingSession &&
        existingSession.clients.size > 0 &&
        existingSession.state === "host_disconnected";
      sessionManager.setHost(sessionId, device);
      if (isReconnect) {
        const notification = serializeEnvelope(
          createEnvelope({
            type: "session.host_reconnected",
            sessionId,
            payload: {},
          }),
        );
        for (const [, client] of existingSession.clients) {
          if (client.socket.readyState === client.socket.OPEN) {
            client.socket.send(notification);
          }
        }
      }
    } else {
      sessionManager.addClient(sessionId, device);
    }

    // Send welcome with protocol version
    socket.send(
      serializeEnvelope(
        createEnvelope({
          type: "session.connect",
          sessionId,
          payload: {
            role,
            clientName: deviceId,
            protocolVersion: PROTOCOL_VERSION,
          },
        }),
      ),
    );

    // If client just joined and host is not connected, notify immediately
    if (role === "client") {
      const sessionAfterJoin = sessionManager.get(sessionId);
      if (sessionAfterJoin) {
        const hostGone =
          !sessionAfterJoin.host ||
          sessionAfterJoin.state === "host_disconnected" ||
          sessionAfterJoin.host.socket.readyState !==
            sessionAfterJoin.host.socket.OPEN;
        if (hostGone) {
          socket.send(
            serializeEnvelope(
              createEnvelope({
                type: "session.host_disconnected",
                sessionId,
                payload: { reason: "host not connected" },
              }),
            ),
          );
        }
      }
    }

    // Ping/pong for liveness
    const pingTimer = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.ping();
      }
    }, PING_INTERVAL);

    socket.on("message", (data: WebSocket.RawData) => {
      handleSocketMessage(
        socket,
        data.toString(),
        role,
        sessionId,
        deviceId,
        sessionManager,
      );
    });

    socket.on("close", () => {
      clearInterval(pingTimer);
      if (role === "host") {
        const result = sessionManager.removeHost(sessionId);
        // Notify all clients that host disconnected
        if (result) {
          const notification = serializeEnvelope(
            createEnvelope({
              type: "session.host_disconnected",
              sessionId,
              payload: { reason: "host connection closed" },
            }),
          );
          for (const [, client] of result.clients) {
            if (client.socket.readyState === client.socket.OPEN) {
              client.socket.send(notification);
            }
          }
        }
      } else {
        sessionManager.removeClient(sessionId, deviceId);
      }
    });

    socket.on("error", () => {
      // close will fire
    });
  },
);

// ── Graceful shutdown ───────────────────────────────────────────────

function shutdown() {
  process.stdout.write("[gateway] shutting down...\n");
  wss.clients.forEach((ws) => ws.close(1001, "server shutting down"));
  sessionManager.destroy();
  pairingManager.destroy();
  tokenManager.destroy();
  server.close(() => {
    process.stdout.write("[gateway] stopped\n");
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Start ───────────────────────────────────────────────────────────

server.listen(port, () => {
  log("info", `LinkShell Gateway v0.1.0`);
  log("info", `listening on http://0.0.0.0:${port}`);
  log("info", `log level: ${logLevel}`);
});

// ── Helpers ─────────────────────────────────────────────────────────

class BodyTooLargeError extends Error {}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_SIZE) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
