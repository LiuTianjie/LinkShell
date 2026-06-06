import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Clipboard,
  Keyboard,
  KeyboardEvent,
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
import { LegendList, type LegendListRef, type LegendListRenderItemProps } from "@legendapp/list";
import { MenuView } from "@react-native-menu/menu";
import Markdown from "react-native-markdown-display";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import { GlassBar } from "../components/GlassBar";
import type { AgentFileEntry, AgentFileReadResult, AgentWorkspaceHandle } from "../hooks/useAgentWorkspace";
import { useComposerDictation } from "../hooks/useComposerDictation";
import type {
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
} from "../storage/agent-workspace";
import { useTheme, type Theme } from "../theme";

interface AgentConversationScreenProps {
  conversationId: string;
  workspace: AgentWorkspaceHandle;
  isRestoring?: boolean;
  onBack: () => void;
}

type TimelineBottomSpacer = {
  id: "__timeline-bottom-spacer";
  type: "bottom_spacer";
  spacerHeight: number;
};

type TimelineListItem = AgentTimelineItem | TimelineBottomSpacer;

type Option<T extends string> = { label: string; value?: T; image?: string };
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
  { label: "默认权限", value: undefined, image: "hand.raised.fill" },
  { label: "只读", value: "read_only", image: "eye.fill" },
  { label: "自动审查", value: "workspace_write", image: "lock.shield.fill" },
  { label: "完全访问权限", value: "full_access", image: "lock.open.fill" },
];

const MAX_IMAGE_ATTACHMENTS = 3;
const MAX_IMAGE_DATA_URL_LENGTH = 4_000_000;
const FILE_PREVIEW_MAX_BYTES = 256_000;
const DEFAULT_OPTION_ID = "__default__";
const MONO_FONT = Platform.select({ ios: "Menlo", android: "monospace" });

function timelineSurface(theme: Theme): string {
  return theme.mode === "light" ? "rgba(255,255,255,0.78)" : "rgba(255,255,255,0.055)";
}

function agentEventSurface(theme: Theme): string {
  return theme.mode === "light" ? "rgba(255,255,255,0.64)" : "rgba(255,255,255,0.038)";
}

function agentEventBorder(theme: Theme): string {
  return theme.mode === "light" ? "rgba(60,60,67,0.13)" : "rgba(255,255,255,0.08)";
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
  if (status === "completed") {
    return {
      label: "完成",
      color: theme.success,
      bg: theme.mode === "light" ? "rgba(26, 171, 110, 0.10)" : "rgba(78, 222, 163, 0.12)",
    };
  }
  if (status === "pending") return { label: "待执行", color: theme.textTertiary, bg: theme.bgInput };
  return null;
}

function permissionMeta(mode: AgentPermissionMode | undefined, theme: Theme) {
  if (mode === "full_access") {
    return { label: "完全访问权限", icon: "lock.open.fill", color: theme.warning, bg: theme.accentLight };
  }
  if (mode === "workspace_write") {
    return { label: "自动审查", icon: "lock.shield.fill", color: theme.accent, bg: theme.accentLight };
  }
  if (mode === "read_only") {
    return { label: "只读", icon: "eye.fill", color: theme.textSecondary, bg: theme.bgInput };
  }
  return { label: "默认权限", icon: "hand.raised.fill", color: theme.textSecondary, bg: theme.bgInput };
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
  return [{ label: "默认模型", value: undefined }];
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
  return [];
}

function permissionOptionsFor(
  provider: AgentConversationRecord["provider"],
  capabilities: AgentCapabilities | undefined,
): Option<AgentPermissionMode>[] {
  const providerCapability = providerCapabilityFor(provider, capabilities);
  if (providerCapability?.permissionModes) {
    if (providerCapability.permissionModes.length === 0) return [];
    return [
      { label: "默认权限", value: undefined, image: "hand.raised.fill" },
      ...PERMISSION_OPTIONS.filter((option) =>
        option.value ? providerCapability.permissionModes?.includes(option.value) : false,
      ),
    ];
  }
  return PERMISSION_OPTIONS;
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

function formatRuntime(model: string | undefined, effort: AgentReasoningEffort | undefined, modelOptions: Option<string>[]): string {
  const modelLabel = modelOptions.find((item) => item.value === model)?.label ?? model ?? "默认模型";
  return `${modelLabel.replace(/^GPT-/, "")} · ${formatEffort(effort)}`;
}

function formatModel(model: string | undefined, modelOptions: Option<string>[]): string {
  const label = modelOptions.find((item) => item.value === model)?.label ?? model ?? "默认模型";
  return label.replace(/^GPT-/, "");
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

// The trailing "@token" before the cursor (end of text), used to drive the
// @-file-mention palette. Split into a directory part and a filter so
// "@src/co" browses src/ filtering "co" — mirrors the web composer.
function trailingMentionToken(
  text: string,
): { query: string; dir: string; filter: string; start: number; end: number } | null {
  const match = /(?:^|\s)@(\S*)$/.exec(text);
  if (!match) return null;
  const query = match[1];
  const slash = query.lastIndexOf("/");
  const dir = slash >= 0 ? query.slice(0, slash) : "";
  const filter = slash >= 0 ? query.slice(slash + 1) : query;
  return { query, dir, filter, start: text.length - query.length - 1, end: text.length };
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
};

function displayProvider(provider: AgentConversationRecord["provider"]): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  return "Custom";
}

function looksLikeDiff(text: string | undefined): boolean {
  if (!text) return false;
  const value = text.trim();
  return (
    value.startsWith("diff --git ") ||
    value.startsWith("@@ ") ||
    value.includes("\n@@ ") ||
    (value.includes("\n--- ") && value.includes("\n+++ "))
  );
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

function parentPath(path: string): string {
  const clean = path.replace(/\/+$/, "");
  if (!clean || clean === "/") return "/";
  const index = clean.lastIndexOf("/");
  return index <= 0 ? "/" : clean.slice(0, index);
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).pop() || path || "/";
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
          {code}
        </Text>
      </ScrollView>
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
}: {
  blocks?: AgentContentBlock[];
  fallbackText?: string;
  theme: Theme;
  inverse?: boolean;
  monospace?: boolean;
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
              {block.data ? (
                <Image
                  source={{ uri: block.data }}
                  contentFit="cover"
                  style={{ width: 220, maxWidth: "100%", aspectRatio: 4 / 3 }}
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
          <MarkdownContent key={`text-${index}`} text={block.text} theme={theme} inverse={inverse} monospace={monospace} />
        ) : null;
      })}
    </View>
  );
}

function UserMessageContent({
  blocks,
  fallbackText,
  theme,
}: {
  blocks?: AgentContentBlock[];
  fallbackText?: string;
  theme: Theme;
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
          return (
            <View
              key={`image-${index}`}
              style={{
                borderRadius: 10,
                borderCurve: "continuous",
                overflow: "hidden",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
                backgroundColor: theme.bgInput,
              }}
            >
              {block.data ? (
                <Image
                  source={{ uri: block.data }}
                  contentFit="cover"
                  style={{ width: 220, maxWidth: "100%", aspectRatio: 4 / 3 }}
                />
              ) : (
                <View style={{ width: 220, maxWidth: "100%", aspectRatio: 4 / 3, alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <AppSymbol name="photo" size={22} color={theme.textTertiary} />
                  <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
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
              color: theme.textSecondary,
              fontSize: 14,
              lineHeight: 20,
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

const TimelineSeparator = () => <View style={{ height: 12 }} />;

const MarkdownContent = memo(function MarkdownContent({
  text,
  theme,
  inverse = false,
  monospace = false,
}: {
  text: string;
  theme: Theme;
  inverse?: boolean;
  monospace?: boolean;
}) {
  const color = inverse ? "#fff" : theme.text;
  const secondaryColor = inverse ? "rgba(255,255,255,0.82)" : theme.textSecondary;
  const markdownStyle = useMemo(() => ({
    body: {
      color,
      fontFamily: !inverse && monospace ? MONO_FONT : undefined,
      fontSize: inverse ? 14 : 14,
      lineHeight: inverse ? 21 : 21,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 9,
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
      marginBottom: 8,
    },
    ordered_list: {
      marginBottom: 8,
    },
    list_item: {
      marginBottom: 3,
    },
    bullet_list_icon: {
      color: secondaryColor,
    },
    ordered_list_icon: {
      color: secondaryColor,
    },
    code_inline: {
      color,
      backgroundColor: inverse ? "rgba(255,255,255,0.18)" : theme.bgInput,
      borderWidth: 0,
      borderRadius: 5,
      paddingHorizontal: 4,
      fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
      fontSize: 13,
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
    fence: (node: any) => (
      <CodeBlock
        key={node.key}
        label={node.sourceInfo || "代码"}
        code={node.content ?? ""}
        theme={theme}
      />
    ),
    code_block: (node: any) => (
      <CodeBlock
        key={node.key}
        label="代码"
        code={node.content ?? ""}
        theme={theme}
      />
    ),
  }), [theme]);
  return (
    <View style={{ width: "100%" }}>
      <Markdown
        mergeStyle={false}
        style={markdownStyle}
        rules={rules}
        onLinkPress={(url) => {
          if (!/^https?:\/\//i.test(url)) return false;
          Linking.openURL(url).catch(() => {});
          return false;
        }}
      >
        {text}
      </Markdown>
    </View>
  );
});

const FileChangeCard = memo(function FileChangeCard({ tool, theme }: { tool: AgentToolCall; theme: Theme }) {
  const [expanded, setExpanded] = useState(false);
  const input = tool.input?.trim();
  const output = tool.output?.trim();
  const hasDiff = looksLikeDiff(output);
  const diffLineCount = output ? output.split("\n").length : 0;
  const stats = useMemo(() => hasDiff && output ? diffStats(output, input) : null, [hasDiff, input, output]);
  const entries = useMemo(() => output ? diffEntries(output, input) : diffEntries("", input), [input, output]);
  const meta = toolStatusMeta(tool.status, theme);
  const canExpand = Boolean(output || input);

  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        overflow: "hidden",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
      }}
    >
      <Pressable
        onPress={() => canExpand && setExpanded((value) => !value)}
        disabled={!canExpand}
        style={{
          minHeight: 46,
          paddingHorizontal: 12,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
        }}
      >
        <AppSymbol name="pencil.line" size={16} color={theme.textTertiary} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.text, fontSize: 14, fontWeight: "800" }} numberOfLines={1}>
            {entries.length > 1 ? `${entries.length} 个文件修改` : "文件修改"}
          </Text>
          {stats ? (
            <Text style={{ color: theme.textTertiary, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
              {stats.files.length > 0 ? stats.files.map(shortPath).join("、") : "工作区 diff"}
            </Text>
          ) : input ? (
            <Text style={{ color: theme.textTertiary, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
              {input.split("\n").map(shortPath).join("、")}
            </Text>
          ) : null}
        </View>
        {stats ? (
          <View style={{ flexDirection: "row", gap: 4 }}>
            <View style={{ borderRadius: 999, paddingHorizontal: 6, paddingVertical: 3, backgroundColor: "rgba(52, 199, 89, 0.12)" }}>
              <Text style={{ color: theme.success, fontSize: 11, fontWeight: "800" }}>+{stats.added}</Text>
            </View>
            <View style={{ borderRadius: 999, paddingHorizontal: 6, paddingVertical: 3, backgroundColor: "rgba(255, 59, 48, 0.12)" }}>
              <Text style={{ color: theme.error, fontSize: 11, fontWeight: "800" }}>-{stats.removed}</Text>
            </View>
          </View>
        ) : meta ? (
          <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: meta.bg }}>
            <Text style={{ color: meta.color, fontSize: 11, fontWeight: "700" }}>{meta.label}</Text>
          </View>
        ) : null}
        {canExpand ? <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={13} color={theme.textTertiary} /> : null}
      </Pressable>

      {entries.length > 0 ? (
        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }}>
          {entries.slice(0, expanded ? entries.length : 4).map((entry, index) => (
            <View
              key={`${entry.path}-${index}`}
              style={{
                minHeight: 38,
                paddingHorizontal: 12,
                paddingVertical: 8,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                borderTopColor: theme.separator,
              }}
            >
              <Text
                selectable
                style={{ flex: 1, color: theme.textSecondary, fontSize: 13 }}
                numberOfLines={1}
              >
                {shortPath(entry.path)}
              </Text>
              {entry.added > 0 || entry.removed > 0 ? (
                <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "800" }}>
                  <Text style={{ color: theme.success }}>+{entry.added}</Text>
                  <Text> </Text>
                  <Text style={{ color: theme.error }}>-{entry.removed}</Text>
                </Text>
              ) : null}
            </View>
          ))}
          {!expanded && entries.length > 4 ? (
            <Text style={{ paddingHorizontal: 12, paddingBottom: 9, color: theme.textTertiary, fontSize: 12 }}>
              还有 {entries.length - 4} 个文件
            </Text>
          ) : null}
        </View>
      ) : null}

      {hasDiff && output && expanded ? (
        <View style={{ padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }}>
          <DiffBlock diff={output} theme={theme} expanded />
        </View>
      ) : !hasDiff && output && expanded ? (
        <View style={{ gap: 8, padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }}>
          <Text style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }}>
            这条历史事件没有携带 diff。升级后的 CLI 会优先展示补丁内容；旧记录只能显示工具返回摘要。
          </Text>
          <CodeBlock label="修改摘要" code={output} theme={theme} maxLines={6} />
        </View>
      ) : !output && input && expanded ? (
        <View style={{ padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }}>
          <CodeBlock label="修改文件" code={input} theme={theme} maxLines={6} />
        </View>
      ) : null}

      {canExpand ? (
        <Pressable
          onPress={() => setExpanded((value) => !value)}
          hitSlop={8}
          style={{
            minHeight: 38,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.separator,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: theme.accent, fontSize: 12, fontWeight: "800" }}>
            {expanded
              ? hasDiff ? "收起 diff" : "收起详情"
              : hasDiff ? `查看 diff${diffLineCount > 0 ? `（${diffLineCount} 行）` : ""}` : "查看详情"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const ToolCard = memo(function ToolCard({ tool, theme }: { tool: AgentToolCall; theme: Theme }) {
  const [expanded, setExpanded] = useState(false);
  if (tool.name.includes("文件")) return <FileChangeCard tool={tool} theme={theme} />;
  const input = tool.input?.trim();
  const output = tool.output?.trim();
  const meta = toolStatusMeta(tool.status, theme);
  const language = commandLanguage(tool.name);
  const canExpand = Boolean(input || output);
  const isCommand = tool.name.includes("命令");
  const commandSummary = isCommand && input ? humanizeCommand(input, tool.status === "running") : null;
  const title = commandSummary ? commandSummary.verb : tool.name;
  const subtitle = commandSummary ? commandSummary.target : input || output || "";
  const iconName = tool.name.includes("MCP") ? "server.rack" : "terminal.fill";

  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        overflow: "hidden",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
      }}
    >
      <Pressable
        onPress={() => canExpand && setExpanded((value) => !value)}
        disabled={!canExpand}
        style={{
          minHeight: 44,
          paddingHorizontal: 12,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
        }}
      >
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: tool.status === "running" ? theme.accentLight : theme.bgInput,
          }}
        >
          <AppSymbol name={iconName} size={14} color={tool.status === "running" ? theme.accent : theme.textTertiary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text selectable style={{ color: theme.text, fontSize: 13, fontWeight: "800" }} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text selectable style={{ color: theme.textTertiary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {meta ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: meta.bg }}>
            {tool.status === "running" ? <ActivityIndicator size="small" color={meta.color} /> : null}
            <Text style={{ color: meta.color, fontSize: 11, fontWeight: "700" }}>{meta.label}</Text>
          </View>
        ) : null}
        {canExpand ? <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={13} color={theme.textTertiary} /> : null}
      </Pressable>
      {expanded ? (
        <View style={{ gap: 8, padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }}>
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
            borderTopWidth: expanded ? StyleSheet.hairlineWidth : 0,
            borderTopColor: theme.separator,
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
  const canExpand = Boolean(text && text.length > 120);
  return (
    <Pressable
      onPress={() => canExpand && setExpanded((value) => !value)}
      disabled={!canExpand}
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
        backgroundColor: agentEventSurface(theme),
        paddingHorizontal: 10,
        paddingVertical: 9,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: running ? theme.accentLight : theme.bgInput,
        }}
      >
        <AppSymbol name={icon} size={13} color={running ? theme.accent : theme.textTertiary} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "800" }} numberOfLines={1}>
            {title}
          </Text>
          {running ? <ActivityIndicator size="small" color={theme.accent} /> : null}
        </View>
        {text ? (
          <Text
            selectable
            style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }}
            numberOfLines={expanded ? undefined : 2}
          >
            {text}
          </Text>
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
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
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
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
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
}: {
  item: AgentTimelineItem;
  theme: Theme;
  onPermission: (requestId: string, outcome: "allow" | "deny" | "cancelled", optionId?: string) => void;
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
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
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
            <MarkdownContent text={item.permission!.context} theme={theme} />
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
    <View
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        borderRadius: 999,
        backgroundColor: theme.accentLight,
        paddingHorizontal: 9,
        paddingVertical: 5,
      }}
    >
      <ActivityIndicator size="small" color={theme.accent} />
      <Text style={{ color: theme.accent, fontSize: 12, fontWeight: "800" }}>正在生成</Text>
    </View>
  );
}

function noticeAccent(kind: AgentNotice["kind"], theme: Theme): { bg: string; color: string; icon: string } {
  if (kind === "warning" || kind === "native_unsupported") {
    return { bg: theme.errorLight, color: theme.error, icon: "exclamationmark.triangle.fill" };
  }
  if (kind === "model_changed") {
    return { bg: theme.accentLight, color: theme.accent, icon: "sparkles" };
  }
  if (kind === "effort_changed") {
    return { bg: theme.accentLight, color: theme.accent, icon: "textformat.size.larger" };
  }
  if (kind === "permission_changed") {
    return { bg: theme.accentLight, color: theme.accent, icon: "lock.shield.fill" };
  }
  return { bg: theme.bgInput, color: theme.textSecondary, icon: "info.circle.fill" };
}

function NoticeStrip({
  notices,
  theme,
  onDismiss,
}: {
  notices: AgentNotice[];
  theme: Theme;
  onDismiss: (id: string) => void;
}) {
  if (notices.length === 0) return null;
  return (
    <View style={{ gap: 6, paddingBottom: 6 }}>
      {notices.map((notice) => {
        const accent = noticeAccent(notice.kind, theme);
        return (
          <Pressable
            key={notice.id}
            onPress={() => onDismiss(notice.id)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 12,
              borderCurve: "continuous",
              backgroundColor: accent.bg,
            }}
          >
            <AppSymbol name={accent.icon} size={13} color={accent.color} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: accent.color, fontSize: 12, fontWeight: "800" }} numberOfLines={1}>
                {notice.title}
              </Text>
              {notice.detail ? (
                <Text style={{ color: theme.textTertiary, fontSize: 11, marginTop: 1 }} numberOfLines={2}>
                  {notice.detail}
                </Text>
              ) : null}
            </View>
            <AppSymbol name="xmark" size={11} color={theme.textTertiary} />
          </Pressable>
        );
      })}
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

function MentionPanel({
  entries,
  loading,
  error,
  currentDir,
  canNavigateUp,
  theme,
  onSelect,
  onNavigateUp,
  onClose,
}: {
  entries: AgentFileEntry[];
  loading: boolean;
  error?: string;
  currentDir: string;
  canNavigateUp: boolean;
  theme: Theme;
  onSelect: (entry: AgentFileEntry) => void;
  onNavigateUp: () => void;
  onClose: () => void;
}) {
  return (
    <View style={{ borderRadius: 12, borderCurve: "continuous", backgroundColor: timelineSurface(theme), borderWidth: StyleSheet.hairlineWidth, borderColor: theme.separator, overflow: "hidden" }}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.separator, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AppSymbol name="at" size={12} color={theme.textTertiary} />
        <Text style={{ flex: 1, color: theme.textSecondary, fontSize: 12, fontWeight: "800" }} numberOfLines={1}>
          {currentDir || "引用文件"}
        </Text>
        {loading ? <ActivityIndicator size="small" color={theme.accent} /> : null}
        <Pressable onPress={onClose} hitSlop={8}>
          <AppSymbol name="xmark" size={12} color={theme.textTertiary} />
        </Pressable>
      </View>
      {error ? (
        <View style={{ padding: 12 }}>
          <Text style={{ color: theme.error, fontSize: 12, lineHeight: 17 }}>{error}</Text>
        </View>
      ) : entries.length === 0 && !loading && !canNavigateUp ? (
        <View style={{ padding: 12 }}>
          <Text style={{ color: theme.textTertiary, fontSize: 13, fontWeight: "700" }}>没有匹配的文件</Text>
        </View>
      ) : (
        <ScrollView style={{ maxHeight: 280 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={entries.length > 6}>
          {canNavigateUp ? (
            <Pressable
              onPress={onNavigateUp}
              style={({ pressed }) => ({
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: theme.separator,
                backgroundColor: pressed ? theme.bgInput : "transparent",
                flexDirection: "row",
                gap: 9,
                alignItems: "center",
              })}
            >
              <AppSymbol name="arrow.up.left" size={15} color={theme.textTertiary} />
              <Text style={{ flex: 1, color: theme.textSecondary, fontSize: 13, fontWeight: "700", fontFamily: MONO_FONT }}>..</Text>
            </Pressable>
          ) : null}
          {entries.map((entry, index) => (
            <Pressable
              key={entry.path}
              onPress={() => onSelect(entry)}
              style={({ pressed }) => ({
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderBottomWidth: index === entries.length - 1 ? 0 : StyleSheet.hairlineWidth,
                borderBottomColor: theme.separator,
                backgroundColor: pressed ? theme.bgInput : "transparent",
                flexDirection: "row",
                gap: 9,
                alignItems: "center",
              })}
            >
              <AppSymbol
                name={entry.isDirectory ? "folder.fill" : "doc.text"}
                size={15}
                color={entry.isDirectory ? theme.accent : theme.textSecondary}
              />
              <Text style={{ flex: 1, color: theme.text, fontSize: 13, fontWeight: "600", fontFamily: MONO_FONT }} numberOfLines={1}>
                {entry.name}{entry.isDirectory ? "/" : ""}
              </Text>
              {entry.isDirectory ? <AppSymbol name="chevron.right" size={12} color={theme.textTertiary} /> : null}
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function AssistantMessage({
  item,
  text,
  theme,
}: {
  item: AgentTimelineItem;
  text: string;
  theme: Theme;
}) {
  const [copied, setCopied] = useState(false);
  const hasBody = Boolean(text || item.content?.length);
  const copyText = (text || (item.content ?? [])
    .map((block) => block.type === "text" ? block.text ?? "" : "")
    .filter(Boolean)
    .join("\n"))
    .trim();
  const canCopy = copyText.length > 0;
  const copyAssistantMessage = useCallback(() => {
    if (!canCopy) return;
    copy(copyText).then((ok) => {
      if (!ok) {
        Alert.alert("复制失败", "系统剪贴板暂不可用，请长按文本手动复制。");
        return;
      }
      Haptics.selectionAsync().catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {
      Alert.alert("复制失败", "系统剪贴板暂不可用，请长按文本手动复制。");
    });
  }, [canCopy, copyText]);

  return (
    <View style={{ gap: 7, paddingVertical: 3 }}>
      {hasBody ? (
        <View
          style={{
            borderRadius: 10,
            borderCurve: "continuous",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: agentEventBorder(theme),
            backgroundColor: theme.mode === "light" ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.045)",
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        >
          <MessageContent blocks={item.content} fallbackText={text} theme={theme} monospace={false} />
        </View>
      ) : null}
      {item.isStreaming ? <StreamingPill theme={theme} /> : null}
      {canCopy ? (
        <Pressable
          onPress={copyAssistantMessage}
          hitSlop={8}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            borderRadius: 999,
            paddingHorizontal: 8,
            paddingVertical: 4,
            backgroundColor: pressed ? theme.bgInput : "transparent",
            opacity: pressed ? 0.72 : 1,
          })}
        >
          <AppSymbol name={copied ? "checkmark" : "doc.on.doc"} size={12} color={copied ? theme.success : theme.textTertiary} />
          <Text style={{ color: copied ? theme.success : theme.textTertiary, fontSize: 11, fontWeight: "800" }}>
            {copied ? "已复制" : "复制回复"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function userMessageDeliveryLabel(item: AgentTimelineItem): { text: string; pending: boolean } | null {
  const delivery = item.metadata?.delivery;
  if (delivery !== "steer" && delivery !== "queued" && delivery !== "new_turn") return null;
  if (item.metadata?.fallbackFrom === "steer") {
    return { text: "已作为新消息发送", pending: false };
  }
  if (delivery === "queued") {
    return { text: "排队中", pending: false };
  }
  if (delivery === "steer") {
    return { text: "已引导", pending: false };
  }
  return null;
}

function isQueuedFollowUpItem(item: AgentTimelineItem, conversationStatus?: string): boolean {
  return item.type === "message" &&
    item.role === "user" &&
    (item.metadata?.delivery === "queued" || item.metadata?.delivery === "steer") &&
    item.metadata?.fallbackFrom !== "steer" &&
    item.metadata?.queuedSent !== true &&
    item.metadata?.queuedDiscarded !== true &&
    (item.metadata?.optimistic === true || conversationStatus === "running");
}

function isQueuedFollowUpPlaceholder(item: AgentTimelineItem): boolean {
  return item.type === "message" &&
    item.role === "user" &&
    item.metadata?.delivery === "queued";
}

function queuedFollowUpText(blocks: AgentContentBlock[] | undefined): string {
  const text = (blocks ?? [])
    .map((block) => block.type === "text" ? block.text ?? "" : "图片附件")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function isTimelineBottomSpacer(item: TimelineListItem): item is TimelineBottomSpacer {
  return item.type === "bottom_spacer";
}

function QueuedFollowUpList({
  items,
  theme,
  canSteer,
  onSteer,
  onDiscard,
}: {
  items: AgentTimelineItem[];
  theme: Theme;
  canSteer: boolean;
  onSteer: (item: AgentTimelineItem) => void;
  onDiscard: (item: AgentTimelineItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <View
      style={{
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.separator,
        overflow: "hidden",
        backgroundColor: theme.mode === "light" ? "rgba(255,255,255,0.82)" : "rgba(255,255,255,0.035)",
      }}
    >
      <ScrollView
        style={{ maxHeight: 108 }}
        contentContainerStyle={{ paddingVertical: 2 }}
        showsVerticalScrollIndicator={items.length > 3}
        keyboardShouldPersistTaps="handled"
      >
        {items.map((item, index) => {
          const text = item.text || queuedFollowUpText(item.content) || "后续指令";
          const canInsert = text.trim().length > 0;
          return (
            <View
              key={item.id}
              style={{
                minHeight: 36,
                paddingHorizontal: 14,
                paddingVertical: 7,
                borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                borderTopColor: theme.separator,
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
              }}
            >
              <AppSymbol name="arrow.up" size={12} color={theme.textTertiary} />
              <Text
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: theme.textSecondary,
                  fontSize: 12,
                  lineHeight: 16,
                }}
                numberOfLines={2}
              >
                {text}
              </Text>
              <Pressable
                disabled={!canInsert}
                onPress={() => onSteer(item)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="立即引导当前回复"
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  borderRadius: 999,
                  backgroundColor: pressed ? theme.accentLight : "transparent",
                  paddingHorizontal: 6,
                  paddingVertical: 3,
                  opacity: canInsert ? 1 : 0.45,
                  display: canSteer ? "flex" : "none",
                })}
              >
                <AppSymbol name="arrow.turn.up.right" size={10} color={theme.accent} />
                <Text style={{ color: theme.accent, fontSize: 11, fontWeight: "800" }}>
                  引导
                </Text>
              </Pressable>
              <Pressable
                onPress={() => onDiscard(item)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="删除排队消息"
                style={({ pressed }) => ({
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? theme.bgInput : "transparent",
                })}
              >
                <AppSymbol name="trash" size={12} color={theme.textTertiary} />
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

type AgentRailTone = "default" | "running" | "warning" | "error" | "success";

function agentRailColor(tone: AgentRailTone, theme: Theme): string {
  if (tone === "running") return theme.accent;
  if (tone === "warning") return theme.warning;
  if (tone === "error") return theme.error;
  if (tone === "success") return theme.success;
  return theme.textTertiary;
}

function AgentTimelineBlock({
  children,
  theme,
  tone = "default",
}: {
  children: React.ReactNode;
  theme: Theme;
  tone?: AgentRailTone;
}) {
  const railColor = agentRailColor(tone, theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "stretch", gap: 9 }}>
      <View style={{ width: 28, alignItems: "center" }}>
        <View style={{ width: StyleSheet.hairlineWidth, height: 8, backgroundColor: theme.separator }} />
        <View
          style={{
            width: 9,
            height: 9,
            borderRadius: 5,
            backgroundColor: railColor,
            opacity: tone === "default" ? 0.55 : 1,
          }}
        />
        <View style={{ width: StyleSheet.hairlineWidth, flex: 1, minHeight: 8, backgroundColor: theme.separator }} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {children}
      </View>
    </View>
  );
}

function SystemMessageCard({ text, theme }: { text: string; theme: Theme }) {
  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
        paddingHorizontal: 10,
        paddingVertical: 9,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
      }}
    >
      <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: theme.bgInput }}>
        <AppSymbol name="info.circle" size={13} color={theme.textTertiary} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "900" }}>
          系统
        </Text>
        <Text selectable style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }}>
          {text}
        </Text>
      </View>
    </View>
  );
}

function UserMessageCard({
  item,
  text,
  theme,
  deliveryLabel,
  onEdit,
}: {
  item: AgentTimelineItem;
  text: string;
  theme: Theme;
  deliveryLabel: { text: string; pending: boolean } | null;
  onEdit?: (text: string) => void;
}) {
  const isSteer = item.metadata?.delivery === "steer";
  const canEdit = Boolean(onEdit) && text.trim().length > 0 && !item.isStreaming;
  return (
    <View style={{ alignSelf: "flex-end", maxWidth: "82%", gap: 4, alignItems: "flex-end" }}>
    <View
      style={{
        maxWidth: "100%",
        minWidth: text.length < 10 ? 108 : undefined,
        borderRadius: 13,
        borderCurve: "continuous",
        backgroundColor: theme.mode === "light" ? "#ffffff" : "rgba(255,255,255,0.08)",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: isSteer
          ? theme.mode === "light" ? "rgba(58,95,200,0.22)" : "rgba(173,198,255,0.24)"
          : theme.mode === "light"
            ? "rgba(60,60,67,0.12)"
            : "rgba(255,255,255,0.10)",
        paddingVertical: 9,
        paddingHorizontal: 12,
        gap: 5,
      }}
    >
      {text || item.content?.length ? (
        <UserMessageContent blocks={item.content} fallbackText={text} theme={theme} />
      ) : item.isStreaming ? (
        <StreamingPill theme={theme} />
      ) : null}
      {deliveryLabel ? (
        <View
          style={{
            alignSelf: "flex-end",
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingTop: 1,
          }}
        >
          {deliveryLabel.pending ? <ActivityIndicator size="small" color={theme.textTertiary} /> : null}
          {isSteer ? <AppSymbol name="arrow.up" size={10} color={theme.accent} /> : null}
          <Text style={{ color: isSteer ? theme.accent : theme.textTertiary, fontSize: 10, fontWeight: "800" }}>
            {isSteer ? "已引导" : deliveryLabel.text}
          </Text>
        </View>
      ) : null}
    </View>
      {canEdit ? (
        <Pressable
          onPress={() => onEdit!(text)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="编辑并重新发送"
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            borderRadius: 999,
            paddingHorizontal: 8,
            paddingVertical: 3,
            backgroundColor: pressed ? theme.bgInput : "transparent",
            opacity: pressed ? 0.72 : 1,
          })}
        >
          <AppSymbol name="pencil" size={11} color={theme.textTertiary} />
          <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>编辑</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function PlanCard({ steps, theme }: { steps: AgentPlanStep[]; theme: Theme }) {
  const completed = steps.filter((step) => step.status === "completed").length;
  const active = steps.find((step) => step.status === "in_progress");
  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
        overflow: "hidden",
      }}
    >
      <View
        style={{
          minHeight: 46,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.separator,
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
        }}
      >
        <View style={{ width: 26, height: 26, borderRadius: 7, alignItems: "center", justifyContent: "center", backgroundColor: theme.accentLight }}>
          <AppSymbol name="list.bullet.rectangle.fill" size={14} color={theme.accent} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.text, fontSize: 14, fontWeight: "900" }} numberOfLines={1}>
            执行计划
          </Text>
          <Text style={{ color: active ? theme.accent : theme.textTertiary, fontSize: 11, fontWeight: "700", marginTop: 2 }} numberOfLines={1}>
            {active ? `正在进行：${active.text}` : `${completed}/${steps.length} 已完成`}
          </Text>
        </View>
        <View style={{ borderRadius: 999, backgroundColor: theme.bgInput, paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>
            {completed}/{steps.length}
          </Text>
        </View>
      </View>
      <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 9 }}>
        {steps.map((step, index) => {
          const isDone = step.status === "completed";
          const isActive = step.status === "in_progress";
          const color = isDone ? theme.success : isActive ? theme.accent : theme.textTertiary;
          return (
            <View key={step.id} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              <View style={{ alignItems: "center", width: 16 }}>
                <AppSymbol
                  name={isDone ? "checkmark.circle.fill" : isActive ? "clock" : "circle"}
                  size={14}
                  color={color}
                />
                {index < steps.length - 1 ? (
                  <View style={{ width: StyleSheet.hairlineWidth, flex: 1, minHeight: 10, marginTop: 3, backgroundColor: theme.separator }} />
                ) : null}
              </View>
              <Text selectable style={{ flex: 1, color: isActive ? theme.text : theme.textSecondary, fontSize: 13, lineHeight: 18, fontWeight: isActive ? "700" : "500" }}>
                {step.text}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function ErrorCard({ text, theme }: { text: string; theme: Theme }) {
  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: theme.errorLight,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.error,
        padding: 12,
        flexDirection: "row",
        gap: 9,
        alignItems: "flex-start",
      }}
    >
      <AppSymbol name="exclamationmark.triangle.fill" size={16} color={theme.error} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={{ color: theme.error, fontSize: 13, fontWeight: "900" }}>
          Agent 出错了
        </Text>
        <Text selectable style={{ color: theme.error, fontSize: 13, lineHeight: 18 }}>
          {text}
        </Text>
      </View>
    </View>
  );
}

function AgentConversationSkeleton({ theme }: { theme: Theme }) {
  const rows = [0, 1, 2, 3];
  return (
    <View style={{ paddingVertical: 18, gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "center", paddingVertical: 6 }}>
        <ActivityIndicator size="small" color={theme.accent} />
        <Text style={{ color: theme.textTertiary, fontSize: 13, fontWeight: "800" }}>正在获取消息…</Text>
      </View>
      {rows.map((row) => {
        const isUser = row === 1;
        return (
          <View
            key={row}
            style={{
              alignSelf: isUser ? "flex-end" : "stretch",
              width: isUser ? "62%" : "100%",
              borderRadius: 10,
              borderCurve: "continuous",
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.mode === "light" ? "rgba(60,60,67,0.08)" : "rgba(255,255,255,0.07)",
              backgroundColor: theme.mode === "light" ? "rgba(255,255,255,0.68)" : "rgba(255,255,255,0.045)",
              paddingHorizontal: 12,
              paddingVertical: 12,
              gap: 8,
            }}
          >
            <View style={{ width: isUser ? "74%" : "92%", height: 10, borderRadius: 5, backgroundColor: theme.bgInput }} />
            <View style={{ width: isUser ? "48%" : "78%", height: 10, borderRadius: 5, backgroundColor: theme.bgInput }} />
            {!isUser ? (
              <View style={{ width: "56%", height: 10, borderRadius: 5, backgroundColor: theme.bgInput }} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const TimelineItemView = memo(function TimelineItemView({
  item,
  theme,
  onPermission,
  onStructuredInput,
  onEditMessage,
}: {
  item: AgentTimelineItem;
  theme: Theme;
  onPermission: (requestId: string, outcome: "allow" | "deny" | "cancelled", optionId?: string) => void;
  onStructuredInput: (requestId: string, answers: Record<string, string[]>) => void;
  onEditMessage?: (text: string) => void;
}) {
  if (item.kind === "subagent_action" && item.subagent) {
    return (
      <AgentTimelineBlock theme={theme} tone={item.isStreaming ? "running" : "default"}>
        <SubagentCard action={item.subagent} theme={theme} running={item.isStreaming} />
      </AgentTimelineBlock>
    );
  }

  if (item.kind === "user_input_prompt" && item.structuredInput) {
    return (
      <AgentTimelineBlock theme={theme} tone="warning">
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
      <AgentTimelineBlock theme={theme} tone={item.isStreaming ? "running" : "default"}>
        <SystemActivityCard
          icon="brain.head.profile"
          title={item.isStreaming ? "正在思考" : "思考"}
          text={item.text}
          theme={theme}
          running={item.isStreaming}
        />
      </AgentTimelineBlock>
    );
  }

  if (item.kind === "review" || item.kind === "context_compaction" || item.kind === "tool_activity") {
    const title =
      item.kind === "review"
        ? "审查"
        : item.kind === "context_compaction"
          ? "上下文压缩"
          : "工具活动";
    return (
      <AgentTimelineBlock theme={theme} tone={item.isStreaming ? "running" : "default"}>
        <SystemActivityCard
          icon={item.kind === "review" ? "doc.text.magnifyingglass" : item.kind === "context_compaction" ? "square.stack.3d.up" : "terminal.fill"}
          title={title}
          text={item.text}
          theme={theme}
          running={item.isStreaming}
        />
      </AgentTimelineBlock>
    );
  }

  if (item.type === "status") {
    return item.text ? (
      <AgentTimelineBlock theme={theme} tone={item.status === "error" ? "error" : item.isStreaming ? "running" : "default"}>
        <SystemActivityCard
          icon={item.status === "error" ? "exclamationmark.triangle.fill" : "info.circle"}
          title={item.status === "error" ? "状态异常" : "状态"}
          text={item.text}
          theme={theme}
          running={item.isStreaming}
        />
      </AgentTimelineBlock>
    ) : null;
  }

  if (item.type === "message") {
    const isUser = item.role === "user";
    const text = item.text || (item.content ?? []).map((block) => block.text ?? "").join("\n");
    if (item.role === "system") {
      return text ? (
        <AgentTimelineBlock theme={theme}>
          <SystemMessageCard text={text} theme={theme} />
        </AgentTimelineBlock>
      ) : null;
    }
    if (!isUser) {
      return (
        <AssistantMessage
          item={item}
          text={text}
          theme={theme}
        />
      );
    }
    const deliveryLabel = userMessageDeliveryLabel(item);
    return (
      <UserMessageCard item={item} text={text} theme={theme} deliveryLabel={deliveryLabel} onEdit={onEditMessage} />
    );
  }

  if (item.type === "tool_call" && item.toolCall && !item.commandExecution && !item.fileChange) {
    const tone: AgentRailTone = item.toolCall.status === "running"
      ? "running"
      : item.toolCall.status === "failed"
        ? "error"
        : item.toolCall.status === "completed"
          ? "success"
          : "default";
    return (
      <AgentTimelineBlock theme={theme} tone={tone}>
        <ToolCard tool={item.toolCall} theme={theme} />
      </AgentTimelineBlock>
    );
  }

  if (item.commandExecution) {
    const status = item.commandExecution.status ?? (item.isStreaming ? "running" : "completed");
    const tone: AgentRailTone = status === "running" ? "running" : status === "failed" ? "error" : status === "completed" ? "success" : "default";
    return (
      <AgentTimelineBlock theme={theme} tone={tone}>
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
            status,
          }}
          theme={theme}
        />
      </AgentTimelineBlock>
    );
  }

  if (item.fileChange) {
    const status = item.fileChange.status ?? (item.isStreaming ? "running" : "completed");
    const tone: AgentRailTone = status === "running" ? "running" : status === "failed" ? "error" : status === "completed" ? "success" : "default";
    const summary = item.fileChange.entries
      .map((entry) => [entry.kind, entry.path].filter(Boolean).join(" ") || entry.path)
      .join("\n");
    return (
      <AgentTimelineBlock theme={theme} tone={tone}>
        <FileChangeCard
          tool={{
            id: item.itemId ?? item.id,
            name: "文件修改",
            input: summary,
            output: item.fileChange.diff ?? item.fileChange.summary,
            createdAt: item.createdAt,
            status,
          }}
          theme={theme}
        />
      </AgentTimelineBlock>
    );
  }

  if (item.type === "plan" && item.plan?.length) {
    const tone: AgentRailTone = item.plan.some((step) => step.status === "in_progress")
      ? "running"
      : item.plan.every((step) => step.status === "completed")
        ? "success"
        : "default";
    return (
      <AgentTimelineBlock theme={theme} tone={tone}>
        <PlanCard steps={item.plan} theme={theme} />
      </AgentTimelineBlock>
    );
  }

  if (item.type === "permission" && item.permission) {
    const outcome = item.metadata?.permissionOutcome;
    const tone: AgentRailTone = outcome === "allow" ? "success" : outcome === "deny" || outcome === "cancelled" ? "error" : "warning";
    return (
      <AgentTimelineBlock theme={theme} tone={tone}>
        <PermissionRequestCard item={item} theme={theme} onPermission={onPermission} />
      </AgentTimelineBlock>
    );
  }

  if (item.type === "error") {
    return (
      <AgentTimelineBlock theme={theme} tone="error">
        <ErrorCard text={item.error || item.text || "Agent 出错了"} theme={theme} />
      </AgentTimelineBlock>
    );
  }

  return null;
});

function HighlightedCodeLine({
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
}

function FilePreviewDrawer({
  visible,
  conversationId,
  cwd,
  workspace,
  theme,
  topInset,
  bottomInset,
  onClose,
}: {
  visible: boolean;
  conversationId: string;
  cwd: string;
  workspace: AgentWorkspaceHandle;
  theme: Theme;
  topInset: number;
  bottomInset: number;
  onClose: () => void;
}) {
  const [currentPath, setCurrentPath] = useState(cwd);
  const [entries, setEntries] = useState<AgentFileEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | undefined>();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<AgentFileReadResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const requestSeqRef = useRef(0);
  const readSeqRef = useRef(0);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPreviewTimeout = useCallback(() => {
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
  }, []);

  const loadDirectory = useCallback(async (path: string) => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setCurrentPath(path);
    setBrowseLoading(true);
    setBrowseError(undefined);
    setSelectedPath(null);
    setPreview(null);
    readSeqRef.current += 1;
    clearPreviewTimeout();
    setPreviewLoading(false);
    const result = await workspace.browseFiles(conversationId, path);
    if (requestSeqRef.current !== requestSeq) return;
    setEntries(result.entries);
    setBrowseError(result.error);
    setCurrentPath(result.path || path);
    setBrowseLoading(false);
  }, [clearPreviewTimeout, conversationId, workspace]);

  useEffect(() => () => clearPreviewTimeout(), [clearPreviewTimeout]);

  useEffect(() => {
    if (visible) return;
    readSeqRef.current += 1;
    clearPreviewTimeout();
    setPreviewLoading(false);
  }, [clearPreviewTimeout, visible]);

  useEffect(() => {
    if (!visible) return;
    loadDirectory(cwd).catch(() => {
      setBrowseLoading(false);
      setBrowseError("读取目录失败。");
    });
  }, [cwd, loadDirectory, visible]);

  const openEntry = useCallback((entry: AgentFileEntry) => {
    if (entry.isDirectory) {
      loadDirectory(entry.path).catch(() => {
        setBrowseLoading(false);
        setBrowseError("读取目录失败。");
      });
      return;
    }
    setSelectedPath(entry.path);
    setPreviewLoading(true);
    setPreview(null);
    const readSeq = readSeqRef.current + 1;
    readSeqRef.current = readSeq;
    clearPreviewTimeout();
    previewTimeoutRef.current = setTimeout(() => {
      if (readSeqRef.current !== readSeq) return;
      readSeqRef.current += 1;
      previewTimeoutRef.current = null;
      setPreview({
        path: entry.path,
        content: "",
        encoding: "utf8",
        truncated: false,
        error: "文件读取无响应，请确认主机端仍在线并已更新到支持文件预览的版本。",
      });
      setPreviewLoading(false);
    }, 16_000);
    workspace.readFile(conversationId, entry.path, FILE_PREVIEW_MAX_BYTES)
      .then((result) => {
        if (readSeqRef.current !== readSeq) return;
        clearPreviewTimeout();
        setPreview(result);
      })
      .catch((error) => {
        if (readSeqRef.current !== readSeq) return;
        clearPreviewTimeout();
        setPreview({
          path: entry.path,
          content: "",
          encoding: "utf8",
          truncated: false,
          error: error instanceof Error ? error.message : "读取文件失败。",
        });
      })
      .finally(() => {
        if (readSeqRef.current === readSeq) setPreviewLoading(false);
      });
  }, [clearPreviewTimeout, conversationId, loadDirectory, workspace]);

  const copyPreview = useCallback(() => {
    if (!preview?.content) return;
    copy(preview.content).then((ok) => {
      if (!ok) Alert.alert("复制失败", "系统剪贴板暂不可用，请长按文本手动复制。");
    }).catch(() => Alert.alert("复制失败", "系统剪贴板暂不可用，请长按文本手动复制。"));
  }, [preview?.content]);

  if (!visible) return null;

  const language = preview ? languageFromPath(preview.path) : "text";
  const lines = preview?.content.split("\n") ?? [];
  const directoryCount = entries.filter((entry) => entry.isDirectory).length;
  const fileCount = entries.length - directoryCount;

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
                {directoryCount} 个目录 · {fileCount} 个文件
              </Text>
            </View>
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
        </View>

        <ScrollView
          style={{ flex: 1, marginTop: 10 }}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 6 }}
          keyboardShouldPersistTaps="handled"
        >
          {browseError ? (
            <View style={{ borderRadius: 10, padding: 10, backgroundColor: theme.errorLight }}>
              <Text style={{ color: theme.error, fontSize: 12, lineHeight: 17 }}>{browseError}</Text>
            </View>
          ) : null}
          {browseLoading && entries.length === 0 ? (
            <View style={{ paddingVertical: 24, alignItems: "center" }}>
              <ActivityIndicator color={theme.accent} />
            </View>
          ) : null}
          {entries.map((entry) => {
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
          })}

          <View
            style={{
              marginTop: 8,
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
                  {preview ? fileName(preview.path) : selectedPath ? fileName(selectedPath) : "选择一个文件"}
                </Text>
                <Text style={{ color: theme.textTertiary, fontSize: 10, marginTop: 2, fontFamily: MONO_FONT }} numberOfLines={1}>
                  {preview ? [language, formatBytes(preview.size), preview.truncated ? "已截断" : null].filter(Boolean).join(" · ") : "支持常见代码文件高亮"}
                </Text>
              </View>
              {preview?.content ? (
                <Pressable onPress={copyPreview} hitSlop={8}>
                  <AppSymbol name="doc.on.doc" size={15} color={theme.textSecondary} />
                </Pressable>
              ) : null}
            </View>
            {previewLoading ? (
              <View style={{ paddingVertical: 28, alignItems: "center" }}>
                <ActivityIndicator color={theme.accent} />
              </View>
            ) : preview?.error ? (
              <View style={{ padding: 12 }}>
                <Text selectable style={{ color: theme.error, fontSize: 12, lineHeight: 17 }}>
                  {preview.error}
                </Text>
              </View>
            ) : preview ? (
              <ScrollView horizontal bounces={false}>
                <View style={{ minWidth: 520, paddingVertical: 8, paddingRight: 14 }}>
                  {lines.map((line, index) => (
                    <HighlightedCodeLine
                      key={`${preview.path}:${index}`}
                      line={line}
                      lineNumber={index + 1}
                      language={language}
                      theme={theme}
                    />
                  ))}
                </View>
              </ScrollView>
            ) : (
              <View style={{ padding: 12 }}>
                <Text style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }}>
                  从上方列表选择文件后会在这里显示内容。
                </Text>
              </View>
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
  isRestoring = false,
  onBack,
}: AgentConversationScreenProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const conversation = workspace.getConversation(conversationId);
  const timeline = workspace.getTimeline(conversationId);
  const dedupedTimeline = useMemo(() => dedupeTimelineItems(timeline), [timeline]);
  const queuedFollowUps = useMemo(
    () => dedupedTimeline.filter((item) => isQueuedFollowUpItem(item, conversation?.status)),
    [conversation?.status, dedupedTimeline],
  );
  const visibleTimeline = useMemo(
    () => dedupedTimeline.filter((item) => !isQueuedFollowUpPlaceholder(item)),
    [dedupedTimeline],
  );
  // Mirror into a ref so renderTimelineItem can read neighbor items without
  // depending on `visibleTimeline` — otherwise the renderer's identity changes
  // on every streamed token and defeats LegendList row recycling.
  const visibleTimelineRef = useRef(visibleTimeline);
  visibleTimelineRef.current = visibleTimeline;
  const timelineRef = useRef<LegendListRef>(null);
  const composerInputRef = useRef<TextInput>(null);
  const timelineNearBottomRef = useRef(true);
  const [isTimelineNearBottom, setIsTimelineNearBottom] = useState(true);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const [bottomComposerHeight, setBottomComposerHeight] = useState(0);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [text, setText] = useState("");
  // Cursor position in the composer, so dictated text inserts where the caret
  // is rather than always appending. Updated on every selection change.
  const selectionRef = useRef(0);
  const [model, setModel] = useState<string | undefined>(conversation?.model);
  const [effort, setEffort] = useState<AgentReasoningEffort | undefined>(conversation?.reasoningEffort);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode | undefined>(
    conversation?.permissionMode,
  );
  const [attachments, setAttachments] = useState<AgentContentBlock[]>([]);
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false);
  // Android rename modal (iOS uses the native Alert.prompt instead).
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  // @-file-mention palette state: entries fetched for the directory under the
  // current @token, refetched only when that directory changes.
  const [mentionEntries, setMentionEntries] = useState<AgentFileEntry[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionError, setMentionError] = useState<string | undefined>();
  const [mentionFetchedDir, setMentionFetchedDir] = useState<string | null>(null);
  const capabilities = conversation ? workspace.capabilitiesBySessionId.get(conversation.sessionId) : undefined;
  const providerCapability = conversation ? providerCapabilityFor(conversation.provider, capabilities) : undefined;
  const providerSupportsImageInput = conversation?.provider === "claude" || conversation?.provider === "codex";
  const supportsImages = Boolean(
    providerSupportsImageInput ||
    (capabilities?.enabled && (providerCapability?.supportsImages ?? capabilities.supportsImages)),
  );
  const turnRunning = conversation?.status === "running";
  const waitingPermission = conversation?.status === "waiting_permission";
  const running = turnRunning || waitingPermission;
  const canSteerRunningTurn = turnRunning && conversation?.provider === "codex";
  const meta = visibleConversationStatus(conversation?.status, theme);
  const canSend = Boolean(text.trim() || attachments.length > 0);
  const modelOpts = useMemo(
    () => modelOptionsFor(conversation?.provider ?? "codex", capabilities),
    [capabilities, conversation?.provider],
  );
  const effortOpts = useMemo(
    () => effortOptionsFor(conversation?.provider ?? "codex", capabilities),
    [capabilities, conversation?.provider],
  );
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
  const commandPanelVisible = Boolean(commandToken && availableCommands.length > 0 && attachments.length === 0 && !running);
  // @-file-mention: active when a trailing @token exists and the slash palette
  // isn't (slash takes priority). Resolves the absolute dir to browse from cwd.
  const mentionToken = useMemo(() => (commandToken ? null : trailingMentionToken(text)), [commandToken, text]);
  const mentionTargetDir = useMemo(() => {
    if (!mentionToken) return null;
    const base = (conversation?.cwd || ".").replace(/\/+$/, "") || "/";
    return mentionToken.dir ? `${base}/${mentionToken.dir}` : base;
  }, [conversation?.cwd, mentionToken]);
  const mentionPanelVisible = Boolean(mentionToken && !running);
  const currentCollaborationMode = (conversation?.collaborationMode ?? providerCapability?.currentMode ?? "default") as AgentCollaborationMode;
  const composerBottomOffset = Platform.OS === "ios" ? Math.max(0, keyboardInset - insets.bottom) : 0;
  const timelineBottomInset = Math.max(
    bottomComposerHeight + composerBottomOffset,
    Math.max(insets.bottom + 116, 132) + composerBottomOffset,
  );
  const timelineListData = useMemo<TimelineListItem[]>(
    () =>
      visibleTimeline.length === 0
        ? []
        : [
            ...visibleTimeline,
            {
              id: "__timeline-bottom-spacer",
              type: "bottom_spacer",
              spacerHeight: timelineBottomInset + 18,
            },
          ],
    [timelineBottomInset, visibleTimeline],
  );

  useEffect(() => {
    if (commandPanelVisible) {
      Keyboard.dismiss();
    }
  }, [commandPanelVisible]);

  useEffect(() => {
    const applyKeyboardFrame = (event: KeyboardEvent) => {
      if (typeof Keyboard.scheduleLayoutAnimation === "function") {
        Keyboard.scheduleLayoutAnimation(event);
      }
      const nextInset = Platform.OS === "ios"
        ? Math.max(0, windowHeight - event.endCoordinates.screenY)
        : Math.max(0, windowHeight - event.endCoordinates.screenY, event.endCoordinates.height);
      setKeyboardInset((current) => Math.abs(current - nextInset) > 4 ? nextInset : current);
    };
    const clearKeyboardFrame = (event?: KeyboardEvent) => {
      if (event && typeof Keyboard.scheduleLayoutAnimation === "function") {
        Keyboard.scheduleLayoutAnimation(event);
      }
      setKeyboardInset((current) => current === 0 ? current : 0);
    };

    if (Platform.OS === "ios") {
      const showSub = Keyboard.addListener("keyboardWillShow", applyKeyboardFrame);
      const hideSub = Keyboard.addListener("keyboardWillHide", clearKeyboardFrame);
      return () => {
        showSub.remove();
        hideSub.remove();
      };
    }

    const showSub = Keyboard.addListener("keyboardDidShow", applyKeyboardFrame);
    const hideSub = Keyboard.addListener("keyboardDidHide", clearKeyboardFrame);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [insets.bottom, windowHeight]);

  useEffect(() => {
    setModel(conversation?.model);
    setEffort(conversation?.reasoningEffort);
    setPermissionMode(conversation?.permissionMode);
  }, [conversation?.id, conversation?.model, conversation?.permissionMode, conversation?.reasoningEffort]);

  useEffect(() => {
    if (!conversation) return;
    workspace.markRead(conversation.id);
  }, [conversation?.id, conversation?.lastResponseAt, timeline.length, workspace.markRead]);

  useEffect(() => () => {
    if (conversationId) workspace.markRead(conversationId);
  }, [conversationId, workspace.markRead]);

  // Fetch directory entries for the active @-mention token. Guarded against
  // races (only the latest target's result is applied) and only refetches when
  // the resolved directory changes, not on every keystroke within it.
  useEffect(() => {
    if (!mentionTargetDir || !conversation) {
      setMentionLoading(false);
      return;
    }
    if (mentionTargetDir === mentionFetchedDir) return;
    let cancelled = false;
    setMentionLoading(true);
    setMentionError(undefined);
    workspace.browseFiles(conversation.id, mentionTargetDir)
      .then((result) => {
        if (cancelled) return;
        setMentionEntries(result.error ? [] : result.entries);
        setMentionError(result.error);
        setMentionFetchedDir(mentionTargetDir);
      })
      .catch(() => {
        if (!cancelled) setMentionError("读取目录失败。");
      })
      .finally(() => {
        if (!cancelled) setMentionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversation, mentionFetchedDir, mentionTargetDir, workspace]);

  useEffect(() => {
    if (effort && !effortOpts.some((option) => option.value === effort)) {
      setEffort(undefined);
      if (conversation) {
        workspace.updateConversationSettings(conversation.id, { reasoningEffort: undefined }).catch(() => {});
      }
    }
  }, [conversation, effort, effortOpts, workspace]);

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
  const permissionMenuActions = useMemo(
    () =>
      permissionOpts.map((option) => ({
        id: `permission:${option.value ?? DEFAULT_OPTION_ID}`,
        title: option.label,
        image: option.image,
        state: option.value === permissionMode ? "on" as const : "off" as const,
      })),
    [permissionOpts, permissionMode],
  );
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
  const settingsMenuActions = useMemo(() => {
    const sections: Array<{ id: string; title: string; subactions: any[] }> = [];
    if (modelMenuActions.length > 1) {
      sections.push({ id: "model_section", title: "模型", subactions: modelMenuActions });
    }
    if (effortMenuActions.length > 0) {
      sections.push({ id: "effort_section", title: "思考强度", subactions: effortMenuActions });
    }
    if (permissionMenuActions.length > 0) {
      sections.push({ id: "permission_section", title: "权限模式", subactions: permissionMenuActions });
    }
    return sections;
  }, [effortMenuActions, modelMenuActions, permissionMenuActions]);
  const compactSettingsLabel = useMemo(() => {
    if (modelMenuActions.length > 1) return formatModel(model, modelOpts);
    if (effortMenuActions.length > 0) return formatEffort(effort);
    return "设置";
  }, [effort, effortMenuActions.length, model, modelMenuActions.length, modelOpts]);
  const handleSettingsMenu = useCallback((eventId: string) => {
    if (eventId.startsWith("model:")) {
      commitModel(valueFromMenuId<string>(eventId.slice("model:".length)));
      return;
    }
    if (eventId.startsWith("effort:")) {
      commitEffort(valueFromMenuId<AgentReasoningEffort>(eventId.slice("effort:".length)));
      return;
    }
    if (eventId.startsWith("permission:")) {
      setPermissionModeWithGuard(valueFromMenuId<AgentPermissionMode>(eventId.slice("permission:".length)));
    }
  }, [commitEffort, commitModel, setPermissionModeWithGuard]);
  const nativePlanCommand = useMemo(
    () =>
      availableCommands.find(
        (command) => command.name === "plan" && command.executionKind === "native" && !command.disabledReason,
      ),
    [availableCommands],
  );
  const visibleNotices = useMemo(
    () =>
      workspace.notices.filter(
        (notice) => !notice.conversationId || notice.conversationId === conversationId,
      ),
    [conversationId, workspace.notices],
  );
  useEffect(() => {
    if (visibleNotices.length === 0) return;
    const timers = visibleNotices.map((notice) =>
      setTimeout(() => workspace.dismissNotice(notice.id), notice.durationMs && notice.durationMs > 0 ? notice.durationMs : 4000),
    );
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, [visibleNotices, workspace]);
  const timelineAutoScrollKey = useMemo(
    () =>
      visibleTimeline
        .map((item) => {
          const tool = item.toolCall;
          return [
            item.id,
            item.updatedAt ?? item.createdAt,
            item.text?.length ?? 0,
            tool?.output?.length ?? 0,
            item.isStreaming ? 1 : 0,
          ].join(":");
        })
        .join("|"),
    [visibleTimeline],
  );
  const handleTimelineScroll = useCallback((event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    const nearBottom = distanceFromBottom < 96;
    timelineNearBottomRef.current = nearBottom;
    setIsTimelineNearBottom(nearBottom);
    if (nearBottom) {
      setHasNewOutput(false);
    }
    // Scrolled near the top → page in older history (matches web's scroll-up).
    if (contentOffset.y < 120 && contentSize.height > layoutMeasurement.height) {
      workspace.loadOlderHistory(conversationId);
    }
  }, [conversationId, workspace]);

  const forceTimelineToBottom = useCallback((animated = true) => {
    const ref = timelineRef.current;
    if (!ref) return;
    const listRef = ref as LegendListRef & {
      scrollToIndex?: (options: { index: number; animated?: boolean; viewPosition?: number; viewOffset?: number }) => void;
      scrollToOffset?: (options: { offset: number; animated?: boolean }) => void;
    };
    const nativeScrollRef = ref.getNativeScrollRef() as {
      scrollToEnd?: (options?: { animated?: boolean }) => void;
      scrollTo?: (options?: { y?: number; animated?: boolean }) => void;
    } | null;
    if (timelineListData.length > 0) {
      try {
        listRef.scrollToIndex?.({
          index: timelineListData.length - 1,
          animated,
          viewPosition: 1,
          viewOffset: 0,
        });
      } catch {
        // LegendList can reject scrollToIndex before the last row is measured; fall back below.
      }
    }
    listRef.scrollToEnd({ animated, viewOffset: 0 });
    listRef.scrollToOffset?.({ offset: Number.MAX_SAFE_INTEGER, animated });
    nativeScrollRef?.scrollToEnd?.({ animated });
    nativeScrollRef?.scrollTo?.({ y: Number.MAX_SAFE_INTEGER, animated });
    timelineNearBottomRef.current = true;
    setIsTimelineNearBottom(true);
    setHasNewOutput(false);
  }, [timelineListData.length]);

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

  const renderTimelineItem = useCallback(({ item, index }: LegendListRenderItemProps<TimelineListItem>) => {
    if (isTimelineBottomSpacer(item)) {
      return <View style={{ height: item.spacerHeight }} />;
    }
    const previous = visibleTimelineRef.current[index - 1];
    const startsTurn = Boolean(item.turnId && previous?.turnId && item.turnId !== previous.turnId);
    return (
      <View style={{ gap: 12 }}>
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
          onPermission={(requestId, outcome, optionId) =>
            workspace.respondPermission(conversationId, requestId, outcome, optionId)
          }
          onStructuredInput={(requestId, answers) =>
            workspace.respondStructuredInput(conversationId, requestId, answers)
          }
          onEditMessage={(value) => {
            setText(value);
            selectionRef.current = value.length;
            requestAnimationFrame(() => composerInputRef.current?.focus());
            Haptics.selectionAsync().catch(() => {});
          }}
        />
      </View>
    );
  }, [conversationId, theme, workspace]);

  const timelineEmpty = useMemo(() => {
    if (isRestoring) return <AgentConversationSkeleton theme={theme} />;
    return (
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
    );
  }, [isRestoring, theme]);

  useEffect(() => {
    if (visibleTimeline.length === 0) return;
    if (!timelineNearBottomRef.current) {
      setHasNewOutput(true);
      return;
    }
    setHasNewOutput(false);
    forceTimelineToBottom(false);
  }, [forceTimelineToBottom, timelineAutoScrollKey, visibleTimeline.length]);

  const send = useCallback(() => {
    const value = text.trim();
    if (!canSend || !conversation) return;
    const commandMatch = attachments.length === 0 && !running
      ? commandFromMessage(value, availableCommands)
      : null;
    if (commandMatch) {
      const run = () => {
        workspace.executeCommand(conversation.id, commandMatch.command, value, commandMatch.args);
        setText("");
        setAttachments([]);
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
    workspace.sendPrompt(conversation.id, value, {
      model,
      reasoningEffort: nextEffort,
      permissionMode: nextPermissionMode,
      collaborationMode: currentCollaborationMode,
      attachments,
    });
    setText("");
    setAttachments([]);
    scrollTimelineToBottom(true);
  }, [attachments, availableCommands, canSend, conversation, currentCollaborationMode, effort, effortOpts, model, permissionMode, permissionOpts, running, scrollTimelineToBottom, text, workspace]);

  // Plan mode: once a planning turn finishes (plan mode on, idle, last item is
  // the agent's), offer a one-tap "execute" that exits plan mode and proceeds.
  const planReady = useMemo(() => {
    if (currentCollaborationMode !== "plan") return false;
    if (running) return false;
    // Last visible item is the agent's (a finished planning turn), not a
    // just-sent user message — mirrors the web console's execute-plan gate.
    const last = visibleTimeline[visibleTimeline.length - 1];
    return Boolean(last) && last.role !== "user";
  }, [currentCollaborationMode, running, visibleTimeline]);

  const handleExecutePlan = useCallback(() => {
    if (!conversation) return;
    workspace.sendPrompt(conversation.id, "请按上面的计划开始执行。", {
      model,
      reasoningEffort: effort,
      permissionMode,
      collaborationMode: "default",
    });
    scrollTimelineToBottom(true);
  }, [conversation, effort, model, permissionMode, scrollTimelineToBottom, workspace]);

  const renameConversation = useCallback(() => {
    if (!conversation) return;
    if (Platform.OS === "ios" && typeof Alert.prompt === "function") {
      Alert.prompt(
        "重命名对话",
        undefined,
        [
          { text: "取消", style: "cancel" },
          {
            text: "保存",
            onPress: (value?: string) => {
              const title = (value ?? "").trim();
              if (title) workspace.rename(conversation.id, title).catch(() => {});
            },
          },
        ],
        "plain-text",
        conversation.title ?? "",
      );
      return;
    }
    // Android (and any platform without Alert.prompt): in-app modal.
    setRenameDraft(conversation.title ?? "");
    setRenameModalVisible(true);
  }, [conversation, workspace]);

  const submitRename = useCallback(() => {
    const title = renameDraft.trim();
    setRenameModalVisible(false);
    if (title && conversation) {
      workspace.rename(conversation.id, title).catch(() => {});
    }
  }, [conversation, renameDraft, workspace]);

  const insertDictatedText = useCallback((dictated: string) => {
    const insert = dictated.trim();
    if (!insert) return;
    setText((prev) => {
      const pos = Math.min(Math.max(selectionRef.current, 0), prev.length);
      const before = prev.slice(0, pos);
      const after = prev.slice(pos);
      const combined =
        before +
        (before && !before.endsWith(" ") ? " " : "") +
        insert +
        (after && !after.startsWith(" ") ? " " : "") +
        after;
      selectionRef.current = (
        before + (before && !before.endsWith(" ") ? " " : "") + insert
      ).length;
      return combined;
    });
    Haptics.selectionAsync().catch(() => {});
  }, []);
  const dictation = useComposerDictation(insertDictatedText);

  const steerQueuedFollowUp = useCallback((item: AgentTimelineItem) => {
    if (!conversation) return;
    workspace.sendQueuedFollowUp(conversation.id, item.id, "steer");
    Haptics.selectionAsync().catch(() => {});
    scrollTimelineToBottom(true);
  }, [conversation, scrollTimelineToBottom, workspace]);

  const discardQueuedFollowUp = useCallback((item: AgentTimelineItem) => {
    if (!conversation) return;
    workspace.discardQueuedFollowUp(conversation.id, item.id);
    Haptics.selectionAsync().catch(() => {});
  }, [conversation, workspace]);

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

  // Entries matching the current @token's filter, folders first. Only valid
  // once the fetched directory matches the token's resolved target.
  const mentionMatches = useMemo(() => {
    if (!mentionToken || mentionFetchedDir !== mentionTargetDir) return [];
    const filter = mentionToken.filter.toLowerCase();
    return mentionEntries
      .filter((entry) => entry.name.toLowerCase().includes(filter))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 50);
  }, [mentionEntries, mentionFetchedDir, mentionTargetDir, mentionToken]);

  // Insert the picked entry, replacing the trailing @token. Folders keep a
  // trailing slash so the palette drills in; files terminate with a space.
  const selectMention = useCallback((entry: AgentFileEntry) => {
    if (!mentionToken) return;
    const base = (conversation?.cwd || ".").replace(/\/+$/, "");
    const rel = base && entry.path.startsWith(base)
      ? entry.path.slice(base.length).replace(/^\/+/, "")
      : entry.name;
    setText((current) => {
      const head = current.slice(0, mentionToken.start);
      const next = `${head}@${rel}${entry.isDirectory ? "/" : " "}`;
      selectionRef.current = next.length;
      return next;
    });
    Haptics.selectionAsync().catch(() => {});
  }, [conversation?.cwd, mentionToken]);

  const closeMentionPanel = useCallback(() => {
    if (!mentionToken) return;
    setText((current) => `${current.slice(0, mentionToken.start)}${current.slice(mentionToken.end)}`);
  }, [mentionToken]);

  // Navigate the @-mention browser up one directory by dropping the last
  // segment of the token's dir part. Bounded at the conversation cwd (empty
  // dir → no-op), mirroring the web composer's cwd-relative mentions.
  const navigateMentionUp = useCallback(() => {
    if (!mentionToken || !mentionToken.dir) return;
    const dir = mentionToken.dir;
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    setText((current) => {
      const head = current.slice(0, mentionToken.start);
      const next = `${head}@${parent}${parent ? "/" : ""}`;
      selectionRef.current = next.length;
      return next;
    });
    Haptics.selectionAsync().catch(() => {});
  }, [mentionToken]);

  const cancelRunningTurn = useCallback(() => {
    if (!conversation) return;
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
  }, [conversation, workspace]);

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

  const showAttachSheet = useCallback(() => {
    if (!supportsImages) {
      Alert.alert("当前 Agent 不支持图片", "请切换到 Claude 或 Codex Agent，或使用支持图片输入的自定义 Agent。");
      return;
    }
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["取消", "拍照", "从相册选择"], cancelButtonIndex: 0 },
        (index) => {
          if (index === 1) pickImages("camera").catch(() => {});
          if (index === 2) pickImages("library").catch(() => {});
        },
      );
      return;
    }
    Alert.alert("添加图片", undefined, [
      { text: "取消", style: "cancel" },
      { text: "拍照", onPress: () => pickImages("camera").catch(() => {}) },
      { text: "从相册选择", onPress: () => pickImages("library").catch(() => {}) },
    ]);
  }, [pickImages, supportsImages]);

  if (!conversation && !workspace.isHydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, paddingHorizontal: 16, paddingTop: insets.top + 64 }}>
        <AgentConversationSkeleton theme={theme} />
      </View>
    );
  }

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
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
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
            onPress={() => setFileDrawerOpen(true)}
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
                {[displayProvider(conversation.provider), formatModel(conversation.model, modelOpts), shortPath(conversation.cwd)].filter(Boolean).join(" · ")}
              </Text>
            </View>
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
              { id: "rename", title: "重命名", image: "pencil" },
              { id: "archive", title: conversation.archived ? "取消归档" : "归档", image: "archivebox" },
            ]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "refresh") {
                workspace.requestCapabilities(conversation.sessionId);
              }
              if (nativeEvent.event === "rename") {
                renameConversation();
              }
              if (nativeEvent.event === "archive") {
                workspace.archive(conversation.id, !conversation.archived).then(onBack).catch(() => {});
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
          data={timelineListData}
          style={{ flex: 1 }}
          keyExtractor={(item) => item.id}
          renderItem={renderTimelineItem}
          ListEmptyComponent={timelineEmpty}
          ListHeaderComponent={
            visibleTimeline.length > 0 && workspace.getHistoryState(conversationId)?.loading ? (
              <View style={{ paddingTop: 8, paddingBottom: 14, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 7 }}>
                <ActivityIndicator size="small" color={theme.accent} />
                <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>加载更早的消息…</Text>
              </View>
            ) : null
          }
          ItemSeparatorComponent={TimelineSeparator}
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: 16,
            paddingTop: insets.top + 60,
            paddingBottom: visibleTimeline.length === 0 ? timelineBottomInset + 18 : 0,
          }}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          scrollIndicatorInsets={{ top: insets.top + 60, bottom: 18 + timelineBottomInset }}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          onScroll={handleTimelineScroll}
          onContentSizeChange={() => {
            if (timelineNearBottomRef.current) forceTimelineToBottom(false);
          }}
          onLayout={() => {
            if (timelineNearBottomRef.current) forceTimelineToBottom(false);
          }}
          scrollEventThrottle={16}
          estimatedItemSize={160}
          drawDistance={420}
          alignItemsAtEnd
          maintainScrollAtEnd={{ onDataChange: true, onItemLayout: true, onLayout: true }}
          maintainScrollAtEndThreshold={0.2}
          maintainVisibleContentPosition={false}
        />
        {isRestoring && visibleTimeline.length > 0 ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: insets.top + 58,
              left: 0,
              right: 0,
              alignItems: "center",
              zIndex: 12,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
                borderRadius: 999,
                backgroundColor: theme.mode === "light" ? "rgba(255,255,255,0.82)" : "rgba(42,42,43,0.82)",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
                paddingHorizontal: 10,
                paddingVertical: 6,
                shadowColor: "#000",
                shadowOpacity: theme.mode === "dark" ? 0.20 : 0.08,
                shadowRadius: 10,
                shadowOffset: { width: 0, height: 4 },
              }}
            >
              <ActivityIndicator size="small" color={theme.accent} />
              <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "800" }}>正在同步最新消息…</Text>
            </View>
          </View>
        ) : null}
        {!isTimelineNearBottom || hasNewOutput ? (
          <View
            pointerEvents="box-none"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: timelineBottomInset + 12,
              alignItems: "center",
              zIndex: 20,
              elevation: 20,
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
        pointerEvents="box-none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: composerBottomOffset,
        }}
      >
        <View
          onLayout={(event) => {
            const nextHeight = Math.ceil(event.nativeEvent.layout.height);
            setBottomComposerHeight((current) =>
              Math.abs(current - nextHeight) > 1 ? nextHeight : current
            );
          }}
          style={{
            paddingHorizontal: 10,
            paddingTop: 6,
            paddingBottom: Math.max(insets.bottom + 6, 12),
            backgroundColor: "transparent",
            gap: 6,
          }}
        >
          <NoticeStrip
            notices={visibleNotices}
            theme={theme}
            onDismiss={(id) => workspace.dismissNotice(id)}
          />
          {planReady ? (
            <View
              style={{
                marginBottom: 6,
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                borderRadius: 16,
                borderCurve: "continuous",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.accent,
                backgroundColor: theme.accentLight,
                paddingHorizontal: 14,
                paddingVertical: 11,
              }}
            >
              <AppSymbol name="checklist" size={15} color={theme.accent} />
              <Text style={{ flex: 1, color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
                计划已就绪。执行它，或在下方继续补充。
              </Text>
              <Pressable
                onPress={handleExecutePlan}
                hitSlop={6}
                style={({ pressed }) => ({
                  borderRadius: 999,
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  backgroundColor: pressed ? theme.accentSecondary : theme.accent,
                })}
              >
                <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>执行计划</Text>
              </Pressable>
            </View>
          ) : null}
          {dictation.pressing ? (
            <View
              style={{
                marginBottom: 6,
                borderRadius: 16,
                borderCurve: "continuous",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: dictation.inCancelZone ? theme.error : theme.separator,
                backgroundColor: dictation.inCancelZone ? theme.errorLight : theme.bgCard,
                paddingHorizontal: 14,
                paddingVertical: 12,
                gap: 6,
                shadowColor: "#000",
                shadowOpacity: theme.mode === "dark" ? 0.26 : 0.10,
                shadowRadius: 18,
                shadowOffset: { width: 0, height: 8 },
                elevation: 8,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.error }} />
                <Text style={{ flex: 1, color: theme.text, fontSize: 15, lineHeight: 21 }} numberOfLines={3}>
                  {dictation.liveText || "正在听…"}
                </Text>
              </View>
              <Text
                style={{
                  textAlign: "center",
                  fontSize: 12,
                  fontWeight: dictation.inCancelZone ? "800" : "600",
                  color: dictation.inCancelZone ? theme.error : theme.textTertiary,
                }}
              >
                {dictation.inCancelZone ? "松开取消" : "↑ 上滑取消，松开插入"}
              </Text>
            </View>
          ) : null}
          <View
            style={{
              borderRadius: 22,
              borderCurve: "continuous",
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.mode === "light" ? "rgba(60,60,67,0.18)" : "rgba(255,255,255,0.14)",
              backgroundColor: theme.bgCard,
              paddingHorizontal: 0,
              paddingTop: 0,
              paddingBottom: 0,
              gap: 0,
              overflow: "hidden",
              shadowColor: "#000",
              shadowOpacity: theme.mode === "dark" ? 0.26 : 0.10,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 8 },
              elevation: 8,
            }}
          >
          {queuedFollowUps.length > 0 ? (
            <QueuedFollowUpList
              items={queuedFollowUps}
              theme={theme}
              canSteer={canSteerRunningTurn}
              onSteer={steerQueuedFollowUp}
              onDiscard={discardQueuedFollowUp}
            />
          ) : null}
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
          {mentionPanelVisible && mentionToken ? (
            <MentionPanel
              entries={mentionMatches}
              loading={mentionLoading}
              error={mentionError}
              currentDir={mentionTargetDir ?? ""}
              canNavigateUp={Boolean(mentionToken.dir)}
              theme={theme}
              onSelect={selectMention}
              onNavigateUp={navigateMentionUp}
              onClose={closeMentionPanel}
            />
          ) : null}
          <TextInput
            ref={composerInputRef}
            value={text}
            onChangeText={setText}
            onSelectionChange={(event) => {
              selectionRef.current = event.nativeEvent.selection.end;
            }}
            placeholder={canSteerRunningTurn ? "要求后续变更" : waitingPermission ? "Agent 运行中，可先编辑草稿" : turnRunning ? "发送将加入队列，结束后自动发送" : "给 Agent 发送消息"}
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
              minHeight: 50,
              maxHeight: 132,
              color: theme.text,
              fontSize: 14,
              lineHeight: 20,
              paddingHorizontal: 14,
              paddingTop: 12,
              paddingBottom: 6,
            }}
          />
          {running ? (
            <Text style={{ color: theme.textTertiary, fontSize: 11, lineHeight: 15, paddingHorizontal: 14, paddingBottom: 2 }}>
              {canSteerRunningTurn
                ? "Codex 正在工作，发送会加入队列；点队列里的引导可立即打断当前回复。"
                : waitingPermission
                  ? "当前任务正在等待授权，请先处理授权请求或停止任务。"
                  : "Agent 正在工作，发送会加入队列，本回合结束后自动发送。"}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 10 }}>
            <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7 }}>
              {supportsImages ? (
                <Pressable
                  onPress={showAttachSheet}
                  style={({ pressed }) => ({
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: pressed ? theme.bgInput : "transparent",
                  })}
                >
                  <AppSymbol name="plus" size={18} color={theme.textSecondary} />
                </Pressable>
              ) : null}
              {nativePlanCommand ? (
                <Pressable
                  onPress={() => {
                    const targetName = currentCollaborationMode === "plan" ? "exit-plan" : "plan";
                    const command = availableCommands.find((item) => item.name === targetName) ?? nativePlanCommand;
                    if (command?.disabledReason) {
                      Alert.alert("命令不可用", command.disabledReason);
                      return;
                    }
                    executeSlashCommand(command);
                  }}
                  style={({ pressed }) => ({
                    height: 30,
                    borderRadius: 999,
                    alignItems: "center",
                    justifyContent: "center",
                    flexDirection: "row",
                    gap: 5,
                    paddingHorizontal: 11,
                    backgroundColor: currentCollaborationMode === "plan"
                      ? (pressed ? theme.accentLight : "rgba(173,198,255,0.28)")
                      : (pressed ? theme.bgInput : theme.mode === "light" ? "rgba(60,60,67,0.06)" : "rgba(255,255,255,0.08)"),
                  })}
                >
                  <AppSymbol name="checklist" size={13} color={currentCollaborationMode === "plan" ? theme.accent : theme.textSecondary} />
                  <Text style={{ color: currentCollaborationMode === "plan" ? theme.accent : theme.textSecondary, fontSize: 11, fontWeight: "800" }}>
                    Plan
                  </Text>
                </Pressable>
              ) : null}
              <MenuView
                actions={settingsMenuActions}
                onPressAction={({ nativeEvent }) => handleSettingsMenu(nativeEvent.event)}
              >
                <View
                  style={{
                    minHeight: 30,
                    borderRadius: 999,
                    paddingHorizontal: 9,
                    paddingVertical: 6,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    backgroundColor: permissionMode === "full_access"
                      ? "rgba(255,214,10,0.20)"
                      : "transparent",
                  }}
                >
                  <AppSymbol
                    name="bolt"
                    size={12}
                    color={permissionMode === "full_access" ? theme.warning : theme.textSecondary}
                  />
                  <Text
                    style={{
                      color: theme.textSecondary,
                      fontSize: 12,
                      fontWeight: "800",
                    }}
                    numberOfLines={1}
                  >
                    {compactSettingsLabel}
                  </Text>
                  <AppSymbol
                    name="chevron.down"
                    size={9}
                    color={theme.textTertiary}
                  />
                </View>
              </MenuView>
            </View>
            {dictation.available ? (
              <View
                {...dictation.panHandlers}
                style={{
                  width: 34,
                  height: 30,
                  borderRadius: 15,
                  borderCurve: "continuous",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: dictation.pressing
                    ? dictation.inCancelZone
                      ? theme.errorLight
                      : theme.accent
                    : "transparent",
                }}
              >
                <AppSymbol
                  name={dictation.pressing ? "mic.fill" : "mic"}
                  size={15}
                  color={
                    dictation.pressing
                      ? dictation.inCancelZone
                        ? theme.error
                        : "#fff"
                      : theme.textTertiary
                  }
                />
              </View>
            ) : null}
            {running ? (
              <Pressable
                onPress={cancelRunningTurn}
                accessibilityRole="button"
                accessibilityLabel="停止当前任务"
                style={({ pressed }) => ({
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? theme.bgElevated : theme.mode === "light" ? "#111111" : "#f6f6f7",
                })}
              >
                <AppSymbol name="stop.fill" size={14} color={theme.mode === "light" ? "#ffffff" : "#111111"} />
              </Pressable>
            ) : null}
            {(!waitingPermission) ? (
              <Pressable
                onPress={send}
                disabled={!canSend}
                accessibilityRole="button"
                accessibilityLabel={turnRunning ? "加入队列发送" : "发送消息"}
                accessibilityState={{ disabled: !canSend }}
                style={({ pressed }) => ({
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? theme.accentSecondary : theme.accent,
                  opacity: canSend ? 1 : 0.45,
                })}
              >
                <AppSymbol name="arrow.up" size={18} color="#fff" />
              </Pressable>
            ) : null}
          </View>
          </View>
        </View>
      </View>
      <FilePreviewDrawer
        visible={fileDrawerOpen}
        conversationId={conversation.id}
        cwd={conversation.cwd || "~"}
        workspace={workspace}
        theme={theme}
        topInset={insets.top}
        bottomInset={insets.bottom}
        onClose={() => setFileDrawerOpen(false)}
      />
      <Modal
        visible={renameModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameModalVisible(false)}
      >
        <Pressable
          onPress={() => setRenameModalVisible(false)}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center", justifyContent: "center", paddingHorizontal: 28 }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              width: "100%",
              maxWidth: 360,
              borderRadius: 18,
              borderCurve: "continuous",
              backgroundColor: theme.bgCard,
              padding: 18,
              gap: 14,
            }}
          >
            <Text style={{ color: theme.text, fontSize: 16, fontWeight: "800" }}>重命名对话</Text>
            <TextInput
              value={renameDraft}
              onChangeText={setRenameDraft}
              autoFocus
              placeholder="对话标题"
              placeholderTextColor={theme.textTertiary}
              returnKeyType="done"
              onSubmitEditing={submitRename}
              style={{
                minHeight: 44,
                borderRadius: 11,
                borderCurve: "continuous",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
                backgroundColor: theme.bgInput,
                paddingHorizontal: 12,
                color: theme.text,
                fontSize: 15,
              }}
            />
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
              <Pressable
                onPress={() => setRenameModalVisible(false)}
                style={({ pressed }) => ({
                  paddingHorizontal: 16,
                  paddingVertical: 9,
                  borderRadius: 10,
                  backgroundColor: pressed ? theme.bgInput : "transparent",
                })}
              >
                <Text style={{ color: theme.textSecondary, fontSize: 14, fontWeight: "700" }}>取消</Text>
              </Pressable>
              <Pressable
                onPress={submitRename}
                disabled={!renameDraft.trim()}
                style={({ pressed }) => ({
                  paddingHorizontal: 16,
                  paddingVertical: 9,
                  borderRadius: 10,
                  backgroundColor: pressed ? theme.accentSecondary : theme.accent,
                  opacity: renameDraft.trim() ? 1 : 0.45,
                })}
              >
                <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>保存</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
