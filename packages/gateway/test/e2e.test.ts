import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import { createEnvelope, parseEnvelope, serializeEnvelope } from "@linkshell/protocol";
import { parseTypedPayload as parseLocalTypedPayload } from "../../shared-protocol/src/index.js";
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

function connectWs(hostDeviceId: string, role: string, deviceId?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `${WS_BASE}/ws?hostDeviceId=${hostDeviceId}&role=${role}${deviceId ? `&deviceId=${deviceId}` : ""}`;
    const ws = new WebSocket(url);
    attachMessageBuffer(ws);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

const messageQueues = new WeakMap<WebSocket, ReturnType<typeof parseEnvelope>[]>();
const messageWaiters = new WeakMap<WebSocket, Array<(msg: ReturnType<typeof parseEnvelope>) => void>>();

function attachMessageBuffer(ws: WebSocket): void {
  messageQueues.set(ws, []);
  messageWaiters.set(ws, []);
  ws.on("message", (data) => {
    const msg = parseEnvelope(data.toString());
    const waiters = messageWaiters.get(ws) ?? [];
    const waiter = waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      messageQueues.get(ws)?.push(msg);
    }
  });
}

function waitForMessage(ws: WebSocket): Promise<ReturnType<typeof parseEnvelope>> {
  const queue = messageQueues.get(ws);
  const queued = queue?.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve) => {
    const waiters = messageWaiters.get(ws) ?? [];
    waiters.push(resolve);
    messageWaiters.set(ws, waiters);
  });
}

// ── Test server setup ───────────────────────────────────────────────

let server: Server;
let wss: WebSocketServer;
let sessionManager: SessionManager;
let pairingManager: PairingManager;
let pairingCounter = 0;

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
      const record = pairingManager.create((body.hostDeviceId as string | undefined) ?? `host-${++pairingCounter}`);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        hostDeviceId: record.hostDeviceId,
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
      res.end(JSON.stringify({ hostDeviceId: result.hostDeviceId }));
      return;
    }

    if (method === "GET" && url.pathname === "/devices") {
      const devices = sessionManager.listActive().map((s) => ({
        id: s.id,
        hostDeviceId: s.hostDeviceId,
        state: s.state,
        hasHost: !!s.host,
        clientCount: s.clients.size,
        machineId: s.machineId ?? null,
        hostname: s.hostname ?? null,
        cwd: s.cwd ?? null,
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ devices }));
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
    const hostDeviceId = url.searchParams.get("hostDeviceId")!;
    const role = url.searchParams.get("role") as "host" | "client";
    const deviceId = url.searchParams.get("deviceId") ?? "test-device";

    const device = { socket, role, deviceId, connectedAt: Date.now() };
    if (role === "host") {
      sessionManager.setHost(hostDeviceId, device);
    } else {
      sessionManager.addClient(hostDeviceId, device);
    }

    socket.send(serializeEnvelope(createEnvelope({
      type: "device.connect",
      hostDeviceId,
      payload: { role, clientName: deviceId },
    })));

    socket.on("message", (data: WebSocket.RawData) => {
      handleSocketMessage(socket, data.toString(), role, hostDeviceId, deviceId, sessionManager);
    });

    socket.on("close", () => {
      if (role === "host") sessionManager.removeHost(hostDeviceId);
      else sessionManager.removeClient(hostDeviceId, deviceId);
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

describe("Protocol schemas", () => {
  it("keeps provider capability fields for agent v2", () => {
    const payload = parseLocalTypedPayload("agent.v2.capabilities", {
      enabled: true,
      provider: "codex",
      providers: [{
        id: "codex",
        label: "Codex",
        enabled: true,
        models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
        defaultModel: "gpt-5.5",
        reasoningEfforts: ["none", "minimal", "high"],
        permissionModes: ["read_only", "workspace_write"],
        commands: [{
          id: "codex:linkshell:plan",
          name: "plan",
          title: "/plan",
          description: "Enter plan mode",
          provider: "codex",
          source: "linkshell",
          argsMode: "none",
          executionKind: "native",
        }],
        modes: [{ id: "plan", title: "Plan" }],
        currentMode: "plan",
        features: { permissions: true, reasoningEffort: true },
      }],
      supportsSessionList: true,
      supportsSessionLoad: true,
      supportsImages: true,
      supportsAudio: false,
      supportsPermission: true,
      supportsPlan: true,
      supportsCancel: true,
    });
    expect(payload.providers?.[0]?.models?.[0]?.id).toBe("gpt-5.5");
    expect(payload.providers?.[0]?.defaultModel).toBe("gpt-5.5");
    expect(payload.providers?.[0]?.reasoningEfforts).toContain("minimal");
    expect(payload.providers?.[0]?.permissionModes).toContain("read_only");
    expect(payload.providers?.[0]?.commands?.[0]?.name).toBe("plan");
    expect(payload.providers?.[0]?.modes?.[0]?.id).toBe("plan");
    expect(payload.providers?.[0]?.currentMode).toBe("plan");
    expect(payload.providers?.[0]?.features?.permissions).toBe(true);
  });

  it("validates agent command execution and collaboration mode payloads", () => {
    const command = parseLocalTypedPayload("agent.v2.command.execute", {
      conversationId: "conversation-1",
      commandId: "codex:linkshell:plan",
      rawText: "/plan",
      clientMessageId: "cmd-1",
    });
    expect(command.commandId).toBe("codex:linkshell:plan");

    const prompt = parseLocalTypedPayload("agent.v2.prompt", {
      conversationId: "conversation-1",
      clientMessageId: "msg-1",
      contentBlocks: [{ type: "text", text: "make a plan" }],
      collaborationMode: "plan",
    });
    expect(prompt.collaborationMode).toBe("plan");
  });

  it("accepts missing and present machineId fields", () => {
    const legacyConnect = parseLocalTypedPayload("session.connect", {
      role: "host",
      clientName: "old-cli",
    });
    expect(legacyConnect.machineId).toBeUndefined();

    const connect = parseLocalTypedPayload("session.connect", {
      role: "host",
      clientName: "new-cli",
      machineId: "machine-123",
    });
    expect(connect.machineId).toBe("machine-123");

    const status = parseLocalTypedPayload("terminal.status", {
      phase: "idle",
      machineId: "machine-123",
    });
    expect(status.machineId).toBe("machine-123");
  });

  it("keeps terminal payloads generic and provider-free", () => {
    const connect = parseLocalTypedPayload("device.connect", {
      role: "host",
      clientName: "shell-cli",
      capabilities: ["terminal"],
    });
    expect(connect.capabilities).toContain("terminal");

    const spawn = parseLocalTypedPayload("terminal.spawn", {
      cwd: "/repo",
    });
    expect(spawn.cwd).toBe("/repo");
  });

  it("keeps structured agent v2 patch fields", () => {
    const payload = parseLocalTypedPayload("agent.v2.event", {
      conversationId: "conversation-1",
      patch: {
        itemId: "tool-1",
        kind: "command_execution",
        commandExecution: {
          command: "pnpm typecheck",
          status: "running",
          output: "checking",
        },
        fileChange: {
          entries: [{ path: "packages/shared-protocol/src/index.ts", kind: "modified" }],
          status: "completed",
        },
        metadata: { inputPending: false },
      },
    });
    expect(payload.patch?.commandExecution?.command).toBe("pnpm typecheck");
    expect(payload.patch?.fileChange?.entries[0]?.path).toBe("packages/shared-protocol/src/index.ts");
    expect(payload.patch?.metadata?.inputPending).toBe(false);
  });
});

describe("Pairing flow", () => {
  it("creates a pairing and returns code + hostDeviceId", async () => {
    const { status, body } = await postJson("/pairings", { hostDeviceId: "host-pair-create" });
    expect(status).toBe(201);
    expect(body.pairingCode).toMatch(/^\d{6}$/);
    expect(body.hostDeviceId).toBe("host-pair-create");
    expect(body.expiresAt).toBeTruthy();
  });

  it("claims a pairing with valid code", async () => {
    const create = await postJson("/pairings", { hostDeviceId: "host-pair-claim" });
    const claim = await postJson("/pairings/claim", { pairingCode: create.body.pairingCode });
    expect(claim.status).toBe(200);
    expect(claim.body.hostDeviceId).toBe(create.body.hostDeviceId);
  });

  it("rejects invalid pairing code", async () => {
    const { status, body } = await postJson("/pairings/claim", { pairingCode: "000000" });
    expect(status).toBe(404);
    expect(body.error).toBe("pairing_not_found");
  });
});

describe("WebSocket device", () => {
  it("host connects and receives device.connect", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.hostDeviceId as string;

    const host = await connectWs(sessionId, "host");
    const msg = await waitForMessage(host);
    expect(msg.type).toBe("device.connect");
    expect(msg.hostDeviceId).toBe(sessionId);
    host.close();
  });

  it("host output is forwarded to client", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.hostDeviceId as string;

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
    const sessionId = body.hostDeviceId as string;

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
    const sessionId = body.hostDeviceId as string;

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

  it("rejects invalid typed payloads without killing the session", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.hostDeviceId as string;

    const host = await connectWs(sessionId, "host", "host-invalid-payload");
    await waitForMessage(host);

    const client = await connectWs(sessionId, "client", "client-invalid-payload");
    await waitForMessage(client);

    host.send(serializeEnvelope(createEnvelope({
      type: "terminal.resize",
      hostDeviceId: sessionId,
      payload: {
        cols: 0,
        rows: 24,
      },
    })));

    const error = await waitForMessage(host);
    expect(error.type).toBe("device.error");
    expect((error.payload as Record<string, unknown>).code).toBe("invalid_message");

    host.send(serializeEnvelope(createEnvelope({
      type: "terminal.output",
      sessionId,
      seq: 1,
      payload: { stream: "stdout", data: "still alive", encoding: "utf8" },
    })));

    const received = await waitForMessage(client);
    expect(received.type).toBe("terminal.output");
    expect((received.payload as Record<string, unknown>).data).toBe("still alive");

    client.send(serializeEnvelope(createEnvelope({
      type: "terminal.input",
      sessionId,
      payload: {},
    })));

    const clientError = await waitForMessage(client);
    expect(clientError.type).toBe("device.error");
    expect((clientError.payload as Record<string, unknown>).code).toBe("invalid_message");

    host.close();
    client.close();
  });

  it("rejects envelopes whose hostDeviceId differs from the websocket URL", async () => {
    const { body: first } = await postJson("/pairings", {});
    const { body: second } = await postJson("/pairings", {});
    const sessionId = first.hostDeviceId as string;
    const otherSessionId = second.hostDeviceId as string;

    const host = await connectWs(sessionId, "host", "host-mismatch");
    await waitForMessage(host);

    const client = await connectWs(sessionId, "client", "client-mismatch");
    await waitForMessage(client);

    client.send(serializeEnvelope(createEnvelope({
      type: "terminal.input",
      hostDeviceId: otherSessionId,
      payload: { data: "cross-session\n" },
    })));

    const error = await waitForMessage(client);
    expect(error.type).toBe("device.error");
    expect(error.hostDeviceId).toBe(sessionId);
    expect((error.payload as Record<string, unknown>).code).toBe("invalid_message");

    host.close();
    client.close();
  });
});

describe("Control ownership", () => {
  it("first client auto-gets control and can send input", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.hostDeviceId as string;

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
    const sessionId = body.hostDeviceId as string;

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
    expect(error.type).toBe("device.error");
    expect((error.payload as Record<string, unknown>).code).toBe("control_conflict");

    host.close();
    client1.close();
    client2.close();
  });

  it("rejects agent prompt from non-controller clients", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.hostDeviceId as string;

    const host = await connectWs(sessionId, "host", "host-agent-ctrl");
    await waitForMessage(host);

    const client1 = await connectWs(sessionId, "client", "client-agent-ctrl-a");
    await waitForMessage(client1);

    const client2 = await connectWs(sessionId, "client", "client-agent-ctrl-b");
    await waitForMessage(client2);

    client2.send(serializeEnvelope(createEnvelope({
      type: "agent.prompt",
      sessionId,
      payload: {
        clientMessageId: "test-message",
        contentBlocks: [{ type: "text", text: "hello" }],
      },
    })));

    const error = await waitForMessage(client2);
    expect(error.type).toBe("device.error");
    expect((error.payload as Record<string, unknown>).code).toBe("control_conflict");

    client2.send(serializeEnvelope(createEnvelope({
      type: "agent.session.new",
      sessionId,
      payload: { cwd: "/tmp" },
    })));

    const sessionError = await waitForMessage(client2);
    expect(sessionError.type).toBe("device.error");
    expect((sessionError.payload as Record<string, unknown>).code).toBe("control_conflict");

    host.close();
    client1.close();
    client2.close();
  });

  it("routes structured input responses only from the controller", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.hostDeviceId as string;

    const host = await connectWs(sessionId, "host", "host-agent-input");
    await waitForMessage(host);

    const client1 = await connectWs(sessionId, "client", "client-agent-input-a");
    await waitForMessage(client1);

    const client2 = await connectWs(sessionId, "client", "client-agent-input-b");
    await waitForMessage(client2);

    const response = createEnvelope({
      type: "agent.v2.structured_input.respond",
      sessionId,
      payload: {
        conversationId: "conversation-1",
        requestId: "input-1",
        answers: { question: ["answer"] },
      },
    });

    client2.send(serializeEnvelope(response));
    const error = await waitForMessage(client2);
    expect(error.type).toBe("device.error");
    expect((error.payload as Record<string, unknown>).code).toBe("control_conflict");

    client1.send(serializeEnvelope(response));
    const received = await waitForMessage(host);
    expect(received.type).toBe("agent.v2.structured_input.respond");
    expect((received.payload as Record<string, unknown>).requestId).toBe("input-1");

    host.close();
    client1.close();
    client2.close();
  });

  it("routes agent command execution only from the controller", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.hostDeviceId as string;

    const host = await connectWs(sessionId, "host", "host-agent-command");
    await waitForMessage(host);

    const client1 = await connectWs(sessionId, "client", "client-agent-command-a");
    await waitForMessage(client1);

    const client2 = await connectWs(sessionId, "client", "client-agent-command-b");
    await waitForMessage(client2);

    const command = createEnvelope({
      type: "agent.v2.command.execute",
      sessionId,
      payload: {
        conversationId: "conversation-1",
        commandId: "codex:linkshell:plan",
        rawText: "/plan",
        clientMessageId: "cmd-1",
      },
    });

    client2.send(serializeEnvelope(command));
    const error = await waitForMessage(client2);
    expect(error.type).toBe("device.error");
    expect((error.payload as Record<string, unknown>).code).toBe("control_conflict");

    client1.send(serializeEnvelope(command));
    const received = await waitForMessage(host);
    expect(received.type).toBe("agent.v2.command.execute");
    expect((received.payload as Record<string, unknown>).commandId).toBe("codex:linkshell:plan");

    host.close();
    client1.close();
    client2.close();
  });

  it("does not store agent messages in terminal status replay", async () => {
    const { body } = await postJson("/pairings", {});
    const sessionId = body.hostDeviceId as string;

    const host = await connectWs(sessionId, "host", "host-agent-cache");
    await waitForMessage(host);

    const client = await connectWs(sessionId, "client", "client-agent-cache");
    await waitForMessage(client);

    host.send(serializeEnvelope(createEnvelope({
      type: "agent.v2.capabilities",
      sessionId,
      payload: {
        enabled: true,
        provider: "codex",
        providers: [],
        workspaceProtocolVersion: 2,
        supportsSessionList: true,
        supportsSessionLoad: true,
        supportsImages: false,
        supportsAudio: false,
        supportsPermission: true,
        supportsPlan: true,
        supportsCancel: true,
      },
    })));

    const received = await waitForMessage(client);
    expect(received.type).toBe("agent.v2.capabilities");
    expect(sessionManager.getStatusReplay(sessionId)).toHaveLength(0);

    host.close();
    client.close();
  });
});

describe("Device list", () => {
  it("shows active devices", async () => {
    const { body: pairing } = await postJson("/pairings", {});
    const sessionId = pairing.hostDeviceId as string;

    const host = await connectWs(sessionId, "host", "host-list");
    await waitForMessage(host);
    sessionManager.setMetadata(
      sessionId,
      "codex",
      "machine-list",
      "workstation",
      undefined,
      "/repo",
      "repo",
    );

    const { body } = await getJson("/devices");
    const devices = body.devices as Array<Record<string, unknown>>;
    const found = devices.find((s) => s.hostDeviceId === sessionId);
    expect(found).toBeTruthy();
    expect(found!.hasHost).toBe(true);
    expect(found!.machineId).toBe("machine-list");
    expect(found!.hostname).toBe("workstation");
    expect(found!.cwd).toBe("/repo");

    host.close();
  });
});

describe("Device authorization revocation", () => {
  it("disconnects live clients for the revoked authorization", () => {
    const manager = new SessionManager();
    const closeA = vi.fn();
    const closeB = vi.fn();

    try {
      manager.setHost("host-revoke", {
        role: "host",
        deviceId: "host-revoke-device",
        connectedAt: Date.now(),
        socket: {
          OPEN: 1,
          readyState: 1,
        } as unknown as WebSocket,
      });
      manager.addClient("host-revoke", {
        role: "client",
        deviceId: "client-a",
        token: "token-a",
        authorizationId: "auth-a",
        connectedAt: Date.now(),
        socket: {
          OPEN: 1,
          readyState: 1,
          close: closeA,
        } as unknown as WebSocket,
      });
      manager.addClient("host-revoke", {
        role: "client",
        deviceId: "client-b",
        token: "token-b",
        authorizationId: "auth-b",
        connectedAt: Date.now(),
        socket: {
          OPEN: 1,
          readyState: 1,
          close: closeB,
        } as unknown as WebSocket,
      });

      const closed = manager.disconnectAuthorization("host-revoke", "auth-a");
      const summary = manager.getSummary("host-revoke");

      expect(closed).toBe(1);
      expect(closeA).toHaveBeenCalledWith(4001, "authorization revoked");
      expect(closeB).not.toHaveBeenCalled();
      expect(summary?.clientCount).toBe(1);
      expect(summary?.controllerId).toBe("client-b");
    } finally {
      manager.destroy();
    }
  });
});
