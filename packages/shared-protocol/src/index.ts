import { z } from "zod";

// ── Protocol version ────────────────────────────────────────────────

export const PROTOCOL_VERSION = 1;
// Oldest peer protocol version this build still interoperates with. The CLI and
// app ship and update independently, so version negotiation must DEGRADE, never
// hard-reject: a peer that omits its version is a legacy pre-versioning client
// and is always treated as compatible.
export const PROTOCOL_MIN_COMPATIBLE_VERSION = 1;

/**
 * Decide whether a peer's advertised protocol version can interoperate with
 * this build. Returns true when the version is absent (legacy client) or within
 * the supported range. Callers should warn — not disconnect — on `false`, so an
 * out-of-date CLI/app keeps working in degraded mode rather than breaking.
 */
export function isProtocolVersionCompatible(remoteVersion?: number): boolean {
  if (remoteVersion === undefined || remoteVersion === null) return true;
  if (!Number.isFinite(remoteVersion)) return false;
  return remoteVersion >= PROTOCOL_MIN_COMPATIBLE_VERSION;
}

// ── Payload size caps ───────────────────────────────────────────────
// Bound unbounded base64/data strings so a malicious or buggy peer can't
// OOM the relay. These are runtime-only constraints; the static type of
// each field stays `string`.

const MAX_TERMINAL_DATA = 1_048_576; // 1 MB — terminal stdin/stdout chunk
const MAX_SCREEN_FRAME_DATA = 4_194_304; // 4 MB — base64 JPEG frame
const MAX_FILE_UPLOAD_DATA = 8_388_608; // 8 MB — uploaded file payload
const MAX_TUNNEL_BODY = 8_388_608; // 8 MB — tunnel HTTP body chunk
const MAX_TUNNEL_WS_DATA = 1_048_576; // 1 MB — tunnel websocket frame
const MAX_AGENT_BLOCK_DATA = 8_388_608; // 8 MB — agent content block data
const MAX_TUNNEL_URL = 8192; // tunnel request URL length
const MAX_HTTP_METHOD = 16; // HTTP verb length

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

export const terminalProviderSchema = z.enum([
  "claude",
  "codex",
  "gemini",
  "copilot",
  "custom",
]);
export type TerminalProvider = z.infer<typeof terminalProviderSchema>;

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
  data: z.string().max(MAX_TERMINAL_DATA),
  encoding: z.literal("utf8").default("utf8"),
  isReplay: z.boolean().default(false),
  isFinal: z.boolean().default(false),
});

export const terminalInputPayloadSchema = z.object({
  data: z.string().max(MAX_TERMINAL_DATA),
});

export const terminalResizePayloadSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const sessionConnectPayloadSchema = z.object({
  role: deviceRoleSchema,
  clientName: z.string().min(1),
  provider: terminalProviderSchema.optional(),
  protocolVersion: z.number().int().optional(),
  machineId: z.string().min(1).optional(),
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
  machineId: z.string().min(1).optional(),
});

export const sessionHeartbeatPayloadSchema = z.object({
  ts: z.number(), // unix ms
});

export const pairingCreatedPayloadSchema = z.object({
  pairingCode: z.string().regex(/^\d{6}$/),
  sessionId: z.string().min(1),
  expiresAt: z.string().datetime(),
});

export const sessionClaimPayloadSchema = z.object({
  pairingCode: z.string().regex(/^\d{6}$/),
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
  data: z.string().max(MAX_SCREEN_FRAME_DATA), // base64 JPEG
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
  provider: terminalProviderSchema.optional(),
  // When true, always spawn a fresh PTY even if one already exists for this cwd
  // (lets a client open multiple terminal tabs in the same directory). Omitted/
  // false preserves the legacy one-terminal-per-cwd dedup (mobile relies on it).
  forceNew: z.boolean().optional(),
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
  includeFiles: z.boolean().optional().default(false),
  requestId: z.string().min(1).optional(),
});

export const terminalBrowseEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().datetime().optional(),
});

export const terminalBrowseResultPayloadSchema = z.object({
  path: z.string(),
  entries: z.array(terminalBrowseEntrySchema),
  error: z.string().optional(),
  requestId: z.string().min(1).optional(),
});

export const terminalFileReadPayloadSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(1_000_000).optional().default(256_000),
  requestId: z.string().min(1).optional(),
});

export const terminalFileReadResultPayloadSchema = z.object({
  path: z.string(),
  content: z.string().default(""),
  encoding: z.literal("utf8").default("utf8"),
  size: z.number().int().nonnegative().optional(),
  truncated: z.boolean().default(false),
  error: z.string().optional(),
  requestId: z.string().min(1).optional(),
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
  provider: terminalProviderSchema.optional(),
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
  permissionResolution: z
    .object({
      requestId: z.string(),
      outcome: z.enum(["allow", "deny", "cancelled"]),
      source: z.string().optional(),
      delivered: z.boolean(),
    })
    .optional(),
  pendingPermissionCount: z.number().optional(),
  machineId: z.string().min(1).optional(),
});

// ── File upload payloads ────────────────────────────────────────────

export const fileUploadPayloadSchema = z.object({
  data: z.string().max(MAX_FILE_UPLOAD_DATA), // base64 encoded
  filename: z
    .string()
    .min(1)
    .refine((s) => !s.includes("..") && !s.startsWith("/"), "invalid filename"),
});

export const permissionDecisionPayloadSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
});

export const permissionDecisionResultPayloadSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
  resolved: z.boolean(),
  delivered: z.boolean(),
  source: z.string().optional(),
  message: z.string().optional(),
});

export const errorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

// ── Tunnel payloads ────────────────────────────────────────────────

export const tunnelRequestPayloadSchema = z.object({
  requestId: z.string().min(1),
  method: z.string().min(1).max(MAX_HTTP_METHOD),
  url: z.string().max(MAX_TUNNEL_URL),
  headers: z.record(z.string()),
  body: z.string().max(MAX_TUNNEL_BODY).nullable(), // base64 encoded
  port: z.number().int().min(1).max(65535),
});

export const tunnelResponsePayloadSchema = z.object({
  requestId: z.string().min(1),
  statusCode: z.number().int(),
  headers: z.record(z.string()),
  body: z.string().max(MAX_TUNNEL_BODY), // base64 encoded chunk
  isFinal: z.boolean(),
});

export const tunnelWsDataPayloadSchema = z.object({
  requestId: z.string().min(1),
  data: z.string().max(MAX_TUNNEL_WS_DATA), // base64 encoded
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

// ── Agent GUI / ACP payloads ───────────────────────────────────────

export const agentProviderSchema = z.enum(["codex", "claude", "custom"]);
export const agentReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export const agentPermissionModeSchema = z.enum([
  "read_only",
  "workspace_write",
  "full_access",
]);

export const agentCollaborationModeSchema = z.enum(["default", "plan"]);

export const agentContentBlockSchema = z.object({
  type: z.enum(["text", "image"]),
  text: z.string().optional(),
  data: z.string().max(MAX_AGENT_BLOCK_DATA).optional(),
  mimeType: z.string().optional(),
});

export const agentMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.number(),
  isStreaming: z.boolean().optional(),
});

export const agentToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.string().optional(),
  output: z.string().optional(),
  createdAt: z.number().optional(),
  status: z.enum(["pending", "running", "completed", "failed"]).default("pending"),
});

export const agentPermissionSchema = z.object({
  requestId: z.string().min(1),
  toolName: z.string().optional(),
  toolInput: z.string().optional(),
  context: z.string().optional(),
  options: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(["allow", "deny", "other"]).default("other"),
  })).default([]),
});

export const agentModelOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const agentCommandDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  provider: agentProviderSchema.optional(),
  source: z.enum(["built_in", "custom", "project", "user", "linkshell"]).default("built_in"),
  category: z.string().optional(),
  argsMode: z.enum(["none", "optional", "required", "raw"]).default("optional"),
  requiresIdle: z.boolean().optional(),
  destructive: z.boolean().optional(),
  disabledReason: z.string().optional(),
  executionKind: z.enum(["prompt", "native", "local_ui"]).default("prompt"),
});

export const agentModeDescriptorSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
});

export const agentProviderCapabilitySchema = z.object({
  id: agentProviderSchema,
  label: z.string().min(1),
  enabled: z.boolean(),
  reason: z.string().optional(),
  supportsImages: z.boolean().optional(),
  supportsPermission: z.boolean().optional(),
  supportsPlan: z.boolean().optional(),
  supportsCancel: z.boolean().optional(),
  models: z.array(agentModelOptionSchema).optional(),
  defaultModel: z.string().min(1).optional(),
  reasoningEfforts: z.array(agentReasoningEffortSchema).optional(),
  permissionModes: z.array(agentPermissionModeSchema).optional(),
  commands: z.array(agentCommandDescriptorSchema).optional(),
  modes: z.array(agentModeDescriptorSchema).optional(),
  currentMode: z.string().optional(),
  features: z.record(z.boolean()).optional(),
});

export const agentCapabilitiesPayloadSchema = z.object({
  enabled: z.boolean(),
  provider: agentProviderSchema.optional(),
  machineId: z.string().min(1).optional(),
  providers: z.array(agentProviderCapabilitySchema).optional(),
  protocolVersion: z.number().int().optional(),
  error: z.string().optional(),
  supportsSessionList: z.boolean().default(false),
  supportsSessionLoad: z.boolean().default(false),
  supportsImages: z.boolean().default(false),
  supportsAudio: z.boolean().default(false),
  supportsPermission: z.boolean().default(false),
  supportsPlan: z.boolean().default(false),
  supportsCancel: z.boolean().default(false),
});

export const agentInitializePayloadSchema = z.object({});

export const agentSessionNewPayloadSchema = z.object({
  cwd: z.string().optional(),
  provider: agentProviderSchema.optional(),
  mcpServers: z.record(z.unknown()).optional(),
});

export const agentSessionLoadPayloadSchema = z.object({
  agentSessionId: z.string().min(1),
  cwd: z.string().optional(),
});

export const agentSessionListPayloadSchema = z.object({});

export const agentPromptPayloadSchema = z.object({
  agentSessionId: z.string().optional(),
  clientMessageId: z.string().min(1),
  contentBlocks: z.array(agentContentBlockSchema).min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: agentReasoningEffortSchema.optional(),
  permissionMode: agentPermissionModeSchema.optional(),
});

export const agentCancelPayloadSchema = z.object({
  agentSessionId: z.string().optional(),
});

export const agentUpdatePayloadSchema = z.object({
  agentSessionId: z.string().optional(),
  kind: z.enum(["message", "message_delta", "tool_call", "tool_result", "plan", "status", "error"]),
  message: agentMessageSchema.optional(),
  delta: z.string().optional(),
  toolCall: agentToolCallSchema.optional(),
  plan: z.array(z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    status: z.enum(["pending", "in_progress", "completed"]),
  })).optional(),
  status: z.enum(["idle", "running", "waiting_permission", "error"]).optional(),
  error: z.string().optional(),
});

export const agentPermissionRequestPayloadSchema = agentPermissionSchema.extend({
  agentSessionId: z.string().optional(),
});

export const agentPermissionResponsePayloadSchema = z.object({
  agentSessionId: z.string().optional(),
  requestId: z.string().min(1),
  outcome: z.enum(["allow", "deny", "cancelled"]),
  optionId: z.string().optional(),
});

export const agentSnapshotPayloadSchema = z.object({
  agentSessionId: z.string().optional(),
  capabilities: agentCapabilitiesPayloadSchema.optional(),
  messages: z.array(agentMessageSchema).default([]),
  toolCalls: z.array(agentToolCallSchema).default([]),
  pendingPermissions: z.array(agentPermissionSchema).default([]),
  status: z.enum(["unavailable", "idle", "running", "waiting_permission", "error"]).default("unavailable"),
  error: z.string().optional(),
});

// ── Agent Workspace v2 payloads ────────────────────────────────────

export const agentV2StatusSchema = z.enum([
  "unavailable",
  "idle",
  "running",
  "waiting_permission",
  "error",
]);

export const agentV2TimelineKindSchema = z.enum([
  "chat",
  "thinking",
  "tool_activity",
  "command_execution",
  "file_change",
  "subagent_action",
  "plan",
  "user_input_prompt",
  "review",
  "context_compaction",
]);

export const agentV2FileChangeEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.string().optional(),
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
});

export const agentV2FileChangeSchema = z.object({
  entries: z.array(agentV2FileChangeEntrySchema).default([]),
  diff: z.string().optional(),
  summary: z.string().optional(),
  changeSetId: z.string().optional(),
  status: z.enum(["pending", "running", "completed", "failed"]).optional(),
});

export const agentV2CommandExecutionSchema = z.object({
  command: z.string().optional(),
  cwd: z.string().optional(),
  output: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  status: z.enum(["pending", "running", "completed", "failed"]).optional(),
});

export const agentV2StructuredInputOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

export const agentV2StructuredInputQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string().optional(),
  question: z.string().min(1),
  isOther: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  selectionLimit: z.number().int().positive().optional(),
  options: z.array(agentV2StructuredInputOptionSchema).optional(),
});

export const agentV2StructuredInputSchema = z.object({
  requestId: z.string().min(1),
  questions: z.array(agentV2StructuredInputQuestionSchema).default([]),
});

export const agentV2SubagentRefSchema = z.object({
  threadId: z.string().min(1),
  agentId: z.string().optional(),
  nickname: z.string().optional(),
  role: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
});

export const agentV2SubagentStateSchema = z.object({
  threadId: z.string().min(1),
  status: z.string().min(1),
  message: z.string().optional(),
});

export const agentV2SubagentActionSchema = z.object({
  tool: z.string().min(1),
  status: z.string().min(1),
  prompt: z.string().optional(),
  model: z.string().optional(),
  receiverThreadIds: z.array(z.string().min(1)).default([]),
  receiverAgents: z.array(agentV2SubagentRefSchema).default([]),
  agentStates: z.record(agentV2SubagentStateSchema).default({}),
});

export const agentV2TimelineItemSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  type: z.enum(["message", "tool_call", "plan", "permission", "status", "error"]),
  kind: agentV2TimelineKindSchema.optional(),
  turnId: z.string().optional(),
  itemId: z.string().optional(),
  role: z.enum(["user", "assistant", "system"]).optional(),
  content: z.array(agentContentBlockSchema).optional(),
  text: z.string().optional(),
  toolCall: agentToolCallSchema.optional(),
  commandExecution: agentV2CommandExecutionSchema.optional(),
  fileChange: agentV2FileChangeSchema.optional(),
  subagent: agentV2SubagentActionSchema.optional(),
  structuredInput: agentV2StructuredInputSchema.optional(),
  plan: z.array(z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    status: z.enum(["pending", "in_progress", "completed"]),
  })).optional(),
  permission: agentPermissionSchema.optional(),
  status: agentV2StatusSchema.optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
  isStreaming: z.boolean().optional(),
});

export const agentV2ConversationSchema = z.object({
  id: z.string().min(1),
  agentSessionId: z.string().optional(),
  provider: agentProviderSchema.default("codex"),
  cwd: z.string(),
  title: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: agentReasoningEffortSchema.optional(),
  permissionMode: agentPermissionModeSchema.optional(),
  collaborationMode: agentCollaborationModeSchema.optional(),
  status: agentV2StatusSchema.default("idle"),
  archived: z.boolean().default(false),
  lastMessagePreview: z.string().optional(),
  lastActivityAt: z.number(),
  createdAt: z.number(),
});

export const agentV2CapabilitiesRequestPayloadSchema = z.object({});

export const agentV2CapabilitiesPayloadSchema = agentCapabilitiesPayloadSchema.extend({
  workspaceProtocolVersion: z.number().int().default(2),
});

export const agentV2ConversationOpenPayloadSchema = z.object({
  conversationId: z.string().optional(),
  agentSessionId: z.string().optional(),
  cwd: z.string().optional(),
  provider: agentProviderSchema.optional(),
  model: z.string().optional(),
  reasoningEffort: agentReasoningEffortSchema.optional(),
  permissionMode: agentPermissionModeSchema.optional(),
  collaborationMode: agentCollaborationModeSchema.optional(),
  title: z.string().optional(),
});

export const agentV2ConversationOpenedPayloadSchema = z.object({
  conversation: agentV2ConversationSchema,
  snapshot: z.array(agentV2TimelineItemSchema).default([]),
  requestedConversationId: z.string().min(1).optional(),
});

export const agentV2ConversationListPayloadSchema = z.object({
  includeArchived: z.boolean().optional().default(false),
});

export const agentV2ConversationListResultPayloadSchema = z.object({
  conversations: z.array(agentV2ConversationSchema),
});

export const agentV2PromptPayloadSchema = z.object({
  conversationId: z.string().min(1),
  clientMessageId: z.string().min(1),
  contentBlocks: z.array(agentContentBlockSchema).min(1),
  delivery: z.enum(["auto", "new_turn", "steer"]).optional().default("auto"),
  targetTurnId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: agentReasoningEffortSchema.optional(),
  permissionMode: agentPermissionModeSchema.optional(),
  collaborationMode: agentCollaborationModeSchema.optional(),
});

export const agentV2CommandExecutePayloadSchema = z.object({
  conversationId: z.string().min(1),
  commandId: z.string().min(1),
  rawText: z.string().optional(),
  args: z.string().optional(),
  clientMessageId: z.string().min(1),
});

export const agentV2CancelPayloadSchema = z.object({
  conversationId: z.string().min(1),
});

export const agentV2PermissionRespondPayloadSchema = z.object({
  conversationId: z.string().min(1),
  requestId: z.string().min(1),
  outcome: z.enum(["allow", "deny", "cancelled"]),
  optionId: z.string().optional(),
});

export const agentV2StructuredInputRespondPayloadSchema = z.object({
  conversationId: z.string().min(1),
  requestId: z.string().min(1),
  answers: z.record(z.array(z.string())),
});

export const agentV2SnapshotRequestPayloadSchema = z.object({
  conversationId: z.string().optional(),
});

export const agentV2SnapshotPayloadSchema = z.object({
  conversations: z.array(agentV2ConversationSchema).default([]),
  activeConversationId: z.string().optional(),
  items: z.array(agentV2TimelineItemSchema).default([]),
  machineId: z.string().min(1).optional(),
});

export const agentV2EventPayloadSchema = z.object({
  conversationId: z.string().min(1),
  conversation: agentV2ConversationSchema.optional(),
  item: agentV2TimelineItemSchema.optional(),
  patch: z.object({
    itemId: z.string().min(1),
    kind: agentV2TimelineKindSchema.optional(),
    role: z.enum(["user", "assistant", "system"]).optional(),
    content: z.array(agentContentBlockSchema).optional(),
    text: z.string().optional(),
    textDelta: z.string().optional(),
    status: agentV2StatusSchema.optional(),
    toolCall: agentToolCallSchema.optional(),
    commandExecution: agentV2CommandExecutionSchema.optional(),
    fileChange: agentV2FileChangeSchema.optional(),
    subagent: agentV2SubagentActionSchema.optional(),
    structuredInput: agentV2StructuredInputSchema.optional(),
    plan: z.array(z.object({
      id: z.string().min(1),
      text: z.string().min(1),
      status: z.enum(["pending", "in_progress", "completed"]),
    })).optional(),
    permission: agentPermissionSchema.optional(),
    error: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    updatedAt: z.number().optional(),
    isStreaming: z.boolean().optional(),
  }).optional(),
});

export const agentV2PermissionRequestPayloadSchema = agentPermissionSchema.extend({
  conversationId: z.string().min(1),
  item: agentV2TimelineItemSchema.optional(),
});

// Lightweight one-shot notification from CLI to mobile (toast-style).
// Used to confirm model switches, signal unsupported native commands, etc.
export const agentV2NoticePayloadSchema = z.object({
  conversationId: z.string().optional(),
  kind: z.enum([
    "model_changed",
    "effort_changed",
    "permission_changed",
    "native_unsupported",
    "info",
    "warning",
  ]),
  title: z.string().min(1),
  detail: z.string().optional(),
  durationMs: z.number().int().positive().optional(),
});

// History pagination: client requests OLDER timeline items for a conversation
// (scrolling up). cursor is opaque (passed back from a prior result); omit for
// the first older page. The host pages the provider transcript via its cursor.
export const agentV2HistoryRequestPayloadSchema = z.object({
  conversationId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional().default(50),
});

export const agentV2HistoryResultPayloadSchema = z.object({
  conversationId: z.string().min(1),
  // Older items, chronologically ascending; the client prepends them.
  items: z.array(agentV2TimelineItemSchema).default([]),
  // Opaque cursor for the NEXT (even older) page; absent when no more history.
  nextCursor: z.string().optional(),
  hasMore: z.boolean().default(false),
});

// Mutate a conversation's user-facing metadata (rename / archive toggle).
// Fields are optional: send only what changes. The host applies the patch to
// its tracked conversation and echoes the updated record back via agent.v2.event.
export const agentV2ConversationUpdatePayloadSchema = z.object({
  conversationId: z.string().min(1),
  title: z.string().optional(),
  archived: z.boolean().optional(),
});

// "Delete" a conversation. Semantics: FORGET it from the workspace's tracked
// set — it does NOT delete the agent's on-disk transcript/session file (that's
// destructive and irreversible). The host drops it from its in-memory map and
// tombstones the id so syncProviderSessions can't resurrect it on the next list.
export const agentV2ConversationDeletePayloadSchema = z.object({
  conversationId: z.string().min(1),
});

// Host → clients: a conversation was forgotten; clients remove it from their list.
export const agentV2ConversationDeletedPayloadSchema = z.object({
  conversationId: z.string().min(1),
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
  "terminal.file.read": terminalFileReadPayloadSchema,
  "terminal.file.read.result": terminalFileReadResultPayloadSchema,
  "terminal.kill": terminalKillPayloadSchema,
  "terminal.mkdir": terminalMkdirPayloadSchema,
  "terminal.status": terminalStatusPayloadSchema,
  "permission.decision": permissionDecisionPayloadSchema,
  "permission.decision.result": permissionDecisionResultPayloadSchema,
  "tunnel.request": tunnelRequestPayloadSchema,
  "tunnel.response": tunnelResponsePayloadSchema,
  "tunnel.ws.data": tunnelWsDataPayloadSchema,
  "tunnel.ws.close": tunnelWsClosePayloadSchema,
  "terminal.history.request": terminalHistoryRequestPayloadSchema,
  "terminal.history.response": terminalHistoryResponsePayloadSchema,
  "agent.initialize": agentInitializePayloadSchema,
  "agent.capabilities": agentCapabilitiesPayloadSchema,
  "agent.session.new": agentSessionNewPayloadSchema,
  "agent.session.load": agentSessionLoadPayloadSchema,
  "agent.session.list": agentSessionListPayloadSchema,
  "agent.prompt": agentPromptPayloadSchema,
  "agent.cancel": agentCancelPayloadSchema,
  "agent.update": agentUpdatePayloadSchema,
  "agent.permission.request": agentPermissionRequestPayloadSchema,
  "agent.permission.response": agentPermissionResponsePayloadSchema,
  "agent.snapshot": agentSnapshotPayloadSchema,
  "agent.v2.capabilities.request": agentV2CapabilitiesRequestPayloadSchema,
  "agent.v2.capabilities": agentV2CapabilitiesPayloadSchema,
  "agent.v2.conversation.open": agentV2ConversationOpenPayloadSchema,
  "agent.v2.conversation.opened": agentV2ConversationOpenedPayloadSchema,
  "agent.v2.conversation.list": agentV2ConversationListPayloadSchema,
  "agent.v2.conversation.list.result": agentV2ConversationListResultPayloadSchema,
  "agent.v2.conversation.update": agentV2ConversationUpdatePayloadSchema,
  "agent.v2.conversation.delete": agentV2ConversationDeletePayloadSchema,
  "agent.v2.conversation.deleted": agentV2ConversationDeletedPayloadSchema,
  "agent.v2.prompt": agentV2PromptPayloadSchema,
  "agent.v2.command.execute": agentV2CommandExecutePayloadSchema,
  "agent.v2.cancel": agentV2CancelPayloadSchema,
  "agent.v2.permission.respond": agentV2PermissionRespondPayloadSchema,
  "agent.v2.permission.request": agentV2PermissionRequestPayloadSchema,
  "agent.v2.structured_input.respond": agentV2StructuredInputRespondPayloadSchema,
  "agent.v2.snapshot.request": agentV2SnapshotRequestPayloadSchema,
  "agent.v2.snapshot": agentV2SnapshotPayloadSchema,
  "agent.v2.event": agentV2EventPayloadSchema,
  "agent.v2.notice": agentV2NoticePayloadSchema,
  "agent.v2.history.request": agentV2HistoryRequestPayloadSchema,
  "agent.v2.history.result": agentV2HistoryResultPayloadSchema,
} as const;

export type ProtocolMessageType = keyof typeof protocolMessageSchemas;

export const agentV2HostToClientMessageTypes = [
  "agent.v2.capabilities",
  "agent.v2.conversation.opened",
  "agent.v2.conversation.list.result",
  "agent.v2.event",
  "agent.v2.snapshot",
  "agent.v2.permission.request",
  "agent.v2.notice",
  "agent.v2.history.result",
  "agent.v2.conversation.deleted",
] as const satisfies readonly ProtocolMessageType[];

export const agentV2ClientWriteMessageTypes = [
  "agent.v2.conversation.open",
  "agent.v2.conversation.update",
  "agent.v2.conversation.delete",
  "agent.v2.prompt",
  "agent.v2.command.execute",
  "agent.v2.cancel",
  "agent.v2.permission.respond",
  "agent.v2.structured_input.respond",
] as const satisfies readonly ProtocolMessageType[];

export const agentV2ClientReadMessageTypes = [
  "agent.v2.capabilities.request",
  "agent.v2.conversation.list",
  "agent.v2.snapshot.request",
  "agent.v2.history.request",
] as const satisfies readonly ProtocolMessageType[];

export type AgentV2MessageRoute =
  | "host_to_client"
  | "client_write"
  | "client_read";

const agentV2HostToClientSet = new Set<string>(agentV2HostToClientMessageTypes);
const agentV2ClientWriteSet = new Set<string>(agentV2ClientWriteMessageTypes);
const agentV2ClientReadSet = new Set<string>(agentV2ClientReadMessageTypes);

export function agentV2MessageRoute(type: string): AgentV2MessageRoute | null {
  if (agentV2HostToClientSet.has(type)) return "host_to_client";
  if (agentV2ClientWriteSet.has(type)) return "client_write";
  if (agentV2ClientReadSet.has(type)) return "client_read";
  return null;
}

export function isAgentV2HostToClientMessage(type: string): boolean {
  return agentV2MessageRoute(type) === "host_to_client";
}

export function isAgentV2ClientWriteMessage(type: string): boolean {
  return agentV2MessageRoute(type) === "client_write";
}

export function isAgentV2ClientReadMessage(type: string): boolean {
  return agentV2MessageRoute(type) === "client_read";
}

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
  // Guard against unregistered or inherited keys (e.g. "toString") so the
  // lookup can never resolve to a non-schema and crash with a raw TypeError.
  if (!Object.prototype.hasOwnProperty.call(protocolMessageSchemas, type)) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["type"],
        message: `Unknown protocol message type: ${String(type)}`,
      },
    ]);
  }
  return protocolMessageSchemas[type].parse(payload);
}
