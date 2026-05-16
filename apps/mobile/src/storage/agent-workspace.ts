import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";

export type AgentProvider = "codex" | "claude" | "custom";
export type AgentStatus = "unavailable" | "idle" | "running" | "waiting_permission" | "error";
export type AgentReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type AgentServiceTier = "standard" | "fast";
export type AgentPermissionMode = "read_only" | "workspace_write" | "full_access";
export type AgentCollaborationMode = "default" | "plan";
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

export interface AgentCommandDescriptor {
  id: string;
  name: string;
  title: string;
  description?: string;
  provider?: AgentProvider;
  source: "built_in" | "custom" | "project" | "user" | "linkshell";
  category?: string;
  argsMode: "none" | "optional" | "required" | "raw";
  requiresIdle?: boolean;
  destructive?: boolean;
  disabledReason?: string;
  executionKind: "prompt" | "native" | "local_ui";
}

export interface AgentModeDescriptor {
  id: string;
  title: string;
  description?: string;
}

export interface AgentConversationRecord {
  id: string;
  serverUrl: string;
  hostDeviceId: string;
  sessionId: string;
  machineId?: string;
  agentSessionId?: string;
  provider: AgentProvider;
  cwd: string;
  title?: string;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  serviceTier?: AgentServiceTier;
  permissionMode?: AgentPermissionMode;
  collaborationMode?: AgentCollaborationMode;
  status: AgentStatus;
  archived: boolean;
  timelineRevision?: number;
  historyComplete?: boolean;
  runningTurnId?: string;
  syncStatus?: "syncing" | "complete" | "stale" | "deferred";
  source?: "device" | "device-history" | "device-live" | "app-server" | "cache";
  canonical?: boolean;
  lastMessagePreview?: string;
  lastActivityAt: number;
  createdAt: number;
  schemaVersion: 2;
}

export interface AgentTimelineItem {
  id: string;
  conversationId: string;
  type: "message" | "tool_call" | "plan" | "permission" | "status" | "error";
  kind?: AgentTimelineKind;
  revision?: number;
  source?: "device" | "device-history" | "device-live" | "app-server" | "cache";
  canonical?: boolean;
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
  capabilitiesRevision?: number;
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
  reasoningEfforts?: AgentReasoningEffort[];
  defaultReasoningEffort?: AgentReasoningEffort;
  speedTiers?: AgentServiceTier[];
  supportsImages?: boolean;
  description?: string;
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
  providerProtocol?: string;
  modelsSource?: "runtime" | "fallback" | "static" | "unavailable";
  modelListError?: string;
  models?: AgentModelOption[];
  defaultModel?: string;
  reasoningEfforts?: AgentReasoningEffort[];
  speedTiers?: AgentServiceTier[];
  defaultServiceTier?: AgentServiceTier;
  permissionModes?: AgentPermissionMode[];
  commands?: AgentCommandDescriptor[];
  modes?: AgentModeDescriptor[];
  currentMode?: string;
  features?: Record<string, boolean>;
}

const CONVERSATIONS_KEY = "@linkshell/agent-conversations:v2";
const LEGACY_CONVERSATIONS_KEY = "@linkshell/agent-conversations:v1";
const TIMELINE_PREFIX = "@linkshell/agent-timeline:v1:";
const MAX_CONVERSATIONS = 100;
const MAX_TIMELINE_ITEMS = 200;
const MAX_TIMELINE_BYTES = 100 * 1024 * 1024;
const IMAGE_CACHE_DIR = `${FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? ""}agent-images`;

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "");
}

function sortConversations(items: AgentConversationRecord[]): AgentConversationRecord[] {
  return [...items].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

function normalizeAgentIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 120) || "item";
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function extensionForMimeType(mimeType: string | undefined): string {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/heic") return "heic";
  if (mimeType === "image/heif") return "heif";
  return "img";
}

function parseImageData(value: string | undefined, mimeType: string | undefined): {
  base64: string;
  mimeType: string | undefined;
} | null {
  if (!value || value.startsWith("file://") || /^https?:\/\//i.test(value)) return null;
  const match = value.match(/^data:([^;,]+)?;base64,(.*)$/is);
  if (match) {
    return {
      base64: match[2] ?? "",
      mimeType: match[1] || mimeType,
    };
  }
  if (/^[a-zA-Z0-9+/=\s]+$/.test(value) && value.length > 512) {
    return { base64: value.replace(/\s+/g, ""), mimeType };
  }
  return null;
}

async function ensureImageCacheDir(conversationId: string): Promise<string | null> {
  if (!IMAGE_CACHE_DIR) return null;
  const root = `${IMAGE_CACHE_DIR}/`;
  const dir = `${root}${sanitizePathSegment(conversationId)}/`;
  await FileSystem.makeDirectoryAsync(root, { intermediates: true }).catch(() => {});
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  return dir;
}

async function cacheImageBlock(
  conversationId: string,
  item: AgentTimelineItem,
  block: AgentContentBlock,
  blockIndex: number,
): Promise<AgentContentBlock> {
  if (block.type !== "image") return block;
  const parsed = parseImageData(block.data, block.mimeType);
  if (!parsed?.base64) return block;
  const dir = await ensureImageCacheDir(conversationId);
  if (!dir) return block;
  const itemKey = sanitizePathSegment(item.id || item.itemId || "message");
  const updatedAt = item.updatedAt ?? item.createdAt;
  const hash = hashString(parsed.base64.slice(0, 4096) + parsed.base64.length);
  const ext = extensionForMimeType(parsed.mimeType);
  const uri = `${dir}${itemKey}-${blockIndex}-${updatedAt}-${hash}.${ext}`;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) {
      await FileSystem.writeAsStringAsync(uri, parsed.base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
    return {
      ...block,
      data: uri,
      mimeType: parsed.mimeType ?? block.mimeType,
      text: block.text,
    };
  } catch {
    return block;
  }
}

async function cacheTimelineImages(
  conversationId: string,
  items: AgentTimelineItem[],
): Promise<AgentTimelineItem[]> {
  return Promise.all(items.map(async (item) => {
    if (item.type !== "message" || !item.content?.some((block) => block.type === "image")) {
      return item;
    }
    const content = await Promise.all(
      item.content.map((block, index) => cacheImageBlock(conversationId, item, block, index)),
    );
    return { ...item, content };
  }));
}

export function makeAgentConversationId(input: {
  serverUrl: string;
  hostDeviceId?: string;
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
    const raw = await AsyncStorage.getItem(CONVERSATIONS_KEY) ?? await AsyncStorage.getItem(LEGACY_CONVERSATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as (AgentConversationRecord & { hostDeviceId?: string; schemaVersion?: number })[];
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed.map((item) => {
      const serverUrl = normalizeServerUrl(item.serverUrl);
      const hostDeviceId = item.hostDeviceId ?? item.sessionId;
      return {
        ...item,
        serverUrl,
        hostDeviceId,
        sessionId: hostDeviceId,
        schemaVersion: 2 as const,
      };
    });
    const { items: migrated, migrations } = migrateProviderScopedConversations(normalized);
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
  input: Omit<AgentConversationRecord, "hostDeviceId" | "schemaVersion"> & {
    hostDeviceId?: string;
    schemaVersion?: 1 | 2;
  },
  options: { preserveLocalArchived?: boolean } = {},
): Promise<AgentConversationRecord> {
  const conversations = await loadAgentConversations();
  const normalized: AgentConversationRecord = {
    ...input,
    serverUrl: normalizeServerUrl(input.serverUrl),
    hostDeviceId: input.hostDeviceId ?? input.sessionId,
    sessionId: input.hostDeviceId ?? input.sessionId,
    schemaVersion: 2,
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

export async function replaceAgentConversationsForDevice(input: {
  serverUrl: string;
  hostDeviceId: string;
  conversations: Array<Omit<AgentConversationRecord, "hostDeviceId" | "schemaVersion"> & {
    hostDeviceId?: string;
    schemaVersion?: 1 | 2;
  }>;
  providers?: AgentProvider[];
  preserveLocalArchived?: boolean;
}): Promise<AgentConversationRecord[]> {
  const conversations = await loadAgentConversations();
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const normalized = input.conversations.map((conversation): AgentConversationRecord => ({
    ...conversation,
    serverUrl: normalizeServerUrl(conversation.serverUrl || serverUrl),
    hostDeviceId: conversation.hostDeviceId ?? conversation.sessionId ?? input.hostDeviceId,
    sessionId: conversation.hostDeviceId ?? conversation.sessionId ?? input.hostDeviceId,
    schemaVersion: 2,
  }));
  const incomingIds = new Set(normalized.map((conversation) => conversation.id));
  const incomingProviders = new Set(input.providers ?? normalized.map((conversation) => conversation.provider));
  const previousById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const preserveLocalArchived = input.preserveLocalArchived ?? true;
  const mergedIncoming = normalized.map((conversation) => {
    const previous = previousById.get(conversation.id);
    if (!previous) return conversation;
    return {
      ...previous,
      ...conversation,
      archived: preserveLocalArchived && previous.archived && !conversation.archived
        ? true
        : conversation.archived,
    };
  });
  const retained = conversations.filter((conversation) => {
    const sameDevice =
      normalizeServerUrl(conversation.serverUrl) === serverUrl &&
      (conversation.hostDeviceId ?? conversation.sessionId) === input.hostDeviceId;
    const sameProvider = incomingProviders.has(conversation.provider);
    return !sameDevice || !sameProvider || incomingIds.has(conversation.id);
  });
  const next = [
    ...mergedIncoming,
    ...retained.filter((conversation) => !incomingIds.has(conversation.id)),
  ];
  await saveConversations(next);
  return sortConversations(next);
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
  next = await cacheTimelineImages(conversationId, next);
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
