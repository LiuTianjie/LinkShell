import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
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
import {
  parseTunnelPath,
  parseTunnelCookie,
  handleTunnelRequest,
  handleTunnelWsUpgrade,
  cleanupSessionTunnels,
} from "./tunnel.js";

export interface EmbeddedGatewayOptions {
  port?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
  silent?: boolean;
}

export interface EmbeddedGateway {
  port: number;
  httpUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
}

const PING_INTERVAL = 20_000;
const MAX_BODY_SIZE = 4096;
const MAX_WS_MESSAGE_SIZE = 50 * 1024 * 1024; // 50MB (supports base64 image uploads)

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const createPairingBody = z.object({ sessionId: z.string().optional() });
const claimPairingBody = z.object({
  pairingCode: z.string().length(6),
  deviceToken: z.string().min(1).optional(),
});

class BodyTooLargeError extends Error {}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  });
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

/**
 * Start an embedded gateway. Returns a handle to get URLs and close it.
 * Used by CLI when no external --gateway is provided.
 */
export function startEmbeddedGateway(
  options: EmbeddedGatewayOptions = {},
): Promise<EmbeddedGateway> {
  const targetPort = options.port ?? 0; // 0 = random available port
  const logLevel = options.logLevel ?? "warn";
  const silent = options.silent ?? false;

  function log(level: "debug" | "info" | "warn" | "error", msg: string): void {
    if (silent) return;
    if (LOG_LEVELS[level] >= LOG_LEVELS[logLevel]) {
      process.stderr.write(`[gateway:${level}] ${msg}\n`);
    }
  }

  const sessionManager = new SessionManager();
  const pairingManager = new PairingManager();
  const tokenManager = new TokenManager();

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, Authorization",
        "access-control-max-age": "86400",
      });
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/pairings") {
        const body = createPairingBody.parse(await readJson(req));
        const record = pairingManager.create(body.sessionId);
        json(res, 201, {
          sessionId: record.sessionId,
          pairingCode: record.pairingCode,
          expiresAt: new Date(record.expiresAt).toISOString(),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/pairings/claim") {
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

      if (method === "GET" && url.pathname === "/sessions") {
        const token = extractBearerToken(req);
        if (!token || !tokenManager.validate(token)) {
          json(res, 401, {
            error: "unauthorized",
            message: "Valid device token required",
          });
          return;
        }
        const allowedIds = tokenManager.getSessionIds(token);
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
            hostname: s.hostname ?? null,
            platform: s.platform ?? null,
          }));
        json(res, 200, { sessions });
        return;
      }

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

      // Tunnel HTTP proxy (explicit path)
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

      json(res, 404, { error: "not_found" });
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
        log("error", `unhandled: ${err}`);
        json(res, 500, {
          error: "internal_error",
          message: "Internal server error",
        });
      }
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_MESSAGE_SIZE,
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    // Tunnel WebSocket upgrade (for HMR etc.)
    const tunnelParsed = parseTunnelPath(url.pathname);
    if (tunnelParsed) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleTunnelWsUpgrade(ws, tunnelParsed, url, sessionManager, tokenManager);
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
      url.searchParams.set("token", tunnelCookie.token);
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleTunnelWsUpgrade(ws, fallbackParsed, url, sessionManager, tokenManager);
      });
      return;
    }

    if (url.pathname !== "/ws") {
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

      const device = { socket, role, deviceId, connectedAt: Date.now() };

      if (role === "host") {
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
            if (client.socket.readyState === client.socket.OPEN)
              client.socket.send(notification);
          }
        }
      } else {
        sessionManager.addClient(sessionId, device);
      }

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

      const pingTimer = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.ping();
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
          if (result) {
            const notification = serializeEnvelope(
              createEnvelope({
                type: "session.host_disconnected",
                sessionId,
                payload: { reason: "host connection closed" },
              }),
            );
            for (const [, client] of result.clients) {
              if (client.socket.readyState === client.socket.OPEN)
                client.socket.send(notification);
            }
          }
        } else {
          sessionManager.removeClient(sessionId, deviceId);
        }
      });

      socket.on("error", () => {});
    },
  );

  return new Promise<EmbeddedGateway>((resolve, reject) => {
    server.on("error", reject);
    server.listen(targetPort, () => {
      const addr = server.address();
      const actualPort =
        typeof addr === "object" && addr ? addr.port : targetPort;
      log("info", `embedded gateway on port ${actualPort}`);
      resolve({
        port: actualPort,
        httpUrl: `http://127.0.0.1:${actualPort}`,
        wsUrl: `ws://127.0.0.1:${actualPort}/ws`,
        close: () =>
          new Promise<void>((res) => {
            wss.clients.forEach((ws) => ws.close(1001, "shutting down"));
            sessionManager.destroy();
            pairingManager.destroy();
            tokenManager.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}
