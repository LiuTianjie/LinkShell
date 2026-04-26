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
  terminalId: z.string().min(1).optional(),
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
  cwd: z.string().optional(),
  projectName: z.string().optional(),
});

export const terminalExitPayloadSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable().optional(),
});

export const sessionAckPayloadSchema = z.object({
  seq: z.number().int().nonnegative(),
});

export const sessionResumePayloadSchema = z.object({
  // Backward-compatible single-terminal cursor.
  lastAckedSeq: z.number().int().min(-1).optional().default(-1),
  // Multi-terminal resume cursor keyed by terminalId.
  lastAckedSeqByTerminal: z.record(z.number().int().min(-1)).optional().default({}),
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

// ── Screen sharing payloads ─────────────────────────────────────────

export const screenStartPayloadSchema = z.object({
  fps: z.number().int().min(1).max(30).default(5),
  quality: z.number().int().min(10).max(100).default(60),
  scale: z.number().min(0.1).max(1).default(0.5),
});

export const screenStopPayloadSchema = z.object({});

export const screenFramePayloadSchema = z.object({
  data: z.string(), // base64 JPEG
  width: z.number().int(),
  height: z.number().int(),
  frameId: z.number().int(),
  chunkIndex: z.number().int().default(0),
  chunkTotal: z.number().int().default(1),
});

export const screenStatusPayloadSchema = z.object({
  active: z.boolean(),
  mode: z.enum(["webrtc", "fallback", "off"]).default("off"),
  error: z.string().optional(),
});

export const screenOfferPayloadSchema = z.object({
  sdp: z.string(),
});

export const screenAnswerPayloadSchema = z.object({
  sdp: z.string(),
});

export const screenIcePayloadSchema = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().nullable().optional(),
});

// ── Terminal spawn/list payloads ───────────────────────────────────

export const terminalSpawnPayloadSchema = z.object({
  cwd: z.string().min(1),
  provider: z.enum(["claude", "codex", "custom"]).optional(),
});

export const terminalInfoSchema = z.object({
  terminalId: z.string().min(1),
  cwd: z.string(),
  projectName: z.string(),
  provider: z.string(),
  status: z.enum(["running", "exited"]),
});

export const terminalListPayloadSchema = z.object({
  terminals: z.array(terminalInfoSchema),
});

export const terminalSpawnedPayloadSchema = z.object({
  terminalId: z.string().min(1),
  cwd: z.string(),
  projectName: z.string(),
  provider: z.string().optional(),
});

export const terminalKillPayloadSchema = z.object({
  terminalId: z.string().min(1),
});

export const terminalMkdirPayloadSchema = z.object({
  path: z.string().min(1),
});

// ── Terminal browse payloads ──────────────────────────────────────

export const terminalBrowsePayloadSchema = z.object({
  path: z.string().min(1),
});

export const terminalBrowseEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
});

export const terminalBrowseResultPayloadSchema = z.object({
  path: z.string(),
  entries: z.array(terminalBrowseEntrySchema),
  error: z.string().optional(),
});

// ── Terminal status payloads (from Claude Code hooks) ────────────────

export const terminalStatusPayloadSchema = z.object({
  phase: z.enum([
    "thinking",
    "tool_use",
    "outputting",
    "waiting",
    "idle",
    "error",
  ]),
  seq: z.number().optional(),
  toolName: z.string().optional(),
  toolInput: z.string().optional(),
  permissionRequest: z.string().optional(),
  summary: z.string().optional(),
  topPermission: z
    .object({
      requestId: z.string(),
      toolName: z.string(),
      toolInput: z.string(),
      permissionRequest: z.string(),
      timestamp: z.number(),
    })
    .optional(),
  pendingPermissionCount: z.number().optional(),
});

// ── File upload payloads ────────────────────────────────────────────

export const fileUploadPayloadSchema = z.object({
  data: z.string(), // base64 encoded
  filename: z.string().min(1),
});

export const permissionDecisionPayloadSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
});

export const errorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

// ── Tunnel payloads ────────────────────────────────────────────────

export const tunnelRequestPayloadSchema = z.object({
  requestId: z.string().min(1),
  method: z.string().min(1),
  url: z.string(),
  headers: z.record(z.string()),
  body: z.string().nullable(), // base64 encoded
  port: z.number().int().min(1).max(65535),
});

export const tunnelResponsePayloadSchema = z.object({
  requestId: z.string().min(1),
  statusCode: z.number().int(),
  headers: z.record(z.string()),
  body: z.string(), // base64 encoded chunk
  isFinal: z.boolean(),
});

export const tunnelWsDataPayloadSchema = z.object({
  requestId: z.string().min(1),
  data: z.string(), // base64 encoded
  isBinary: z.boolean(),
});

export const tunnelWsClosePayloadSchema = z.object({
  requestId: z.string().min(1),
  code: z.number().int().optional(),
  reason: z.string().optional(),
});

// ── Terminal history payloads ─────────────────────────────────────

export const terminalHistoryRequestPayloadSchema = z.object({
  count: z.number().int().min(1).max(500).default(100),
});

export const terminalHistoryResponsePayloadSchema = z.object({
  entries: z.array(z.string()),
  shell: z.string().optional(),
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
  "screen.start": screenStartPayloadSchema,
  "screen.stop": screenStopPayloadSchema,
  "screen.frame": screenFramePayloadSchema,
  "screen.status": screenStatusPayloadSchema,
  "screen.offer": screenOfferPayloadSchema,
  "screen.answer": screenAnswerPayloadSchema,
  "screen.ice": screenIcePayloadSchema,
  "file.upload": fileUploadPayloadSchema,
  "terminal.spawn": terminalSpawnPayloadSchema,
  "terminal.spawned": terminalSpawnedPayloadSchema,
  "terminal.list": terminalListPayloadSchema,
  "terminal.browse": terminalBrowsePayloadSchema,
  "terminal.browse.result": terminalBrowseResultPayloadSchema,
  "terminal.kill": terminalKillPayloadSchema,
  "terminal.mkdir": terminalMkdirPayloadSchema,
  "terminal.status": terminalStatusPayloadSchema,
  "permission.decision": permissionDecisionPayloadSchema,
  "tunnel.request": tunnelRequestPayloadSchema,
  "tunnel.response": tunnelResponsePayloadSchema,
  "tunnel.ws.data": tunnelWsDataPayloadSchema,
  "tunnel.ws.close": tunnelWsClosePayloadSchema,
  "terminal.history.request": terminalHistoryRequestPayloadSchema,
  "terminal.history.response": terminalHistoryResponsePayloadSchema,
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
  terminalId?: string;
  traceId?: string;
}): Envelope {
  return {
    id: input.id ?? generateId(),
    type: input.type,
    sessionId: input.sessionId,
    terminalId: input.terminalId,
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
