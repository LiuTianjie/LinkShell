import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";
import { LinearGradient } from "expo-linear-gradient";
import { LegendList, type LegendListRef, type LegendListRenderItemProps } from "@legendapp/list";
import { MenuView, type MenuAction } from "@react-native-menu/menu";
import Markdown from "react-native-markdown-display";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import { BrowserView } from "../components/BrowserView";
import { GlassBar } from "../components/GlassBar";
import type { AgentFileEntry, AgentFileReadResult, AgentWorkspaceHandle } from "../hooks/useAgentWorkspace";
import type {
  AgentContentBlock,
  AgentCapabilities,
  AgentCommandDescriptor,
  AgentConversationRecord,
  AgentCollaborationMode,
  AgentFileChange,
  AgentPermissionMode,
  AgentReasoningEffort,
  AgentServiceTier,
  AgentStructuredInput,
  AgentSubagentAction,
  AgentTimelineItem,
  AgentToolCall,
} from "../storage/agent-workspace";
import { useTheme, type Theme } from "../theme";

interface AgentConversationScreenProps {
  conversationId: string;
  workspace: AgentWorkspaceHandle;
  deviceToken?: string | null;
  authToken?: string | null;
  onBack: () => void;
}

type Option<T extends string> = { label: string; value?: T; image?: string };
interface QueuedCodexPrompt {
  id: string;
  text: string;
  attachments: AgentContentBlock[];
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  serviceTier?: AgentServiceTier;
  permissionMode?: AgentPermissionMode;
  collaborationMode: AgentCollaborationMode;
}

function createQueuedPromptId(): string {
  return `queued-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function queuedPromptPreview(item: QueuedCodexPrompt): string {
  const text = item.text.trim();
  if (text) return text;
  return item.attachments.length > 0 ? `${item.attachments.length} 张图片` : "空消息";
}

const CODEX_PROMPT_QUEUE_KEY_PREFIX = "@linkshell/codex-prompt-queue:v1:";

function codexPromptQueueKey(conversationId: string): string {
  return `${CODEX_PROMPT_QUEUE_KEY_PREFIX}${conversationId}`;
}

function parseQueuedCodexPrompt(value: unknown): QueuedCodexPrompt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id ? record.id : createQueuedPromptId();
  const text = typeof record.text === "string" ? record.text : "";
  const rawAttachments = Array.isArray(record.attachments) ? record.attachments : [];
  const attachments = rawAttachments.filter((block): block is AgentContentBlock => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return false;
    const candidate = block as Partial<AgentContentBlock>;
    return candidate.type === "text" || candidate.type === "image";
  });
  const collaborationMode = record.collaborationMode === "plan" ? "plan" : "default";
  if (!text.trim() && attachments.length === 0) return undefined;
  return {
    id,
    text,
    attachments,
    model: typeof record.model === "string" ? record.model : undefined,
    reasoningEffort: record.reasoningEffort === "none" || record.reasoningEffort === "minimal" || record.reasoningEffort === "low" || record.reasoningEffort === "medium" || record.reasoningEffort === "high" || record.reasoningEffort === "xhigh"
      ? record.reasoningEffort
      : undefined,
    serviceTier: record.serviceTier === "standard" || record.serviceTier === "fast" ? record.serviceTier : undefined,
    permissionMode: record.permissionMode === "read_only" || record.permissionMode === "workspace_write" || record.permissionMode === "full_access"
      ? record.permissionMode
      : undefined,
    collaborationMode,
  };
}

async function loadQueuedCodexPrompts(conversationId: string): Promise<QueuedCodexPrompt[]> {
  const raw = await AsyncStorage.getItem(codexPromptQueueKey(conversationId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(parseQueuedCodexPrompt).filter((item): item is QueuedCodexPrompt => Boolean(item))
      : [];
  } catch {
    return [];
  }
}

async function saveQueuedCodexPrompts(conversationId: string, prompts: QueuedCodexPrompt[]): Promise<void> {
  const key = codexPromptQueueKey(conversationId);
  if (prompts.length === 0) {
    await AsyncStorage.removeItem(key);
    return;
  }
  await AsyncStorage.setItem(key, JSON.stringify(prompts.slice(0, 50)));
}

function markdownHasParent(parent: unknown, type: string): boolean {
  return Array.isArray(parent) && parent.some((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === type);
}

function markdownOrderedListIndex(node: any, parent: unknown): string {
  const orderedList = Array.isArray(parent)
    ? parent.find((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "ordered_list")
    : undefined;
  const start = typeof orderedList?.attributes?.start === "number" ? orderedList.attributes.start : 1;
  const index = typeof node.index === "number" ? node.index : 0;
  return `${start + index}${typeof node.markup === "string" ? node.markup : "."}`;
}

const DEFAULT_PERMISSION_ICON = "hand.raised";
const AUTO_REVIEW_PERMISSION_ICON = "checkmark.shield";
const FULL_ACCESS_PERMISSION_ICON = "exclamationmark.shield";
const EFFORT_OPTIONS: Option<AgentReasoningEffort>[] = [
  { label: "默认强度", value: undefined },
  { label: "无", value: "none" },
  { label: "极低", value: "minimal" },
  { label: "低", value: "low" },
  { label: "中", value: "medium" },
  { label: "高", value: "high" },
  { label: "超高", value: "xhigh" },
];

const PERMISSION_OPTIONS: Option<AgentPermissionMode>[] = [
  { label: "默认权限", value: undefined, image: DEFAULT_PERMISSION_ICON },
  { label: "只读", value: "read_only", image: "eye.fill" },
  { label: "自动审查", value: "workspace_write", image: AUTO_REVIEW_PERMISSION_ICON },
  { label: "完全访问权限", value: "full_access", image: FULL_ACCESS_PERMISSION_ICON },
];
const SPEED_OPTIONS: Option<AgentServiceTier>[] = [
  { label: "标准", value: "standard", image: "speedometer" },
  { label: "快速", value: "fast", image: "bolt.fill" },
];
const DEFAULT_MODEL_OPTIONS: Option<string>[] = [{ label: "默认模型", value: undefined }];
const CLAUDE_MODEL_OPTIONS: Option<string>[] = [
  { label: "默认模型", value: undefined },
  { label: "Sonnet", value: "sonnet" },
  { label: "Opus", value: "opus" },
  { label: "Haiku", value: "haiku" },
  { label: "Sonnet 1M", value: "sonnet[1m]" },
  { label: "Opus Plan", value: "opusplan" },
];

const MAX_IMAGE_ATTACHMENTS = 3;
const MAX_IMAGE_DATA_URL_LENGTH = 4_000_000;
const FILE_PREVIEW_MAX_BYTES = 256_000;
const FILE_PREVIEW_TIMEOUT_MS = 30_000;
const DEFAULT_OPTION_ID = "__default__";
const MONO_FONT = Platform.select({ ios: "Menlo", android: "monospace" });

function timelineSurface(theme: Theme): string {
  return theme.mode === "light" ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.055)";
}

function timelineMaterial(theme: Theme): string {
  return theme.mode === "light" ? "rgba(248,248,249,0.92)" : "rgba(255,255,255,0.06)";
}

function timelinePressedSurface(theme: Theme): string {
  return theme.mode === "light" ? "rgba(60,60,67,0.055)" : "rgba(255,255,255,0.06)";
}

function subtleDivider(theme: Theme): string {
  return theme.mode === "light" ? "rgba(60,60,67,0.11)" : "rgba(255,255,255,0.10)";
}

function conversationPaper(theme: Theme): string {
  return theme.mode === "light" ? "#fbfbfb" : theme.bg;
}

function remodexMuted(theme: Theme): string {
  return theme.mode === "light" ? "rgba(90,90,96,0.62)" : theme.textTertiary;
}

function conversationInset(theme: Theme): string {
  return theme.mode === "light" ? "rgba(60,60,67,0.075)" : "rgba(255,255,255,0.075)";
}

function menuActions<T extends string>(options: Option<T>[], currentValue: T | undefined) {
  return options.map((option) => ({
    id: option.value ?? DEFAULT_OPTION_ID,
    title: option.label,
    image: option.image,
    state: option.value === currentValue ? "on" as const : "off" as const,
  }));
}

function valueFromMenuId<T extends string>(id: string): T | undefined {
  return id === DEFAULT_OPTION_ID ? undefined : id as T;
}

function statusMeta(status: string, theme: Theme) {
  switch (status) {
    case "running":
      return { label: "运行中", color: theme.accent, bg: theme.accentLight };
    case "waiting_permission":
      return { label: "待授权", color: theme.warning, bg: theme.accentLight };
    case "error":
      return { label: "错误", color: theme.error, bg: theme.errorLight };
    case "idle":
      return { label: "空闲", color: theme.success, bg: theme.accentLight };
    default:
      return { label: "不可用", color: theme.textTertiary, bg: theme.bgInput };
  }
}

function visibleConversationStatus(status: string | undefined, theme: Theme) {
  if (status === "running" || status === "waiting_permission" || status === "error") {
    return statusMeta(status, theme);
  }
  return null;
}

function toolStatusMeta(status: AgentToolCall["status"], theme: Theme) {
  if (status === "running") return { label: "运行中", color: theme.accent, bg: theme.accentLight };
  if (status === "failed") return { label: "失败", color: theme.error, bg: theme.errorLight };
  if (status === "completed") return { label: "完成", color: theme.success, bg: theme.accentLight };
  return null;
}

function permissionMeta(mode: AgentPermissionMode | undefined, theme: Theme) {
  if (mode === "full_access") {
    return { label: "完全访问权限", icon: FULL_ACCESS_PERMISSION_ICON, color: theme.warning, bg: theme.accentLight };
  }
  if (mode === "workspace_write") {
    return { label: "自动审查", icon: AUTO_REVIEW_PERMISSION_ICON, color: theme.accent, bg: theme.accentLight };
  }
  if (mode === "read_only") {
    return { label: "只读", icon: "eye.fill", color: theme.textSecondary, bg: theme.bgInput };
  }
  return { label: "默认权限", icon: DEFAULT_PERMISSION_ICON, color: theme.textSecondary, bg: theme.bgInput };
}

function providerCapabilityFor(
  provider: AgentConversationRecord["provider"],
  capabilities: AgentCapabilities | undefined,
) {
  return capabilities?.providers?.find((p) => p.id === provider);
}

function modelOptionsFor(
  provider: AgentConversationRecord["provider"],
  capabilities: AgentCapabilities | undefined,
): Option<string>[] {
  const providerCapability = providerCapabilityFor(provider, capabilities);
  const dynamicModels = providerCapability?.models;
  const defaultModel = providerCapability?.defaultModel ?? "default";
  if (dynamicModels?.length) {
    return dynamicModels.map((m) => ({
      label: m.label,
      value: m.id === defaultModel || m.id === "default" ? undefined : m.id,
    }));
  }
  if (provider === "claude") return CLAUDE_MODEL_OPTIONS;
  if (provider === "codex") return [];
  return [];
}

function effortOptionsFor(
  provider: AgentConversationRecord["provider"],
  capabilities: AgentCapabilities | undefined,
): Option<AgentReasoningEffort>[] {
  const providerCapability = providerCapabilityFor(provider, capabilities);
  if (providerCapability?.reasoningEfforts) {
    if (providerCapability.reasoningEfforts.length === 0) return [];
    return [
      { label: "默认强度", value: undefined },
      ...EFFORT_OPTIONS.filter((option) =>
        option.value ? providerCapability.reasoningEfforts?.includes(option.value) : false,
      ),
    ];
  }
  if (!providerCapability && provider === "codex") return [];
  if (!providerCapability && provider === "claude") {
    return [
      { label: "默认强度", value: undefined },
      ...EFFORT_OPTIONS.filter((option) =>
        option.value === "low" ||
        option.value === "medium" ||
        option.value === "high" ||
        option.value === "xhigh",
      ),
    ];
  }
  return [];
}

function speedOptionsFor(
  provider: AgentConversationRecord["provider"],
  capabilities: AgentCapabilities | undefined,
  model: string | undefined,
): Option<AgentServiceTier>[] {
  if (provider !== "codex") return [];
  const providerCapability = providerCapabilityFor(provider, capabilities);
  const modelId = model ?? providerCapability?.defaultModel;
  const modelCapability = modelId
    ? providerCapability?.models?.find((item) => item.id === modelId)
    : undefined;
  const speedTiers = modelCapability?.speedTiers ?? providerCapability?.speedTiers;
  if (!speedTiers?.includes("fast")) return [];
  return SPEED_OPTIONS.filter((option) => option.value && speedTiers.includes(option.value));
}

function permissionOptionsFor(
  provider: AgentConversationRecord["provider"],
  capabilities: AgentCapabilities | undefined,
): Option<AgentPermissionMode>[] {
  const providerCapability = providerCapabilityFor(provider, capabilities);
  if (providerCapability?.permissionModes) {
    if (providerCapability.permissionModes.length === 0) return [];
    return [
      { label: "默认权限", value: undefined, image: DEFAULT_PERMISSION_ICON },
      ...PERMISSION_OPTIONS.filter((option) =>
        option.value ? providerCapability.permissionModes?.includes(option.value) : false,
      ),
    ];
  }
  if (!providerCapability && (provider === "codex" || provider === "claude")) return PERMISSION_OPTIONS;
  return [];
}

function formatEffort(effort?: AgentReasoningEffort): string {
  if (!effort) return "默认";
  if (effort === "xhigh") return "超高";
  if (effort === "high") return "高";
  if (effort === "medium") return "中";
  if (effort === "low") return "低";
  if (effort === "minimal") return "极低";
  if (effort === "none") return "无";
  return "极低";
}

function formatModel(model: string | undefined, modelOptions: Option<string>[]): string {
  const label = modelOptions.find((item) => item.value === model)?.label ?? model ?? "默认模型";
  return label.replace(/^GPT-/, "");
}

function formatModelCompact(model: string | undefined, modelOptions: Option<string>[]): string {
  const label = formatModel(model, modelOptions)
    .replace(/^gpt-/i, "")
    .replace(/-codex/i, "")
    .replace(/-mini/i, " Mini")
    .replace(/-spark/i, " Spark");
  return label === "默认模型" ? "模型" : label;
}

function formatRuntimeCompact(
  model: string | undefined,
  modelOptions: Option<string>[],
  effort: AgentReasoningEffort | undefined,
  tier: AgentServiceTier | undefined,
): string {
  return [
    formatModelCompact(model, modelOptions),
    effort ? formatEffort(effort) : undefined,
    tier === "fast" ? "快" : undefined,
  ].filter(Boolean).join(" ");
}

function permissionModeNeedsAttention(mode: AgentPermissionMode | undefined): boolean {
  return mode === "workspace_write" || mode === "full_access";
}

function trailingSlashCommandToken(text: string): { query: string; start: number; end: number } | null {
  const slashIndex = text.lastIndexOf("/");
  if (slashIndex < 0) return null;
  if (slashIndex > 0 && !/\s/.test(text[slashIndex - 1] ?? "")) return null;
  const query = text.slice(slashIndex + 1);
  if (/\s/.test(query)) return null;
  return { query, start: slashIndex, end: text.length };
}

function commandSearchBlob(command: AgentCommandDescriptor): string {
  return [command.name, command.title, command.description, command.category, command.source].filter(Boolean).join(" ").toLowerCase();
}

function filteredCommands(
  commands: AgentCommandDescriptor[],
  query: string,
): AgentCommandDescriptor[] {
  const normalized = query.trim().toLowerCase();
  return normalized
    ? commands.filter((command) => commandSearchBlob(command).includes(normalized))
    : commands;
}

function commandCategoryLabel(command: AgentCommandDescriptor): string {
  if (command.category) return command.category;
  if (command.source === "project") return "Project";
  if (command.source === "user") return "User";
  if (command.source === "linkshell") return "LinkShell";
  return "Built-in";
}

function commandRawText(command: AgentCommandDescriptor, args = ""): string {
  const cleanArgs = args.trim();
  return `/${command.name}${cleanArgs ? ` ${cleanArgs}` : ""}`;
}

function commandFromMessage(
  text: string,
  commands: AgentCommandDescriptor[],
): { command: AgentCommandDescriptor; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [token, ...rest] = trimmed.slice(1).split(/\s+/);
  const command = commands.find((item) => item.name === token || item.title === `/${token}`);
  return command ? { command, args: rest.join(" ") } : null;
}

function isElevatedPermissionOption(option: { id: string; label: string; kind: "allow" | "deny" | "other" }): boolean {
  if (option.kind !== "allow") return false;
  const token = `${option.id} ${option.label}`.toLowerCase();
  return (
    token.includes("always") ||
    token.includes("forever") ||
    token.includes("session") ||
    token.includes("profile") ||
    token.includes("full") ||
    token.includes("workspace") ||
    token.includes("全部") ||
    token.includes("总是") ||
    token.includes("永久") ||
    token.includes("会话")
  );
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

async function copy(value: string): Promise<boolean> {
  try {
    Clipboard.setString(value);
    const copied = typeof Clipboard.getString === "function" ? await Clipboard.getString() : value;
    Haptics.selectionAsync().catch(() => {});
    return copied === value || copied.length > 0;
  } catch {
    return false;
  }
}

function imageBlockFromAsset(asset: ImagePicker.ImagePickerAsset): AgentContentBlock | null {
  if (!asset.base64) return null;
  const mimeType = asset.mimeType || "image/jpeg";
  return {
    type: "image",
    data: `data:${mimeType};base64,${asset.base64}`,
    mimeType,
    text: asset.fileName || "图片附件",
  };
}

type FileDiffEntry = {
  path: string;
  added: number;
  removed: number;
  kind?: string;
  patch?: string;
};

type OpenFileReferenceOptions = {
  diff?: string;
  title?: string;
  autoRead?: boolean;
};

type ToolActivityEntry = {
  id: string;
  icon: string;
  title: string;
  subtitle?: string;
  category: "read" | "search" | "list" | "command" | "tool";
  status: AgentToolCall["status"];
  input?: string;
  output?: string;
  language: string;
  createdAt?: number;
};

function displayProvider(provider: AgentConversationRecord["provider"]): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  return "Custom";
}

function looksLikeDiff(text: string | undefined): boolean {
  if (!text) return false;
  const value = extractFencedDiff(text) ?? text.trim();
  return (
    value.startsWith("diff --git ") ||
    value.startsWith("*** Begin Patch") ||
    value.startsWith("@@ ") ||
    value.includes("\n@@ ") ||
    (value.includes("\n--- ") && value.includes("\n+++ "))
  );
}

function extractFencedDiff(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const blocks = [...text.matchAll(/```(?:diff|patch)?\s*\n([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (blocks.length > 0) return blocks.join("\n\n");
  const trimmed = text.trim();
  return trimmed ? trimmed : undefined;
}

function splitPatchIntoFileChunks(patch: string | undefined): Map<string, string> {
  const chunks = new Map<string, string>();
  if (!patch?.trim()) return chunks;
  let currentPath: string | undefined;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentPath || currentLines.length === 0) return;
    chunks.set(currentPath, currentLines.join("\n").trimEnd());
  };

  for (const line of patch.split(/\r?\n/)) {
    const gitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const updateMatch = line.match(/^\*\*\* Update File:\s+(.+)$/);
    const addMatch = line.match(/^\*\*\* Add File:\s+(.+)$/);
    const deleteMatch = line.match(/^\*\*\* Delete File:\s+(.+)$/);
    const headerPath = gitMatch?.[2] ?? updateMatch?.[1] ?? addMatch?.[1] ?? deleteMatch?.[1];
    if (headerPath) {
      flush();
      currentPath = headerPath.trim();
      currentLines = [line];
      continue;
    }
    if (currentPath) currentLines.push(line);
  }
  flush();
  return chunks;
}

function diffStats(diff: string, fallback?: string) {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match?.[2]) files.add(match[2]);
    } else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      files.add(line.replace(/^\+\+\+ b?\//, "").trim());
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  if (files.size === 0 && fallback) {
    fallback
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => files.add(line.replace(/^(modify|create|delete|update|add)\s+/i, "")));
  }
  return { files: [...files].slice(0, 4), added, removed };
}

function diffEntries(diff: string, fallback?: string): FileDiffEntry[] {
  const entries: FileDiffEntry[] = [];
  let current: FileDiffEntry | null = null;

  const flush = () => {
    if (current && (current.path || current.added > 0 || current.removed > 0)) {
      const existing = entries.find((entry) => entry.path === current!.path);
      if (existing) {
        existing.added += current.added;
        existing.removed += current.removed;
      } else {
        entries.push(current);
      }
    }
    current = null;
  };

  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      flush();
      const match = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = { path: match?.[2] || rawLine.replace(/^diff --git\s+/, ""), added: 0, removed: 0 };
      continue;
    }
    const patchHeader = rawLine.match(/^\*\*\* (Add|Update|Delete) File:\s+(.+)$/);
    if (patchHeader?.[2]) {
      flush();
      current = {
        path: patchHeader[2].trim(),
        kind: patchHeader[1] === "Add" ? "create" : patchHeader[1] === "Delete" ? "delete" : "update",
        added: 0,
        removed: 0,
      };
      continue;
    }
    if (rawLine.startsWith("+++ ") && !rawLine.startsWith("+++ /dev/null")) {
      const path = rawLine.replace(/^\+\+\+ b?\//, "").trim();
      if (!current) current = { path, added: 0, removed: 0 };
      else current.path = path;
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      if (!current) current = { path: "工作区 diff", added: 0, removed: 0 };
      current.added += 1;
      continue;
    }
    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      if (!current) current = { path: "工作区 diff", added: 0, removed: 0 };
      current.removed += 1;
    }
  }
  flush();

  if (entries.length > 0) return entries.slice(0, 12);

  const fallbackEntries = (fallback ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      path: line.replace(/^(modify|create|delete|update|add)\s+/i, ""),
      added: 0,
      removed: 0,
    }));
  return fallbackEntries.slice(0, 12);
}

function entryKindLabel(kind: string | undefined): string | undefined {
  const normalized = kind?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "create" || normalized === "add" || normalized === "added") return "新增";
  if (normalized === "delete" || normalized === "deleted" || normalized === "remove") return "删除";
  if (normalized === "move" || normalized === "rename" || normalized === "renamed") return "重命名";
  if (normalized === "update" || normalized === "edit" || normalized === "edited" || normalized === "modify") return "编辑";
  return kind;
}

function parentPath(path: string): string {
  const clean = path.replace(/\/+$/, "");
  if (!clean || clean === "/") return "/";
  const index = clean.lastIndexOf("/");
  return index <= 0 ? "/" : clean.slice(0, index);
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).pop() || path || "/";
}

function normalizeFileReference(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim();
  if (!value) return undefined;
  if (/^(https?:|mailto:|tel:|sms:|linkshell:)/i.test(value)) return undefined;
  if (/^file:\/\//i.test(value)) value = value.replace(/^file:\/\//i, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the original value if it is not URI-encoded.
  }
  value = value
    .replace(/[#?].*$/, "")
    .replace(/:(\d+)(?::\d+)?$/, "")
    .trim();
  if (!value) return undefined;
  if (value.startsWith("/") || value.startsWith("~") || value.startsWith("./") || value.startsWith("../")) return value;
  if (value.includes("/") || /^[\w.-]+\.[A-Za-z0-9]+$/.test(value)) return value;
  return undefined;
}

function resolveFileReference(path: string, cwd: string): string {
  if (path.startsWith("/") || path.startsWith("~")) return path;
  const base = cwd && cwd !== "~" ? cwd.replace(/\/+$/, "") : "~";
  return `${base}/${path.replace(/^\.\//, "")}`;
}

function imageUriFromValue(value: string | undefined): string | undefined {
  const uri = value?.trim();
  if (!uri) return undefined;
  if (/^(data:|https?:\/\/|file:\/\/|asset:\/\/|content:\/\/|ph:\/\/)/i.test(uri)) return uri;
  if (uri.startsWith("/")) return `file://${uri}`;
  return uri;
}

function formatBytes(value: number | undefined): string {
  if (typeof value !== "number") return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function languageFromPath(path: string): string {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    mjs: "javascript",
    cjs: "javascript",
    css: "css",
    scss: "scss",
    html: "html",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    sh: "shell",
    zsh: "shell",
    bash: "shell",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    swift: "swift",
    kt: "kotlin",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    sql: "sql",
    xml: "xml",
  };
  return map[ext] ?? (ext || "text");
}

type HighlightToken = { text: string; color: string; fontWeight?: "400" | "700" };

function syntaxTokens(line: string, language: string, theme: Theme): HighlightToken[] {
  if (!line) return [{ text: " ", color: theme.textSecondary }];
  if (line.startsWith("+") && !line.startsWith("+++")) return [{ text: line, color: theme.success }];
  if (line.startsWith("-") && !line.startsWith("---")) return [{ text: line, color: theme.error }];
  if (line.startsWith("@@")) return [{ text: line, color: theme.accent, fontWeight: "700" }];

  const commentIndex = (() => {
    if (["python", "ruby", "shell", "yaml"].includes(language)) return line.indexOf("#");
    const slash = line.indexOf("//");
    return slash >= 0 ? slash : -1;
  })();
  const code = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const comment = commentIndex >= 0 ? line.slice(commentIndex) : "";
  const keywordPattern = /\b(import|from|export|const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|interface|type|extends|implements|async|await|try|catch|throw|new|true|false|null|undefined|def|self|struct|enum|public|private|protected|static|package)\b/g;
  const tokenPattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b(import|from|export|const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|interface|type|extends|implements|async|await|try|catch|throw|new|true|false|null|undefined|def|self|struct|enum|public|private|protected|static|package)\b)/g;
  const tokens: HighlightToken[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(code))) {
    if (match.index > cursor) {
      tokens.push({ text: code.slice(cursor, match.index), color: theme.textSecondary });
    }
    const value = match[0];
    const isString = value.startsWith("\"") || value.startsWith("'") || value.startsWith("`");
    const isNumber = /^\d/.test(value);
    tokens.push({
      text: value,
      color: isString ? theme.success : isNumber ? theme.warning : keywordPattern.test(value) ? theme.accent : theme.text,
      fontWeight: isString || isNumber ? "400" : "700",
    });
    keywordPattern.lastIndex = 0;
    cursor = match.index + value.length;
  }
  if (cursor < code.length) tokens.push({ text: code.slice(cursor), color: theme.textSecondary });
  if (comment) tokens.push({ text: comment, color: theme.textTertiary });
  return tokens.length ? tokens : [{ text: line, color: theme.textSecondary }];
}

function diffLineColors(line: string, theme: Theme) {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return { color: theme.success, backgroundColor: "rgba(52, 199, 89, 0.12)" };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return { color: theme.error, backgroundColor: "rgba(255, 59, 48, 0.12)" };
  }
  if (line.startsWith("@@")) {
    return { color: theme.accent, backgroundColor: theme.accentLight };
  }
  if (line.startsWith("diff --git") || line.startsWith("---") || line.startsWith("+++")) {
    return { color: theme.textSecondary, backgroundColor: theme.bgInput };
  }
  return { color: theme.textSecondary, backgroundColor: "transparent" };
}

function commandLanguage(toolName: string): string {
  return toolName.includes("命令") ? "shell" : "text";
}

function parsedToolInput(input: string | undefined): Record<string, unknown> | undefined {
  if (!input?.trim()) return undefined;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function firstToolString(input: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!input) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function fileEntriesFromToolInput(input: string | undefined): FileDiffEntry[] {
  const parsed = parsedToolInput(input);
  if (!parsed) return [];
  const directPath = firstToolString(parsed, ["path", "file_path", "filePath", "relativePath"]);
  if (directPath) return [{ path: directPath, added: 0, removed: 0 }];

  const rawFiles = parsed.files ?? parsed.paths ?? parsed.entries;
  if (!Array.isArray(rawFiles)) return [];
  return rawFiles
    .map((entry) => {
      if (typeof entry === "string") return { path: entry, added: 0, removed: 0 };
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const path = firstToolString(record, ["path", "file_path", "filePath", "relativePath"]);
      if (!path) return null;
      return {
        path,
        added: typeof record.added === "number" ? record.added : 0,
        removed: typeof record.removed === "number" ? record.removed : 0,
        kind: typeof record.kind === "string" ? record.kind : undefined,
      };
    })
    .filter((entry): entry is FileDiffEntry => Boolean(entry?.path));
}

function isFileToolName(name: string): boolean {
  const token = normalizedToken(name);
  return (
    token.includes("filechange") ||
    token.includes("applypatch") ||
    token.includes("multiedit") ||
    token === "edit" ||
    token === "write" ||
    token === "notebookedit" ||
    name.includes("文件")
  );
}

function humanizeToolCall(tool: AgentToolCall): { icon: string; title: string; subtitle?: string } {
  const input = parsedToolInput(tool.input);
  const token = normalizedToken(tool.name);
  const rawTarget =
    firstToolString(input, ["path", "file_path", "filePath", "relativePath", "pattern", "query", "command", "url"]) ??
    tool.input?.trim();
  const target = rawTarget ? rawTarget.split("\n")[0] : undefined;
  if (token.includes("mcp")) {
    return { icon: "server.rack", title: tool.name, subtitle: target };
  }
  if (token.includes("websearch") || token.includes("webfetch") || token.includes("browser") || token.includes("openurl")) {
    return { icon: "globe", title: token.includes("search") ? "搜索网页" : "读取网页", subtitle: target };
  }
  if (token.includes("grep") || token.includes("glob") || token.includes("search") || token.includes("find")) {
    return { icon: "magnifyingglass", title: tool.status === "running" ? "正在搜索" : "搜索了", subtitle: target };
  }
  if (token.includes("read") || token.includes("cat") || token.includes("openfile")) {
    return { icon: "doc.text", title: tool.status === "running" ? "正在读取" : "读取了", subtitle: target };
  }
  if (token.includes("exec") || token.includes("terminal") || token.includes("bash") || token.includes("shell")) {
    return { icon: "terminal.fill", title: tool.status === "running" ? "正在运行" : "运行了", subtitle: target };
  }
  return { icon: "terminal.fill", title: tool.name, subtitle: target };
}

function unwrapShell(raw: string): string {
  let value = raw.trim();
  const lower = value.toLowerCase();
  const prefixes = [
    "/usr/bin/zsh -lc ",
    "/bin/zsh -lc ",
    "zsh -lc ",
    "/usr/bin/bash -lc ",
    "/usr/bin/bash -c ",
    "/bin/bash -lc ",
    "/bin/bash -c ",
    "bash -lc ",
    "bash -c ",
    "/bin/sh -c ",
    "sh -c ",
  ];

  for (const prefix of prefixes) {
    if (!lower.startsWith(prefix)) continue;
    value = value.slice(prefix.length).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const cdIndex = value.indexOf("&&");
    if (cdIndex >= 0) value = value.slice(cdIndex + 2).trim();
    break;
  }

  const pipeIndex = value.indexOf(" | ");
  if (pipeIndex >= 0) value = value.slice(0, pipeIndex).trim();
  return value;
}

function compactPath(value: string): string {
  const cleaned = value.trim().replace(/^["']|["']$/g, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length <= 2) return cleaned;
  return parts.slice(-2).join("/");
}

function lastCommandTarget(args: string, fallback: string): string {
  const tokens = args.split(/\s+/).filter(Boolean);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index].replace(/^["']|["']$/g, "");
    if (!token || token.startsWith("-")) continue;
    return compactPath(token);
  }
  return fallback;
}

function humanizeCommand(raw: string, running: boolean): { verb: string; target: string } {
  const command = unwrapShell(raw);
  const [toolRaw, ...rest] = command.split(/\s+/);
  const tool = (toolRaw || command).split("/").pop()?.toLowerCase() || "";
  const args = rest.join(" ");
  switch (tool) {
    case "cat":
    case "nl":
    case "head":
    case "tail":
    case "sed":
    case "less":
    case "more":
      return { verb: running ? "正在读取" : "读取了", target: lastCommandTarget(args, "文件") };
    case "rg":
    case "grep":
    case "ag":
    case "ack":
      return { verb: running ? "正在搜索" : "搜索了", target: args ? args.slice(0, 80) : "工作区" };
    case "ls":
    case "find":
    case "fd":
      return { verb: running ? "正在列出" : "列出了", target: lastCommandTarget(args, "文件") };
    case "mkdir":
      return { verb: running ? "正在创建" : "创建了", target: lastCommandTarget(args, "目录") };
    case "rm":
      return { verb: running ? "正在删除" : "删除了", target: lastCommandTarget(args, "文件") };
    case "git":
      return { verb: running ? "正在运行 git" : "运行了 git", target: args || "命令" };
    default:
      return { verb: running ? "正在运行" : "运行了", target: command || raw };
  }
}

function normalizedToken(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[_\-\s/]+/g, "");
}

function isEmptyActivityText(value: string | undefined): boolean {
  const text = value?.trim();
  if (!text) return true;
  if (text === "[]" || text === "{}" || text === "null" || text === "undefined") return true;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length === 0;
    if (parsed && typeof parsed === "object") return Object.keys(parsed).length === 0;
  } catch {
    // Non-JSON text is real activity content.
  }
  return false;
}

function subagentTitle(action: AgentSubagentAction): string {
  const count = Math.max(1, action.receiverThreadIds.length, action.receiverAgents.length);
  const token = normalizedToken(action.tool);
  if (token.includes("spawn")) return `启动 ${count} 个子 Agent`;
  if (token.includes("wait")) return `等待 ${count} 个子 Agent`;
  if (token.includes("resume")) return `恢复 ${count} 个子 Agent`;
  if (token.includes("close")) return `关闭 ${count} 个子 Agent`;
  if (token.includes("sendinput")) return `更新 ${count} 个子 Agent`;
  return count === 1 ? "子 Agent 活动" : `${count} 个子 Agent 活动`;
}

function subagentStatusLabel(status: string | undefined): string {
  const token = normalizedToken(status);
  if (token === "completed" || token === "done" || token === "success") return "完成";
  if (token === "failed" || token === "error") return "失败";
  if (token === "stopped" || token === "cancelled") return "已停止";
  if (token === "queued" || token === "pending") return "排队中";
  if (token === "running" || token === "inprogress") return "运行中";
  return status || "未知";
}

function subagentDisplayName(agent: AgentSubagentAction["receiverAgents"][number], fallbackThreadId: string): string {
  if (agent.nickname && agent.role) return `${agent.nickname} [${agent.role}]`;
  if (agent.nickname) return agent.nickname;
  if (agent.role) return agent.role;
  return fallbackThreadId.length > 14 ? `Agent ${fallbackThreadId.slice(-8)}` : fallbackThreadId || "Agent";
}

function fileToolDedupeKey(item: AgentTimelineItem): string | null {
  const tool = item.toolCall;
  if (item.type !== "tool_call" || !tool?.name.includes("文件")) return null;
  const output = tool.output?.trim();
  if (output) return `file-output:${output}`;
  const input = tool.input?.trim();
  return input ? `file-input:${input}` : null;
}

function dedupeTimelineItems(items: AgentTimelineItem[]): AgentTimelineItem[] {
  const keepByKey = new Map<string, number>();
  items.forEach((item, index) => {
    const key = fileToolDedupeKey(item);
    if (key) keepByKey.set(key, index);
  });
  return items.filter((item, index) => {
    const key = fileToolDedupeKey(item);
    return !key || keepByKey.get(key) === index;
  });
}

function isFileChangeItem(item: AgentTimelineItem): boolean {
  return item.kind === "file_change" || Boolean(item.fileChange);
}

function fileChangeGroupKey(item: AgentTimelineItem): string {
  return item.turnId || `near:${Math.floor(item.createdAt / 2500)}`;
}

function aggregateFileChangeItems(group: AgentTimelineItem[]): AgentTimelineItem {
  if (group.length === 1) return group[0]!;
  const first = group[0]!;
  const entriesByPath = new Map<string, AgentFileChange["entries"][number]>();
  const diffParts: string[] = [];
  const summaryParts: string[] = [];
  let hasRunning = false;
  let hasFailed = false;

  for (const item of group) {
    const fileChange = item.fileChange;
    const entries = fileChange?.entries ?? [];
    for (const entry of entries) {
      const path = entry.path?.trim();
      if (!path) continue;
      const existing = entriesByPath.get(path);
      if (existing) {
        existing.added = (existing.added ?? 0) + (entry.added ?? 0);
        existing.removed = (existing.removed ?? 0) + (entry.removed ?? 0);
        existing.kind ??= entry.kind;
      } else {
        entriesByPath.set(path, { ...entry, added: entry.added ?? 0, removed: entry.removed ?? 0 });
      }
    }
    const diff = fileChange?.diff ?? (looksLikeDiff(item.toolCall?.output) ? item.toolCall?.output : undefined);
    const summary = fileChange?.summary ?? (!looksLikeDiff(item.toolCall?.output) ? item.toolCall?.output : undefined);
    if (diff?.trim()) diffParts.push(diff.trim());
    if (summary?.trim()) summaryParts.push(summary.trim());
    const status = fileChange?.status ?? item.toolCall?.status;
    hasRunning ||= status === "running" || status === "pending" || item.isStreaming === true;
    hasFailed ||= status === "failed";
  }

  const entries = [...entriesByPath.values()];
  const added = entries.reduce((sum, entry) => sum + (entry.added ?? 0), 0);
  const removed = entries.reduce((sum, entry) => sum + (entry.removed ?? 0), 0);
  const status: AgentToolCall["status"] = hasRunning ? "running" : hasFailed ? "failed" : "completed";
  const summary = summaryParts.length > 0
    ? summaryParts.join("\n")
    : entries.map((entry) => [entry.kind, entry.path].filter(Boolean).join(" ")).join("\n");
  const diff = diffParts.length > 0 ? diffParts.join("\n\n") : undefined;

  return {
    ...first,
    id: `file-change-group:${group.map((item) => item.id).join("|")}`,
    itemId: first.itemId ?? first.id,
    type: "tool_call",
    kind: "file_change",
    text: `已编辑 ${entries.length} 个文件 +${added} -${removed}`,
    toolCall: {
      id: first.itemId ?? first.id,
      name: "文件修改",
      input: summary,
      output: diff ?? summary,
      createdAt: first.createdAt,
      status,
    },
    fileChange: {
      entries,
      diff,
      summary,
      status,
    },
    createdAt: Math.min(...group.map((item) => item.createdAt)),
    updatedAt: Math.max(...group.map((item) => item.updatedAt ?? item.createdAt)),
    isStreaming: hasRunning,
    metadata: {
      ...(first.metadata ?? {}),
      groupedItemIds: group.map((item) => item.id),
    },
  };
}

function toolFromTimelineItem(item: AgentTimelineItem): AgentToolCall | null {
  if (item.fileChange || item.kind === "file_change") return null;
  if (item.commandExecution) {
    return {
      id: item.itemId ?? item.id,
      name: "命令",
      input: [
        item.commandExecution.command,
        item.commandExecution.cwd ? `cwd: ${item.commandExecution.cwd}` : undefined,
      ].filter(Boolean).join("\n\n"),
      output: item.commandExecution.output,
      createdAt: item.createdAt,
      status: item.commandExecution.status ?? "running",
    };
  }
  if (item.type !== "tool_call" || !item.toolCall || isFileToolName(item.toolCall.name)) return null;
  return item.toolCall;
}

function toolActivityCategory(title: string, tool: AgentToolCall): ToolActivityEntry["category"] {
  const token = normalizedToken(tool.name);
  if (title.includes("读取") || token.includes("read") || token.includes("cat")) return "read";
  if (title.includes("搜索") || token.includes("grep") || token.includes("search") || token.includes("glob")) return "search";
  if (title.includes("列出") || token.includes("list") || token.includes("ls")) return "list";
  if (title.includes("运行") || token.includes("bash") || token.includes("shell") || token.includes("exec")) return "command";
  return "tool";
}

function toolActivityEntryFromItem(item: AgentTimelineItem): ToolActivityEntry | null {
  const tool = toolFromTimelineItem(item);
  if (!tool) return null;
  const input = tool.input?.trim();
  const output = tool.output?.trim();
  const isCommand = tool.name.includes("命令");
  const commandSummary = isCommand && input ? humanizeCommand(input, tool.status === "running") : null;
  const presentation = commandSummary ? null : humanizeToolCall(tool);
  const title = commandSummary ? commandSummary.verb : presentation?.title ?? tool.name;
  const subtitle = commandSummary ? commandSummary.target : (presentation?.subtitle ?? input ?? output ?? "");
  const icon = commandSummary ? "terminal.fill" : presentation?.icon ?? "terminal.fill";
  return {
    id: item.itemId ?? item.id,
    icon,
    title,
    subtitle,
    category: toolActivityCategory(title, tool),
    status: tool.status,
    input,
    output,
    language: commandLanguage(tool.name),
    createdAt: tool.createdAt ?? item.createdAt,
  };
}

function toolActivityGroupKey(item: AgentTimelineItem): string {
  return item.turnId || `near:${Math.floor(item.createdAt / 4000)}`;
}

function summarizeToolActivity(entries: ToolActivityEntry[]): string {
  const fileTargets = new Set<string>();
  let searches = 0;
  let commands = 0;
  let tools = 0;
  for (const entry of entries) {
    if ((entry.category === "read" || entry.category === "list") && entry.subtitle) {
      fileTargets.add(entry.subtitle);
    } else if (entry.category === "search") {
      searches += 1;
    } else if (entry.category === "command") {
      commands += 1;
    } else {
      tools += 1;
    }
  }
  const parts = [
    fileTargets.size > 0 ? `${fileTargets.size} 个文件` : null,
    searches > 0 ? `${searches} 次搜索` : null,
    commands > 0 ? `${commands} 条命令` : null,
    tools > 0 ? `${tools} 个工具` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `已探索 ${parts.join(" ")}` : `已运行 ${entries.length} 个操作`;
}

function aggregateToolActivityItems(group: AgentTimelineItem[]): AgentTimelineItem {
  if (group.length < 2) return group[0]!;
  const first = group[0]!;
  const entries = group
    .map(toolActivityEntryFromItem)
    .filter((entry): entry is ToolActivityEntry => Boolean(entry));
  if (entries.length < 2) return first;
  const hasRunning = entries.some((entry) => entry.status === "running" || entry.status === "pending");
  const hasFailed = entries.some((entry) => entry.status === "failed");
  const status: AgentToolCall["status"] = hasRunning ? "running" : hasFailed ? "failed" : "completed";
  const text = summarizeToolActivity(entries);
  return {
    ...first,
    id: `tool-activity-group:${group.map((item) => item.id).join("|")}`,
    type: "tool_call",
    kind: "tool_activity",
    text,
    toolCall: {
      id: first.itemId ?? first.id,
      name: "探索",
      input: entries.map((entry) => [entry.title, entry.subtitle].filter(Boolean).join(" ")).join("\n"),
      createdAt: first.createdAt,
      status,
    },
    commandExecution: undefined,
    createdAt: Math.min(...group.map((item) => item.createdAt)),
    updatedAt: Math.max(...group.map((item) => item.updatedAt ?? item.createdAt)),
    isStreaming: hasRunning,
    metadata: {
      ...(first.metadata ?? {}),
      groupedItemIds: group.map((item) => item.id),
      toolActivityEntries: entries,
    },
  };
}

function groupFileChangeItems(items: AgentTimelineItem[]): AgentTimelineItem[] {
  const out: AgentTimelineItem[] = [];
  let pending: AgentTimelineItem[] = [];
  let pendingKey: string | undefined;

  const flush = () => {
    if (pending.length > 0) out.push(aggregateFileChangeItems(pending));
    pending = [];
    pendingKey = undefined;
  };

  for (const item of items) {
    if (!isFileChangeItem(item)) {
      flush();
      out.push(item);
      continue;
    }
    const key = fileChangeGroupKey(item);
    if (pending.length > 0 && pendingKey !== key) flush();
    pending.push(item);
    pendingKey = key;
  }
  flush();
  return out;
}

function groupToolActivityItems(items: AgentTimelineItem[]): AgentTimelineItem[] {
  const out: AgentTimelineItem[] = [];
  let pending: AgentTimelineItem[] = [];
  let pendingKey: string | undefined;

  const flush = () => {
    if (pending.length > 0) {
      out.push(pending.length > 1 ? aggregateToolActivityItems(pending) : pending[0]!);
    }
    pending = [];
    pendingKey = undefined;
  };

  for (const item of items) {
    const entry = toolActivityEntryFromItem(item);
    if (!entry) {
      flush();
      out.push(item);
      continue;
    }
    const key = toolActivityGroupKey(item);
    if (pending.length > 0 && pendingKey !== key) flush();
    pending.push(item);
    pendingKey = key;
  }
  flush();
  return out;
}

function prepareTimelineItems(items: AgentTimelineItem[]): AgentTimelineItem[] {
  return groupToolActivityItems(groupFileChangeItems(dedupeTimelineItems(items)));
}

function utf8ByteLength(value: string): number {
  try {
    return encodeURIComponent(value).replace(/%[0-9A-F]{2}/gi, "x").length;
  } catch {
    return value.length;
  }
}

function sliceWithinByteLimit(value: string, limit: number, fromEnd = false): string {
  let bytes = 0;
  const chars = fromEnd ? [...value].reverse() : [...value];
  const out: string[] = [];
  for (const char of chars) {
    const nextBytes = utf8ByteLength(char);
    if (bytes + nextBytes > limit) break;
    bytes += nextBytes;
    out.push(char);
  }
  return fromEnd ? out.reverse().join("") : out.join("");
}

function clippedTextWindow(text: string, limit: number): { text: string; hiddenByteCount: number } {
  const total = utf8ByteLength(text);
  if (total <= limit) return { text, hiddenByteCount: 0 };
  const marker = "\n\n...\n\n";
  const markerBytes = utf8ByteLength(marker);
  const contentLimit = Math.max(2, limit - markerBytes);
  const head = sliceWithinByteLimit(text, Math.max(1, Math.floor(contentLimit / 3)));
  const tail = sliceWithinByteLimit(text, Math.max(1, contentLimit - utf8ByteLength(head)), true);
  return {
    text: `${head}${marker}${tail}`,
    hiddenByteCount: Math.max(0, total - utf8ByteLength(head) - utf8ByteLength(tail)),
  };
}

function timelineTextLimit(item: AgentTimelineItem | undefined, fallback: number): number {
  if (!item) return fallback;
  if (item.kind === "file_change" || item.fileChange) return 48_000;
  if (item.kind === "thinking") return 16_000;
  if (item.kind === "tool_activity" || item.kind === "command_execution" || item.commandExecution || item.toolCall) return 8_000;
  return 32_000;
}

function expandedLimit(baseLimit: number, level: number): number {
  return baseLimit * Math.pow(2, Math.max(0, Math.min(level, 12)));
}

function useDisplayWindow(text: string | undefined, baseLimit: number) {
  const [level, setLevel] = useState(0);
  const window = useMemo(() => clippedTextWindow(text ?? "", expandedLimit(baseLimit, level)), [baseLimit, level, text]);
  const canExpand = window.hiddenByteCount > 0;
  const expand = useCallback(() => setLevel((value) => value + 1), []);
  return { text: window.text, hiddenByteCount: window.hiddenByteCount, canExpand, expand };
}

function ExpandTextButton({
  hiddenByteCount,
  theme,
  inverse,
  onPress,
}: {
  hiddenByteCount: number;
  theme: Theme;
  inverse?: boolean;
  onPress: () => void;
}) {
  if (hiddenByteCount <= 0) return null;
  const kb = Math.max(1, Math.ceil(hiddenByteCount / 1024));
  return (
    <Pressable onPress={onPress} hitSlop={8} style={{ alignSelf: "flex-start", paddingVertical: 4 }}>
      <Text style={{ color: inverse ? "rgba(255,255,255,0.86)" : theme.accent, fontSize: 12, fontWeight: "800" }}>
        展开更多（约 {kb} KB）
      </Text>
    </Pressable>
  );
}

function CodeBlock({
  label,
  code,
  theme,
  maxLines,
}: {
  label: string;
  code: string;
  theme: Theme;
  maxLines?: number;
}) {
  const [copied, setCopied] = useState(false);
  const display = useDisplayWindow(code, 8_000);
  const onCopy = useCallback(() => {
    copy(code).then((ok) => {
      if (!ok) {
        Alert.alert("复制失败", "系统剪贴板暂不可用，请长按文本手动复制。");
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {
      Alert.alert("复制失败", "系统剪贴板暂不可用，请长按文本手动复制。");
    });
  }, [code]);

  return (
    <View
      style={{
        borderRadius: 10,
        borderCurve: "continuous",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.separator,
        backgroundColor: theme.bgInput,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          minHeight: 30,
          paddingHorizontal: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.separator,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <Text style={{ flex: 1, color: theme.textTertiary, fontSize: 11, fontWeight: "700" }} numberOfLines={1}>
          {label}
        </Text>
        <Pressable
          onPress={onCopy}
          hitSlop={8}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2 }}
        >
          <AppSymbol name={copied ? "checkmark" : "doc.on.doc"} size={12} color={theme.textTertiary} />
          <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "700" }}>
            {copied ? "已复制" : "复制"}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false}>
        <Text
          selectable
          numberOfLines={maxLines}
          style={{
            minWidth: "100%",
            paddingHorizontal: 10,
            paddingVertical: 9,
            color: theme.textSecondary,
            fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {display.text}
        </Text>
      </ScrollView>
      <View style={{ paddingHorizontal: 10, paddingBottom: display.canExpand ? 6 : 0 }}>
        <ExpandTextButton hiddenByteCount={display.hiddenByteCount} theme={theme} onPress={display.expand} />
      </View>
    </View>
  );
}

function DiffBlock({
  diff,
  theme,
  expanded,
}: {
  diff: string;
  theme: Theme;
  expanded: boolean;
}) {
  const lines = diff.split("\n");
  const visibleLines = expanded ? lines.slice(0, 500) : lines.slice(0, 18);
  return (
    <View
      style={{
        borderRadius: 10,
        borderCurve: "continuous",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.separator,
        backgroundColor: theme.bgInput,
        overflow: "hidden",
      }}
    >
      <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false}>
        <View style={{ minWidth: "100%", paddingVertical: 6 }}>
          {visibleLines.map((line, index) => {
            const colors = diffLineColors(line, theme);
            return (
              <Text
                key={`${index}-${line.slice(0, 12)}`}
                selectable
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 1,
                  minWidth: "100%",
                  color: colors.color,
                  backgroundColor: colors.backgroundColor,
                  fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
                  fontSize: 11,
                  lineHeight: 16,
                }}
              >
                {line || " "}
              </Text>
            );
          })}
          {visibleLines.length < lines.length ? (
            <Text
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                color: theme.textTertiary,
                fontSize: 11,
                fontWeight: "700",
              }}
            >
              还有 {lines.length - visibleLines.length} 行
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function MessageContent({
  blocks,
  fallbackText,
  theme,
  inverse = false,
  monospace = false,
  onOpenFile,
}: {
  blocks?: AgentContentBlock[];
  fallbackText?: string;
  theme: Theme;
  inverse?: boolean;
  monospace?: boolean;
  onOpenFile?: (path: string, options?: OpenFileReferenceOptions) => void;
}) {
  const normalized = blocks?.length
    ? blocks
    : fallbackText
      ? [{ type: "text" as const, text: fallbackText }]
      : [];

  return (
    <View style={{ gap: 9 }}>
      {normalized.map((block, index) => {
        if (block.type === "image") {
          const imageUri = imageUriFromValue(block.data);
          return (
            <View
              key={`image-${index}`}
              style={{
                borderRadius: 12,
                borderCurve: "continuous",
                overflow: "hidden",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: inverse ? "rgba(255,255,255,0.28)" : theme.separator,
                backgroundColor: inverse ? "rgba(255,255,255,0.12)" : theme.bgInput,
              }}
            >
              {imageUri ? (
                <Image
                  source={{ uri: imageUri }}
                  contentFit="cover"
                  transition={120}
                  style={{ width: 260, maxWidth: "100%", aspectRatio: 4 / 3 }}
                />
              ) : (
                <View style={{ width: 220, maxWidth: "100%", aspectRatio: 4 / 3, alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <AppSymbol name="photo" size={22} color={inverse ? "rgba(255,255,255,0.78)" : theme.textTertiary} />
                  <Text style={{ color: inverse ? "rgba(255,255,255,0.78)" : theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
                    图片附件
                  </Text>
                </View>
              )}
            </View>
          );
        }

        return block.text ? (
          <MarkdownContent
            key={`text-${index}`}
            text={block.text}
            theme={theme}
            inverse={inverse}
            monospace={monospace}
            onOpenFile={onOpenFile}
          />
        ) : null;
      })}
    </View>
  );
}

function UserMessageContent({
  blocks,
  fallbackText,
  theme,
  inverse = false,
}: {
  blocks?: AgentContentBlock[];
  fallbackText?: string;
  theme: Theme;
  inverse?: boolean;
}) {
  const normalized = blocks?.length
    ? blocks
    : fallbackText
      ? [{ type: "text" as const, text: fallbackText }]
      : [];

  return (
    <View style={{ gap: 8 }}>
      {normalized.map((block, index) => {
        if (block.type === "image") {
          const imageUri = imageUriFromValue(block.data);
          return (
            <View
              key={`image-${index}`}
              style={{
                borderRadius: 10,
                borderCurve: "continuous",
                overflow: "hidden",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: inverse ? "rgba(255,255,255,0.30)" : theme.separator,
                backgroundColor: inverse ? "rgba(255,255,255,0.14)" : theme.bgInput,
              }}
            >
              {imageUri ? (
                <Image
                  source={{ uri: imageUri }}
                  contentFit="cover"
                  transition={120}
                  style={{ width: 260, maxWidth: "100%", aspectRatio: 4 / 3 }}
                />
              ) : (
                <View style={{ width: 220, maxWidth: "100%", aspectRatio: 4 / 3, alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <AppSymbol name="photo" size={22} color={inverse ? "rgba(255,255,255,0.78)" : theme.textTertiary} />
                  <Text style={{ color: inverse ? "rgba(255,255,255,0.78)" : theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
                    图片附件
                  </Text>
                </View>
              )}
            </View>
          );
        }

        return block.text ? (
          <Text
            key={`text-${index}`}
            selectable
            style={{
              color: inverse ? "#fff" : theme.text,
              fontSize: 14,
              lineHeight: 21,
              fontWeight: "500",
            }}
          >
            {block.text.trim()}
          </Text>
        ) : null;
      })}
    </View>
  );
}

function MarkdownContent({
  text,
  theme,
  inverse = false,
  monospace = false,
  onOpenFile,
}: {
  text: string;
  theme: Theme;
  inverse?: boolean;
  monospace?: boolean;
  onOpenFile?: (path: string, options?: OpenFileReferenceOptions) => void;
}) {
  const color = inverse ? "#fff" : theme.text;
  const secondaryColor = inverse ? "rgba(255,255,255,0.82)" : theme.textSecondary;
  const markdownStyle = useMemo(() => ({
    body: {
      color,
      fontFamily: !inverse && monospace ? MONO_FONT : undefined,
      fontSize: inverse ? 14 : 13,
      lineHeight: inverse ? 21 : 20,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 8,
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "flex-start" as const,
      width: "auto" as const,
      minWidth: 0,
    },
    heading1: {
      color,
      fontFamily: !inverse && monospace ? MONO_FONT : undefined,
      fontSize: inverse ? 18 : 16,
      lineHeight: inverse ? 25 : 23,
      fontWeight: "800" as const,
      marginTop: 6,
      marginBottom: 8,
    },
    heading2: {
      color,
      fontFamily: !inverse && monospace ? MONO_FONT : undefined,
      fontSize: inverse ? 16 : 15,
      lineHeight: inverse ? 23 : 22,
      fontWeight: "800" as const,
      marginTop: 6,
      marginBottom: 7,
    },
    heading3: {
      color,
      fontFamily: !inverse && monospace ? MONO_FONT : undefined,
      fontSize: 14,
      lineHeight: 21,
      fontWeight: "800" as const,
      marginTop: 4,
      marginBottom: 6,
    },
    heading4: {
      color,
      fontSize: 14,
      lineHeight: 21,
      fontWeight: "800" as const,
      marginTop: 4,
      marginBottom: 5,
    },
    strong: {
      color,
      fontWeight: "800" as const,
    },
    em: {
      color,
      fontStyle: "italic" as const,
    },
    s: {
      color: secondaryColor,
      textDecorationLine: "line-through" as const,
    },
    link: {
      color: inverse ? "#fff" : theme.accent,
      textDecorationLine: "underline" as const,
    },
    blockquote: {
      backgroundColor: "transparent",
      borderLeftColor: inverse ? "rgba(255,255,255,0.4)" : theme.separator,
      borderLeftWidth: 3,
      paddingLeft: 10,
      marginLeft: 0,
      marginBottom: 8,
    },
    bullet_list: {
      marginTop: 2,
      marginBottom: 8,
    },
    ordered_list: {
      marginTop: 2,
      marginBottom: 8,
    },
    list_item: {
      marginBottom: 4,
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
    },
    bullet_list_icon: {
      color: secondaryColor,
      marginLeft: 0,
      marginRight: 8,
    },
    ordered_list_icon: {
      color: secondaryColor,
      marginLeft: 0,
      marginRight: 8,
      minWidth: 22,
      textAlign: "right" as const,
    },
    bullet_list_content: {
      flex: 1,
      minWidth: 0,
    },
    ordered_list_content: {
      flex: 1,
      minWidth: 0,
    },
    code_inline: {
      color,
      backgroundColor: inverse ? "rgba(255,255,255,0.18)" : theme.bgInput,
      borderWidth: 0,
      borderRadius: 4,
      paddingHorizontal: 3,
      paddingVertical: 1,
      fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
      fontSize: inverse ? 13 : 12,
      lineHeight: inverse ? 18 : 17,
    },
    fence: {
      backgroundColor: "transparent",
    },
    code_block: {
      backgroundColor: "transparent",
    },
    table: {
      borderColor: theme.separator,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 8,
      overflow: "hidden" as const,
      marginBottom: 8,
    },
    th: {
      backgroundColor: inverse ? "rgba(255,255,255,0.16)" : theme.bgInput,
      borderColor: theme.separator,
      padding: 8,
    },
    tr: {
      borderColor: theme.separator,
    },
    td: {
      borderColor: theme.separator,
      padding: 8,
    },
    hr: {
      backgroundColor: inverse ? "rgba(255,255,255,0.28)" : theme.separator,
      height: StyleSheet.hairlineWidth,
      marginVertical: 8,
    },
  }), [color, inverse, monospace, secondaryColor, theme]);
  const rules = useMemo(() => ({
    paragraph: (node: any, children: React.ReactNode, parent: unknown) => {
      const inList = markdownHasParent(parent, "list_item");
      return (
        <View
          key={node.key}
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "flex-start",
            flexShrink: 1,
            minWidth: 0,
            marginTop: 0,
            marginBottom: inList ? 2 : 8,
          }}
        >
          {children}
        </View>
      );
    },
    list_item: (node: any, children: React.ReactNode, parent: unknown) => {
      const ordered = markdownHasParent(parent, "ordered_list");
      const marker = ordered ? markdownOrderedListIndex(node, parent) : "•";
      return (
        <View
          key={node.key}
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            width: "100%",
            marginBottom: 5,
          }}
        >
          <Text
            accessible={false}
            style={{
              color: secondaryColor,
              width: ordered ? 24 : 14,
              marginRight: ordered ? 9 : 8,
              textAlign: ordered ? "right" : "center",
              fontSize: inverse ? 14 : 13,
              lineHeight: inverse ? 21 : 20,
              fontWeight: "700",
            }}
          >
            {marker}
          </Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            {children}
          </View>
        </View>
      );
    },
    code_inline: (node: any) => (
      <Text
        key={node.key}
        style={{
          color,
          backgroundColor: inverse ? "rgba(255,255,255,0.18)" : theme.bgInput,
          borderRadius: 4,
          paddingHorizontal: 3,
          paddingVertical: 1,
          fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
          fontSize: inverse ? 13 : 12,
          lineHeight: inverse ? 18 : 17,
        }}
      >
        {node.content}
      </Text>
    ),
    image: (node: any) => {
      const source = imageUriFromValue(
        node.attributes?.src ?? node.attrs?.src ?? node.src ?? node.content,
      );
      if (!source) return null;
      return (
        <View
          key={node.key}
          style={{
            marginBottom: 8,
            borderRadius: 12,
            borderCurve: "continuous",
            overflow: "hidden",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: inverse ? "rgba(255,255,255,0.28)" : theme.separator,
            backgroundColor: inverse ? "rgba(255,255,255,0.12)" : theme.bgInput,
          }}
        >
          <Image
            source={{ uri: source }}
            contentFit="cover"
            transition={120}
            style={{ width: 260, maxWidth: "100%", aspectRatio: 4 / 3 }}
          />
        </View>
      );
    },
    fence: (node: any) => (
      <View key={node.key} style={{ marginTop: 3, marginBottom: 13 }}>
        <CodeBlock
          label={node.sourceInfo || "代码"}
          code={node.content ?? ""}
          theme={theme}
        />
      </View>
    ),
    code_block: (node: any) => (
      <View key={node.key} style={{ marginTop: 3, marginBottom: 13 }}>
        <CodeBlock
          label="代码"
          code={node.content ?? ""}
          theme={theme}
        />
      </View>
    ),
  }), [color, inverse, secondaryColor, theme]);
  return (
    <View style={{ width: "100%" }}>
      <Markdown
        mergeStyle={false}
        style={markdownStyle}
        rules={rules}
        onLinkPress={(url) => {
          const filePath = normalizeFileReference(url);
          if (filePath && onOpenFile) {
            onOpenFile(filePath, { autoRead: true });
            return false;
          }
          if (!/^https?:\/\//i.test(url)) return false;
          Linking.openURL(url).catch(() => {});
          return false;
        }}
      >
        {text}
      </Markdown>
    </View>
  );
}

const FileChangeCard = memo(function FileChangeCard({
  tool,
  theme,
  fileChange,
  onOpenFile,
}: {
  tool: AgentToolCall;
  theme: Theme;
  fileChange?: AgentFileChange;
  onOpenFile?: (path: string, options?: OpenFileReferenceOptions) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const input = tool.input?.trim();
  const output = tool.output?.trim();
  const patchText = useMemo(() => extractFencedDiff(fileChange?.diff ?? output), [fileChange?.diff, output]);
  const hasDiff = looksLikeDiff(patchText);
  const diffLineCount = patchText ? patchText.split("\n").length : 0;
  const structuredEntries = fileChange?.entries?.filter((entry) => entry.path?.trim()) ?? [];
  const patchChunks = useMemo(() => splitPatchIntoFileChunks(patchText), [patchText]);
  const inputEntries = useMemo(() => fileEntriesFromToolInput(input), [input]);
  const entries = useMemo(() => {
    if (structuredEntries.length > 0) {
      return structuredEntries.map((entry) => ({
        path: entry.path,
        added: entry.added ?? 0,
        removed: entry.removed ?? 0,
        kind: entry.kind,
        patch: patchChunks.get(entry.path) ?? patchChunks.get(shortPath(entry.path)),
      }));
    }
    if (inputEntries.length > 0) return inputEntries;
    return patchText ? diffEntries(patchText, input).map((entry) => ({
      ...entry,
      patch: patchChunks.get(entry.path) ?? patchChunks.get(shortPath(entry.path)),
    })) : diffEntries("", input);
  }, [input, inputEntries, patchChunks, patchText, structuredEntries]);
  const stats = useMemo(() => {
    if (structuredEntries.length > 0) {
      return {
        files: structuredEntries.map((entry) => entry.path),
        added: structuredEntries.reduce((sum, entry) => sum + (entry.added ?? 0), 0),
        removed: structuredEntries.reduce((sum, entry) => sum + (entry.removed ?? 0), 0),
      };
    }
    return hasDiff && patchText ? diffStats(patchText, input) : null;
  }, [hasDiff, input, patchText, structuredEntries]);
  const meta = toolStatusMeta(tool.status, theme);
  const canCollapse = Boolean(entries.length > 0 || output || input);
  const hasDetails = Boolean(output || input || patchText || entries.some((entry) => entry.patch));
  const title = entries.length > 0 ? `已编辑 ${entries.length} 个文件` : "文件修改";

  return (
    <View
      style={{
        borderRadius: 12,
        borderCurve: "continuous",
        backgroundColor: timelineMaterial(theme),
        overflow: "hidden",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: subtleDivider(theme),
      }}
    >
      <Pressable
        onPress={() => canCollapse && setExpanded((value) => !value)}
        disabled={!canCollapse}
        style={({ pressed }) => ({
          minHeight: 46,
          paddingHorizontal: 12,
          paddingTop: 7,
          paddingBottom: expanded && entries.length > 0 ? 7 : 9,
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          backgroundColor: pressed ? timelinePressedSurface(theme) : "transparent",
        })}
      >
        <AppSymbol name="doc.badge.plus" size={16} color={theme.textSecondary} />
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 7, flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.textSecondary, fontSize: 13, fontWeight: "700" }} numberOfLines={1}>
            {title}
          </Text>
          {stats && (stats.added > 0 || stats.removed > 0) ? (
            <Text style={{ fontSize: 12, fontFamily: MONO_FONT, fontWeight: "700" }} numberOfLines={1}>
              <Text style={{ color: theme.success }}>+{stats.added}</Text>
              <Text style={{ color: theme.textTertiary }}> </Text>
              <Text style={{ color: theme.error }}>-{stats.removed}</Text>
            </Text>
          ) : null}
        </View>
        {!stats && meta ? (
          <Text style={{ color: meta.color, fontSize: 12, fontWeight: "600" }}>{meta.label}</Text>
        ) : null}
        {canCollapse ? <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={12} color={theme.textTertiary} /> : null}
      </Pressable>

      {entries.length > 0 && expanded ? (
        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: subtleDivider(theme) }}>
          {entries.slice(0, expanded ? entries.length : 4).map((entry, index) => {
            const entryDiff = entry.patch ?? (entries.length === 1 ? patchText : undefined);
            return (
              <Pressable
                key={`${entry.path}-${index}`}
                disabled={!onOpenFile}
                onPress={() => onOpenFile?.(entry.path, entryDiff ? { diff: entryDiff, title: shortPath(entry.path) } : undefined)}
                style={{
                  minHeight: 38,
                  paddingHorizontal: 12,
                  paddingVertical: 9,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                  borderTopColor: subtleDivider(theme),
                }}
              >
                <Text
                  selectable
                  style={{ flex: 1, color: onOpenFile ? theme.accent : theme.text, fontSize: 13, fontWeight: onOpenFile ? "700" : "400" }}
                  numberOfLines={1}
                >
                  {shortPath(entry.path)}
                </Text>
                {onOpenFile ? <AppSymbol name="doc.text.magnifyingglass" size={13} color={theme.textTertiary} /> : null}
                {entry.kind ? (
                  <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>
                    {entryKindLabel(entry.kind)}
                  </Text>
                ) : null}
                {entry.added > 0 || entry.removed > 0 ? (
                  <Text style={{ color: theme.textTertiary, fontSize: 12, fontFamily: MONO_FONT, fontWeight: "700" }}>
                    <Text style={{ color: theme.success }}>+{entry.added}</Text>
                    <Text> </Text>
                    <Text style={{ color: theme.error }}>-{entry.removed}</Text>
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
          {!expanded && entries.length > 4 ? (
            <Text style={{ paddingHorizontal: 12, paddingBottom: 9, color: theme.textTertiary, fontSize: 12 }}>
              再显示 {entries.length - 4} 个文件
            </Text>
          ) : null}
        </View>
      ) : null}

      {hasDiff && patchText && showDetails ? (
        <View style={{ padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: subtleDivider(theme), gap: 10 }}>
          {entries.some((entry) => entry.patch) ? (
            entries.map((entry, index) => entry.patch ? (
              <View key={`patch-${entry.path}-${index}`} style={{ gap: 6 }}>
                <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "800" }} numberOfLines={1}>
                  {shortPath(entry.path)}
                </Text>
                <DiffBlock diff={entry.patch} theme={theme} expanded={entries.length <= 2} />
              </View>
            ) : null)
          ) : (
            <DiffBlock diff={patchText} theme={theme} expanded />
          )}
        </View>
      ) : !hasDiff && output && showDetails ? (
        <View style={{ gap: 8, padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: subtleDivider(theme) }}>
          <Text style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }}>
            这条历史事件没有携带 diff。升级后的 CLI 会优先展示补丁内容；旧记录只能显示工具返回摘要。
          </Text>
          <CodeBlock label="修改摘要" code={output} theme={theme} maxLines={6} />
        </View>
      ) : !output && input && showDetails ? (
        <View style={{ padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: subtleDivider(theme) }}>
          <CodeBlock label="修改文件" code={input} theme={theme} maxLines={6} />
        </View>
      ) : null}

      {hasDetails ? (
        <Pressable
          onPress={() => setShowDetails((value) => !value)}
          hitSlop={8}
          style={({ pressed }) => ({
            minHeight: 38,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: subtleDivider(theme),
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: pressed ? timelinePressedSurface(theme) : "transparent",
          })}
        >
          <Text style={{ color: theme.accent, fontSize: 12, fontWeight: "800" }}>
            {showDetails
              ? hasDiff ? "收起 diff" : "收起详情"
              : hasDiff ? `查看 diff${diffLineCount > 0 ? `（${diffLineCount} 行）` : ""}` : "查看详情"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const ToolCard = memo(function ToolCard({
  tool,
  theme,
  onOpenFile,
}: {
  tool: AgentToolCall;
  theme: Theme;
  onOpenFile?: (path: string, options?: OpenFileReferenceOptions) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (isFileToolName(tool.name)) return <FileChangeCard tool={tool} theme={theme} onOpenFile={onOpenFile} />;
  const input = tool.input?.trim();
  const output = tool.output?.trim();
  const meta = toolStatusMeta(tool.status, theme);
  const language = commandLanguage(tool.name);
  const canExpand = Boolean(input || output);
  const isCommand = tool.name.includes("命令");
  const commandSummary = isCommand && input ? humanizeCommand(input, tool.status === "running") : null;
  const presentation = commandSummary ? null : humanizeToolCall(tool);
  const title = commandSummary ? commandSummary.verb : presentation?.title ?? tool.name;
  const subtitle = commandSummary ? commandSummary.target : (presentation?.subtitle ?? input ?? output ?? "");
  const icon = commandSummary ? "terminal.fill" : presentation?.icon ?? "terminal.fill";
  const statusLabel = meta?.label;
  const statusColor = tool.status === "failed" ? theme.error : theme.textTertiary;

  return (
    <View
      style={{
        alignSelf: "stretch",
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: subtleDivider(theme),
        marginLeft: 3,
        paddingLeft: 10,
      }}
    >
      <Pressable
        onPress={() => canExpand && setExpanded((value) => !value)}
        disabled={!canExpand}
        style={({ pressed }) => ({
          minHeight: 36,
          borderRadius: 9,
          borderCurve: "continuous",
          paddingHorizontal: 6,
          paddingVertical: 6,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: pressed ? timelinePressedSurface(theme) : "transparent",
        })}
      >
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: conversationInset(theme),
          }}
        >
          <AppSymbol name={icon} size={12} color={theme.textTertiary} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text selectable style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "800" }} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text selectable style={{ color: remodexMuted(theme), fontSize: 11, lineHeight: 15 }} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {statusLabel ? (
          <Text style={{ color: statusColor, fontSize: 11, fontWeight: "800" }} numberOfLines={1}>
            {statusLabel}
          </Text>
        ) : null}
        {canExpand ? <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={10} color={theme.textTertiary} /> : null}
      </Pressable>
      {expanded ? (
        <View
          style={{
            gap: 8,
            marginTop: 4,
            marginRight: 2,
            marginBottom: 6,
            padding: 10,
            borderRadius: 10,
            borderCurve: "continuous",
            backgroundColor: theme.mode === "light" ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.035)",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: subtleDivider(theme),
          }}
        >
          {input ? <CodeBlock label={`输入 · ${language}`} code={input} theme={theme} maxLines={24} /> : null}
          {output ? <CodeBlock label={`输出 · ${language}`} code={output} theme={theme} maxLines={28} /> : null}
        </View>
      ) : null}
      {expanded && canExpand && (input?.length ?? 0) + (output?.length ?? 0) > 500 ? (
        <Pressable
          onPress={() => setExpanded((value) => !value)}
          hitSlop={8}
          style={{
            minHeight: expanded ? 34 : 0,
            alignItems: "center",
            justifyContent: "center",
            marginHorizontal: 10,
          }}
        >
          <Text style={{ color: theme.accent, fontSize: 12, fontWeight: "700" }}>
            收起详情
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

function toolActivityEntriesFromTimelineItem(item: AgentTimelineItem): ToolActivityEntry[] {
  const raw = item.metadata?.toolActivityEntries;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is ToolActivityEntry => {
    if (!entry || typeof entry !== "object") return false;
    const record = entry as Partial<ToolActivityEntry>;
    return typeof record.id === "string" &&
      typeof record.title === "string" &&
      typeof record.status === "string" &&
      typeof record.language === "string";
  });
}

function ToolActivityEntryRow({
  entry,
  theme,
}: {
  entry: ToolActivityEntry;
  theme: Theme;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = Boolean(entry.input || entry.output);
  const meta = toolStatusMeta(entry.status, theme);
  return (
    <View>
      <Pressable
        disabled={!canExpand}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => ({
          minHeight: 40,
          paddingHorizontal: 10,
          paddingVertical: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          backgroundColor: pressed ? timelinePressedSurface(theme) : "transparent",
        })}
      >
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 7,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: conversationInset(theme),
          }}
        >
          <AppSymbol name={entry.icon} size={12} color={theme.textTertiary} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "800" }} numberOfLines={1}>
            {entry.title}
          </Text>
          {entry.subtitle ? (
            <Text style={{ color: remodexMuted(theme), fontSize: 11, lineHeight: 15 }} numberOfLines={1}>
              {entry.subtitle}
            </Text>
          ) : null}
        </View>
        {meta ? (
          <Text style={{ color: entry.status === "failed" ? theme.error : theme.textTertiary, fontSize: 11, fontWeight: "800" }} numberOfLines={1}>
            {meta.label}
          </Text>
        ) : null}
        {canExpand ? <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={10} color={theme.textTertiary} /> : null}
      </Pressable>
      {expanded ? (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10, gap: 8 }}>
          {entry.input ? <CodeBlock label={`输入 · ${entry.language}`} code={entry.input} theme={theme} maxLines={16} /> : null}
          {entry.output ? <CodeBlock label={`输出 · ${entry.language}`} code={entry.output} theme={theme} maxLines={18} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function ToolActivityGroupCard({
  item,
  theme,
}: {
  item: AgentTimelineItem;
  theme: Theme;
}) {
  const [expanded, setExpanded] = useState(false);
  const entries = toolActivityEntriesFromTimelineItem(item);
  const meta = toolStatusMeta(item.toolCall?.status ?? "completed", theme);
  return (
    <View
      style={{
        alignSelf: "stretch",
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: subtleDivider(theme),
        marginLeft: 3,
        paddingLeft: 10,
      }}
    >
      <Pressable
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => ({
          minHeight: 42,
          borderRadius: 9,
          borderCurve: "continuous",
          paddingHorizontal: 6,
          paddingVertical: 7,
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          backgroundColor: pressed ? timelinePressedSurface(theme) : "transparent",
        })}
      >
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 7,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: conversationInset(theme),
          }}
        >
          <AppSymbol name="terminal.fill" size={12} color={theme.textTertiary} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ color: remodexMuted(theme), fontSize: 13, fontWeight: "800" }} numberOfLines={1}>
            {item.text || summarizeToolActivity(entries)}
          </Text>
          <Text style={{ color: theme.textTertiary, fontSize: 11, lineHeight: 15 }} numberOfLines={1}>
            {entries.slice(0, 3).map((entry) => entry.subtitle || entry.title).filter(Boolean).join(" · ")}
          </Text>
        </View>
        {meta ? (
          <Text style={{ color: item.toolCall?.status === "failed" ? theme.error : theme.textTertiary, fontSize: 11, fontWeight: "800" }}>
            {meta.label}
          </Text>
        ) : null}
        <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={11} color={theme.textTertiary} />
      </Pressable>
      {expanded ? (
        <View
          style={{
            marginTop: 4,
            marginRight: 2,
            marginBottom: 6,
            borderRadius: 12,
            borderCurve: "continuous",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: subtleDivider(theme),
            backgroundColor: theme.mode === "light" ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.035)",
            overflow: "hidden",
          }}
        >
          {entries.map((entry, index) => (
            <View
              key={`${entry.id}-${index}`}
              style={{
                borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                borderTopColor: subtleDivider(theme),
              }}
            >
              <ToolActivityEntryRow entry={entry} theme={theme} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SystemActivityCard({
  icon,
  title,
  text,
  theme,
  running,
}: {
  icon: string;
  title: string;
  text?: string;
  theme: Theme;
  running?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const display = useDisplayWindow(text, running ? 16_000 : 8_000);
  const canExpand = Boolean(text && text.length > 120);
  return (
    <Pressable
      onPress={() => canExpand && setExpanded((value) => !value)}
      disabled={!canExpand}
      style={{
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: subtleDivider(theme),
        marginLeft: 3,
        paddingLeft: 10,
        paddingRight: 6,
        paddingVertical: 5,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
      }}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: conversationInset(theme),
        }}
      >
        <AppSymbol name={icon} size={12} color={theme.textTertiary} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: remodexMuted(theme), fontSize: 11, fontWeight: "800" }} numberOfLines={1}>
            {title}
          </Text>
          {running ? <ActivityIndicator size="small" color={theme.textTertiary} /> : null}
        </View>
        {text ? (
          <Text
            selectable
            style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17, fontFamily: MONO_FONT }}
            numberOfLines={expanded ? undefined : 2}
          >
            {expanded ? display.text : text}
          </Text>
        ) : null}
        {expanded ? (
          <ExpandTextButton hiddenByteCount={display.hiddenByteCount} theme={theme} onPress={display.expand} />
        ) : null}
      </View>
      {canExpand ? <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={12} color={theme.textTertiary} /> : null}
    </Pressable>
  );
}

function SubagentCard({ action, theme, running }: { action: AgentSubagentAction; theme: Theme; running?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const rows = action.receiverThreadIds.length > 0
    ? action.receiverThreadIds
    : action.receiverAgents.map((agent) => agent.threadId);
  const uniqueRows = [...new Set(rows)];
  return (
    <View
      style={{
        borderRadius: 10,
        borderCurve: "continuous",
        backgroundColor: timelineSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.separator,
        padding: 12,
        gap: 9,
      }}
    >
      <Pressable onPress={() => setExpanded((value) => !value)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AppSymbol name="person.2.fill" size={15} color={theme.accent} />
        <Text style={{ flex: 1, color: theme.text, fontSize: 14, fontWeight: "800" }} numberOfLines={1}>
          {subagentTitle(action)}
        </Text>
        {running ? <ActivityIndicator size="small" color={theme.accent} /> : null}
        <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={12} color={theme.textTertiary} />
      </Pressable>
      {action.prompt ? (
        <Text selectable style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }} numberOfLines={expanded ? 4 : 1}>
          {action.prompt}
        </Text>
      ) : null}
      {expanded && uniqueRows.length > 0 ? (
        <View style={{ gap: 6 }}>
          {uniqueRows.map((threadId) => {
            const agent = action.receiverAgents.find((entry) => entry.threadId === threadId);
            const state = action.agentStates[threadId];
            const status = subagentStatusLabel(state?.status ?? action.status);
            return (
              <View key={threadId} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: status === "失败" ? theme.error : status === "完成" ? theme.success : theme.accent }} />
                <Text selectable style={{ flex: 1, color: theme.textSecondary, fontSize: 13 }} numberOfLines={1}>
                  {agent ? subagentDisplayName(agent, threadId) : threadId}
                </Text>
                {agent?.model ? (
                  <Text style={{ color: theme.textTertiary, fontSize: 11 }} numberOfLines={1}>
                    {agent.model}
                  </Text>
                ) : null}
                <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>
                  {status}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function StructuredInputCard({
  input,
  theme,
  submitted,
  submitting,
  error,
  onSubmit,
}: {
  input: AgentStructuredInput;
  theme: Theme;
  submitted?: boolean;
  submitting?: boolean;
  error?: string;
  onSubmit: (answers: Record<string, string[]>) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  const answers = useMemo(() => {
    const next: Record<string, string[]> = {};
    for (const question of input.questions) {
      const typedAnswer = typed[question.id]?.trim();
      const selectedAnswers = (selected[question.id] ?? [])
        .map((value) => value.trim())
        .filter(Boolean);
      const values = typedAnswer ? [...selectedAnswers, typedAnswer] : selectedAnswers;
      if (values.length > 0) next[question.id] = values;
    }
    return next;
  }, [input.questions, selected, typed]);

  const canSubmit = input.questions.length > 0 &&
    input.questions.every((question) => (answers[question.id] ?? []).length > 0) &&
    !submitted &&
    !submitting;

  const toggleOption = useCallback((questionId: string, optionId: string, limit?: number) => {
    setSelected((current) => {
      const max = Math.max(limit ?? 1, 1);
      const existing = current[questionId] ?? [];
      const hasValue = existing.includes(optionId);
      const nextValues = hasValue
        ? existing.filter((value) => value !== optionId)
        : max === 1
          ? [optionId]
          : existing.length < max
            ? [...existing, optionId]
            : existing;
      return { ...current, [questionId]: nextValues };
    });
  }, []);

  return (
    <View
      style={{
        borderRadius: 10,
        borderCurve: "continuous",
        backgroundColor: timelineSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.separator,
        padding: 12,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AppSymbol name="questionmark.circle.fill" size={15} color={theme.accent} />
        <Text style={{ color: theme.text, fontSize: 14, fontWeight: "800" }}>
          {submitted ? "已发送补充信息" : submitting ? "正在发送补充信息" : "Agent 需要补充信息"}
        </Text>
      </View>
      {input.questions.map((question) => (
        <View key={question.id} style={{ gap: 6 }}>
          {question.header ? (
            <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>
              {question.header}
            </Text>
          ) : null}
          <Text selectable style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
            {question.question}
          </Text>
          {question.options?.length ? (
            <View style={{ gap: 6 }}>
              {question.selectionLimit && question.selectionLimit > 1 ? (
                <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "700" }}>
                  最多选择 {question.selectionLimit} 项
                </Text>
              ) : null}
              {question.options.map((option) => {
                const isSelected = (selected[question.id] ?? []).includes(option.id);
                return (
                  <Pressable
                    key={option.id}
                    disabled={submitted || submitting}
                    onPress={() => toggleOption(question.id, option.id, question.selectionLimit)}
                    style={{
                      borderRadius: 10,
                      borderCurve: "continuous",
                      paddingHorizontal: 10,
                      paddingVertical: 9,
                      backgroundColor: isSelected
                        ? theme.accentLight
                        : theme.bgInput,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: isSelected
                        ? theme.accent
                        : theme.separator,
                      opacity: submitted || submitting ? 0.65 : 1,
                      gap: 3,
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text style={{ flex: 1, color: theme.textSecondary, fontSize: 12, fontWeight: "800" }}>
                        {option.label}
                      </Text>
                      {isSelected ? <AppSymbol name="checkmark.circle.fill" size={14} color={theme.accent} /> : null}
                    </View>
                    {option.description ? (
                      <Text style={{ color: theme.textTertiary, fontSize: 11, marginTop: 2 }}>
                        {option.description}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {question.options?.length && !question.isOther ? null : (
            <TextInput
              value={typed[question.id] ?? ""}
              onChangeText={(value) => setTyped((current) => ({ ...current, [question.id]: value }))}
              editable={!submitted && !submitting}
              secureTextEntry={question.isSecret}
              placeholder={question.isSecret ? "输入敏感信息" : "输入回答"}
              placeholderTextColor={theme.textTertiary}
              multiline={!question.isSecret}
              style={{
                minHeight: 42,
                borderRadius: 10,
                borderCurve: "continuous",
                paddingHorizontal: 10,
                paddingVertical: 9,
                color: theme.text,
                backgroundColor: theme.bgInput,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
                fontSize: 13,
              }}
            />
          )}
        </View>
      ))}
      {error ? (
        <Text style={{ color: theme.error, fontSize: 12, fontWeight: "700" }}>
          {error}
        </Text>
      ) : null}
      {!submitted ? (
        <Pressable
          disabled={!canSubmit}
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            onSubmit(answers);
          }}
          style={({ pressed }) => ({
            minHeight: 40,
            borderRadius: 10,
            borderCurve: "continuous",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: pressed ? theme.accentSecondary : theme.accent,
            opacity: canSubmit ? 1 : 0.45,
          })}
        >
          <Text style={{ color: "#fff", fontSize: 13, fontWeight: "800" }}>
            {submitting ? "发送中" : "发送回答"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function PermissionRequestCard({
  item,
  theme,
  onPermission,
  onOpenFile,
}: {
  item: AgentTimelineItem;
  theme: Theme;
  onPermission: (requestId: string, outcome: "allow" | "deny" | "cancelled", optionId?: string) => void;
  onOpenFile?: (path: string, options?: OpenFileReferenceOptions) => void;
}) {
  const outcome = item.metadata?.permissionOutcome;
  const permissionPending = item.metadata?.permissionPending === true;
  const permissionLive = item.metadata?.permissionLive === true;
  const permissionExpired = !outcome && !permissionPending && (
    item.metadata?.permissionExpired === true || !permissionLive
  );
  const selectedOptionId = item.metadata?.optionId;
  const permissionError = typeof item.metadata?.permissionError === "string"
    ? item.metadata.permissionError
    : undefined;
  const options = item.permission!.options.length > 0
    ? item.permission!.options
    : [
        { id: "deny", label: "拒绝", kind: "deny" as const },
        { id: "allow_once", label: "允许一次", kind: "allow" as const },
      ];
  const selectedLabel = options.find((option) => option.id === selectedOptionId)?.label ??
    (outcome === "allow" ? "已允许" : outcome === "deny" ? "已拒绝" : outcome === "cancelled" ? "已取消" : undefined);
  const statusLabel = outcome
    ? selectedLabel ?? "授权已处理"
    : permissionPending
      ? "发送中"
      : permissionExpired
        ? "已失效"
        : "等待处理";
  const statusColor = outcome === "deny" || outcome === "cancelled"
    ? theme.error
    : outcome === "allow"
      ? theme.success
      : permissionExpired
        ? theme.textTertiary
        : theme.warning;
  const toolName = item.permission!.toolName || "工具调用";

  return (
    <View
      style={{
        borderRadius: 10,
        borderCurve: "continuous",
        backgroundColor: timelineSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.separator,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          paddingHorizontal: 12,
          paddingVertical: 11,
          backgroundColor: "transparent",
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.separator,
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
        }}
      >
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: 13,
            backgroundColor: theme.accentLight,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <AppSymbol name="checkmark.shield" size={14} color={theme.warning} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.text, fontSize: 14, fontWeight: "800" }} numberOfLines={1}>
            需要授权 · {toolName}
          </Text>
          <Text style={{ color: statusColor, fontSize: 12, fontWeight: "700", marginTop: 2 }} numberOfLines={1}>
            {statusLabel}
          </Text>
        </View>
        {permissionPending ? <ActivityIndicator size="small" color={theme.warning} /> : null}
      </View>

      {item.permission!.context || item.permission!.toolInput || permissionError ? (
        <View style={{ padding: 12, gap: 9 }}>
          {item.permission!.context ? (
            <MarkdownContent text={item.permission!.context} theme={theme} onOpenFile={onOpenFile} />
          ) : null}
          {item.permission!.toolInput ? (
            <CodeBlock label="请求内容" code={item.permission!.toolInput} theme={theme} maxLines={8} />
          ) : null}
          {permissionError ? (
            <Text style={{ color: theme.error, fontSize: 12, lineHeight: 17, fontWeight: "700" }}>
              {permissionError}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View
        style={{
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.separator,
          gap: 3,
        }}
      >
        {options.map((option) => {
          const optionOutcome = option.kind === "allow" ? "allow" : option.kind === "deny" ? "deny" : "cancelled";
          const isAllow = option.kind === "allow";
          const isDeny = option.kind === "deny";
          const isElevated = isElevatedPermissionOption(option);
          const selected = Boolean(outcome) &&
            (selectedOptionId === option.id || (!selectedOptionId && outcome === optionOutcome));
          const inactive = Boolean(outcome) && !selected;
          const optionColor = selected
            ? theme.text
            : isAllow
              ? isElevated ? theme.warning : theme.accent
              : isDeny
                ? theme.error
                : theme.textSecondary;

          return (
            <Pressable
              key={option.id}
              disabled={permissionPending || permissionExpired || Boolean(outcome)}
              onPress={() => {
                if (isElevated) {
                  Alert.alert(
                    "确认高权限授权",
                    `“${option.label}”可能会扩大本次授权范围。确认继续吗？`,
                    [
                      { text: "取消", style: "cancel" },
                      {
                        text: "确认授权",
                        onPress: () => onPermission(item.permission!.requestId, optionOutcome, option.id),
                      },
                    ],
                  );
                  return;
                }
                onPermission(item.permission!.requestId, optionOutcome, option.id);
              }}
              style={({ pressed }) => ({
                minHeight: 36,
                borderRadius: 5,
                borderCurve: "continuous",
                paddingHorizontal: 8,
                paddingVertical: 8,
                borderLeftWidth: 3,
                borderLeftColor: selected ? theme.text : "transparent",
                backgroundColor: pressed ? theme.bgInput : "transparent",
                opacity: inactive || permissionPending || permissionExpired ? 0.45 : 1,
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
              })}
            >
              <AppSymbol
                name={selected ? "checkmark" : isAllow ? "checkmark.circle" : isDeny ? "xmark.circle" : "minus.circle"}
                size={14}
                color={optionColor}
              />
              <Text style={{ flex: 1, color: optionColor, fontSize: 13, fontWeight: selected ? "800" : "700" }} numberOfLines={2}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function StreamingPill({ theme }: { theme: Theme }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 4 }}>
      <ActivityIndicator size="small" color={theme.textTertiary} />
      <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>正在生成</Text>
    </View>
  );
}

function SlashCommandPanel({
  commands,
  query,
  theme,
  onSelect,
  onClose,
}: {
  commands: AgentCommandDescriptor[];
  query: string;
  theme: Theme;
  onSelect: (command: AgentCommandDescriptor) => void;
  onClose: () => void;
}) {
  const items = filteredCommands(commands, query);
  if (items.length === 0) {
    return (
      <View style={{ borderRadius: 12, borderCurve: "continuous", backgroundColor: timelineSurface(theme), borderWidth: StyleSheet.hairlineWidth, borderColor: theme.separator, padding: 12 }}>
        <Text style={{ color: theme.textTertiary, fontSize: 13, fontWeight: "700" }}>没有匹配的命令</Text>
      </View>
    );
  }
  return (
    <View style={{ borderRadius: 12, borderCurve: "continuous", backgroundColor: timelineSurface(theme), borderWidth: StyleSheet.hairlineWidth, borderColor: theme.separator, overflow: "hidden" }}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.separator, flexDirection: "row", alignItems: "center" }}>
        <Text style={{ flex: 1, color: theme.textSecondary, fontSize: 12, fontWeight: "800" }}>
          命令 · {items.length}
        </Text>
        <Pressable onPress={onClose} hitSlop={8}>
          <AppSymbol name="xmark" size={12} color={theme.textTertiary} />
        </Pressable>
      </View>
      <ScrollView
        style={{ maxHeight: 320 }}
        bounces={items.length > 5}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={items.length > 5}
      >
        {items.map((command, index) => {
          const disabled = Boolean(command.disabledReason);
          return (
            <Pressable
              key={command.id}
              disabled={disabled}
              onPress={() => onSelect(command)}
              style={({ pressed }) => ({
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderBottomWidth: index === items.length - 1 ? 0 : StyleSheet.hairlineWidth,
                borderBottomColor: theme.separator,
                backgroundColor: pressed ? theme.bgInput : "transparent",
                opacity: disabled ? 0.45 : 1,
                flexDirection: "row",
                gap: 9,
                alignItems: "flex-start",
              })}
            >
              <View style={{ width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: command.destructive ? theme.errorLight : theme.accentLight }}>
                <AppSymbol name={command.destructive ? "exclamationmark.triangle.fill" : "terminal.fill"} size={12} color={command.destructive ? theme.error : theme.accent} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                  <Text style={{ color: theme.text, fontSize: 14, fontWeight: "800" }} numberOfLines={1}>
                    {command.title}
                  </Text>
                  <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
                    {commandCategoryLabel(command)}
                  </Text>
                </View>
                <Text style={{ color: disabled ? theme.error : theme.textTertiary, fontSize: 12, lineHeight: 16, marginTop: 2 }} numberOfLines={2}>
                  {command.disabledReason || command.description || "发送给当前 Agent"}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function AssistantMessage({
  item,
  text,
  theme,
  onOpenFile,
}: {
  item: AgentTimelineItem;
  text: string;
  theme: Theme;
  onOpenFile?: (path: string, options?: OpenFileReferenceOptions) => void;
}) {
  const display = useDisplayWindow(text, timelineTextLimit(item, 32_000));
  const displayBlocks = useMemo(() => {
    if (!item.content?.length) return undefined;
    let replacedFirstText = false;
    return item.content.map((block) => {
      if (block.type !== "text" || replacedFirstText) return block;
      replacedFirstText = true;
      return { ...block, text: display.text };
    });
  }, [display.text, item.content]);
  const hasBody = Boolean(text || item.content?.length);
  return (
    <View
      style={{
        alignSelf: "stretch",
        paddingVertical: 4,
        paddingRight: 2,
      }}
    >
      {hasBody ? (
        <View
          style={{
            borderLeftWidth: StyleSheet.hairlineWidth,
            borderLeftColor: subtleDivider(theme),
            paddingLeft: 11,
            gap: item.isStreaming ? 6 : 0,
          }}
        >
          {item.isStreaming ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingBottom: 1 }}>
              <ActivityIndicator size="small" color={theme.accent} />
              <Text style={{ color: theme.accent, fontSize: 11, fontWeight: "800" }}>生成中</Text>
            </View>
          ) : null}
          {item.isStreaming && !item.content?.some((block) => block.type === "image") ? (
            <Text
              selectable
              style={{
                color: theme.text,
                fontSize: 14,
                lineHeight: 21,
              }}
            >
              {display.text}
            </Text>
          ) : (
            <MessageContent blocks={displayBlocks ?? item.content} fallbackText={display.text} theme={theme} onOpenFile={onOpenFile} />
          )}
          <ExpandTextButton hiddenByteCount={display.hiddenByteCount} theme={theme} onPress={display.expand} />
        </View>
      ) : null}
      {!hasBody && item.isStreaming ? <StreamingPill theme={theme} /> : null}
    </View>
  );
}

function AgentTimelineBlock({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ marginLeft: 0, marginRight: 0 }}>
      {children}
    </View>
  );
}

function TimelineItemView({
  item,
  theme,
  onPermission,
  onStructuredInput,
  onOpenFile,
}: {
  item: AgentTimelineItem;
  theme: Theme;
  onPermission: (requestId: string, outcome: "allow" | "deny" | "cancelled", optionId?: string) => void;
  onStructuredInput: (requestId: string, answers: Record<string, string[]>) => void;
  onOpenFile?: (path: string, options?: OpenFileReferenceOptions) => void;
}) {
  if (item.kind === "subagent_action" && item.subagent) {
    return (
      <AgentTimelineBlock>
        <SubagentCard action={item.subagent} theme={theme} running={item.isStreaming} />
      </AgentTimelineBlock>
    );
  }

  if (item.kind === "user_input_prompt" && item.structuredInput) {
    return (
      <AgentTimelineBlock>
        <StructuredInputCard
          input={item.structuredInput}
          theme={theme}
          submitted={item.metadata?.inputSubmitted === true}
          submitting={item.metadata?.inputSubmitting === true}
          error={typeof item.metadata?.inputError === "string" ? item.metadata.inputError : undefined}
          onSubmit={(answers) => onStructuredInput(item.structuredInput!.requestId, answers)}
        />
      </AgentTimelineBlock>
    );
  }

  if (item.kind === "thinking") {
    if (isEmptyActivityText(item.text)) return null;
    return (
      <SystemActivityCard
        icon="brain.head.profile"
        title={item.isStreaming ? "正在思考" : "思考"}
        text={item.text}
        theme={theme}
        running={item.isStreaming}
      />
    );
  }

  if (item.kind === "tool_activity") {
    const entries = toolActivityEntriesFromTimelineItem(item);
    if (entries.length > 0) {
      return (
        <AgentTimelineBlock>
          <ToolActivityGroupCard item={item} theme={theme} />
        </AgentTimelineBlock>
      );
    }
  }

  if (item.kind === "review" || item.kind === "context_compaction" || item.kind === "tool_activity") {
    const title =
      item.kind === "review"
        ? "审查"
        : item.kind === "context_compaction"
          ? "上下文压缩"
          : "工具活动";
    return (
      <SystemActivityCard
        icon={item.kind === "review" ? "doc.text.magnifyingglass" : item.kind === "context_compaction" ? "square.stack.3d.up" : "terminal.fill"}
        title={title}
        text={item.text}
        theme={theme}
        running={item.isStreaming}
      />
    );
  }

  if (item.type === "status") {
    return item.text ? (
      <SystemActivityCard
        icon={item.status === "error" ? "exclamationmark.triangle.fill" : "info.circle"}
        title={item.status === "error" ? "状态异常" : "状态"}
        text={item.text}
        theme={theme}
        running={item.isStreaming}
      />
    ) : null;
  }

  if (item.type === "message") {
    const isUser = item.role === "user";
    const text = item.text || (item.content ?? []).map((block) => block.text ?? "").join("\n");
    if (item.role === "system") {
      return text ? (
        <View style={{ paddingVertical: 2 }}>
          <Text selectable style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }}>
            {text}
          </Text>
        </View>
      ) : null;
    }
    if (!isUser) {
      return <AssistantMessage item={item} text={text} theme={theme} onOpenFile={onOpenFile} />;
    }
    return (
      <View
        style={{
          alignSelf: "flex-end",
          maxWidth: "88%",
          minWidth: 42,
          borderRadius: 18,
          borderCurve: "continuous",
          backgroundColor: theme.mode === "light" ? "#ececef" : "rgba(255,255,255,0.08)",
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: subtleDivider(theme),
          paddingVertical: 9,
          paddingHorizontal: 13,
          gap: 6,
        }}
      >
        {text || item.content?.length ? (
          <UserMessageContent blocks={item.content} fallbackText={text} theme={theme} />
        ) : item.isStreaming ? (
          <StreamingPill theme={theme} />
        ) : null}
      </View>
    );
  }

  if (item.type === "tool_call" && item.toolCall && !item.commandExecution && !item.fileChange) {
    return (
      <AgentTimelineBlock>
        <ToolCard tool={item.toolCall} theme={theme} onOpenFile={onOpenFile} />
      </AgentTimelineBlock>
    );
  }

  if (item.commandExecution) {
    return (
      <AgentTimelineBlock>
        <ToolCard
          tool={{
            id: item.itemId ?? item.id,
            name: "命令",
            input: [
              item.commandExecution.command,
              item.commandExecution.cwd ? `cwd: ${item.commandExecution.cwd}` : undefined,
            ].filter(Boolean).join("\n\n"),
            output: item.commandExecution.output,
            createdAt: item.createdAt,
            status: item.commandExecution.status ?? "running",
          }}
          theme={theme}
          onOpenFile={onOpenFile}
        />
      </AgentTimelineBlock>
    );
  }

  if (item.fileChange) {
    const summary = item.fileChange.entries
      .map((entry) => [entry.kind, entry.path].filter(Boolean).join(" ") || entry.path)
      .join("\n") || item.fileChange.summary;
    return (
      <AgentTimelineBlock>
        <FileChangeCard
          tool={{
            id: item.itemId ?? item.id,
            name: "文件修改",
            input: summary,
            output: item.fileChange.diff ?? item.fileChange.summary,
            createdAt: item.createdAt,
            status: item.fileChange.status ?? "running",
          }}
          theme={theme}
          fileChange={item.fileChange}
          onOpenFile={onOpenFile}
        />
      </AgentTimelineBlock>
    );
  }

  if (item.type === "plan" && item.plan?.length) {
    return (
      <AgentTimelineBlock>
        <View style={{ borderRadius: 12, borderCurve: "continuous", backgroundColor: timelineMaterial(theme), borderWidth: StyleSheet.hairlineWidth, borderColor: subtleDivider(theme), padding: 12, gap: 9 }}>
          <Text style={{ color: theme.textSecondary, fontSize: 13, fontWeight: "700" }}>执行计划</Text>
          {item.plan.map((step) => (
            <View key={step.id} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              <AppSymbol
                name={step.status === "completed" ? "checkmark.circle.fill" : step.status === "in_progress" ? "clock" : "circle"}
                size={14}
                color={step.status === "completed" ? theme.success : step.status === "in_progress" ? theme.accent : theme.textTertiary}
              />
              <Text selectable style={{ flex: 1, color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
                {step.text}
              </Text>
            </View>
          ))}
        </View>
      </AgentTimelineBlock>
    );
  }

  if (item.type === "permission" && item.permission) {
    return (
      <AgentTimelineBlock>
        <PermissionRequestCard item={item} theme={theme} onPermission={onPermission} onOpenFile={onOpenFile} />
      </AgentTimelineBlock>
    );
  }

  if (item.type === "error") {
    return (
      <AgentTimelineBlock>
        <View style={{ borderRadius: 10, borderCurve: "continuous", backgroundColor: theme.errorLight, padding: 12 }}>
          <Text selectable style={{ color: theme.error, fontSize: 13, lineHeight: 18 }}>
            {item.error || item.text || "Agent 出错了"}
          </Text>
        </View>
      </AgentTimelineBlock>
    );
  }

  return null;
}

const TimelineItemRow = memo(function TimelineItemRow({
  item,
  previousTurnId,
  theme,
  onPermission,
  onStructuredInput,
  onOpenFile,
}: {
  item: AgentTimelineItem;
  previousTurnId?: string;
  theme: Theme;
  onPermission: (requestId: string, outcome: "allow" | "deny" | "cancelled", optionId?: string) => void;
  onStructuredInput: (requestId: string, answers: Record<string, string[]>) => void;
  onOpenFile?: (path: string, options?: OpenFileReferenceOptions) => void;
}) {
  const startsTurn = Boolean(item.turnId && previousTurnId && item.turnId !== previousTurnId);
  return (
    <View style={{ gap: 8 }}>
      {startsTurn ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
          <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.separator }} />
          <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>新一轮</Text>
          <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.separator }} />
        </View>
      ) : null}
      <TimelineItemView
        item={item}
        theme={theme}
        onOpenFile={onOpenFile}
        onPermission={onPermission}
        onStructuredInput={onStructuredInput}
      />
    </View>
  );
}, (prev, next) =>
  prev.item === next.item &&
  prev.previousTurnId === next.previousTurnId &&
  prev.theme === next.theme &&
  prev.onPermission === next.onPermission &&
  prev.onStructuredInput === next.onStructuredInput &&
  prev.onOpenFile === next.onOpenFile
);

const HighlightedCodeLine = memo(function HighlightedCodeLine({
  line,
  lineNumber,
  language,
  theme,
}: {
  line: string;
  lineNumber: number;
  language: string;
  theme: Theme;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", minHeight: 19 }}>
      <Text
        style={{
          width: 42,
          color: theme.textTertiary,
          fontSize: 11,
          lineHeight: 19,
          fontFamily: MONO_FONT,
          textAlign: "right",
          paddingRight: 10,
        }}
      >
        {lineNumber}
      </Text>
      <Text selectable style={{ flex: 1, color: theme.textSecondary, fontSize: 12, lineHeight: 19, fontFamily: MONO_FONT }}>
        {syntaxTokens(line, language, theme).map((token, index) => (
          <Text key={`${lineNumber}:${index}`} style={{ color: token.color, fontWeight: token.fontWeight }}>
            {token.text}
          </Text>
        ))}
      </Text>
    </View>
  );
});

function FilePreviewCodeContent({
  previewLoading,
  preview,
  language,
  theme,
  height,
  referenceOnlyPath,
  onReadReference,
}: {
  previewLoading: boolean;
  preview: AgentFileReadResult | null;
  language: string;
  theme: Theme;
  height?: number;
  referenceOnlyPath?: string | null;
  onReadReference?: (path: string) => void;
}) {
  const lines = useMemo(() => preview?.content.split("\n") ?? [], [preview?.content]);
  const renderLine = useCallback(({ item, index }: { item: string; index: number }) => (
    <HighlightedCodeLine
      line={item}
      lineNumber={index + 1}
      language={language}
      theme={theme}
    />
  ), [language, theme]);

  if (previewLoading) {
    return (
      <View style={{ paddingVertical: 28, alignItems: "center" }}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  if (preview?.error) {
    return (
      <View style={{ padding: 12 }}>
        <Text selectable style={{ color: theme.error, fontSize: 12, lineHeight: 17 }}>
          {preview.error}
        </Text>
      </View>
    );
  }

  if (!preview) {
    if (referenceOnlyPath) {
      return (
        <View style={{ padding: 12, gap: 10 }}>
          <Text selectable style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, fontFamily: MONO_FONT }}>
            {referenceOnlyPath}
          </Text>
          <Text style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }}>
            这条链接来自消息记录，先作为文件引用打开。需要查看当前主机文件内容时再读取。
          </Text>
          {onReadReference ? (
            <Pressable
              onPress={() => onReadReference(referenceOnlyPath)}
              style={({ pressed }) => ({
                alignSelf: "flex-start",
                borderRadius: 999,
                paddingHorizontal: 10,
                paddingVertical: 7,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                backgroundColor: pressed ? theme.accentSecondary : theme.accentLight,
              })}
            >
              <AppSymbol name="arrow.down.circle" size={13} color={theme.accent} />
              <Text style={{ color: theme.accent, fontSize: 12, fontWeight: "800" }}>读取当前文件</Text>
            </Pressable>
          ) : null}
        </View>
      );
    }
    return (
      <View style={{ padding: 12 }}>
        <Text style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }}>
          从上方列表选择文件后会在这里显示内容。
        </Text>
      </View>
    );
  }

  const listHeight = height ?? Math.min(360, Math.max(120, lines.length * 19 + 16));
  return (
    <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator style={{ height: listHeight }}>
      <View style={{ width: 900, minWidth: 520, height: listHeight, paddingVertical: 8, paddingRight: 14 }}>
        <LegendList
          data={lines}
          keyExtractor={(_line, index) => `${preview.path}:${index}`}
          renderItem={renderLine}
          estimatedItemSize={19}
          drawDistance={360}
          recycleItems
          style={{ flex: 1 }}
        />
      </View>
    </ScrollView>
  );
}

function FilePreviewDiffContent({
  diff,
  theme,
  height,
}: {
  diff: string;
  theme: Theme;
  height: number;
}) {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  const renderLine = useCallback(({ item, index }: { item: string; index: number }) => {
    const colors = diffLineColors(item, theme);
    return (
      <Text
        selectable
        style={{
          paddingHorizontal: 10,
          paddingVertical: 1,
          minWidth: "100%",
          color: colors.color,
          backgroundColor: colors.backgroundColor,
          fontFamily: MONO_FONT,
          fontSize: 11,
          lineHeight: 16,
        }}
      >
        {item || " "}
      </Text>
    );
  }, [theme]);

  return (
    <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator style={{ height }}>
      <View style={{ width: 900, minWidth: 520, height, paddingVertical: 8, paddingRight: 14 }}>
        <LegendList
          data={lines}
          keyExtractor={(_line, index) => `diff:${index}`}
          renderItem={renderLine}
          estimatedItemSize={16}
          drawDistance={360}
          recycleItems
          style={{ flex: 1 }}
        />
      </View>
    </ScrollView>
  );
}

function FilePreviewDrawer({
  visible,
  conversationId,
  cwd,
  workspace,
  theme,
  topInset,
  bottomInset,
  initialFilePath,
  initialDiff,
  initialLiveRead = true,
  onClose,
  onInsertReference,
}: {
  visible: boolean;
  conversationId: string;
  cwd: string;
  workspace: AgentWorkspaceHandle;
  theme: Theme;
  topInset: number;
  bottomInset: number;
  initialFilePath?: string | null;
  initialDiff?: { path: string; diff: string; title?: string } | null;
  initialLiveRead?: boolean;
  onClose: () => void;
  onInsertReference?: (path: string) => void;
}) {
  const { height: windowHeight } = useWindowDimensions();
  const [currentPath, setCurrentPath] = useState(cwd);
  const [entries, setEntries] = useState<AgentFileEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | undefined>();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<AgentFileReadResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const requestSeqRef = useRef(0);
  const readSeqRef = useRef(0);
  const browseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceRef = useRef(workspace);
  const directFileMode = Boolean(initialFilePath);
  const directDiffMode = Boolean(initialDiff?.diff);
  const directLiveRead = initialLiveRead !== false;

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => () => {
    if (browseTimeoutRef.current) clearTimeout(browseTimeoutRef.current);
    if (readTimeoutRef.current) clearTimeout(readTimeoutRef.current);
  }, []);

  const loadDirectory = useCallback(async (path: string) => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    if (browseTimeoutRef.current) clearTimeout(browseTimeoutRef.current);
    setCurrentPath(path);
    setBrowseLoading(true);
    setBrowseError(undefined);
    setSelectedPath(null);
    setPreview(null);
    readSeqRef.current += 1;
    setPreviewLoading(false);
    browseTimeoutRef.current = setTimeout(() => {
      if (requestSeqRef.current !== requestSeq) return;
      requestSeqRef.current += 1;
      setEntries([]);
      setBrowseError("读取目录超时：主机端没有返回文件列表，请确认 Codex/LinkShell 会话仍在线。");
      setBrowseLoading(false);
    }, FILE_PREVIEW_TIMEOUT_MS);
    try {
      const result = await workspaceRef.current.browseFiles(conversationId, path);
      if (requestSeqRef.current !== requestSeq) return;
      if (browseTimeoutRef.current) {
        clearTimeout(browseTimeoutRef.current);
        browseTimeoutRef.current = null;
      }
      setEntries(result.entries);
      setBrowseError(result.error);
      setCurrentPath(result.path || path);
      setBrowseLoading(false);
    } catch (error) {
      if (requestSeqRef.current !== requestSeq) return;
      if (browseTimeoutRef.current) {
        clearTimeout(browseTimeoutRef.current);
        browseTimeoutRef.current = null;
      }
      setEntries([]);
      setBrowseError(error instanceof Error ? error.message : "读取目录失败。");
      setBrowseLoading(false);
    }
  }, [conversationId]);

  const openFilePath = useCallback((path: string) => {
    setSelectedPath(path);
    setPreviewLoading(true);
    setPreview(null);
    const readSeq = readSeqRef.current + 1;
    readSeqRef.current = readSeq;
    if (readTimeoutRef.current) clearTimeout(readTimeoutRef.current);
    readTimeoutRef.current = setTimeout(() => {
      if (readSeqRef.current !== readSeq) return;
      readSeqRef.current += 1;
      setPreview({
        path,
        content: "",
        encoding: "utf8",
        truncated: false,
        error: "读取文件超时：主机端没有返回文件内容，请确认 Codex app-server / LinkShell 会话仍在线。",
      });
      setPreviewLoading(false);
    }, FILE_PREVIEW_TIMEOUT_MS);
    workspaceRef.current.readFile(conversationId, path, FILE_PREVIEW_MAX_BYTES)
      .then((result) => {
        if (readSeqRef.current !== readSeq) return;
        if (readTimeoutRef.current) {
          clearTimeout(readTimeoutRef.current);
          readTimeoutRef.current = null;
        }
        setPreview(result);
      })
      .catch((error) => {
        if (readSeqRef.current !== readSeq) return;
        if (readTimeoutRef.current) {
          clearTimeout(readTimeoutRef.current);
          readTimeoutRef.current = null;
        }
        setPreview({
          path,
          content: "",
          encoding: "utf8",
          truncated: false,
          error: error instanceof Error ? error.message : "读取文件失败。",
        });
      })
      .finally(() => {
        if (readSeqRef.current === readSeq) setPreviewLoading(false);
      });
  }, [conversationId]);

  useEffect(() => {
    if (!visible) return;
    const target = initialFilePath ? resolveFileReference(initialFilePath, cwd) : undefined;
    if (target) {
      setCurrentPath(parentPath(target));
      setEntries([]);
      setBrowseLoading(false);
      setBrowseError(undefined);
      if (initialDiff?.diff) {
        readSeqRef.current += 1;
        setSelectedPath(target);
        setPreview(null);
        setPreviewLoading(false);
        return;
      }
      if (!directLiveRead) {
        readSeqRef.current += 1;
        if (readTimeoutRef.current) {
          clearTimeout(readTimeoutRef.current);
          readTimeoutRef.current = null;
        }
        setSelectedPath(target);
        setPreview(null);
        setPreviewLoading(false);
        return;
      }
      openFilePath(target);
      return;
    }
    loadDirectory(cwd).catch(() => {
      setBrowseLoading(false);
      setBrowseError("读取目录失败。");
    });
  }, [cwd, directLiveRead, initialDiff?.diff, initialFilePath, loadDirectory, openFilePath, visible]);

  const openEntry = useCallback((entry: AgentFileEntry) => {
    if (entry.isDirectory) {
      loadDirectory(entry.path).catch(() => {
        setBrowseLoading(false);
        setBrowseError("读取目录失败。");
      });
      return;
    }
    openFilePath(entry.path);
  }, [loadDirectory, openFilePath]);

  const copyPreview = useCallback(() => {
    if (!preview?.content) return;
    copy(preview.content).then((ok) => {
      if (!ok) Alert.alert("复制失败", "系统剪贴板暂不可用，请长按文本手动复制。");
    }).catch(() => Alert.alert("复制失败", "系统剪贴板暂不可用，请长按文本手动复制。"));
  }, [preview?.content]);

  const referencePath = preview?.path ?? selectedPath;

  if (!visible) return null;

  const language = preview ? languageFromPath(preview.path) : selectedPath ? languageFromPath(selectedPath) : "text";
  const directoryCount = entries.filter((entry) => entry.isDirectory).length;
  const fileCount = entries.length - directoryCount;
  const directPreviewHeight = Math.max(260, windowHeight - topInset - Math.max(bottomInset, 12) - 118);
  const referenceOnlyPath = directFileMode && !directDiffMode && !directLiveRead && selectedPath && !preview && !previewLoading
    ? selectedPath
    : null;

  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 40,
        flexDirection: "row",
      }}
      pointerEvents="box-none"
    >
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.34)" }} onPress={onClose} />
      <View
        style={{
          width: "88%",
          maxWidth: 460,
          backgroundColor: theme.bg,
          borderLeftWidth: StyleSheet.hairlineWidth,
          borderColor: theme.separator,
          paddingTop: topInset + 10,
          paddingBottom: Math.max(bottomInset, 12),
          shadowColor: "#000",
          shadowOpacity: 0.28,
          shadowRadius: 28,
          shadowOffset: { width: -8, height: 0 },
          elevation: 12,
        }}
      >
        <View style={{ paddingHorizontal: 14, gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: theme.accentLight,
              }}
            >
              <AppSymbol name="doc.text.magnifyingglass" size={17} color={theme.accent} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.text, fontSize: 16, fontWeight: "800" }}>文件预览</Text>
              <Text style={{ color: theme.textTertiary, fontSize: 11, marginTop: 2, fontFamily: MONO_FONT }} numberOfLines={1}>
                {directDiffMode && selectedPath ? `Diff · ${selectedPath}` : directFileMode && selectedPath ? selectedPath : `${directoryCount} 个目录 · ${fileCount} 个文件`}
              </Text>
            </View>
            {!directFileMode ? (
              <Pressable
                onPress={() => loadDirectory(currentPath)}
                hitSlop={8}
                style={({ pressed }) => ({
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? theme.accentLight : theme.bgInput,
                })}
              >
                {browseLoading ? <ActivityIndicator size="small" color={theme.accent} /> : <AppSymbol name="arrow.clockwise" size={15} color={theme.textSecondary} />}
              </Pressable>
            ) : null}
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={({ pressed }) => ({
                width: 32,
                height: 32,
                borderRadius: 16,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? theme.bgInput : "transparent",
              })}
            >
              <AppSymbol name="xmark" size={16} color={theme.textSecondary} />
            </Pressable>
          </View>

          {!directFileMode ? (
            <View
              style={{
                borderRadius: 12,
                borderCurve: "continuous",
                backgroundColor: theme.bgInput,
                paddingHorizontal: 10,
                paddingVertical: 8,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Pressable
                onPress={() => loadDirectory(parentPath(currentPath))}
                disabled={currentPath === "/"}
                style={{ opacity: currentPath === "/" ? 0.35 : 1 }}
              >
                <AppSymbol name="chevron.left" size={15} color={theme.textSecondary} />
              </Pressable>
              <Text style={{ flex: 1, color: theme.textSecondary, fontSize: 11, fontFamily: MONO_FONT }} numberOfLines={1}>
                {currentPath}
              </Text>
            </View>
          ) : null}
        </View>

        <ScrollView
          style={{ flex: 1, marginTop: 10 }}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 6 }}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={!directFileMode}
        >
          {!directFileMode && browseError ? (
            <View style={{ borderRadius: 10, padding: 10, backgroundColor: theme.errorLight }}>
              <Text style={{ color: theme.error, fontSize: 12, lineHeight: 17 }}>{browseError}</Text>
            </View>
          ) : null}
          {!directFileMode && browseLoading && entries.length === 0 ? (
            <View style={{ paddingVertical: 24, alignItems: "center" }}>
              <ActivityIndicator color={theme.accent} />
            </View>
          ) : null}
          {!directFileMode ? entries.map((entry) => {
            const selected = selectedPath === entry.path;
            return (
              <Pressable
                key={entry.path}
                onPress={() => openEntry(entry)}
                style={({ pressed }) => ({
                  borderRadius: 10,
                  borderCurve: "continuous",
                  paddingVertical: 9,
                  paddingHorizontal: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 9,
                  backgroundColor: selected ? theme.accentLight : pressed ? theme.bgInput : "transparent",
                })}
              >
                <AppSymbol
                  name={entry.isDirectory ? "folder.fill" : "doc.text"}
                  size={17}
                  color={entry.isDirectory ? theme.accent : selected ? theme.accent : theme.textSecondary}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: theme.text, fontSize: 13, fontWeight: "700" }} numberOfLines={1}>
                    {entry.name}
                  </Text>
                  {!entry.isDirectory ? (
                    <Text style={{ color: theme.textTertiary, fontSize: 10, marginTop: 2, fontFamily: MONO_FONT }}>
                      {formatBytes(entry.size)}
                    </Text>
                  ) : null}
                </View>
                {entry.isDirectory ? <AppSymbol name="chevron.right" size={13} color={theme.textTertiary} /> : null}
              </Pressable>
            );
          }) : null}

          <View
            style={{
              marginTop: directFileMode ? 0 : 8,
              flex: directFileMode ? 1 : undefined,
              minHeight: directFileMode ? 0 : undefined,
              borderRadius: 12,
              borderCurve: "continuous",
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.separator,
              backgroundColor: theme.mode === "light" ? "#fff" : "#09090a",
              overflow: "hidden",
            }}
          >
            <View
              style={{
                minHeight: 40,
                paddingHorizontal: 10,
                paddingVertical: 9,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
              }}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: theme.text, fontSize: 13, fontWeight: "800" }} numberOfLines={1}>
                  {directDiffMode
                    ? initialDiff?.title ?? (selectedPath ? fileName(selectedPath) : "Diff")
                    : preview ? fileName(preview.path) : selectedPath ? fileName(selectedPath) : "选择一个文件"}
                </Text>
                <Text style={{ color: theme.textTertiary, fontSize: 10, marginTop: 2, fontFamily: MONO_FONT }} numberOfLines={1}>
                  {directDiffMode
                    ? `${initialDiff?.diff.split("\n").length ?? 0} 行 diff`
                    : preview ? [language, formatBytes(preview.size), preview.truncated ? "已截断" : null].filter(Boolean).join(" · ") : referenceOnlyPath ? "文件引用 · 未读取" : "支持常见代码文件高亮"}
                </Text>
              </View>
              {!directDiffMode && preview?.content ? (
                <Pressable onPress={copyPreview} hitSlop={8}>
                  <AppSymbol name="doc.on.doc" size={15} color={theme.textSecondary} />
                </Pressable>
              ) : null}
              {referencePath && onInsertReference ? (
                <Pressable
                  onPress={() => onInsertReference(referencePath)}
                  hitSlop={8}
                  style={({ pressed }) => ({
                    borderRadius: 999,
                    paddingHorizontal: 9,
                    paddingVertical: 6,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    backgroundColor: pressed ? theme.accentSecondary : theme.accentLight,
                  })}
                >
                  <AppSymbol name="at" size={13} color={theme.accent} />
                  <Text style={{ color: theme.accent, fontSize: 11, fontWeight: "800" }}>引用</Text>
                </Pressable>
              ) : null}
            </View>
            {directDiffMode && initialDiff?.diff ? (
              <FilePreviewDiffContent diff={initialDiff.diff} theme={theme} height={directPreviewHeight} />
            ) : (
              <FilePreviewCodeContent
                previewLoading={previewLoading}
                preview={preview}
                language={language}
                theme={theme}
                height={directFileMode ? directPreviewHeight : undefined}
                referenceOnlyPath={referenceOnlyPath}
                onReadReference={openFilePath}
              />
            )}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

export function AgentConversationScreen({
  conversationId,
  workspace,
  deviceToken,
  authToken,
  onBack,
}: AgentConversationScreenProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const conversation = workspace.getConversation(conversationId);
  const timeline = workspace.getTimeline(conversationId);
  const loadOlderHistory = workspace.loadOlderHistory;
  const respondPermission = workspace.respondPermission;
  const respondStructuredInput = workspace.respondStructuredInput;
  const visibleTimeline = useMemo(() => prepareTimelineItems(timeline), [timeline]);
  const visibleTimelineRef = useRef<AgentTimelineItem[]>(visibleTimeline);
  visibleTimelineRef.current = visibleTimeline;
  const timelineRef = useRef<LegendListRef>(null);
  const timelineNearBottomRef = useRef(true);
  const runtimeCapabilityRequestRef = useRef<string | null>(null);
  const [isTimelineNearBottom, setIsTimelineNearBottom] = useState(true);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const [text, setText] = useState("");
  const [model, setModel] = useState<string | undefined>(conversation?.model);
  const [effort, setEffort] = useState<AgentReasoningEffort | undefined>(conversation?.reasoningEffort);
  const [serviceTier, setServiceTier] = useState<AgentServiceTier | undefined>(conversation?.serviceTier);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode | undefined>(
    conversation?.permissionMode,
  );
  const [attachments, setAttachments] = useState<AgentContentBlock[]>([]);
  const [queuedCodexPrompts, setQueuedCodexPrompts] = useState<QueuedCodexPrompt[]>([]);
  const queuedAutoSendInFlightRef = useRef(false);
  const queuedPersistenceReadyRef = useRef(false);
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false);
  const [fileDrawerInitialPath, setFileDrawerInitialPath] = useState<string | null>(null);
  const [fileDrawerInitialDiff, setFileDrawerInitialDiff] = useState<{ path: string; diff: string; title?: string } | null>(null);
  const [fileDrawerInitialLiveRead, setFileDrawerInitialLiveRead] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const capabilities = useMemo(() => {
    if (!conversation) return undefined;
    return workspace.capabilitiesBySessionId.get(conversation.sessionId) ??
      workspace.capabilitiesBySessionId.get(conversation.hostDeviceId);
  }, [conversation, workspace.capabilitiesBySessionId]);
  const providerCapability = conversation ? providerCapabilityFor(conversation.provider, capabilities) : undefined;
  const providerSupportsImageInput = conversation?.provider === "claude" || conversation?.provider === "codex";
  const supportsImages = Boolean(
    providerSupportsImageInput ||
    (capabilities?.enabled && (providerCapability?.supportsImages ?? capabilities.supportsImages)),
  );
  const running = conversation?.status === "running" || conversation?.status === "waiting_permission";
  const meta = visibleConversationStatus(conversation?.status, theme);
  const syncLabel = conversation?.syncStatus === "stale"
    ? "未同步"
    : conversation?.syncStatus === "deferred"
    ? "离线缓存"
    : conversation?.syncStatus === "syncing" && !running
    ? "同步中"
    : undefined;
  const topFadeColors: [string, string, string, string] = theme.mode === "light"
    ? ["#fbfbfb", "rgba(251,251,251,0.92)", "rgba(251,251,251,0.52)", "rgba(251,251,251,0)"]
    : [theme.bg, "rgba(19,19,20,0.92)", "rgba(19,19,20,0.52)", "rgba(19,19,20,0)"];
  const permission = permissionMeta(permissionMode, theme);
  const canSend = Boolean(text.trim() || attachments.length > 0);
  const canGuideRunningCodex = conversation?.provider === "codex" && conversation.status === "running" && Boolean(conversation.runningTurnId);
  const canQueueRunningCodex = conversation?.provider === "codex" && conversation.status === "running" && Boolean(conversation.runningTurnId);
  const canSubmitComposer = canSend && (!running || canQueueRunningCodex);
  const modelOpts = useMemo(
    () => modelOptionsFor(conversation?.provider ?? "codex", capabilities),
    [capabilities, conversation?.provider],
  );
  const effortOpts = useMemo(
    () => effortOptionsFor(conversation?.provider ?? "codex", capabilities),
    [capabilities, conversation?.provider],
  );
  const speedOpts = useMemo(
    () => speedOptionsFor(conversation?.provider ?? "codex", capabilities, model),
    [capabilities, conversation?.provider, model],
  );
  const effectiveServiceTier = serviceTier ?? providerCapability?.defaultServiceTier ?? "standard";
  const permissionOpts = useMemo(
    () => permissionOptionsFor(conversation?.provider ?? "codex", capabilities),
    [capabilities, conversation?.provider],
  );
  const commandToken = useMemo(() => trailingSlashCommandToken(text), [text]);
  const availableCommands = useMemo(
    () => (providerCapability?.commands ?? []).filter((command) =>
      !command.provider || command.provider === conversation?.provider,
    ),
    [conversation?.provider, providerCapability?.commands],
  );
  const commandPanelVisible = Boolean(commandToken && availableCommands.length > 0 && attachments.length === 0);
  const currentCollaborationMode = (conversation?.collaborationMode ?? providerCapability?.currentMode ?? "default") as AgentCollaborationMode;
  const runtimeModelReady = conversation?.provider !== "codex" || modelOpts.length > 0;
  const runtimeLabel = runtimeModelReady
    ? formatRuntimeCompact(model, modelOpts, effort, speedOpts.length > 0 ? effectiveServiceTier : undefined)
    : providerCapability?.modelListError
    ? "模型失败"
    : "同步中";

  useEffect(() => {
    if (commandPanelVisible) {
      Keyboard.dismiss();
    }
  }, [commandPanelVisible]);

  useEffect(() => {
    if (!conversation || conversation.provider !== "codex" || runtimeModelReady) return;
    const key = `${conversation.sessionId}:${conversation.hostDeviceId}`;
    if (runtimeCapabilityRequestRef.current === key) return;
    runtimeCapabilityRequestRef.current = key;
    workspace.requestCapabilities(conversation.sessionId);
  }, [conversation, runtimeModelReady, workspace]);

  useEffect(() => {
    setModel(conversation?.model);
    setEffort(conversation?.reasoningEffort);
    setServiceTier(conversation?.serviceTier);
    setPermissionMode(conversation?.permissionMode);
  }, [conversation?.id, conversation?.model, conversation?.permissionMode, conversation?.reasoningEffort, conversation?.serviceTier]);

  useEffect(() => {
    if (model && modelOpts.length > 0 && !modelOpts.some((option) => option.value === model)) {
      setModel(undefined);
      if (conversation) {
        workspace.updateConversationSettings(conversation.id, { model: undefined }).catch(() => {});
      }
    }
  }, [conversation, model, modelOpts, workspace]);

  useEffect(() => {
    if (effort && !effortOpts.some((option) => option.value === effort)) {
      setEffort(undefined);
      if (conversation) {
        workspace.updateConversationSettings(conversation.id, { reasoningEffort: undefined }).catch(() => {});
      }
    }
  }, [conversation, effort, effortOpts, workspace]);

  useEffect(() => {
    if (serviceTier && speedOpts.length > 0 && !speedOpts.some((option) => option.value === serviceTier)) {
      setServiceTier(undefined);
      if (conversation) {
        workspace.updateConversationSettings(conversation.id, { serviceTier: undefined }).catch(() => {});
      }
    }
  }, [conversation, serviceTier, speedOpts, workspace]);

  useEffect(() => {
    if (permissionMode && !permissionOpts.some((option) => option.value === permissionMode)) {
      setPermissionMode(undefined);
      if (conversation) {
        workspace.updateConversationSettings(conversation.id, { permissionMode: undefined }).catch(() => {});
      }
    }
  }, [conversation, permissionMode, permissionOpts, workspace]);

  const modelMenuActions = useMemo(
    () =>
      modelOpts.map((option) => ({
        id: `model:${option.value ?? DEFAULT_OPTION_ID}`,
        title: option.label,
        image: "square.stack.3d.up",
        state: option.value === model ? "on" as const : "off" as const,
      })),
    [modelOpts, model],
  );
  const effortMenuActions = useMemo(
    () =>
      effortOpts.map((option) => ({
        id: `effort:${option.value ?? DEFAULT_OPTION_ID}`,
        title: option.label,
        image: "textformat.size.larger",
        state: option.value === effort ? "on" as const : "off" as const,
      })),
    [effortOpts, effort],
  );
  const speedMenuActions = useMemo(
    () =>
      speedOpts.map((option) => ({
        id: `speed:${option.value ?? DEFAULT_OPTION_ID}`,
        title: option.label,
        image: option.image,
        state: option.value === effectiveServiceTier ? "on" as const : "off" as const,
      })),
    [effectiveServiceTier, speedOpts],
  );
  const runtimeMenuActions = useMemo<MenuAction[]>(() => [
    ...(runtimeModelReady && modelMenuActions.length > 0
      ? [{
          title: "模型",
          image: "cpu",
          subactions: modelMenuActions,
        }]
      : []),
    ...(runtimeModelReady && effortMenuActions.length > 0
      ? [{
          title: "智能",
          image: "brain.head.profile",
          subactions: effortMenuActions,
        }]
      : []),
    ...(runtimeModelReady && speedMenuActions.length > 0
      ? [{
          title: "速度",
          image: "speedometer",
          subactions: speedMenuActions,
        }]
      : []),
  ], [effortMenuActions, modelMenuActions, runtimeModelReady, speedMenuActions]);
  const permissionMenuActions = useMemo(
    () => menuActions(permissionOpts, permissionMode),
    [permissionMode, permissionOpts],
  );
  const timelineAutoScrollKey = useMemo(
    () => {
      const item = visibleTimeline[visibleTimeline.length - 1];
      if (!item) return "empty";
      const tool = item.toolCall;
      return [
        item.id,
        item.updatedAt ?? item.createdAt,
        item.text?.length ?? 0,
        item.content?.length ?? 0,
        tool?.output?.length ?? 0,
        item.isStreaming ? 1 : 0,
      ].join(":");
    },
    [visibleTimeline],
  );
  const handleTimelineScroll = useCallback((event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    const nearBottom = distanceFromBottom < 96;
    const previousNearBottom = timelineNearBottomRef.current;
    timelineNearBottomRef.current = nearBottom;
    if (previousNearBottom !== nearBottom) {
      setIsTimelineNearBottom(nearBottom);
    }
    if (nearBottom) {
      setHasNewOutput((current) => current ? false : current);
    }
    if (contentOffset.y < 80) {
      loadOlderHistory(conversationId);
    }
  }, [conversationId, loadOlderHistory]);

  const forceTimelineToBottom = useCallback((animated = true) => {
    const ref = timelineRef.current;
    if (!ref) return;
    const nativeScrollRef = ref.getNativeScrollRef() as { scrollToEnd?: (options?: { animated?: boolean }) => void } | null;
    ref.scrollToEnd({ animated });
    nativeScrollRef?.scrollToEnd?.({ animated });
  }, []);

  const settleTimelineAtBottom = useCallback(() => {
    if (!timelineNearBottomRef.current) return;
    requestAnimationFrame(() => {
      if (timelineNearBottomRef.current) {
        forceTimelineToBottom(false);
      }
    });
  }, [forceTimelineToBottom]);

  const scrollTimelineToBottom = useCallback((animated = true, stick = true) => {
    if (stick) {
      setHasNewOutput(false);
    }

    const scroll = () => forceTimelineToBottom(animated);
    requestAnimationFrame(scroll);
    requestAnimationFrame(() => requestAnimationFrame(scroll));
    setTimeout(scroll, 80);
    setTimeout(scroll, 220);
  }, [forceTimelineToBottom]);

  const openFileReference = useCallback((path: string, options?: OpenFileReferenceOptions) => {
    if (!conversation) return;
    const normalized = normalizeFileReference(path);
    if (!normalized) return;
    const resolved = resolveFileReference(normalized, conversation.cwd || "~");
    setFileDrawerInitialPath(resolved);
    setFileDrawerInitialDiff(options?.diff ? { path: resolved, diff: options.diff, title: options.title } : null);
    setFileDrawerInitialLiveRead(options?.diff ? false : options?.autoRead ?? true);
    setFileDrawerOpen(true);
  }, [conversation]);

  const handleTimelinePermission = useCallback((requestId: string, outcome: "allow" | "deny" | "cancelled", optionId?: string) => {
    respondPermission(conversationId, requestId, outcome, optionId);
  }, [conversationId, respondPermission]);

  const handleTimelineStructuredInput = useCallback((requestId: string, answers: Record<string, string[]>) => {
    respondStructuredInput(conversationId, requestId, answers);
  }, [conversationId, respondStructuredInput]);

  const renderTimelineItem = useCallback(({ item, index }: LegendListRenderItemProps<AgentTimelineItem>) => {
    const previous = visibleTimelineRef.current[index - 1];
    return (
      <TimelineItemRow
        item={item}
        previousTurnId={previous?.turnId}
        theme={theme}
        onOpenFile={openFileReference}
        onPermission={handleTimelinePermission}
        onStructuredInput={handleTimelineStructuredInput}
      />
    );
  }, [handleTimelinePermission, handleTimelineStructuredInput, openFileReference, theme]);

  const timelineEmpty = useMemo(() => (
    <View style={{ paddingVertical: 36, alignItems: "center", gap: 9 }}>
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.accentLight,
        }}
      >
        <AppSymbol name="sparkles" size={22} color={theme.accent} />
      </View>
      <Text style={{ color: theme.text, fontSize: 16, fontWeight: "800" }}>开始一个 Agent 对话</Text>
      <Text style={{ color: theme.textTertiary, fontSize: 13, lineHeight: 18, textAlign: "center" }}>
        发送 prompt 后，回复、代码、工具调用和权限请求都会在这里按时间线展示。
      </Text>
    </View>
  ), [theme]);

  useEffect(() => {
    if (visibleTimeline.length === 0) return;
    if (!timelineNearBottomRef.current) {
      setHasNewOutput(true);
      return;
    }
    setHasNewOutput(false);
    forceTimelineToBottom(false);
  }, [forceTimelineToBottom, timelineAutoScrollKey, visibleTimeline.length]);

  useEffect(() => {
    let cancelled = false;
    queuedPersistenceReadyRef.current = false;
    queuedAutoSendInFlightRef.current = false;
    setQueuedCodexPrompts([]);
    loadQueuedCodexPrompts(conversationId)
      .then((items) => {
        if (cancelled) return;
        setQueuedCodexPrompts((current) => current.length > 0 ? current : items);
      })
      .finally(() => {
        if (!cancelled) queuedPersistenceReadyRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    if (!queuedPersistenceReadyRef.current) return;
    saveQueuedCodexPrompts(conversationId, queuedCodexPrompts).catch(() => {});
  }, [conversationId, queuedCodexPrompts]);

  useEffect(() => {
    if (running) {
      queuedAutoSendInFlightRef.current = false;
    }
  }, [running]);

  const submitPromptToWorkspace = useCallback((prompt: QueuedCodexPrompt, options?: { forceSteer?: boolean }) => {
    if (!conversation) return;
    workspace.sendPrompt(conversation.id, prompt.text, {
      model: prompt.model,
      reasoningEffort: prompt.reasoningEffort,
      serviceTier: prompt.serviceTier,
      permissionMode: prompt.permissionMode,
      collaborationMode: prompt.collaborationMode,
      attachments: prompt.attachments,
      forceSteer: options?.forceSteer,
    });
    scrollTimelineToBottom(true);
  }, [conversation, scrollTimelineToBottom, workspace]);

  useEffect(() => {
    if (!conversation || running || queuedCodexPrompts.length === 0 || queuedAutoSendInFlightRef.current) return;
    const [nextPrompt] = queuedCodexPrompts;
    if (!nextPrompt) return;
    queuedAutoSendInFlightRef.current = true;
    setQueuedCodexPrompts((current) => current.filter((item) => item.id !== nextPrompt.id));
    submitPromptToWorkspace(nextPrompt);
  }, [conversation, queuedCodexPrompts, running, submitPromptToWorkspace]);

  const send = useCallback(() => {
    const value = text.trim();
    if (!canSend || !conversation) return;
    const commandMatch = attachments.length === 0 && !canQueueRunningCodex
      ? commandFromMessage(value, availableCommands)
      : null;
    if (commandMatch) {
      const run = () => {
        workspace.executeCommand(conversation.id, commandMatch.command, value, commandMatch.args);
        setText("");
        setAttachments([]);
        Keyboard.dismiss();
        scrollTimelineToBottom(true);
      };
      if (commandMatch.command.destructive) {
        Alert.alert(
          "执行命令？",
          `${commandMatch.command.title} 可能会重置或改变当前会话状态。`,
          [
            { text: "取消", style: "cancel" },
            { text: "执行", style: "destructive", onPress: run },
          ],
        );
        return;
      }
      run();
      return;
    }
    const nextEffort = effort && effortOpts.some((option) => option.value === effort) ? effort : undefined;
    const nextPermissionMode = permissionMode && permissionOpts.some((option) => option.value === permissionMode)
      ? permissionMode
      : undefined;
    const prompt: QueuedCodexPrompt = {
      id: createQueuedPromptId(),
      text: value,
      attachments,
      model,
      reasoningEffort: nextEffort,
      serviceTier: speedOpts.length > 0 ? effectiveServiceTier : undefined,
      permissionMode: nextPermissionMode,
      collaborationMode: currentCollaborationMode,
    };
    if (canQueueRunningCodex) {
      setQueuedCodexPrompts((current) => [...current, prompt]);
      Haptics.selectionAsync().catch(() => {});
    } else {
      submitPromptToWorkspace(prompt);
    }
    setText("");
    setAttachments([]);
    Keyboard.dismiss();
    scrollTimelineToBottom(true);
  }, [attachments, availableCommands, canQueueRunningCodex, canSend, conversation, currentCollaborationMode, effectiveServiceTier, effort, effortOpts, model, permissionMode, permissionOpts, scrollTimelineToBottom, speedOpts.length, submitPromptToWorkspace, text, workspace]);

  const guideQueuedPrompt = useCallback((prompt: QueuedCodexPrompt) => {
    if (!canGuideRunningCodex) return;
    setQueuedCodexPrompts((current) => current.filter((item) => item.id !== prompt.id));
    submitPromptToWorkspace(prompt, { forceSteer: true });
    Haptics.selectionAsync().catch(() => {});
  }, [canGuideRunningCodex, submitPromptToWorkspace]);

  const removeQueuedPrompt = useCallback((promptId: string) => {
    setQueuedCodexPrompts((current) => current.filter((item) => item.id !== promptId));
    Haptics.selectionAsync().catch(() => {});
  }, []);

  const executeSlashCommand = useCallback((command: AgentCommandDescriptor, args = "") => {
    if (!conversation) return;
    const run = () => {
      const rawText = commandRawText(command, args);
      workspace.executeCommand(conversation.id, command, rawText, args);
      setText("");
      setAttachments([]);
      Haptics.selectionAsync().catch(() => {});
      scrollTimelineToBottom(true);
    };
    if (command.destructive) {
      Alert.alert(
        "执行命令？",
        `${command.title} 可能会重置或改变当前会话状态。`,
        [
          { text: "取消", style: "cancel" },
          { text: "执行", style: "destructive", onPress: run },
        ],
      );
      return;
    }
    run();
  }, [conversation, scrollTimelineToBottom, workspace]);

  const commandByName = useCallback((name: string) =>
    availableCommands.find((command) => command.name === name || command.title === `/${name}`),
    [availableCommands],
  );

  const runCommandByName = useCallback((name: string, args = "") => {
    const command = commandByName(name);
    if (!command) return false;
    executeSlashCommand(command, args);
    return true;
  }, [commandByName, executeSlashCommand]);

  const useDraftForCommand = useCallback((name: string) => {
    const command = commandByName(name);
    if (!command) return;
    const draft = text.trim();
    const run = (args = "") => executeSlashCommand(command, args);
    if (!draft || draft.startsWith("/")) {
      setText(commandRawText(command, ""));
      return;
    }
    Alert.alert(
      command.title,
      "用当前草稿作为这条命令的参数吗？",
      [
        { text: "继续编辑", style: "cancel" },
        { text: "使用草稿", onPress: () => run(draft) },
      ],
    );
  }, [commandByName, executeSlashCommand, text]);

  const insertFileReference = useCallback((path: string) => {
    setText((current) => {
      const prefix = current.trimEnd();
      const next = /\s/.test(path) ? `@${JSON.stringify(path)}` : `@${path}`;
      return prefix ? `${prefix} ${next} ` : `${next} `;
    });
    setFileDrawerOpen(false);
    setFileDrawerInitialPath(null);
    setFileDrawerInitialDiff(null);
    setFileDrawerInitialLiveRead(true);
  }, []);

  const selectSlashCommand = useCallback((command: AgentCommandDescriptor) => {
    if (!commandToken) return;
    const draftWithoutToken = text.slice(0, commandToken.start).trimEnd();
    if (command.argsMode === "none") {
      executeSlashCommand(command);
      return;
    }
    const replacement = commandRawText(command, "");
    const nextText = `${draftWithoutToken ? `${draftWithoutToken} ` : ""}${replacement} `;
    setText(nextText);
    Haptics.selectionAsync().catch(() => {});
  }, [commandToken, executeSlashCommand, text]);

  const closeSlashCommandPanel = useCallback(() => {
    if (!commandToken) return;
    setText((current) => `${current.slice(0, commandToken.start)}${current.slice(commandToken.end)}`.trimEnd());
  }, [commandToken]);

  const commitModel = useCallback((nextModel: string | undefined) => {
    setModel(nextModel);
    if (conversation) {
      workspace.updateConversationSettings(conversation.id, { model: nextModel }).catch(() => {});
    }
  }, [conversation, workspace]);

  const commitEffort = useCallback((nextEffort: AgentReasoningEffort | undefined) => {
    setEffort(nextEffort);
    if (conversation) {
      workspace.updateConversationSettings(conversation.id, { reasoningEffort: nextEffort }).catch(() => {});
    }
  }, [conversation, workspace]);

  const commitServiceTier = useCallback((nextTier: AgentServiceTier | undefined) => {
    setServiceTier(nextTier);
    if (conversation) {
      workspace.updateConversationSettings(conversation.id, { serviceTier: nextTier }).catch(() => {});
    }
  }, [conversation, workspace]);

  const commitPermissionMode = useCallback((nextMode: AgentPermissionMode | undefined) => {
    setPermissionMode(nextMode);
    if (conversation) {
      workspace.updateConversationSettings(conversation.id, { permissionMode: nextMode }).catch(() => {});
    }
  }, [conversation, workspace]);

  const setPermissionModeWithGuard = useCallback((nextMode: AgentPermissionMode | undefined) => {
    if (nextMode === "full_access") {
      Alert.alert(
        "启用完全访问权限？",
        "Agent 可能不再逐项请求文件或命令授权。只在你信任当前任务和工作区时使用。",
        [
          { text: "取消", style: "cancel" },
          { text: "启用", onPress: () => commitPermissionMode(nextMode) },
        ],
      );
      return;
    }
    commitPermissionMode(nextMode);
  }, [commitPermissionMode]);

  const togglePlanMode = useCallback(() => {
    if (!conversation) return;
    const nextMode: AgentCollaborationMode = currentCollaborationMode === "plan" ? "default" : "plan";
    const targetName = nextMode === "plan" ? "plan" : "exit-plan";
    const command = availableCommands.find((item) => item.name === targetName);
    if (command?.disabledReason) {
      Alert.alert("命令不可用", command.disabledReason);
      return;
    }
    if (command) {
      executeSlashCommand(command);
      return;
    }
    workspace.updateConversationSettings(conversation.id, { collaborationMode: nextMode }).catch(() => {});
    Haptics.selectionAsync().catch(() => {});
  }, [availableCommands, conversation, currentCollaborationMode, executeSlashCommand, workspace]);

  const cancelRunningTurn = useCallback(() => {
    if (!conversation) return;
    if (queuedCodexPrompts.length > 0) {
      Alert.alert(
        "打断并执行队首？",
        "Agent 会中断当前任务，然后继续发送队列中的第一条消息。",
        [
          { text: "继续运行", style: "cancel" },
          {
            text: "打断并继续",
            style: "destructive",
            onPress: () => {
              queuedAutoSendInFlightRef.current = false;
              workspace.cancel(conversation.id);
            },
          },
        ],
      );
      return;
    }
    Alert.alert(
      "停止当前任务？",
      "Agent 会中断当前运行中的回复和工具调用。",
      [
        { text: "继续运行", style: "cancel" },
        {
          text: "停止",
          style: "destructive",
          onPress: () => workspace.cancel(conversation.id),
        },
      ],
    );
  }, [conversation, queuedCodexPrompts.length, workspace]);

  const appendImageBlocks = useCallback((assets: ImagePicker.ImagePickerAsset[]) => {
    const blocks = assets
      .map(imageBlockFromAsset)
      .filter((block): block is AgentContentBlock => Boolean(block));
    if (blocks.length === 0) {
      Alert.alert("无法添加图片", "没有读取到图片数据，请换一张图片再试。");
      return;
    }

    const oversized = blocks.find((block) => (block.data?.length ?? 0) > MAX_IMAGE_DATA_URL_LENGTH);
    if (oversized) {
      Alert.alert("图片太大", "请选择较小的截图或照片。");
      return;
    }

    setAttachments((current) => {
      const room = MAX_IMAGE_ATTACHMENTS - current.length;
      if (room <= 0) {
        Alert.alert("图片已满", `一次最多发送 ${MAX_IMAGE_ATTACHMENTS} 张图片。`);
        return current;
      }
      return [...current, ...blocks.slice(0, room)];
    });
    Haptics.selectionAsync().catch(() => {});
  }, []);

  const pickImages = useCallback(async (source: "camera" | "library") => {
    if (!supportsImages) {
      Alert.alert("当前 Agent 不支持图片", "请切换到 Claude 或 Codex Agent，或使用支持图片输入的自定义 Agent。");
      return;
    }
    if (attachments.length >= MAX_IMAGE_ATTACHMENTS) {
      Alert.alert("图片已满", `一次最多发送 ${MAX_IMAGE_ATTACHMENTS} 张图片。`);
      return;
    }

    try {
      if (source === "camera") {
        const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
        if (!permissionResult.granted) {
          Alert.alert("需要相机权限", "允许访问相机后才能拍照发送。");
          return;
        }
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ["images"],
          base64: true,
          quality: 0.55,
        });
        if (!result.canceled) appendImageBlocks(result.assets.slice(0, 1));
        return;
      }

      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permissionResult.granted) {
        Alert.alert("需要相册权限", "允许访问相册后才能选择图片发送。");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        base64: true,
        quality: 0.55,
        allowsMultipleSelection: true,
        selectionLimit: Math.max(1, MAX_IMAGE_ATTACHMENTS - attachments.length),
      });
      if (!result.canceled) appendImageBlocks(result.assets);
    } catch (error) {
      Alert.alert("无法添加图片", error instanceof Error ? error.message : "图片选择失败");
    }
  }, [appendImageBlocks, attachments.length, supportsImages]);

  const composerMenuActions = useMemo<MenuAction[]>(() => {
    const commandAction = (
      name: string,
      title: string,
      image: string,
      options: { destructive?: boolean; requiresDraft?: boolean } = {},
    ): MenuAction | undefined => {
      const command = commandByName(name);
      if (!command) return undefined;
      return {
        id: `cmd:${name}`,
        title,
        image,
        attributes: {
          disabled: running || Boolean(command.disabledReason),
          destructive: options.destructive ?? command.destructive,
        },
      };
    };
    const agentActions = [
      commandAction("review", "Review 当前改动", "doc.text.magnifyingglass"),
      commandAction("subagents", "Subagents", "person.2.fill"),
      commandAction("compact", "压缩上下文", "square.stack.3d.up"),
      commandAction("new", "新上下文", "trash.fill", { destructive: true }),
    ].filter((action): action is MenuAction => Boolean(action));
    const gitActions = [
      commandAction("git-status", "Git 状态", "point.3.connected.trianglepath.dotted"),
      commandAction("git-diff", "Diff 摘要", "plus.forwardslash.minus"),
      commandAction("git-commit", "提交草稿内容", "checkmark.circle.fill"),
      commandAction("git-pull", "Pull", "arrow.down.circle"),
      commandAction("git-push", "Push", "arrow.up.circle"),
      commandAction("git-stash", "Stash", "tray"),
      commandAction("git-stash-pop", "Stash Pop", "arrow.counterclockwise"),
    ].filter((action): action is MenuAction => Boolean(action));
    const planAction: MenuAction | undefined = providerCapability?.supportsPlan || availableCommands.some((command) => command.name === "plan")
      ? {
        id: "toggle-plan",
        title: currentCollaborationMode === "plan" ? "退出 Plan mode" : "Plan mode",
        image: "checklist",
        state: currentCollaborationMode === "plan" ? "on" : "off",
        attributes: {
          disabled: running,
        },
      }
      : undefined;
    return [
      ...(planAction ? [planAction] : []),
      {
        id: "attach-library",
        title: "从相册选择",
        image: "photo",
        attributes: { disabled: !supportsImages || attachments.length >= MAX_IMAGE_ATTACHMENTS },
      },
      {
        id: "attach-camera",
        title: "拍照",
        image: "camera.fill",
        attributes: { disabled: !supportsImages || attachments.length >= MAX_IMAGE_ATTACHMENTS },
      },
      { id: "open-files", title: "引用文件", image: "doc.text.magnifyingglass" },
      { id: "open-preview", title: "端口预览", image: "safari" },
      ...(agentActions.length > 0 ? [{ title: "Agent", image: "sparkles", subactions: agentActions }] : []),
      ...(gitActions.length > 0 ? [{ title: "Git", image: "point.3.connected.trianglepath.dotted", subactions: gitActions }] : []),
    ];
  }, [
    attachments.length,
    availableCommands,
    commandByName,
    currentCollaborationMode,
    providerCapability?.supportsPlan,
    running,
    supportsImages,
  ]);

  const handleComposerMenuAction = useCallback((event: string) => {
    if (event === "toggle-plan") {
      togglePlanMode();
      return;
    }
    if (event === "attach-library") {
      pickImages("library").catch(() => {});
      return;
    }
    if (event === "attach-camera") {
      pickImages("camera").catch(() => {});
      return;
    }
    if (event === "open-files") {
      setFileDrawerInitialPath(null);
      setFileDrawerInitialDiff(null);
      setFileDrawerInitialLiveRead(true);
      setFileDrawerOpen(true);
      return;
    }
    if (event === "open-preview") {
      setPreviewOpen(true);
      return;
    }
    if (event.startsWith("cmd:")) {
      const name = event.slice("cmd:".length);
      if (name === "git-commit" || name === "git-stash") {
        useDraftForCommand(name);
        return;
      }
      runCommandByName(name);
    }
  }, [pickImages, runCommandByName, togglePlanMode, useDraftForCommand]);

  if (!conversation) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ color: theme.text, fontSize: 17, fontWeight: "700" }}>找不到对话</Text>
        <Pressable onPress={onBack} style={{ marginTop: 12 }}>
          <Text style={{ color: theme.accent, fontSize: 15, fontWeight: "700" }}>返回</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={0}
      style={{ flex: 1, backgroundColor: conversationPaper(theme) }}
    >
      <View
        style={{
          position: "absolute",
          top: insets.top + 4,
          left: 12,
          right: 12,
          zIndex: 20,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
        pointerEvents="box-none"
      >
        <GlassBar
          blurTint={theme.mode === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
          fallbackColor={theme.mode === "light" ? "rgba(250,250,250,0.62)" : "rgba(42,42,43,0.58)"}
          style={{
            borderRadius: 17,
            borderCurve: "continuous",
          }}
        >
          <Pressable
            onPress={onBack}
            hitSlop={8}
            style={({ pressed }) => ({
              width: 34,
              height: 34,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? "rgba(120,120,128,0.14)" : "transparent",
            })}
          >
            <AppSymbol name="chevron.left" size={18} color={theme.text} />
          </Pressable>
        </GlassBar>
        <GlassBar
          blurTint={theme.mode === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
          fallbackColor={theme.mode === "light" ? "rgba(250,250,250,0.62)" : "rgba(42,42,43,0.58)"}
          style={{
            borderRadius: 17,
            borderCurve: "continuous",
          }}
        >
          <Pressable
            onPress={() => setPreviewOpen(true)}
            hitSlop={8}
            style={({ pressed }) => ({
              width: 34,
              height: 34,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? "rgba(120,120,128,0.14)" : "transparent",
            })}
          >
            <AppSymbol name="safari" size={18} color={theme.textSecondary} />
          </Pressable>
        </GlassBar>
        <GlassBar
          blurTint={theme.mode === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
          fallbackColor={theme.mode === "light" ? "rgba(250,250,250,0.62)" : "rgba(42,42,43,0.58)"}
          style={{
            borderRadius: 17,
            borderCurve: "continuous",
          }}
        >
          <Pressable
            onPress={() => {
              setFileDrawerInitialPath(null);
              setFileDrawerInitialDiff(null);
              setFileDrawerInitialLiveRead(true);
              setFileDrawerOpen(true);
            }}
            hitSlop={8}
            style={({ pressed }) => ({
              width: 34,
              height: 34,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? "rgba(120,120,128,0.14)" : "transparent",
            })}
          >
            <AppSymbol name="doc.text.magnifyingglass" size={18} color={theme.textSecondary} />
          </Pressable>
        </GlassBar>
        <GlassBar
          blurTint={theme.mode === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
          fallbackColor={theme.mode === "light" ? "rgba(250,250,250,0.62)" : "rgba(42,42,43,0.58)"}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 38,
            borderRadius: 19,
            borderCurve: "continuous",
            paddingHorizontal: 14,
            justifyContent: "center",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
            {meta ? (
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: meta.color }} />
            ) : null}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.text, fontSize: 14, fontWeight: "800", fontFamily: MONO_FONT }} numberOfLines={1}>
                {conversation.title || "Agent"}
              </Text>
              <Text style={{ color: theme.textTertiary, fontSize: 10, marginTop: 2, fontWeight: "700", fontFamily: MONO_FONT }} numberOfLines={1}>
                {[displayProvider(conversation.provider), shortPath(conversation.cwd)].filter(Boolean).join(" · ")}
              </Text>
            </View>
            {syncLabel ? (
              <Text style={{ color: theme.textTertiary, fontSize: 10, fontWeight: "800", fontFamily: MONO_FONT }} numberOfLines={1}>
                {syncLabel}
              </Text>
            ) : null}
            {running ? <ActivityIndicator size="small" color={theme.accent} /> : null}
          </View>
        </GlassBar>
        <GlassBar
          blurTint={theme.mode === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
          fallbackColor={theme.mode === "light" ? "rgba(250,250,250,0.62)" : "rgba(42,42,43,0.58)"}
          style={{
            borderRadius: 17,
            borderCurve: "continuous",
          }}
        >
          <MenuView
            actions={[
              { id: "refresh", title: "刷新快照", image: "arrow.clockwise" },
              { id: "archive", title: conversation.archived ? "取消归档" : "归档", image: "archivebox" },
            ]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "refresh") {
                workspace.refreshConversation(conversation.id);
              }
              if (nativeEvent.event === "archive") {
                workspace.archive(conversation.id, !conversation.archived).then(onBack).catch((error) => {
                  Alert.alert("无法更新归档状态", error instanceof Error ? error.message : String(error));
                });
              }
            }}
          >
            <View
              style={{
                width: 34,
                height: 34,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AppSymbol name="ellipsis.circle" size={20} color={theme.textSecondary} />
            </View>
          </MenuView>
        </GlassBar>
      </View>

      <View style={{ flex: 1 }}>
        <LegendList
          ref={timelineRef}
          data={visibleTimeline}
          style={{ flex: 1 }}
          keyExtractor={(item) => item.id}
          renderItem={renderTimelineItem}
          ListEmptyComponent={timelineEmpty}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 18, paddingTop: insets.top + 64, paddingBottom: 28 }}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          scrollIndicatorInsets={{ top: insets.top + 60, bottom: 28 }}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          onScroll={handleTimelineScroll}
          onContentSizeChange={settleTimelineAtBottom}
          onLayout={settleTimelineAtBottom}
          scrollEventThrottle={16}
          estimatedItemSize={96}
          drawDistance={720}
          alignItemsAtEnd
          maintainScrollAtEnd={{ onDataChange: true, onLayout: true }}
          maintainScrollAtEndThreshold={0.2}
          maintainVisibleContentPosition={false}
        />
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: insets.top + 92,
            zIndex: 8,
          }}
        >
          <LinearGradient
            colors={topFadeColors}
            locations={[0, 0.38, 0.72, 1]}
            style={StyleSheet.absoluteFillObject}
          />
        </View>
        {!isTimelineNearBottom || hasNewOutput ? (
          <View
            pointerEvents="box-none"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 12,
              alignItems: "center",
            }}
          >
            <Pressable
              onPress={() => scrollTimelineToBottom(true)}
              hitSlop={8}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 22,
                borderCurve: "continuous",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
                backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                alignItems: "center",
                justifyContent: "center",
                shadowColor: "#000",
                shadowOpacity: theme.mode === "dark" ? 0.22 : 0.08,
                shadowRadius: 10,
                shadowOffset: { width: 0, height: 4 },
                elevation: 4,
              })}
            >
              <AppSymbol name="arrow.down" size={16} color={theme.text} />
            </Pressable>
          </View>
        ) : null}
      </View>

      <View
        style={{
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom + 2, 12),
          backgroundColor: conversationPaper(theme),
        }}
      >
        <View
          style={{
            borderRadius: 20,
            borderCurve: "continuous",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: subtleDivider(theme),
            backgroundColor: theme.mode === "light" ? "rgba(255,255,255,0.94)" : theme.bgCard,
            paddingHorizontal: 12,
            paddingTop: 9,
            paddingBottom: 9,
            gap: 7,
            shadowColor: "#000",
            shadowOpacity: theme.mode === "dark" ? 0.2 : 0.055,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 8 },
            elevation: 5,
          }}
        >
          {attachments.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View style={{ flexDirection: "row", gap: 8 }}>
                {attachments.map((attachment, index) => (
                  <View
                    key={`${attachment.mimeType}-${index}`}
                    style={{
                      width: 70,
                      height: 70,
                      borderRadius: 12,
                      borderCurve: "continuous",
                      overflow: "hidden",
                      backgroundColor: theme.bgInput,
                    }}
                  >
                    {attachment.data ? (
                      <Image source={{ uri: attachment.data }} contentFit="cover" style={{ width: "100%", height: "100%" }} />
                    ) : null}
                    <Pressable
                      onPress={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      hitSlop={8}
                      style={{
                        position: "absolute",
                        top: 4,
                        right: 4,
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "rgba(0,0,0,0.55)",
                      }}
                    >
                      <AppSymbol name="xmark" size={12} color="#fff" />
                    </Pressable>
                  </View>
                ))}
              </View>
            </ScrollView>
          ) : null}
          {commandPanelVisible && commandToken ? (
            <SlashCommandPanel
              commands={availableCommands}
              query={commandToken.query}
              theme={theme}
              onSelect={selectSlashCommand}
              onClose={closeSlashCommandPanel}
            />
          ) : null}
          {queuedCodexPrompts.length > 0 ? (
            <View
              style={{
                borderRadius: 14,
                borderCurve: "continuous",
                overflow: "hidden",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: subtleDivider(theme),
                backgroundColor: theme.mode === "light" ? "#f7f7f8" : "rgba(255,255,255,0.055)",
              }}
            >
              <View
                style={{
                  minHeight: 32,
                  paddingHorizontal: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: subtleDivider(theme),
                }}
              >
                <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
                  {queuedCodexPrompts.length} 条消息已排队
                </Text>
                <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
                  {canGuideRunningCodex ? "可引导当前任务" : "等待当前任务结束"}
                </Text>
              </View>
              <ScrollView
                style={{ maxHeight: 46 * 3 }}
                bounces={queuedCodexPrompts.length > 3}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={queuedCodexPrompts.length > 3}
              >
                {queuedCodexPrompts.map((prompt, index) => (
                  <View
                    key={prompt.id}
                    style={{
                      minHeight: 46,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                      borderTopColor: subtleDivider(theme),
                    }}
                  >
                    <AppSymbol name="arrow.turn.down.right" size={14} color={theme.textTertiary} />
                    <Text
                      style={{ flex: 1, color: theme.textSecondary, fontSize: 13, lineHeight: 18, fontWeight: "600" }}
                      numberOfLines={2}
                    >
                      {queuedPromptPreview(prompt)}
                    </Text>
                    <Pressable
                      onPress={() => guideQueuedPrompt(prompt)}
                      disabled={!canGuideRunningCodex}
                      hitSlop={8}
                      style={({ pressed }) => ({
                        minHeight: 30,
                        borderRadius: 15,
                        paddingHorizontal: 9,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 4,
                        backgroundColor: pressed
                          ? theme.bgInput
                          : canGuideRunningCodex ? theme.bgCard : "transparent",
                        opacity: canGuideRunningCodex ? 1 : 0.45,
                      })}
                    >
                      <AppSymbol name="arrow.turn.down.right" size={13} color={theme.textSecondary} />
                      <Text style={{ color: theme.textSecondary, fontSize: 13, fontWeight: "800" }}>引导</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => removeQueuedPrompt(prompt.id)}
                      hitSlop={8}
                      style={({ pressed }) => ({
                        width: 30,
                        height: 30,
                        borderRadius: 15,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: pressed ? theme.bgInput : "transparent",
                      })}
                    >
                      <AppSymbol name="trash.fill" size={14} color={theme.textTertiary} />
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            </View>
          ) : null}
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={canQueueRunningCodex ? "要求后续变更，@文件，/命令" : running ? "Agent 运行中，可先编辑草稿" : "询问 Agent，@文件，/命令"}
            placeholderTextColor={theme.textTertiary}
            multiline
            keyboardType="default"
            textContentType="none"
            autoCapitalize="sentences"
            autoCorrect
            spellCheck={false}
            returnKeyType="default"
            blurOnSubmit={false}
            style={{
              minHeight: 44,
              maxHeight: 132,
              color: theme.text,
              fontSize: 14,
              lineHeight: 20,
              paddingHorizontal: 4,
              paddingVertical: 4,
            }}
          />
          {running ? (
            <Text style={{ color: theme.textTertiary, fontSize: 11, lineHeight: 15 }}>
              {canQueueRunningCodex ? "当前任务运行中，发送会先排队；可在队列里点“引导”。" : "当前任务运行中，停止后再发送这条消息。"}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
            <MenuView
              actions={composerMenuActions}
              onPressAction={({ nativeEvent }) => handleComposerMenuAction(nativeEvent.event)}
            >
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 17,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <AppSymbol name="plus" size={18} color={theme.textSecondary} />
              </View>
            </MenuView>
            {permissionMenuActions.length > 0 ? (
              <MenuView
                actions={permissionMenuActions}
                onPressAction={({ nativeEvent }) => {
                  setPermissionModeWithGuard(valueFromMenuId<AgentPermissionMode>(nativeEvent.event));
                }}
              >
                <View
                  style={{
                    minWidth: 38,
                    height: 34,
                    borderRadius: 17,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 2,
                    paddingHorizontal: 5,
                  }}
                >
                  <AppSymbol name={permission.icon} size={16} color={permission.color} />
                  <AppSymbol name="chevron.down" size={8} color={permission.color} />
                </View>
              </MenuView>
            ) : null}
            {runtimeModelReady && runtimeMenuActions.length > 0 ? (
              <MenuView
                actions={runtimeMenuActions}
                onPressAction={({ nativeEvent }) => {
                  const event = nativeEvent.event;
                  if (event.startsWith("model:")) {
                    commitModel(valueFromMenuId<string>(event.slice("model:".length)));
                  } else if (event.startsWith("effort:")) {
                    commitEffort(valueFromMenuId<AgentReasoningEffort>(event.slice("effort:".length)));
                  } else if (event.startsWith("speed:")) {
                    commitServiceTier(valueFromMenuId<AgentServiceTier>(event.slice("speed:".length)));
                  }
                }}
              >
                <View
                  style={{
                    height: 34,
                    maxWidth: 190,
                    borderRadius: 999,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingHorizontal: 8,
                  }}
                >
                  <Text
                    style={{ color: theme.text, fontSize: 15, lineHeight: 20, fontWeight: "700", fontFamily: MONO_FONT, flexShrink: 1 }}
                    numberOfLines={1}
                  >
                    {runtimeLabel}
                  </Text>
                  <AppSymbol name="chevron.down" size={10} color={theme.textTertiary} />
                </View>
              </MenuView>
            ) : (
              <View
                style={{
                  height: 34,
                  justifyContent: "center",
                  paddingHorizontal: 8,
                }}
              >
                <Text
                  style={{ color: theme.textTertiary, fontSize: 14, lineHeight: 20, fontWeight: "700", fontFamily: MONO_FONT }}
                  numberOfLines={1}
                >
                  {runtimeLabel}
                </Text>
              </View>
            )}
            {currentCollaborationMode === "plan" && (providerCapability?.supportsPlan || availableCommands.some((command) => command.name === "plan")) ? (
              <View
                style={{
                  height: 34,
                  borderLeftWidth: StyleSheet.hairlineWidth,
                  borderLeftColor: theme.separator,
                  paddingLeft: 8,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <AppSymbol name="checklist" size={13} color={theme.accent} />
                <Text style={{ color: theme.accent, fontSize: 12, fontWeight: "700" }}>Plan</Text>
              </View>
            ) : null}
            <View style={{ flex: 1 }} />
            {running && !canSubmitComposer ? (
              <Pressable
                onPress={cancelRunningTurn}
                style={({ pressed }) => ({
                  width: 42,
                  height: 42,
                  borderRadius: 21,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed
                    ? theme.textSecondary
                    : theme.mode === "light" ? "#111113" : "#f5f5f7",
                })}
              >
                <AppSymbol name="stop.fill" size={16} color={theme.mode === "light" ? "#fff" : "#111113"} />
              </Pressable>
            ) : (
              <Pressable
                onPress={send}
                disabled={!canSubmitComposer}
                style={({ pressed }) => ({
                  width: 42,
                  height: 42,
                  borderRadius: 21,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed
                    ? theme.textSecondary
                    : theme.mode === "light" ? "#111113" : "#f5f5f7",
                  opacity: canSubmitComposer ? 1 : 0.45,
                })}
              >
                <AppSymbol name="arrow.up" size={18} color={theme.mode === "light" ? "#fff" : "#111113"} />
              </Pressable>
            )}
          </View>
        </View>
      </View>
      <Modal
        visible={previewOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setPreviewOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: theme.bg }}>
          <View
            style={{
              paddingTop: insets.top + 8,
              paddingHorizontal: 12,
              paddingBottom: 8,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.border,
            }}
          >
            <Text style={{ color: theme.text, fontSize: 16, fontWeight: "800" }}>端口预览</Text>
            <Pressable
              onPress={() => setPreviewOpen(false)}
              style={({ pressed }) => ({
                width: 34,
                height: 34,
                borderRadius: 17,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? theme.bgInput : "transparent",
              })}
            >
              <AppSymbol name="xmark" size={16} color={theme.textSecondary} />
            </Pressable>
          </View>
          <BrowserView
            gatewayUrl={conversation.serverUrl}
            hostDeviceId={conversation.hostDeviceId}
            deviceToken={deviceToken ?? null}
            authToken={authToken ?? null}
            isFullscreen={false}
            onToggleFullscreen={() => {}}
          />
        </View>
      </Modal>
      <FilePreviewDrawer
        visible={fileDrawerOpen}
        conversationId={conversation.id}
        cwd={conversation.cwd || "~"}
        workspace={workspace}
        theme={theme}
        topInset={insets.top}
        bottomInset={insets.bottom}
        initialFilePath={fileDrawerInitialPath}
        initialDiff={fileDrawerInitialDiff}
        initialLiveRead={fileDrawerInitialLiveRead}
        onClose={() => {
          setFileDrawerOpen(false);
          setFileDrawerInitialPath(null);
          setFileDrawerInitialDiff(null);
          setFileDrawerInitialLiveRead(true);
        }}
        onInsertReference={insertFileReference}
      />
    </KeyboardAvoidingView>
  );
}
