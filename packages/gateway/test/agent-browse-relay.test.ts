import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import {
  agentV2ClientReadMessageTypes,
  agentV2ClientWriteMessageTypes,
  createEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type Envelope,
  type ProtocolMessageType,
} from "@linkshell/protocol";
import { SessionManager } from "../src/sessions.js";
import { handleSocketMessage } from "../src/relay.js";

// In-memory gateway for relay-only tests. Smaller than e2e.test.ts on purpose.
const TEST_PORT = 18799;
const WS_BASE = `ws://localhost:${TEST_PORT}`;

const queues = new WeakMap<WebSocket, Envelope[]>();
const waiters = new WeakMap<WebSocket, Array<(envelope: Envelope) => void>>();

function attachBuffer(ws: WebSocket): void {
  queues.set(ws, []);
  waiters.set(ws, []);
  ws.on("message", (data) => {
    const envelope = parseEnvelope(data.toString());
    const pending = waiters.get(ws) ?? [];
    const next = pending.shift();
    if (next) next(envelope);
    else queues.get(ws)?.push(envelope);
  });
}

function nextEnvelope(ws: WebSocket, predicate?: (envelope: Envelope) => boolean): Promise<Envelope> {
  const queue = queues.get(ws) ?? [];
  const matchIndex = predicate ? queue.findIndex(predicate) : queue.length > 0 ? 0 : -1;
  if (matchIndex >= 0) {
    const [match] = queue.splice(matchIndex, 1);
    return Promise.resolve(match);
  }
  return new Promise((resolve) => {
    const list = waiters.get(ws) ?? [];
    const wrapped = (envelope: Envelope) => {
      if (!predicate || predicate(envelope)) {
        resolve(envelope);
        return;
      }
      queues.get(ws)?.push(envelope);
      list.push(wrapped);
      waiters.set(ws, list);
    };
    list.push(wrapped);
    waiters.set(ws, list);
  });
}

function connectWs(sessionId: string, role: "host" | "client", deviceId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `${WS_BASE}/ws?sessionId=${sessionId}&role=${role}&deviceId=${deviceId}`;
    const ws = new WebSocket(url);
    attachBuffer(ws);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function agentReadPayload(type: ProtocolMessageType): Record<string, unknown> {
  switch (type) {
    case "agent.v2.conversation.list":
      return { includeArchived: true };
    case "agent.v2.snapshot.request":
      return { conversationId: "conversation-1" };
    default:
      return {};
  }
}

function agentWritePayload(type: ProtocolMessageType, suffix: string): Record<string, unknown> {
  switch (type) {
    case "agent.v2.conversation.open":
      return {
        conversationId: `conversation-open-${suffix}`,
        provider: "codex",
        cwd: "/repo",
      };
    case "agent.v2.prompt":
      return {
        conversationId: "conversation-1",
        clientMessageId: `msg-${suffix}`,
        contentBlocks: [{ type: "text", text: "hello" }],
      };
    case "agent.v2.command.execute":
      return {
        conversationId: "conversation-1",
        commandId: "codex:linkshell:plan",
        rawText: "/plan",
        clientMessageId: `cmd-${suffix}`,
      };
    case "agent.v2.cancel":
      return { conversationId: "conversation-1" };
    case "agent.v2.permission.respond":
      return {
        conversationId: "conversation-1",
        requestId: `permission-${suffix}`,
        outcome: "allow",
        optionId: "allow_once",
      };
    case "agent.v2.structured_input.respond":
      return {
        conversationId: "conversation-1",
        requestId: `input-${suffix}`,
        answers: { question: ["answer"] },
      };
    default:
      return {};
  }
}

let server: Server;
let wss: WebSocketServer;
let sessionManager: SessionManager;

beforeAll(async () => {
  sessionManager = new SessionManager();
  server = createServer();
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, url));
  });

  wss.on("connection", (socket: WebSocket, _req: unknown, url: URL) => {
    const sessionId = url.searchParams.get("sessionId")!;
    const role = url.searchParams.get("role") as "host" | "client";
    const deviceId = url.searchParams.get("deviceId") ?? `device-${Math.random()}`;
    const device = { socket, role, deviceId, connectedAt: Date.now() };
    if (role === "host") sessionManager.setHost(sessionId, device);
    else sessionManager.addClient(sessionId, device);
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("relay controller gating", () => {
  it("forwards terminal.browse from a non-controller client to the host", async () => {
    const sessionId = `browse-${Date.now()}`;
    const host = await connectWs(sessionId, "host", "host-1");
    const observer = await connectWs(sessionId, "client", "observer");
    const controller = await connectWs(sessionId, "client", "controller");

    // Make `controller` the active controller; `observer` is intentionally NOT.
    controller.send(serializeEnvelope(createEnvelope({
      type: "control.claim",
      sessionId,
      deviceId: "controller",
      payload: { deviceId: "controller" },
    })));
    await nextEnvelope(host, (e) => e.type === "control.grant");

    observer.send(serializeEnvelope(createEnvelope({
      type: "terminal.browse",
      sessionId,
      deviceId: "observer",
      payload: { path: "/tmp", includeFiles: false, requestId: "browse-1" },
    })));

    const received = await Promise.race([
      nextEnvelope(host, (e) => e.type === "terminal.browse"),
      new Promise<Envelope>((_, reject) => setTimeout(() => reject(new Error("host did not get browse")), 1500)),
    ]);
    expect(received.type).toBe("terminal.browse");
    expect((received.payload as { requestId: string }).requestId).toBe("browse-1");

    host.close();
    observer.close();
    controller.close();
  });

  it("rejects terminal.input from a non-controller with control_conflict", async () => {
    const sessionId = `input-${Date.now()}`;
    const host = await connectWs(sessionId, "host", "host-1");
    const observer = await connectWs(sessionId, "client", "observer");
    const controller = await connectWs(sessionId, "client", "controller");

    controller.send(serializeEnvelope(createEnvelope({
      type: "control.claim",
      sessionId,
      deviceId: "controller",
      payload: { deviceId: "controller" },
    })));
    await nextEnvelope(host, (e) => e.type === "control.grant");

    observer.send(serializeEnvelope(createEnvelope({
      type: "terminal.input",
      sessionId,
      deviceId: "observer",
      payload: { data: "echo hi\n" },
    })));

    const error = await nextEnvelope(observer, (e) => e.type === "session.error");
    expect((error.payload as { code: string }).code).toBe("control_conflict");

    host.close();
    observer.close();
    controller.close();
  });

  it("uses shared agent.v2 route policy for read and write messages", async () => {
    const sessionId = `agent-route-${Date.now()}`;
    const host = await connectWs(sessionId, "host", "host-1");
    const observer = await connectWs(sessionId, "client", "observer");
    const controller = await connectWs(sessionId, "client", "controller");

    controller.send(serializeEnvelope(createEnvelope({
      type: "control.claim",
      sessionId,
      deviceId: "controller",
      payload: { deviceId: "controller" },
    })));
    await nextEnvelope(host, (e) => e.type === "control.grant");

    for (const type of agentV2ClientReadMessageTypes) {
      observer.send(serializeEnvelope(createEnvelope({
        type,
        sessionId,
        deviceId: "observer",
        payload: agentReadPayload(type),
      })));
      const read = await nextEnvelope(host, (e) => e.type === type);
      expect(read.deviceId).toBe("observer");
    }

    host.send(serializeEnvelope({
      id: "agent-event-1",
      type: "agent.v2.event",
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        conversationId: "conversation-1",
        item: {
          id: "item-1",
          conversationId: "conversation-1",
          type: "message",
          kind: "chat",
          role: "assistant",
          text: "hello",
          createdAt: Date.now(),
        },
      },
    } as Envelope));
    const relayedEvent = await nextEnvelope(observer, (e) => e.type === "agent.v2.event");
    expect((relayedEvent.payload as { conversationId?: string }).conversationId).toBe("conversation-1");

    for (const [index, type] of agentV2ClientWriteMessageTypes.entries()) {
      observer.send(serializeEnvelope(createEnvelope({
        type,
        sessionId,
        deviceId: "observer",
        payload: agentWritePayload(type, `observer-${index}`),
      })));
      const error = await nextEnvelope(observer, (e) => e.type === "session.error");
      expect((error.payload as { code: string }).code).toBe("control_conflict");

      controller.send(serializeEnvelope(createEnvelope({
        type,
        sessionId,
        deviceId: "controller",
        payload: agentWritePayload(type, `controller-${index}`),
      })));
      const write = await nextEnvelope(host, (e) => e.type === type);
      expect(write.deviceId).toBe("controller");
    }

    host.close();
    observer.close();
    controller.close();
  });

  it("keeps agent.v2 payloads transparent and leaves shape validation to endpoints", async () => {
    const sessionId = `agent-transparent-${Date.now()}`;
    const host = await connectWs(sessionId, "host", "host-1");
    const observer = await connectWs(sessionId, "client", "observer");

    host.send(serializeEnvelope({
      id: "agent-event-invalid",
      type: "agent.v2.event",
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { opaque: true },
    } as Envelope));

    const relayed = await nextEnvelope(observer, (e) => e.type === "agent.v2.event");
    expect(relayed.payload).toEqual({ opaque: true });
    expect((queues.get(host) ?? []).find((e) => e.type === "session.error")).toBeUndefined();

    host.close();
    observer.close();
  });
});
