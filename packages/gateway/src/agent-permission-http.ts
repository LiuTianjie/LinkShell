import {
  createEnvelope,
  parseTypedPayload,
  serializeEnvelope,
} from "@linkshell/protocol";
import { z } from "zod";
import type { SessionManager } from "./sessions.js";
import type { TokenManager } from "./tokens.js";

const permissionOutcomeSchema = z.enum(["allow", "deny", "cancelled"]);
const PERMISSION_ACK_TIMEOUT_MS = 12_000;

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
  forwarded?: Array<{
    type: string;
    terminalId?: string;
  }>;
  ack?: AgentPermissionAck;
  body: {
    ok?: true;
    error?: "unauthorized" | "session_not_found" | "host_not_connected" | "invalid_payload" | "permission_not_delivered" | "permission_ack_timeout";
    message?: string;
    resolved?: boolean;
    delivered?: boolean;
  };
};

export type AgentPermissionAck = {
  requestId: string;
  decision: "allow" | "deny";
  resolved: boolean;
  delivered: boolean;
  source?: string;
  message?: string;
};

const pendingAcks = new Map<string, {
  resolve: (ack: AgentPermissionAck) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function ackKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

export function resolveAgentPermissionHttpAck(input: {
  sessionId: string;
  ack: AgentPermissionAck;
}): boolean {
  const key = ackKey(input.sessionId, input.ack.requestId);
  const pending = pendingAcks.get(key);
  if (!pending) return false;
  pendingAcks.delete(key);
  clearTimeout(pending.timer);
  pending.resolve(input.ack);
  return true;
}

function waitForAck(sessionId: string, requestId: string): Promise<AgentPermissionAck | null> {
  const key = ackKey(sessionId, requestId);
  const existing = pendingAcks.get(key);
  if (existing) {
    pendingAcks.delete(key);
    clearTimeout(existing.timer);
    existing.resolve({
      requestId,
      decision: "deny",
      resolved: false,
      delivered: false,
      message: "Superseded by a newer permission response",
    });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(key);
      resolve(null);
    }, PERMISSION_ACK_TIMEOUT_MS);
    pendingAcks.set(key, { resolve, timer });
  });
}

export async function forwardAgentPermissionHttp(input: {
  token: string | null;
  body: AgentPermissionHttpBody;
  sessionManager: SessionManager;
  tokenManager: TokenManager;
}): Promise<AgentPermissionHttpResult> {
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
    const waitsForDelivery = envelopes.some((envelope) => envelope.type === "permission.decision");
    const ackPromise = waitsForDelivery ? waitForAck(body.sessionId, body.requestId) : null;
    for (const envelope of envelopes) {
      session.host.socket.send(serializeEnvelope(envelope));
    }
    session.lastActivity = Date.now();
    if (ackPromise) {
      const ack = await ackPromise;
      if (!ack) {
        return {
          status: 504,
          forwarded: envelopes.map((envelope) => ({
            type: envelope.type,
            terminalId: envelope.terminalId,
          })),
          body: {
            error: "permission_ack_timeout",
            message: "Timed out waiting for host permission delivery acknowledgement",
          },
        };
      }
      if (!ack.delivered) {
        return {
          status: 409,
          forwarded: envelopes.map((envelope) => ({
            type: envelope.type,
            terminalId: envelope.terminalId,
          })),
          ack,
          body: {
            error: "permission_not_delivered",
            message: ack.message ?? "Permission response was not delivered to the Agent",
            resolved: ack.resolved,
            delivered: ack.delivered,
          },
        };
      }
      return {
        status: 200,
        forwarded: envelopes.map((envelope) => ({
          type: envelope.type,
          terminalId: envelope.terminalId,
        })),
        ack,
        body: {
          ok: true,
          resolved: ack.resolved,
          delivered: ack.delivered,
        },
      };
    }
    return {
      status: 200,
      forwarded: envelopes.map((envelope) => ({
        type: envelope.type,
        terminalId: envelope.terminalId,
      })),
      body: { ok: true },
    };
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
