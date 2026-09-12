import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { parseEnvelope, parseTypedPayload } from "@linkshell/protocol";
import {
  type AgentPermissionHttpBody,
  forwardAgentPermissionHttp,
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

  it("forwards terminal protocol payloads as agent.v2.permission.respond when conversationId is set", async () => {
    const h = createHarness();
    try {
      const body: AgentPermissionHttpBody = {
        protocol: "terminal",
        sessionId: h.sessionId,
        conversationId: "conversation-1",
        terminalId: "terminal-1",
        requestId: "request-1",
        outcome: "cancelled",
      };
      const result = await forwardAgentPermissionHttp({
        token: h.token,
        body,
        sessionManager: h.sessionManager,
        tokenManager: h.tokenManager,
      });

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true });
      expect(h.send).toHaveBeenCalledTimes(1);
      const envelope = parseEnvelope(h.send.mock.calls[0]![0] as string);
      expect(envelope.type).toBe("agent.v2.permission.respond");
      expect(parseTypedPayload("agent.v2.permission.respond", envelope.payload)).toEqual({
        conversationId: "conversation-1",
        requestId: "request-1",
        outcome: "cancelled",
      });
    } finally {
      h.destroy();
    }
  });

  it("forwards legacy protocol payloads as agent.v2.permission.respond", async () => {
    const h = createHarness();
    try {
      const body: AgentPermissionHttpBody = {
        protocol: "legacy",
        sessionId: h.sessionId,
        conversationId: "conversation-1",
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
      expect(envelope.type).toBe("agent.v2.permission.respond");
      expect(parseTypedPayload("agent.v2.permission.respond", envelope.payload)).toEqual({
        conversationId: "conversation-1",
        requestId: "request-1",
        outcome: "deny",
      });
    } finally {
      h.destroy();
    }
  });

  it("rejects agent-auth HTTP without conversationId instead of emitting permission.decision", async () => {
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
      const result = await forwardAgentPermissionHttp({
        token: h.token,
        body,
        sessionManager: h.sessionManager,
        tokenManager: h.tokenManager,
      });

      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_payload");
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      h.destroy();
    }
  });
});
