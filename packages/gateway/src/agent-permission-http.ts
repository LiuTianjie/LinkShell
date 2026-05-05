import {
  createEnvelope,
  parseTypedPayload,
  serializeEnvelope,
} from "@linkshell/protocol";
import { z } from "zod";
import type { SessionManager } from "./sessions.js";
import type { TokenManager } from "./tokens.js";

const permissionOutcomeSchema = z.enum(["allow", "deny", "cancelled"]);

export const agentPermissionHttpBodySchema = z.discriminatedUnion("protocol", [
  z.object({
    protocol: z.literal("v2"),
    sessionId: z.string().min(1),
    conversationId: z.string().min(1),
    requestId: z.string().min(1),
    outcome: permissionOutcomeSchema,
    optionId: z.string().optional(),
    terminalId: z.string().optional(),
    agentSessionId: z.string().optional(),
  }),
  z.object({
    protocol: z.literal("legacy"),
    sessionId: z.string().min(1),
    conversationId: z.string().optional(),
    agentSessionId: z.string().optional(),
    requestId: z.string().min(1),
    outcome: permissionOutcomeSchema,
    optionId: z.string().optional(),
    terminalId: z.string().optional(),
  }),
  z.object({
    protocol: z.literal("terminal"),
    sessionId: z.string().min(1),
    conversationId: z.string().optional(),
    requestId: z.string().min(1),
    outcome: permissionOutcomeSchema,
    optionId: z.string().optional(),
    terminalId: z.string().min(1).optional(),
    agentSessionId: z.string().optional(),
  }),
]);

export type AgentPermissionHttpBody = z.infer<typeof agentPermissionHttpBodySchema>;

export type AgentPermissionHttpResult = {
  status: number;
  body: {
    ok?: true;
    error?: "unauthorized" | "session_not_found" | "host_not_connected" | "invalid_payload";
    message?: string;
  };
};

export function forwardAgentPermissionHttp(input: {
  token: string | null;
  body: AgentPermissionHttpBody;
  sessionManager: SessionManager;
  tokenManager: TokenManager;
}): AgentPermissionHttpResult {
  const { token, body, sessionManager, tokenManager } = input;

  if (!token || !tokenManager.owns(token, body.sessionId)) {
    return {
      status: 401,
      body: {
        error: "unauthorized",
        message: "Valid device token required",
      },
    };
  }

  const session = sessionManager.get(body.sessionId);
  if (!session) {
    return {
      status: 404,
      body: {
        error: "session_not_found",
        message: "Session not found",
      },
    };
  }

  if (!session.host || session.host.socket.readyState !== session.host.socket.OPEN) {
    return {
      status: 409,
      body: {
        error: "host_not_connected",
        message: "Host is not connected",
      },
    };
  }

  try {
    const envelopes = createPermissionEnvelopes(body);
    for (const envelope of envelopes) {
      session.host.socket.send(serializeEnvelope(envelope));
    }
    session.lastActivity = Date.now();
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return {
      status: 400,
      body: {
        error: "invalid_payload",
        message: err instanceof Error ? err.message : "Invalid permission response",
      },
    };
  }
}

function createPermissionEnvelopes(body: AgentPermissionHttpBody) {
  if (body.protocol === "v2") {
    const payload = parseTypedPayload("agent.v2.permission.respond", {
      conversationId: body.conversationId,
      requestId: body.requestId,
      outcome: body.outcome,
      optionId: body.optionId || undefined,
    });
    return [createEnvelope({
      type: "agent.v2.permission.respond",
      sessionId: body.sessionId,
      deviceId: "live-activity",
      payload,
    })];
  }

  if (body.protocol === "legacy") {
    const legacyPayload = parseTypedPayload("agent.permission.response", {
      agentSessionId: body.agentSessionId || undefined,
      requestId: body.requestId,
      outcome: body.outcome,
      optionId: body.optionId || undefined,
    });
    const envelopes = [createEnvelope({
      type: "agent.permission.response",
      sessionId: body.sessionId,
      deviceId: "live-activity",
      payload: legacyPayload,
    })];

    // `pr-*` requests are terminal PermissionRequest hooks surfaced through the
    // legacy Agent UI channel. Send the terminal decision too so older hosts, and
    // hosts that route hook permissions through terminal handling, can resolve it
    // without involving the mobile websocket/controller path.
    if (body.requestId.startsWith("pr-")) {
      const decisionPayload = parseTypedPayload("permission.decision", {
        requestId: body.requestId,
        decision: body.outcome === "allow" ? "allow" : "deny",
      });
      envelopes.push(createEnvelope({
        type: "permission.decision",
        sessionId: body.sessionId,
        terminalId: body.terminalId ?? "default",
        deviceId: "live-activity",
        payload: decisionPayload,
      }));
    }

    return envelopes;
  }

  const payload = parseTypedPayload("permission.decision", {
    requestId: body.requestId,
    decision: body.outcome === "allow" ? "allow" : "deny",
  });
  return [createEnvelope({
    type: "permission.decision",
    sessionId: body.sessionId,
    terminalId: body.terminalId ?? "default",
    deviceId: "live-activity",
    payload,
  })];
}
