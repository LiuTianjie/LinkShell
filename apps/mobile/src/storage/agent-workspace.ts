import AsyncStorage from "@react-native-async-storage/async-storage";

export type AgentProvider = "codex" | "claude" | "custom";
export type AgentStatus = "unavailable" | "idle" | "running" | "waiting_permission" | "error";
export type AgentReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type AgentPermissionMode = "read_only" | "workspace_write" | "full_access";
export type AgentTimelineKind =
  | "chat"
  | "thinking"
  | "tool_activity"
  | "command_execution"
  | "file_change"
  | "subagent_action"
  | "plan"
  | "user_input_prompt"
  | "review"
  | "context_compaction";

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

export interface AgentFileChangeEntry {
  path: string;
  kind?: string;
  added?: number;
  removed?: number;
}

export interface AgentFileChange {
  entries: AgentFileChangeEntry[];
  diff?: string;
  summary?: string;
  changeSetId?: string;
  status?: AgentToolCall["status"];
}

export interface AgentCommandExecution {
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number | null;
  status?: AgentToolCall["status"];
}

export interface AgentStructuredInputOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentStructuredInputQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  selectionLimit?: number;
  options?: AgentStructuredInputOption[];
}

export interface AgentStructuredInput {
  requestId: string;
  questions: AgentStructuredInputQuestion[];
}

export interface AgentSubagentRef {
  threadId: string;
  agentId?: string;
  nickname?: string;
  role?: string;
  model?: string;
  prompt?: string;
}

export interface AgentSubagentState {
  threadId: string;
  status: string;
  message?: string;
}

export interface AgentSubagentAction {
  tool: string;
  status: string;
  prompt?: string;
  model?: string;
  receiverThreadIds: string[];
  receiverAgents: AgentSubagentRef[];
  agentStates: Record<string, AgentSubagentState>;
}

export interface AgentConversationRecord {
  id: string;
  serverUrl: string;
  sessionId: string;
  machineId?: string;
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
  kind?: AgentTimelineKind;
  turnId?: string;
  itemId?: string;
  role?: "user" | "assistant" | "system";
  content?: AgentContentBlock[];
  text?: string;
  toolCall?: AgentToolCall;
  commandExecution?: AgentCommandExecution;
  fileChange?: AgentFileChange;
  subagent?: AgentSubagentAction;
  structuredInput?: AgentStructuredInput;
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
  machineId?: string;
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

export interface AgentModelOption {
  id: string;
  label: string;
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
  models?: AgentModelOption[];
  defaultModel?: string;
  reasoningEfforts?: AgentReasoningEffort[];
  permissionModes?: AgentPermissionMode[];
  features?: Record<string, boolean>;
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

function normalizeAgentIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

export function makeAgentConversationId(input: {
  serverUrl: string;
  sessionId: string;
  machineId?: string;
  agentSessionId?: string;
  cwd: string;
  provider?: AgentProvider;
}): string {
  const provider = input.provider ?? "agent";
  const stableSuffix = input.agentSessionId
    ? `remote-${provider}-${normalizeAgentIdSegment(input.agentSessionId)}`
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `agent-${stableSuffix}`;
}

function providerScopedConversationId(record: AgentConversationRecord): string | null {
  if (!record.agentSessionId) return null;
  const suffix = normalizeAgentIdSegment(record.agentSessionId);
  const scoped = `agent-remote-${record.provider}-${suffix}`;
  const legacy = `agent-remote-${suffix}`;
  if (record.id !== legacy) return null;
  return scoped;
}

interface ProviderScopedMigration {
  oldId: string;
  newId: string;
}

function migrateProviderScopedConversations(items: AgentConversationRecord[]): {
  items: AgentConversationRecord[];
  migrations: ProviderScopedMigration[];
} {
  const byId = new Map<string, AgentConversationRecord>();
  const migrations: ProviderScopedMigration[] = [];
  for (const item of items) {
    const migratedId = providerScopedConversationId(item);
    const next = migratedId ? { ...item, id: migratedId } : item;
    if (migratedId) {
      migrations.push({ oldId: item.id, newId: migratedId });
    }
    const existing = byId.get(next.id);
    if (!existing || next.lastActivityAt >= existing.lastActivityAt) {
      byId.set(next.id, next);
    }
  }
  return { items: [...byId.values()], migrations };
}

async function migrateAgentTimelineKey(migration: ProviderScopedMigration): Promise<void> {
  try {
    const oldKey = `${TIMELINE_PREFIX}${migration.oldId}`;
    const newKey = `${TIMELINE_PREFIX}${migration.newId}`;
    const [oldRaw, newRaw] = await Promise.all([
      AsyncStorage.getItem(oldKey),
      AsyncStorage.getItem(newKey),
    ]);
    if (!oldRaw) return;
    const oldItems = JSON.parse(oldRaw) as AgentTimelineItem[];
    if (!Array.isArray(oldItems)) return;
    const newItems = newRaw ? JSON.parse(newRaw) as AgentTimelineItem[] : [];
    const mergedById = new Map<string, AgentTimelineItem>();
    if (Array.isArray(newItems)) {
      for (const item of newItems) {
        if (item.id) mergedById.set(item.id, item);
      }
    }
    for (const item of oldItems) {
      if (!item.id) continue;
      const migratedItem = { ...item, conversationId: migration.newId };
      const existing = mergedById.get(item.id);
      if (!existing || (migratedItem.updatedAt ?? migratedItem.createdAt) >= (existing.updatedAt ?? existing.createdAt)) {
        mergedById.set(item.id, migratedItem);
      }
    }
    await saveAgentTimeline(migration.newId, [...mergedById.values()]);
    await AsyncStorage.removeItem(oldKey);
  } catch {
    // Best-effort migration; old timelines remain untouched if parsing/storage fails.
  }
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
    const { items: migrated, migrations } = migrateProviderScopedConversations(parsed);
    if (JSON.stringify(migrated) !== JSON.stringify(parsed)) {
      await saveConversations(migrated);
      await Promise.all(migrations.map((migration) => migrateAgentTimelineKey(migration)));
    }
    return sortConversations(
      migrated.filter((item) => item.id && item.serverUrl && item.sessionId && item.cwd),
    );
  } catch {
    return [];
  }
}

export async function upsertAgentConversation(
  input: Omit<AgentConversationRecord, "schemaVersion"> & { schemaVersion?: 1 },
  options: { preserveLocalArchived?: boolean } = {},
): Promise<AgentConversationRecord> {
  const conversations = await loadAgentConversations();
  const normalized: AgentConversationRecord = {
    ...input,
    serverUrl: normalizeServerUrl(input.serverUrl),
    schemaVersion: 1,
  };
  const index = conversations.findIndex((item) => item.id === normalized.id);
  const preserveLocalArchived = options.preserveLocalArchived ?? true;
  const nextRecord = index >= 0
    ? {
        ...conversations[index],
        ...normalized,
        archived: preserveLocalArchived && conversations[index].archived && !normalized.archived
          ? true
          : normalized.archived,
      }
    : normalized;
  if (index >= 0) conversations[index] = nextRecord;
  else conversations.unshift(nextRecord);
  await saveConversations(conversations);
  return nextRecord;
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
      .map((item) => {
        if (item.type !== "permission" || item.metadata?.permissionOutcome) return item;
        return {
          ...item,
          metadata: {
            ...(item.metadata ?? {}),
            permissionLive: false,
            permissionPending: false,
            permissionExpired: true,
            permissionError: undefined,
          },
        };
      })
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
