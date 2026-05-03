import AsyncStorage from "@react-native-async-storage/async-storage";

export type AgentProvider = "codex" | "claude" | "custom";
export type AgentStatus = "unavailable" | "idle" | "running" | "waiting_permission" | "error";
export type AgentReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type AgentPermissionMode = "read_only" | "workspace_write" | "full_access";

export interface AgentContentBlock {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input?: string;
  output?: string;
  createdAt?: number;
  status: "pending" | "running" | "completed" | "failed";
}

export interface AgentPlanStep {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface AgentPermission {
  requestId: string;
  toolName?: string;
  toolInput?: string;
  context?: string;
  options: { id: string; label: string; kind: "allow" | "deny" | "other" }[];
}

export interface AgentConversationRecord {
  id: string;
  serverUrl: string;
  sessionId: string;
  agentSessionId?: string;
  provider: AgentProvider;
  cwd: string;
  title?: string;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  permissionMode?: AgentPermissionMode;
  status: AgentStatus;
  archived: boolean;
  lastMessagePreview?: string;
  lastActivityAt: number;
  createdAt: number;
  schemaVersion: 1;
}

export interface AgentTimelineItem {
  id: string;
  conversationId: string;
  type: "message" | "tool_call" | "plan" | "permission" | "status" | "error";
  role?: "user" | "assistant" | "system";
  content?: AgentContentBlock[];
  text?: string;
  toolCall?: AgentToolCall;
  plan?: AgentPlanStep[];
  permission?: AgentPermission;
  status?: AgentStatus;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
  isStreaming?: boolean;
}

export interface AgentCapabilities {
  enabled: boolean;
  provider?: AgentProvider;
  providers?: AgentProviderCapability[];
  protocolVersion?: number;
  workspaceProtocolVersion?: number;
  error?: string;
  supportsSessionList: boolean;
  supportsSessionLoad: boolean;
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsPermission: boolean;
  supportsPlan: boolean;
  supportsCancel: boolean;
}

export interface AgentProviderCapability {
  id: AgentProvider;
  label: string;
  enabled: boolean;
  reason?: string;
  supportsImages?: boolean;
  supportsPermission?: boolean;
  supportsPlan?: boolean;
  supportsCancel?: boolean;
}

const CONVERSATIONS_KEY = "@linkshell/agent-conversations:v1";
const TIMELINE_PREFIX = "@linkshell/agent-timeline:v1:";
const MAX_CONVERSATIONS = 100;
const MAX_TIMELINE_ITEMS = 200;
const MAX_TIMELINE_BYTES = 1024 * 1024;

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "");
}

function sortConversations(items: AgentConversationRecord[]): AgentConversationRecord[] {
  return [...items].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export function makeAgentConversationId(input: {
  serverUrl: string;
  sessionId: string;
  agentSessionId?: string;
  cwd: string;
}): string {
  const stableSuffix = input.agentSessionId
    ? `remote-${input.agentSessionId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `agent-${stableSuffix}`;
}

async function saveConversations(items: AgentConversationRecord[]): Promise<void> {
  await AsyncStorage.setItem(
    CONVERSATIONS_KEY,
    JSON.stringify(sortConversations(items).slice(0, MAX_CONVERSATIONS)),
  );
}

export async function loadAgentConversations(): Promise<AgentConversationRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(CONVERSATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AgentConversationRecord[];
    if (!Array.isArray(parsed)) return [];
    return sortConversations(
      parsed.filter((item) => item.id && item.serverUrl && item.sessionId && item.cwd),
    );
  } catch {
    return [];
  }
}

export async function upsertAgentConversation(
  input: Omit<AgentConversationRecord, "schemaVersion"> & { schemaVersion?: 1 },
): Promise<AgentConversationRecord> {
  const conversations = await loadAgentConversations();
  const normalized: AgentConversationRecord = {
    ...input,
    serverUrl: normalizeServerUrl(input.serverUrl),
    schemaVersion: 1,
  };
  const index = conversations.findIndex((item) => item.id === normalized.id);
  if (index >= 0) conversations[index] = { ...conversations[index], ...normalized };
  else conversations.unshift(normalized);
  await saveConversations(conversations);
  return normalized;
}

export async function archiveAgentConversation(id: string, archived: boolean): Promise<void> {
  const conversations = await loadAgentConversations();
  await saveConversations(
    conversations.map((item) => item.id === id ? { ...item, archived } : item),
  );
}

export async function renameAgentConversation(id: string, title: string): Promise<void> {
  const conversations = await loadAgentConversations();
  await saveConversations(
    conversations.map((item) => item.id === id ? { ...item, title } : item),
  );
}

export async function loadAgentTimeline(conversationId: string): Promise<AgentTimelineItem[]> {
  try {
    const raw = await AsyncStorage.getItem(`${TIMELINE_PREFIX}${conversationId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AgentTimelineItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item.id && item.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-MAX_TIMELINE_ITEMS);
  } catch {
    return [];
  }
}

export async function saveAgentTimeline(
  conversationId: string,
  items: AgentTimelineItem[],
): Promise<void> {
  let next = [...items]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_TIMELINE_ITEMS);
  let serialized = JSON.stringify(next);
  if (serialized.length > MAX_TIMELINE_BYTES) {
    next = next.map((item) =>
      item.type === "message" && item.content
        ? {
            ...item,
            content: item.content.map((block) =>
              block.type === "image"
                ? { ...block, data: undefined, text: block.text || "图片附件" }
                : block,
            ),
          }
        : item,
    );
    serialized = JSON.stringify(next);
  }
  while (serialized.length > MAX_TIMELINE_BYTES && next.length > 20) {
    next = next.slice(10);
    serialized = JSON.stringify(next);
  }
  await AsyncStorage.setItem(`${TIMELINE_PREFIX}${conversationId}`, serialized);
}

export async function upsertAgentTimelineItem(item: AgentTimelineItem): Promise<void> {
  const timeline = await loadAgentTimeline(item.conversationId);
  const index = timeline.findIndex((entry) => entry.id === item.id);
  if (index >= 0) timeline[index] = item;
  else timeline.push(item);
  await saveAgentTimeline(item.conversationId, timeline);
}
