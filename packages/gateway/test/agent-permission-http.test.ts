import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { parseEnvelope, parseTypedPayload } from "@linkshell/protocol";
import {
  type AgentPermissionHttpBody,
  forwardAgentPermissionHttp,
  resolveAgentPermissionHttpAck,
} from "../src/agent-permission-http.js";
import { SessionManager } from "../src/sessions.js";
import { TokenManager } from "../src/tokens.js";

function createHarness(options: { hostConnected?: boolean } = {}) {
  const sessionManager = new SessionManager();
  const tokenManager = new TokenManager();
  const sessionId = "session-1";
  const token = tokenManager.register("device-token-1");
  tokenManager.bind(token, sessionId);

  const send = vi.fn();
  if (options.hostConnected !== false) {
    sessionManager.setHost(sessionId, {
      role: "host",
      deviceId: "host-1",
      connectedAt: Date.now(),
      socket: {
        OPEN: 1,
        readyState: 1,
        send,
      } as unknown as WebSocket,
    });
  }

  return {
    sessionId,
    token,
    send,
    sessionManager,
    tokenManager,
    destroy: () => {
      sessionManager.destroy();
      tokenManager.destroy();
    },
  };
}

describe("Live Activity permission HTTP forwarding", () => {
  it("forwards valid v2 payloads to the host", async () => {
    const h = createHarness();
    try {
      const body: AgentPermissionHttpBody = {
        protocol: "v2",
        sessionId: h.sessionId,
        conversationId: "conversation-1",
        requestId: "request-1",
        outcome: "allow",
        optionId: "allow_once",
      };

      const result = await forwardAgentPermissionHttp({
        token: h.token,
        body,
        sessionManager: h.sessionManager,
        tokenManager: h.tokenManager,
      });

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true });
      expect(result.forwarded).toEqual([
        { type: "agent.v2.permission.respond", terminalId: undefined },
      ]);
      expect(h.send).toHaveBeenCalledTimes(1);
      const envelope = parseEnvelope(h.send.mock.calls[0]![0] as string);
      expect(envelope.type).toBe("agent.v2.permission.respond");
      expect(envelope.sessionId).toBe(h.sessionId);
      expect(parseTypedPayload("agent.v2.permission.respond", envelope.payload)).toEqual({
        conversationId: "conversation-1",
        requestId: "request-1",
        outcome: "allow",
        optionId: "allow_once",
      });
    } finally {
      h.destroy();
    }
  });

  it("rejects missing or invalid tokens", async () => {
    const h = createHarness();
    try {
      const body: AgentPermissionHttpBody = {
        protocol: "v2",
        sessionId: h.sessionId,
        conversationId: "conversation-1",
        requestId: "request-1",
        outcome: "allow",
      };
      const result = await forwardAgentPermissionHttp({
        token: null,
        body,
        sessionManager: h.sessionManager,
        tokenManager: h.tokenManager,
      });

      expect(result.status).toBe(401);
      expect(result.body.error).toBe("unauthorized");
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      h.destroy();
    }
  });

  it("rejects tokens that do not own the session", async () => {
    const h = createHarness();
    try {
      const otherToken = h.tokenManager.register("other-token");
      const body: AgentPermissionHttpBody = {
        protocol: "v2",
        sessionId: h.sessionId,
        conversationId: "conversation-1",
        requestId: "request-1",
        outcome: "allow",
      };
      const result = await forwardAgentPermissionHttp({
        token: otherToken,
        body,
        sessionManager: h.sessionManager,
        tokenManager: h.tokenManager,
      });

      expect(result.status).toBe(401);
      expect(result.body.error).toBe("unauthorized");
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      h.destroy();
    }
  });

  it("returns session_not_found for a valid token bound to a missing session", async () => {
    const h = createHarness();
    try {
      const missingSessionId = "missing-session";
      h.tokenManager.bind(h.token, missingSessionId);
      const body: AgentPermissionHttpBody = {
        protocol: "v2",
        sessionId: missingSessionId,
        conversationId: "conversation-1",
        requestId: "request-1",
        outcome: "allow",
      };
      const result = await forwardAgentPermissionHttp({
        token: h.token,
        body,
        sessionManager: h.sessionManager,
        tokenManager: h.tokenManager,
      });

      expect(result.status).toBe(404);
      expect(result.body.error).toBe("session_not_found");
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      h.destroy();
    }
  });

  it("returns host_not_connected when the host is absent", async () => {
    const h = createHarness({ hostConnected: false });
    try {
      h.sessionManager.getOrCreate(h.sessionId);
      const body: AgentPermissionHttpBody = {
        protocol: "v2",
        sessionId: h.sessionId,
        conversationId: "conversation-1",
        requestId: "request-1",
        outcome: "allow",
      };
      const result = await forwardAgentPermissionHttp({
        token: h.token,
        body,
        sessionManager: h.sessionManager,
        tokenManager: h.tokenManager,
      });

      expect(result.status).toBe(409);
      expect(result.body.error).toBe("host_not_connected");
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      h.destroy();
    }
  });

  it("forwards terminal protocol payloads as permission.decision with terminalId", async () => {
    const h = createHarness();
    try {
      const body: AgentPermissionHttpBody = {
        protocol: "terminal",
        sessionId: h.sessionId,
        terminalId: "terminal-1",
        requestId: "request-1",
        outcome: "cancelled",
      };
      const resultPromise = forwardAgentPermissionHttp({
        token: h.token,
        body,
        sessionManager: h.sessionManager,
        tokenManager: h.tokenManager,
      });

      const envelope = parseEnvelope(h.send.mock.calls[0]![0] as string);
      expect(envelope.type).toBe("permission.decision");
      expect((envelope as any).terminalId).toBe("terminal-1");
      expect(parseTypedPayload("permission.decision", envelope.payload)).toEqual({
        requestId: "request-1",
        decision: "deny",
      });
      resolveAgentPermissionHttpAck({
        sessionId: h.sessionId,
        ack: {
          requestId: "request-1",
          decision: "deny",
          resolved: true,
          delivered: true,
        },
      });
      const result = await resultPromise;
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, resolved: true, delivered: true });
    } finally {
      h.destroy();
    }
  });

  it("forwards legacy protocol payloads with agentSessionId", async () => {
    const h = createHarness();
    try {
      const body: AgentPermissionHttpBody = {
        protocol: "legacy",
        sessionId: h.sessionId,
        agentSessionId: "agent-session-1",
        requestId: "request-1",
        outcome: "deny",
      };
      const result = await forwardAgentPermissionHttp({
        token: h.token,
        body,
        sessionManager: h.sessionManager,
        tokenManager: h.tokenManager,
      });

      expect(result.status).toBe(200);
      expect(h.send).toHaveBeenCalledTimes(1);
      const envelope = parseEnvelope(h.send.mock.calls[0]![0] as string);
      expect(envelope.type).toBe("agent.permission.response");
      expect(parseTypedPayload("agent.permission.response", envelope.payload)).toEqual({
        agentSessionId: "agent-session-1",
        requestId: "request-1",
        outcome: "deny",
      });
    } finally {
      h.destroy();
    }
  });

  it("also forwards terminal decisions for legacy terminal hook requests", async () => {
    const h = createHarness();
    try {
      const body: AgentPermissionHttpBody = {
        protocol: "legacy",
        sessionId: h.sessionId,
        terminalId: "terminal-1",
        requestId: "pr-123-abcdef",
        outcome: "allow",
        optionId: "allow_once",
      };
      const resultPromise = forwardAgentPermissionHttp({
        token: h.token,
        body,
        sessionManager: h.sessionManager,
        tokenManager: h.tokenManager,
      });

      expect(h.send).toHaveBeenCalledTimes(2);
      const legacyEnvelope = parseEnvelope(h.send.mock.calls[0]![0] as string);
      expect(legacyEnvelope.type).toBe("agent.permission.response");
      expect(parseTypedPayload("agent.permission.response", legacyEnvelope.payload)).toEqual({
        requestId: "pr-123-abcdef",
        outcome: "allow",
        optionId: "allow_once",
      });

      const terminalEnvelope = parseEnvelope(h.send.mock.calls[1]![0] as string);
      expect(terminalEnvelope.type).toBe("permission.decision");
      expect((terminalEnvelope as any).terminalId).toBe("terminal-1");
      expect(parseTypedPayload("permission.decision", terminalEnvelope.payload)).toEqual({
        requestId: "pr-123-abcdef",
        decision: "allow",
      });
      resolveAgentPermissionHttpAck({
        sessionId: h.sessionId,
        ack: {
          requestId: "pr-123-abcdef",
          decision: "allow",
          resolved: true,
          delivered: true,
        },
      });
      const result = await resultPromise;
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, resolved: true, delivered: true });
    } finally {
      h.destroy();
    }
  });
});
