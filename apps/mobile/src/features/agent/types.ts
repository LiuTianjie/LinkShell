// Single source of truth for agent types used by the rewritten feature module.
// These are re-exports only — do NOT redefine these types here.

export type {
  AgentContentBlock,
  AgentCapabilities,
  AgentCommandDescriptor,
  AgentConversationRecord,
  AgentCollaborationMode,
  AgentNotice,
  AgentPermissionMode,
  AgentPlanStep,
  AgentReasoningEffort,
  AgentStructuredInput,
  AgentSubagentAction,
  AgentTimelineItem,
  AgentToolCall,
} from "../../storage/agent-workspace";

export type {
  AgentWorkspaceHandle,
  AgentFileEntry,
  AgentFileReadResult,
  AgentHistoryState,
} from "../../hooks/useAgentWorkspace";
