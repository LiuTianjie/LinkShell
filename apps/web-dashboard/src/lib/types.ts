import type { z } from "zod";
import type {
  agentV2TimelineItemSchema,
  agentV2ConversationSchema,
  agentV2EventPayloadSchema,
  agentV2CapabilitiesPayloadSchema,
  agentProviderCapabilitySchema,
  agentMcpServerStatusSchema,
  agentMcpServerDescriptorSchema,
  agentPermissionSchema,
  agentV2StructuredInputSchema,
  agentV2FileChangeSchema,
  agentV2CommandExecutionSchema,
  agentV2SubagentActionSchema,
  agentContentBlockSchema,
  agentToolCallSchema,
  agentProviderSchema,
  agentReasoningEffortSchema,
  agentPermissionModeSchema,
  agentCollaborationModeSchema,
  agentV2StatusSchema,
  agentCommandDescriptorSchema,
  terminalBrowseResultPayloadSchema,
  terminalBrowseEntrySchema,
  terminalFileReadResultPayloadSchema,
  agentV2UsageReportPayloadSchema,
} from "@linkshell/protocol";

// Domain types are derived directly from the protocol's Zod schemas so they can
// never drift from the wire contract. The protocol package ships the schemas
// (not the inferred types), so we infer them here once and reuse app-wide.
export type AgentTimelineItem = z.infer<typeof agentV2TimelineItemSchema>;
export type AgentConversation = z.infer<typeof agentV2ConversationSchema>;
export type AgentV2Event = z.infer<typeof agentV2EventPayloadSchema>;
export type AgentCapabilitiesPayload = z.infer<typeof agentV2CapabilitiesPayloadSchema>;
export type AgentProviderCapability = z.infer<typeof agentProviderCapabilitySchema>;
export type AgentMcpServerStatus = z.infer<typeof agentMcpServerStatusSchema>;
export type AgentMcpServerDescriptor = z.infer<typeof agentMcpServerDescriptorSchema>;
export type AgentPermission = z.infer<typeof agentPermissionSchema>;
export type AgentStructuredInput = z.infer<typeof agentV2StructuredInputSchema>;
export type AgentFileChange = z.infer<typeof agentV2FileChangeSchema>;
export type AgentCommandExecution = z.infer<typeof agentV2CommandExecutionSchema>;
export type AgentSubagentAction = z.infer<typeof agentV2SubagentActionSchema>;
export type AgentContentBlock = z.infer<typeof agentContentBlockSchema>;
export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

export type AgentProvider = z.infer<typeof agentProviderSchema>;
export type AgentReasoningEffort = z.infer<typeof agentReasoningEffortSchema>;
export type AgentPermissionMode = z.infer<typeof agentPermissionModeSchema>;
export type AgentCollaborationMode = z.infer<typeof agentCollaborationModeSchema>;
export type AgentStatus = z.infer<typeof agentV2StatusSchema>;
export type AgentCommandDescriptor = z.infer<typeof agentCommandDescriptorSchema>;
export type AgentUsageReport = z.infer<typeof agentV2UsageReportPayloadSchema>;

export type BrowseEntry = z.infer<typeof terminalBrowseEntrySchema>;
export type BrowseResult = z.infer<typeof terminalBrowseResultPayloadSchema>;
export type FileReadResult = z.infer<typeof terminalFileReadResultPayloadSchema>;

// ── Client-side connection state ────────────────────────────────────

export type ConnectionStatus =
  | "idle"
  | "claiming"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "session_exited"
  | "host_disconnected"
  | `error:${string}`;

export interface GatewayConfig {
  /** Base HTTP(S) URL of the gateway, e.g. https://gw.itool.tech */
  httpUrl: string;
  /** WebSocket URL, derived from httpUrl if absent */
  wsUrl?: string;
}

export interface SessionSummary {
  id: string;
  state: string;
  hasHost: boolean;
  clientCount: number;
  provider: string | null;
  machineId: string | null;
  hostname: string | null;
  platform: string | null;
  projectName: string | null;
  cwd: string | null;
  lastActivity: number;
  agentStatus?: AgentStatus | null;
  agentProvider?: string | null;
  agentConversationId?: string | null;
  agentTitle?: string | null;
  agentLastActivity?: number | null;
  agentUsage?: AgentUsageSummary | null;
  agentUsageReport?: AgentUsageReport | null;
}

export interface AgentUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  totalCostUsd?: number;
}

export interface TerminalView {
  terminalId: string;
  cwd?: string;
  projectName?: string;
  provider?: string;
  status?: string;
}
