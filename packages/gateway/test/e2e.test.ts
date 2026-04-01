import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import { createEnvelope, parseEnvelope, serializeEnvelope } from "@linkshell/protocol";
import { SessionManager } from "../src/sessions.js";
import { PairingManager } from "../src/pairings.js";
import { handleSocketMessage } from "../src/relay.js";

// ── Helpers ─────────────────────────────────────────────────────────

const TEST_PORT = 18787;
const BASE = `http://localhost:${TEST_PORT}`;
const WS_BASE = `ws://localhost:${TEST_PORT}`;

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function getJson(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

function connectWs(sessionId: string, role: string, deviceId?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `${WS_BASE}/ws?sessionId=${sessionId}&role=${role}${deviceId ? `&deviceId=${deviceId}` : ""}`;
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<ReturnType<typeof parseEnvelope>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => {
      resolve(parseEnvelope(data.toString()));
    });
  });
}

// ── Test server setup ───────────────────────────────────────────────

let server: Server;
let wss: WebSocketServer;
let sessionManager: SessionManager;
let pairingManager: PairingManager;

beforeAll(async () => {
  sessionManager = new SessionManager();
  pairingManager = new PairingManager();

  server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === "POST" && url.pathname === "/pairings") {
      const body = await readBody(req);
      const record = pairingManager.create(body.sessionId as string | undefined);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        sessionId: record.sessionId,
        pairingCode: record.pairingCode,
        expiresAt: new Date(record.expiresAt).toISOString(),
      }));
      return;
    }

    if (method === "POST" && url.pathname === "/pairings/claim") {
      const body = await readBody(req);
      const result = pairingManager.claim(body.pairingCode as string);
      if ("error" in result) {
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessionId: result.sessionId }));
      return;
    }

    if (method === "GET" && url.pathname === "/sessions") {
      const sessions = sessionManager.listActive().map((s) => ({
        id: s.id,
        state: s.state,
        hasHost: !!s.host,
        clientCount: s.clients.size,
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessions }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname !== "/ws") { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, url);
    });
  });

  wss.on("connection", (socket: WebSocket, _req: unknown, url: URL) => {
    const sessionId = url.searchParams.get("sessionId")!;
    const role = url.searchParams.get("role") as "host" | "client";
    const deviceId = url.searchParams.get("deviceId") ?? "test-device";

    const device = { socket, role, deviceId, connectedAt: Date.now() };
    if (role === "host") {
      sessionManager.setHost(sessionId, device);
    } else {
      sessionManager.addClient(sessionId, device);
    }

    socket.send(serializeEnvelope(createEnvelope({
      type: "session.connect",
      sessionId,
      payload: { role, clientName: deviceId },
    })));

    socket.on("message", (data: WebSocket.RawData) => {
      handleSocketMessage(socket, data.toString(), role, sessionId, deviceId, sessionManager);
    });

    socket.on("close", () => {
      if (role === "host") sessionManager.removeHost(sessionId);
      else sessionManager.removeClient(sessionId, deviceId);
    });
  });

  await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));
});

afterAll(async () => {
  wss.clients.forEach((ws) => ws.close());
  sessionManager.destroy();
  pairingManager.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Health check", () => {
  it("returns ok", async () => {
    const { status, body } = await getJson("/healthz");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

describe("Pairing flow", () => {
  it("creates a pairing and returns code + sessionId", async () => {
    const { status, body } = await postJson("/pairings", {});
    expect(status).toBe(201);
    expect(body.pairingCode).toMatch(/^\d{6}$/);
    expect(body.sessionId).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();
  });

  it("claims a pairing with valid code", async () => {
    const create = await postJson("/pairings", {});
    const claim = await postJson("/pairings/claim", { pairingCode: create.body.pairingCode });
    expect(claim.status).toBe(200);
    expect(claim.body.sessionId).toBe(create.body.sessionId);
  });

  it("rejects invalid pairing code", async () => {
    const { status, body } = await postJson("/pairings/claim", { pairingCode: "000000" });
    expect(status).toBe(404);
    expect(body.error).toBe("pairing_not_found");
  });
});

describe("WebSocket session", () => {
  it("host connects and receives session.connect", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.sessionId as string;

    const host = await connectWs(sessionId, "host");
    const msg = await waitForMessage(host);
    expect(msg.type).toBe("session.connect");
    expect(msg.sessionId).toBe(sessionId);
    host.close();
  });

  it("host output is forwarded to client", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.sessionId as string;

    const host = await connectWs(sessionId, "host", "host-1");
    await waitForMessage(host); // session.connect

    const client = await connectWs(sessionId, "client", "client-1");
    await waitForMessage(client); // session.connect

    // Host sends terminal output
    const outputEnvelope = createEnvelope({
      type: "terminal.output",
      sessionId,
      seq: 0,
      payload: { stream: "stdout", data: "hello world", encoding: "utf8", isReplay: false, isFinal: false },
    });
    host.send(serializeEnvelope(outputEnvelope));

    const received = await waitForMessage(client);
    expect(received.type).toBe("terminal.output");
    expect((received.payload as Record<string, unknown>).data).toBe("hello world");
    expect(received.seq).toBe(0);

    host.close();
    client.close();
  });

  it("client input is forwarded to host", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.sessionId as string;

    const host = await connectWs(sessionId, "host", "host-2");
    await waitForMessage(host); // session.connect

    const client = await connectWs(sessionId, "client", "client-2");
    await waitForMessage(client); // session.connect

    // Client sends input
    const inputEnvelope = createEnvelope({
      type: "terminal.input",
      sessionId,
      payload: { data: "ls\n" },
    });
    client.send(serializeEnvelope(inputEnvelope));

    const received = await waitForMessage(host);
    expect(received.type).toBe("terminal.input");
    expect((received.payload as Record<string, unknown>).data).toBe("ls\n");

    host.close();
    client.close();
  });

  it("ACK is forwarded from client to host", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.sessionId as string;

    const host = await connectWs(sessionId, "host", "host-3");
    await waitForMessage(host);

    const client = await connectWs(sessionId, "client", "client-3");
    await waitForMessage(client);

    const ackEnvelope = createEnvelope({
      type: "session.ack",
      sessionId,
      payload: { seq: 5 },
    });
    client.send(serializeEnvelope(ackEnvelope));

    const received = await waitForMessage(host);
    expect(received.type).toBe("session.ack");
    expect((received.payload as Record<string, unknown>).seq).toBe(5);

    host.close();
    client.close();
  });
});

describe("Control ownership", () => {
  it("first client auto-gets control and can send input", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.sessionId as string;

    const host = await connectWs(sessionId, "host", "host-ctrl");
    await waitForMessage(host);

    const client = await connectWs(sessionId, "client", "client-ctrl");
    await waitForMessage(client);

    // Client sends input — should work since first client gets control
    client.send(serializeEnvelope(createEnvelope({
      type: "terminal.input",
      sessionId,
      payload: { data: "test\n" },
    })));

    const received = await waitForMessage(host);
    expect(received.type).toBe("terminal.input");

    host.close();
    client.close();
  });

  it("second client without control gets rejected", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.sessionId as string;

    const host = await connectWs(sessionId, "host", "host-ctrl2");
    await waitForMessage(host);

    const client1 = await connectWs(sessionId, "client", "client-ctrl2a");
    await waitForMessage(client1);

    const client2 = await connectWs(sessionId, "client", "client-ctrl2b");
    await waitForMessage(client2);

    // Client2 tries to send input — should be rejected
    client2.send(serializeEnvelope(createEnvelope({
      type: "terminal.input",
      sessionId,
      payload: { data: "nope\n" },
    })));

    const error = await waitForMessage(client2);
    expect(error.type).toBe("session.error");
    expect((error.payload as Record<string, unknown>).code).toBe("control_conflict");

    host.close();
    client1.close();
    client2.close();
  });
});

describe("Session list", () => {
  it("shows active sessions", async () => {
    const { body: pairing } = await postJson("/pairings", {});
    const sessionId = pairing.sessionId as string;

    const host = await connectWs(sessionId, "host", "host-list");
    await waitForMessage(host);

    const { body } = await getJson("/sessions");
    const sessions = body.sessions as Array<Record<string, unknown>>;
    const found = sessions.find((s) => s.id === sessionId);
    expect(found).toBeTruthy();
    expect(found!.hasHost).toBe(true);

    host.close();
  });
});
