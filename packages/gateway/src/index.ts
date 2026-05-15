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
import { createSupabaseStateStore } from "./state-store.js";
import { handleSocketMessage } from "./relay.js";
import {
  agentPermissionHttpBodySchema,
  forwardAgentPermissionHttp,
} from "./agent-permission-http.js";
import {
  parseTunnelPath,
  parseTunnelCookie,
  handleTunnelRequest,
  cleanupSessionTunnels,
} from "./tunnel.js";
import { AUTH_REQUIRED, requireAuth, checkWsAuth, validateRequest, checkSubscriptionByUserId } from "./auth-middleware.js";

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

const stateStore = createSupabaseStateStore();
const sessionManager = new SessionManager();
const pairingManager = new PairingManager(stateStore);
const tokenManager = new TokenManager(stateStore);
await Promise.all([pairingManager.hydrate(), tokenManager.hydrate()]);

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

const createPairingBody = z.object({ hostDeviceId: z.string().min(1) });
const claimPairingBody = z.object({
  pairingCode: z.string().length(6),
  deviceToken: z.string().min(1).optional(),
  clientDeviceId: z.string().min(1).optional(),
  clientName: z.string().min(1).optional(),
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

  // Devices owned by authenticated user (before AUTH_REQUIRED guard — uses its own auth)
  if (method === "GET" && url.pathname === "/devices/mine") {
    const authResult = await validateRequest(req);
    if (!authResult || !authResult.userId) {
      json(res, 401, { error: "auth_required", message: "Authentication required" });
      return;
    }
    const devices = sessionManager
      .listActive()
      .filter((s) => s.userId === authResult.userId)
      .map((s) => sessionManager.getSummary(s.id))
      .filter(Boolean);
    json(res, 200, { devices });
    return;
  }

  // Delete a host device owned by authenticated user
  if (method === "DELETE" && /^\/devices\/[^/]+$/.test(url.pathname)) {
    const hostDeviceId = url.pathname.split("/")[2];
    if (!hostDeviceId) {
      json(res, 400, { error: "missing_host_device_id" });
      return;
    }
    const authResult = await validateRequest(req);
    if (!authResult || !authResult.userId) {
      json(res, 401, { error: "auth_required", message: "Authentication required" });
      return;
    }
    const device = sessionManager.get(hostDeviceId);
    if (!device) {
      json(res, 404, { error: "not_found" });
      return;
    }
    if (device.userId && device.userId === authResult.userId) {
      sessionManager.forceDelete(hostDeviceId);
      json(res, 200, { ok: true });
      return;
    }
    json(res, 403, { error: "forbidden", message: "You do not own this device" });
    return;
  }

  // Tunnel HTTP proxy (explicit path) — before AUTH_REQUIRED, tunnel has its own auth
  const tunnelParsed = parseTunnelPath(url.pathname);
  if (tunnelParsed) {
    await handleTunnelRequest(req, res, sessionManager, tokenManager, tunnelParsed, url);
    return;
  }

  // Tunnel fallback: cookie-based routing for sub-resources (e.g. /_next/static/...)
  const tunnelCookie = parseTunnelCookie(req);
  if (tunnelCookie) {
    const fallbackParsed = {
      hostDeviceId: tunnelCookie.hostDeviceId,
      port: tunnelCookie.port,
      path: url.pathname,
    };
    await handleTunnelRequest(req, res, sessionManager, tokenManager, fallbackParsed, url, tunnelCookie.token);
    return;
  }

  // Live Activity permission response: device-token auth, no controller required.
  if (method === "POST" && url.pathname === "/agent/permission/respond") {
    const token = extractBearerToken(req);
    const parsed = agentPermissionHttpBodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      json(res, 400, {
        error: "invalid_payload",
        message: parsed.error.errors[0]?.message ?? "Invalid permission response payload",
      });
      return;
    }
    const body = parsed.data;
    const result = await forwardAgentPermissionHttp({
      token,
      body,
      sessionManager,
      tokenManager,
    });
    const forwarded = result.forwarded?.map((item) =>
      item.terminalId ? `${item.type}:${item.terminalId}` : item.type,
    ).join(",") ?? "none";
    const ack = result.ack ? ` resolved=${result.ack.resolved} delivered=${result.ack.delivered}` : "";
    log(result.status === 200 ? "info" : "warn", `agent permission respond protocol=${body.protocol} hostDevice=${body.hostDeviceId ?? body.sessionId ?? "unknown"} request=${body.requestId} status=${result.status} forwarded=${forwarded}${ack}`);
    json(res, result.status, result.body);
    return;
  }

  // Auth check for premium gateway (skip healthz, device-owned endpoints, tunnel)
  if (AUTH_REQUIRED) {
    const authResult = await requireAuth(req, res);
    if (!authResult) return; // response already sent
  }

  // Create one-time pairing challenge for a host device
  if (method === "POST" && url.pathname === "/pairings") {
    if (!isRateLimitBypassed(ip) && !pairingLimiter.allow(ip)) {
      json(res, 429, { error: "rate_limited", message: "Too many requests" });
      return;
    }
    const body = createPairingBody.parse(await readJson(req));
    const record = pairingManager.create(body.hostDeviceId);
    json(res, 201, {
      hostDeviceId: record.hostDeviceId,
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
    const authorization = tokenManager.authorize(token, result.hostDeviceId, {
      clientDeviceId: body.clientDeviceId,
      clientName: body.clientName,
    });
    json(res, 200, {
      hostDeviceId: result.hostDeviceId,
      deviceToken: token,
      authorizationId: authorization?.authorizationId,
    });
    return;
  }

  // Authorized host device list
  if (method === "GET" && url.pathname === "/devices") {
    const token = extractBearerToken(req);
    if (!token || !tokenManager.validate(token)) {
      json(res, 401, {
        error: "unauthorized",
        message: "Valid device token required",
      });
      return;
    }
    const allowedIds = tokenManager.getHostDeviceIds(token);
    const devices = [...allowedIds].map((hostDeviceId) => {
      const summary = sessionManager.getSummary(hostDeviceId);
      return summary ?? {
        id: hostDeviceId,
        hostDeviceId,
        state: "host_disconnected",
        online: false,
        hasHost: false,
        clientCount: 0,
        controllerId: null,
        lastActivity: null,
        createdAt: null,
        bufferSize: 0,
        machineId: null,
        hostname: null,
        platform: null,
        cwd: null,
        capabilities: [],
        authorizationId: tokenManager.getAuthorizationId(token, hostDeviceId) ?? null,
      };
    }).map((device) => ({
      ...device,
      authorizationId: tokenManager.getAuthorizationId(token, device.hostDeviceId) ?? null,
    }));
    json(res, 200, { devices });
    return;
  }

  // Device detail
  const deviceMatch = url.pathname.match(/^\/devices\/([^/]+)$/);
  if (method === "GET" && deviceMatch) {
    const token = extractBearerToken(req);
    const targetId = deviceMatch[1]!;
    if (!token || !tokenManager.owns(token, targetId)) {
      json(res, 401, {
        error: "unauthorized",
        message: "Valid device token required",
      });
      return;
    }
    const summary = sessionManager.getSummary(targetId);
    if (!summary) {
      json(res, 200, {
        id: targetId,
        hostDeviceId: targetId,
        state: "host_disconnected",
        online: false,
        hasHost: false,
        clientCount: 0,
        controllerId: null,
        lastActivity: null,
        createdAt: null,
        bufferSize: 0,
        machineId: null,
        hostname: null,
        platform: null,
        cwd: null,
        capabilities: [],
        authorizationId: tokenManager.getAuthorizationId(token, targetId) ?? null,
      });
      return;
    }
    json(res, 200, {
      ...summary,
      authorizationId: tokenManager.getAuthorizationId(token, targetId) ?? null,
    });
    return;
  }

  const revokeMatch = url.pathname.match(/^\/devices\/([^/]+)\/authorizations\/([^/]+)$/);
  if (method === "DELETE" && revokeMatch) {
    const token = extractBearerToken(req);
    const hostDeviceId = decodeURIComponent(revokeMatch[1]!);
    const authorizationId = decodeURIComponent(revokeMatch[2]!);
    if (
      !token ||
      tokenManager.getAuthorizationId(token, hostDeviceId) !== authorizationId ||
      !tokenManager.revoke(token, hostDeviceId, authorizationId)
    ) {
      json(res, 401, {
        error: "unauthorized",
        message: "Valid device authorization required",
      });
      return;
    }
    sessionManager.disconnectAuthorization(hostDeviceId, authorizationId);
    json(res, 200, { ok: true });
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

  // Tunnel WebSocket upgrade (for HMR etc.)
  const tunnelParsed = parseTunnelPath(url.pathname);
  if (tunnelParsed) {
    const ip = getClientIp(request);
    if (!isRateLimitBypassed(ip) && !wsConnectLimiter.allow(ip)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    // Import dynamically to handle tunnel WS upgrade
    import("./tunnel.js").then(({ handleTunnelWsUpgrade }) => {
      wss.handleUpgrade(request, socket, head, async (ws) => {
        await handleTunnelWsUpgrade(ws, tunnelParsed, url, sessionManager, tokenManager);
      });
    });
    return;
  }

  // Tunnel WS fallback via cookie (for HMR paths like /_next/webpack-hmr)
  const tunnelCookie = parseTunnelCookie(request);
  if (tunnelCookie && url.pathname !== "/ws") {
    const fallbackParsed = {
      hostDeviceId: tunnelCookie.hostDeviceId,
      port: tunnelCookie.port,
      path: url.pathname,
    };
    // Inject token into URL so handleTunnelWsUpgrade can auth
    url.searchParams.set("token", tunnelCookie.token);
    wss.handleUpgrade(request, socket, head, async (ws) => {
      const { handleTunnelWsUpgrade } = await import("./tunnel.js");
      await handleTunnelWsUpgrade(ws, fallbackParsed, url, sessionManager, tokenManager);
    });
    return;
  }

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

  // Auth check for premium gateway WebSocket connections
  if (AUTH_REQUIRED) {
    checkWsAuth(request).then((authResult) => {
      if (!authResult || !authResult.authenticated) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!authResult.subscribed) {
        socket.write("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nPro subscription required. Subscribe at https://itool.tech\r\n");
        socket.destroy();
        return;
      }
      (request as any).__authResult = authResult;
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request, url);
      });
    });
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request, url);
  });
});

wss.on(
  "connection",
  (socket: WebSocket, _request: IncomingMessage, url: URL) => {
    const hostDeviceId = url.searchParams.get("hostDeviceId") ?? url.searchParams.get("sessionId");
    const role = url.searchParams.get("role") as "host" | "client" | null;

    if (!hostDeviceId || !role || (role !== "host" && role !== "client")) {
      socket.close(1008, "missing hostDeviceId or role");
      return;
    }

    const deviceId = url.searchParams.get("deviceId") ?? randomUUID();

    let clientToken: string | undefined;
    let clientAuthorizationId: string | undefined;

    if (role === "client") {
      const token = url.searchParams.get("token");
      const authResult = (_request as any).__authResult as
        | { userId?: string }
        | undefined;
      const device = sessionManager.get(hostDeviceId);

      // Allow if: device token owns host device, OR auth user owns host device
      const tokenOwns = Boolean(token && tokenManager.owns(token, hostDeviceId));
      const authOwns =
        AUTH_REQUIRED &&
        authResult?.userId &&
        device?.userId &&
        authResult.userId === device.userId;

      if (!tokenOwns && !authOwns) {
        socket.close(4001, "unauthorized");
        return;
      }
      if (!tokenOwns && authOwns && token) {
        tokenManager.register(token);
        tokenManager.bind(token, hostDeviceId);
        log("info", `bound authenticated device token to host device ${hostDeviceId}`);
      }
      if (token && (tokenOwns || authOwns)) {
        clientToken = token;
        clientAuthorizationId = tokenManager.getAuthorizationId(token, hostDeviceId);
      }
    }

    const device = {
      socket,
      role,
      deviceId,
      token: clientToken,
      authorizationId: clientAuthorizationId,
      connectedAt: Date.now(),
    };

    if (role === "host") {
      // Check if this is a reconnect (session already exists with clients)
      const existingSession = sessionManager.get(hostDeviceId);
      const isReconnect =
        existingSession &&
        existingSession.clients.size > 0 &&
        existingSession.state === "host_disconnected";
      sessionManager.setHost(hostDeviceId, device);

      // Associate userId from auth (for AUTH_REQUIRED gateways)
      const authResult = (_request as any).__authResult as
        | { userId?: string }
        | undefined;
      if (authResult?.userId) {
        const deviceRecord = sessionManager.get(hostDeviceId);
        if (deviceRecord) deviceRecord.userId = authResult.userId;
      }
      if (isReconnect) {
        const notification = serializeEnvelope(
          createEnvelope({
            type: "device.host_reconnected",
            hostDeviceId,
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
      sessionManager.addClient(hostDeviceId, device);
    }

    // Send welcome with protocol version
    socket.send(
      serializeEnvelope(
        createEnvelope({
          type: "device.connect",
          hostDeviceId,
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
      const sessionAfterJoin = sessionManager.get(hostDeviceId);
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
                type: "device.host_disconnected",
                hostDeviceId,
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
      try {
        handleSocketMessage(
          socket,
          data.toString(),
          role,
          hostDeviceId,
          deviceId,
          sessionManager,
        );
      } catch (err) {
        log("error", `unhandled websocket message error for host device ${hostDeviceId}: ${err instanceof Error ? err.message : String(err)}`);
        if (socket.readyState === socket.OPEN) {
          socket.send(
            serializeEnvelope(
              createEnvelope({
                type: "device.error",
                hostDeviceId,
                payload: {
                  code: "invalid_message",
                  message: "Failed to handle message",
                },
              }),
            ),
          );
        }
      }
    });

    socket.on("close", () => {
      clearInterval(pingTimer);
      if (role === "host") {
        const result = sessionManager.removeHost(hostDeviceId);
        cleanupSessionTunnels(hostDeviceId);
        // Notify all clients that host disconnected
        if (result) {
          const notification = serializeEnvelope(
            createEnvelope({
              type: "device.host_disconnected",
              hostDeviceId,
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
        sessionManager.removeClient(hostDeviceId, deviceId);
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

// ── Subscription expiry checker (AUTH_REQUIRED gateways only) ──────

const SUB_CHECK_INTERVAL = 5 * 60_000; // 5 minutes

if (AUTH_REQUIRED) {
  setInterval(async () => {
    for (const session of sessionManager.listActive()) {
      if (!session.userId || !session.host) continue;
      const subscription = await checkSubscriptionByUserId(session.userId);
      if (subscription.status === "unknown") {
        log("warn", `subscription check unknown for user ${session.userId}, keeping host device ${session.id}${subscription.reason ? ` (${subscription.reason})` : ""}`);
        continue;
      }
      if (subscription.status === "inactive") {
        log("info", `subscription expired for user ${session.userId}, disconnecting host device ${session.id}`);
        // Notify host
        try {
          session.host.socket.send(
            serializeEnvelope(
              createEnvelope({
                type: "device.error",
                hostDeviceId: session.id,
                payload: {
                  code: "subscription_expired",
                  message: "Your Pro subscription has expired. Renew at https://itool.tech",
                },
              }),
            ),
          );
        } catch {}
        // Close host connection
        session.host.socket.close(4003, "subscription_expired");
        // Notify clients
        for (const [, client] of session.clients) {
          try {
            client.socket.send(
              serializeEnvelope(
              createEnvelope({
                  type: "device.error",
                  hostDeviceId: session.id,
                  payload: {
                    code: "subscription_expired",
                    message: "Host subscription expired. Session ended.",
                  },
                }),
              ),
            );
            client.socket.close(4003, "subscription_expired");
          } catch {}
        }
      }
    }
  }, SUB_CHECK_INTERVAL);
}

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
