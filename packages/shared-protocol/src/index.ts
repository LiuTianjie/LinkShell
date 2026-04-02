import { z } from "zod";

// ── Protocol version ────────────────────────────────────────────────

export const PROTOCOL_VERSION = 1;

// ── Device & Session enums ──────────────────────────────────────────

export const deviceRoleSchema = z.enum(["host", "client"]);
export type DeviceRole = z.infer<typeof deviceRoleSchema>;

export const sessionStateSchema = z.enum([
  "pending_pairing",
  "connecting",
  "active",
  "reconnecting",
  "idle",
  "terminated",
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const errorCodeSchema = z.enum([
  "session_not_found",
  "pairing_expired",
  "pairing_not_found",
  "control_conflict",
  "session_terminated",
  "ack_out_of_range",
  "invalid_message",
  "unauthorized",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

// ── Envelope ────────────────────────────────────────────────────────

export const envelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  sessionId: z.string().min(1),
  deviceId: z.string().min(1).optional(),
  timestamp: z.string().datetime(),
  traceId: z.string().min(1).optional(),
  seq: z.number().int().nonnegative().optional(),
  ack: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

// ── Payload schemas ─────────────────────────────────────────────────

export const terminalOutputPayloadSchema = z.object({
  stream: z.enum(["stdout", "stderr"]),
  data: z.string(),
  encoding: z.literal("utf8").default("utf8"),
  isReplay: z.boolean().default(false),
  isFinal: z.boolean().default(false),
});

export const terminalInputPayloadSchema = z.object({
  data: z.string(),
});

export const terminalResizePayloadSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const sessionConnectPayloadSchema = z.object({
  role: deviceRoleSchema,
  clientName: z.string().min(1),
  provider: z.enum(["claude", "codex", "custom"]).optional(),
  protocolVersion: z.number().int().optional(),
  hostname: z.string().optional(),
  platform: z.string().optional(),
});

export const terminalExitPayloadSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable().optional(),
});

export const sessionAckPayloadSchema = z.object({
  seq: z.number().int().nonnegative(),
});

export const sessionResumePayloadSchema = z.object({
  lastAckedSeq: z.number().int().min(-1),
});

export const sessionHeartbeatPayloadSchema = z.object({
  ts: z.number(), // unix ms
});

export const pairingCreatedPayloadSchema = z.object({
  pairingCode: z.string().length(6),
  sessionId: z.string().min(1),
  expiresAt: z.string().datetime(),
});

export const sessionClaimPayloadSchema = z.object({
  pairingCode: z.string().length(6),
});

export const sessionClaimedPayloadSchema = z.object({
  sessionId: z.string().min(1),
});

export const controlClaimPayloadSchema = z.object({
  deviceId: z.string().min(1),
});

export const controlGrantPayloadSchema = z.object({
  deviceId: z.string().min(1),
});

export const controlRejectPayloadSchema = z.object({
  deviceId: z.string().min(1),
  reason: z.string().min(1),
});

export const controlReleasePayloadSchema = z.object({
  deviceId: z.string().min(1),
});

export const sessionHostDisconnectedPayloadSchema = z.object({
  reason: z.string().optional(),
});

export const sessionHostReconnectedPayloadSchema = z.object({});

export const errorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

// ── Protocol message type registry ──────────────────────────────────

export const protocolMessageSchemas = {
  "session.connect": sessionConnectPayloadSchema,
  "session.ack": sessionAckPayloadSchema,
  "session.resume": sessionResumePayloadSchema,
  "session.heartbeat": sessionHeartbeatPayloadSchema,
  "session.error": errorPayloadSchema,
  "terminal.output": terminalOutputPayloadSchema,
  "terminal.input": terminalInputPayloadSchema,
  "terminal.resize": terminalResizePayloadSchema,
  "terminal.exit": terminalExitPayloadSchema,
  "pairing.created": pairingCreatedPayloadSchema,
  "pairing.claim": sessionClaimPayloadSchema,
  "pairing.claimed": sessionClaimedPayloadSchema,
  "control.claim": controlClaimPayloadSchema,
  "control.grant": controlGrantPayloadSchema,
  "control.reject": controlRejectPayloadSchema,
  "control.release": controlReleasePayloadSchema,
  "session.host_disconnected": sessionHostDisconnectedPayloadSchema,
  "session.host_reconnected": sessionHostReconnectedPayloadSchema,
} as const;

export type ProtocolMessageType = keyof typeof protocolMessageSchemas;

// ── UUID helper (works in Node, Web, and Expo) ─────────────────────

function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (older Expo native)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

export function createEnvelope<T>(input: {
  type: ProtocolMessageType;
  sessionId: string;
  payload: T;
  id?: string;
  seq?: number;
  ack?: number;
  deviceId?: string;
  traceId?: string;
}): Envelope {
  return {
    id: input.id ?? generateId(),
    type: input.type,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    timestamp: new Date().toISOString(),
    traceId: input.traceId,
    seq: input.seq,
    ack: input.ack,
    payload: input.payload,
  };
}

export function parseEnvelope(raw: string): Envelope {
  return envelopeSchema.parse(JSON.parse(raw));
}

export function serializeEnvelope(message: Envelope): string {
  return JSON.stringify(message);
}

export function parseTypedPayload<TType extends ProtocolMessageType>(
  type: TType,
  payload: unknown,
): z.infer<(typeof protocolMessageSchemas)[TType]> {
  return protocolMessageSchemas[type].parse(payload);
}
