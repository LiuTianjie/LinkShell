import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createNodeHttpHandler, createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { RpcPeer } from "@linkshell/wire";
import { describe, expect, it } from "vitest";
import { AcpConnection } from "../src/drivers/acp/connection.js";

describe("official ACP remote transports", () => {
  for (const transport of ["http", "websocket"] as const) for (const version of [1, 2] as const) it(`${transport} negotiates ACP ${version} and carries bidirectional requests`, async () => {
    const received: unknown[] = [], updates: unknown[] = [], headers: unknown[] = [];
    const acp = new AcpServer({ createAgent: () => ({ connect(stream) {
      const reader = stream.readable.getReader(), writer = stream.writable.getWriter();
      const peer = new RpcPeer({ send: (text) => { void writer.write(JSON.parse(text)).catch(() => {}); }, onRequest: async (method, params) => {
        received.push({ method, params });
        if (method === "initialize") return version === 1 ? { protocolVersion: 1, agentInfo: { name: "remote" }, agentCapabilities: { loadSession: true } } : { protocolVersion: 2, info: { name: "remote" }, capabilities: { session: {} } };
        if (method === "session/new") return { sessionId: "remote-session" };
        if (method === "session/prompt") {
          const answer = await peer.request("session/request_permission", { sessionId: "remote-session", toolCall: { toolCallId: "t", title: "Run" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }, 5000);
          peer.notify("session/update", { sessionId: "remote-session", update: { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "远程中文" } } });
          return { ...(version === 1 ? { stopReason: "end_turn" } : { messageId: "m" }), answer };
        }
        return {};
      } });
      const closed = (async () => {
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) return; peer.receive(JSON.stringify(chunk.value)); } }
        catch { /* Transport shutdown closes the reader. */ }
        finally { peer.close(); }
      })();
      return { closed };
    } }) });
    const handler = createNodeHttpHandler(acp), server = createServer((req, res) => { headers.push(req.headers["x-test"]); handler(req, res); });
    const sockets = new WebSocketServer({ noServer: true });
    const upgrade = createNodeWebSocketUpgradeHandler(acp, sockets);
    server.on("upgrade", (req, socket, head) => { headers.push(req.headers["x-test"]); upgrade(req, socket, head); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No test address");
    const connection = new AcpConnection({ command: "", args: [], protocolVersion: version, clientVersion: "test", transport: { type: transport, url: `${transport === "http" ? "http" : "ws"}://127.0.0.1:${address.port}/acp`, headers: { "X-Test": "transport-header" } },
      onUpdate: (_session, update) => updates.push(update), onRequest: () => ({ outcome: { outcome: "selected", optionId: "allow" } }), onExit: () => {},
    });
    try {
      expect((await connection.start()).protocolVersion).toBe(version);
      await connection.request("session/new", { cwd: "/tmp", mcpServers: [] });
      const result = await connection.request("session/prompt", { sessionId: "remote-session", prompt: [{ type: "text", text: "hello" }] });
      expect(result).toMatchObject({ answer: { outcome: { optionId: "allow" } } });
      const deadline = Date.now() + 1000;
      while (!updates.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(updates).toContainEqual({ sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "远程中文" } });
      expect(headers.every((header) => header === "transport-header")).toBe(true);
      expect(received[0]).toMatchObject(version === 1 ? { params: { clientCapabilities: { auth: { terminal: false } } } } : { params: { capabilities: { auth: {} } } });
    } finally {
      await connection.stop(); await acp.close(); sockets.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
