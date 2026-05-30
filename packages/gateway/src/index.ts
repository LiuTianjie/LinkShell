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
import { HostAuthManager } from "./host-auth.js";
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
import { AUTH_REQUIRED, requireAuth, checkWsAuth, validateRequest, checkSubscriptionByUserId, canReadSessionDetail } from "./auth-middleware.js";
import { setCors } from "./cors.js";
import { serveWeb, webEnabled, webDistPath } from "./static-web.js";

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
const hostAuthManager = new HostAuthManager();
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
  private pruneTimer: ReturnType<typeof setInterval>;
  constructor(
    private maxHits: number,
    private windowMs: number,
  ) {
    // Periodically evict expired windows so the map does not grow unbounded.
    this.pruneTimer = setInterval(
      () => this.prune(),
      Math.max(windowMs, 60_000),
    );
    this.pruneTimer.unref?.();
  }

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

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }

  destroy(): void {
    clearInterval(this.pruneTimer);
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
// Gateway-wide cap on failed pairing claims per window, independent of the
// per-IP creation limiter — mitigates distributed pairing-code guessing.
const CLAIM_FAILURE_RATE_LIMIT_MAX = Number(
  process.env.CLAIM_FAILURE_RATE_LIMIT_MAX ?? 100,
);
const CLAIM_FAILURE_RATE_LIMIT_WINDOW_MS = Number(
  process.env.CLAIM_FAILURE_RATE_LIMIT_WINDOW_MS ?? 60_000,
);
const claimFailureLimiter = new RateLimiter(
  CLAIM_FAILURE_RATE_LIMIT_MAX,
  CLAIM_FAILURE_RATE_LIMIT_WINDOW_MS,
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

/**
 * Trusted reverse proxies, parsed from TRUSTED_PROXIES (comma-separated IPs).
 * X-Forwarded-For is only honored when the immediate peer
 * (req.socket.remoteAddress) is one of these. Default empty = trust nobody,
 * so the socket address is always used and the header cannot be spoofed.
 * IPv6-mapped IPv4 (::ffff:1.2.3.4) is normalized to the bare IPv4 form.
 */
function normalizeIp(ip: string): string {
  const t = ip.trim().toLowerCase();
  if (t.startsWith("::ffff:")) return t.slice(7);
  return t;
}

function parseTrustedProxies(): Set<string> {
  const raw = process.env.TRUSTED_PROXIES ?? "";
  const set = new Set<string>();
  for (const part of raw.split(",")) {
    const ip = normalizeIp(part);
    if (ip) set.add(ip);
  }
  return set;
}

const TRUSTED_PROXIES = parseTrustedProxies();

function getClientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  // Only honor X-Forwarded-For when the direct peer is a configured proxy;
  // otherwise the header is attacker-controlled and would defeat rate limits.
  if (TRUSTED_PROXIES.has(normalizeIp(peer))) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return peer;
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

// The device token proves session ownership. On a premium (AUTH_REQUIRED)
// gateway the Authorization header is taken by the Supabase JWT, so the device
// token rides in the `?token=` query param instead (same as the client WS URL).
// Prefer the query param, fall back to the bearer for non-auth gateways.
function extractDeviceToken(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams.get("token");
  if (q) return q;
  return extractBearerToken(req);
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

// API path prefixes that must NEVER be served the SPA / handled as a web route.
// Everything else (incl. "/", client-side views) may fall through to the web UI,
// which must be reachable BEFORE the AUTH_REQUIRED guard so users can load the
// login page and authenticate in the first place.
function isApiPath(pathname: string): boolean {
  return (
    pathname === "/healthz" ||
    pathname === "/sessions" ||
    pathname.startsWith("/sessions/") ||
    pathname === "/pairings" ||
    pathname.startsWith("/pairings/") ||
    pathname.startsWith("/agent/") ||
    pathname.startsWith("/tunnel/")
  );
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const method = req.method ?? "GET";
  const ip = getClientIp(req);
  let authenticatedUserId: string | undefined;

  // Health check
  if (method === "GET" && url.pathname === "/healthz") {
    json(res, 200, { ok: true });
    return;
  }

  // Sessions owned by authenticated user (before AUTH_REQUIRED guard — uses its own auth)
  if (method === "GET" && url.pathname === "/sessions/mine") {
    const authResult = await validateRequest(req);
    if (!authResult || !authResult.userId) {
      json(res, 401, { error: "auth_required", message: "Authentication required" });
      return;
    }
    if (AUTH_REQUIRED && !authResult.subscribed) {
      json(res, 403, {
        error: "subscription_required",
        message: "Pro subscription required. Subscribe at https://itool.tech",
      });
      return;
    }
    const sessions = sessionManager
      .listActive()
      .filter((s) => s.userId === authResult.userId)
      .map((s) => sessionManager.getSummary(s.id))
      .filter(Boolean);
    json(res, 200, { sessions });
    return;
  }

  // Delete a session owned by authenticated user
  if (method === "DELETE" && url.pathname.startsWith("/sessions/")) {
    const sessionId = url.pathname.split("/")[2];
    if (!sessionId) {
      json(res, 400, { error: "missing_session_id" });
      return;
    }
    const authResult = await validateRequest(req);
    if (!authResult || !authResult.userId) {
      json(res, 401, { error: "auth_required", message: "Authentication required" });
      return;
    }
    if (AUTH_REQUIRED && !authResult.subscribed) {
      json(res, 403, {
        error: "subscription_required",
        message: "Pro subscription required. Subscribe at https://itool.tech",
      });
      return;
    }
    const session = sessionManager.get(sessionId);
    if (!session) {
      json(res, 404, { error: "not_found" });
      return;
    }
    if (session.userId && session.userId === authResult.userId) {
      sessionManager.forceDelete(sessionId);
      json(res, 200, { ok: true });
      return;
    }
    json(res, 403, { error: "forbidden", message: "You do not own this session" });
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
      sessionId: tunnelCookie.sessionId,
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
    log(result.status === 200 ? "info" : "warn", `agent permission respond protocol=${body.protocol} session=${body.sessionId} request=${body.requestId} status=${result.status} forwarded=${forwarded}${ack}`);
    json(res, result.status, result.body);
    return;
  }

  // Web UI (public): serve the built SPA + its static assets BEFORE the
  // AUTH_REQUIRED guard, so the login page itself is reachable on a premium
  // gateway. Only non-API GET/HEAD requests are eligible; API routes above and
  // below are matched explicitly and never reach here as web routes.
  if ((method === "GET" || method === "HEAD") && !isApiPath(url.pathname)) {
    if (await serveWeb(req, res)) return;
  }

  // Auth check for premium gateway (skip healthz, /sessions/mine, tunnel)
  if (AUTH_REQUIRED) {
    const authResult = await requireAuth(req, res);
    if (!authResult) return; // response already sent
    authenticatedUserId = authResult.userId;
  }

  // Create pairing
  if (method === "POST" && url.pathname === "/pairings") {
    if (!isRateLimitBypassed(ip) && !pairingLimiter.allow(ip)) {
      json(res, 429, { error: "rate_limited", message: "Too many requests" });
      return;
    }
    const body = createPairingBody.parse(await readJson(req));
    const record = pairingManager.create(body.sessionId);
    // Issue a secret host token bound to this session. Only the CLI that
    // created the pairing can later connect as role=host (see WS handler).
    const hostToken = hostAuthManager.issue(record.sessionId);
    json(res, 201, {
      sessionId: record.sessionId,
      pairingCode: record.pairingCode,
      hostToken,
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
    // Gateway-wide cap on failed claims, independent of per-IP limiter, to
    // blunt distributed brute-forcing across many source IPs.
    if (!isRateLimitBypassed(ip) && !claimFailureLimiter.allow("global")) {
      json(res, 429, { error: "rate_limited", message: "Too many failed claims" });
      return;
    }
    const body = claimPairingBody.parse(await readJson(req));
    // Idempotent re-claim: if the requester's device token already owns the
    // session this code maps to, re-issue success instead of erroring with
    // already_claimed. Only a token that has PROVEN ownership takes this path,
    // so it can't be used to bypass brute-force protection. This lets a browser
    // that refreshes or re-enters its code reconnect smoothly.
    const peeked = pairingManager.peek(body.pairingCode);
    if (peeked && body.deviceToken && tokenManager.owns(body.deviceToken, peeked.sessionId)) {
      tokenManager.bind(body.deviceToken, peeked.sessionId); // refresh lastUsedAt
      json(res, 200, { sessionId: peeked.sessionId, deviceToken: body.deviceToken });
      return;
    }
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
    const token = extractDeviceToken(req);
    const allowedIds = token && tokenManager.validate(token)
      ? tokenManager.getSessionIds(token)
      : new Set<string>();
    const sessions = sessionManager
      .listActive()
      .filter((s) => allowedIds.has(s.id))
      .map((s) => ({
        id: s.id,
        state: s.state,
        hasHost: !!s.host && s.host.socket.readyState === s.host.socket.OPEN,
        clientCount: s.clients.size,
        controllerId: s.controllerId ?? null,
        lastActivity: s.lastActivity,
        createdAt: s.createdAt,
        provider: s.provider ?? null,
        machineId: s.machineId ?? null,
        hostname: s.hostname ?? null,
        platform: s.platform ?? null,
        cwd: s.cwd ?? null,
        projectName: s.projectName ?? null,
      }));
    json(res, 200, { sessions });
    return;
  }

  // Session detail
  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
  if (method === "GET" && sessionMatch) {
    const token = extractDeviceToken(req);
    const targetId = sessionMatch[1]!;
    const session = sessionManager.get(targetId);
    const tokenOwns = Boolean(token && tokenManager.owns(token, targetId));
    if (!canReadSessionDetail({
      authRequired: AUTH_REQUIRED,
      authenticatedUserId,
      sessionUserId: session?.userId,
      tokenOwns,
    })) {
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

  // Web UI fallback: any remaining non-API GET (these are authenticated on a
  // premium gateway) falls back to the SPA. API-shaped paths that matched no
  // route 404 properly instead of being masked by the SPA shell.
  if ((method === "GET" || method === "HEAD") && !isApiPath(url.pathname)) {
    if (await serveWeb(req, res)) return;
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
      sessionId: tunnelCookie.sessionId,
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
    const sessionId = url.searchParams.get("sessionId");
    const role = url.searchParams.get("role") as "host" | "client" | null;

    if (!sessionId || !role || (role !== "host" && role !== "client")) {
      socket.close(1008, "missing sessionId or role");
      return;
    }

    const deviceId = url.searchParams.get("deviceId") ?? randomUUID();

    if (role === "client") {
      const token = url.searchParams.get("token");
      const authResult = (_request as any).__authResult as
        | { userId?: string }
        | undefined;
      const session = sessionManager.get(sessionId);

      // Allow if: device token owns session, OR auth user owns session
      const tokenOwns = token && tokenManager.owns(token, sessionId);
      const authOwns =
        AUTH_REQUIRED &&
        authResult?.userId &&
        session?.userId &&
        authResult.userId === session.userId;

      if (!tokenOwns && !authOwns) {
        socket.close(4001, "unauthorized");
        return;
      }
      if (!tokenOwns && authOwns && token) {
        tokenManager.register(token);
        tokenManager.bind(token, sessionId);
        log("info", `bound authenticated device token to session ${sessionId}`);
      }
    }

    const device = {
      socket,
      role,
      deviceId,
      connectedAt: Date.now(),
    };

    if (role === "host") {
      // Host-token check (trust-on-first-use). The first host to connect with a
      // token binds the session; after that, only that token is accepted — so a
      // third party who later learns the sessionId can't hijack the host role
      // and capture controller keystrokes or inject terminal output. A host that
      // presents NO token never creates a binding and is allowed as a legacy
      // host, keeping older CLIs (which don't send a token) working.
      const hdr = _request.headers["x-linkshell-host-token"];
      const providedHostToken = Array.isArray(hdr) ? hdr[0] : hdr;
      if (hostAuthManager.has(sessionId)) {
        if (!hostAuthManager.verify(sessionId, providedHostToken)) {
          log("warn", `rejected host connect with bad host token for ${sessionId}`);
          socket.close(4003, "host authentication failed");
          return;
        }
      } else if (providedHostToken) {
        // First host connect with a token (or after a gateway restart lost the
        // in-memory binding) — trust it and bind the session to it.
        hostAuthManager.adopt(sessionId, providedHostToken);
      }
      // else: legacy host without a token — allowed for backward compatibility.

      // Check if this is a reconnect (session already exists with clients)
      const existingSession = sessionManager.get(sessionId);
      const isReconnect =
        existingSession &&
        existingSession.clients.size > 0 &&
        existingSession.state === "host_disconnected";
      sessionManager.setHost(sessionId, device);

      // Associate userId from auth (for AUTH_REQUIRED gateways)
      const authResult = (_request as any).__authResult as
        | { userId?: string }
        | undefined;
      if (authResult?.userId) {
        const session = sessionManager.get(sessionId);
        if (session) session.userId = authResult.userId;
      }
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

    // Ping/pong for liveness — terminate connections that stop responding
    // to pings (dead/half-open sockets) instead of leaking them.
    const liveSocket = socket as WebSocket & { isAlive?: boolean };
    liveSocket.isAlive = true;
    socket.on("pong", () => {
      liveSocket.isAlive = true;
    });
    const pingTimer = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      if (liveSocket.isAlive === false) {
        socket.terminate();
        return;
      }
      liveSocket.isAlive = false;
      socket.ping();
    }, PING_INTERVAL);

    socket.on("message", (data: WebSocket.RawData) => {
      try {
        handleSocketMessage(
          socket,
          data.toString(),
          role,
          sessionId,
          deviceId,
          sessionManager,
        );
      } catch (err) {
        log("error", `unhandled websocket message error for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        if (socket.readyState === socket.OPEN) {
          socket.send(
            serializeEnvelope(
              createEnvelope({
                type: "session.error",
                sessionId,
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
  hostAuthManager.destroy();
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
        log("warn", `subscription check unknown for user ${session.userId}, keeping session ${session.id}${subscription.reason ? ` (${subscription.reason})` : ""}`);
        continue;
      }
      if (subscription.status === "inactive") {
        log("info", `subscription expired for user ${session.userId}, disconnecting session ${session.id}`);
        // Notify host
        try {
          session.host.socket.send(
            serializeEnvelope(
              createEnvelope({
                type: "session.error",
                sessionId: session.id,
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
                  type: "session.error",
                  sessionId: session.id,
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
  if (webEnabled()) {
    log("info", `web UI served from ${webDistPath()} (open http://0.0.0.0:${port}/)`);
  } else {
    log("info", `web UI not bundled (API-only); set WEB_DIST to enable`);
  }
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
