import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Clipboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { MenuView } from "@react-native-menu/menu";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import type { AgentWorkspaceHandle } from "../hooks/useAgentWorkspace";
import type {
  AgentContentBlock,
  AgentConversationRecord,
  AgentPermissionMode,
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
  onBack: () => void;
}

type Option<T extends string> = { label: string; value?: T; image?: string };

const MODEL_OPTIONS: Option<string>[] = [
  { label: "默认模型", value: undefined },
  { label: "GPT-5.5", value: "gpt-5.5" },
  { label: "GPT-5.4", value: "gpt-5.4" },
  { label: "GPT-5.4 Mini", value: "gpt-5.4-mini" },
  { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
];

const EFFORT_OPTIONS: Option<AgentReasoningEffort>[] = [
  { label: "默认强度", value: undefined },
  { label: "低", value: "low" },
  { label: "中", value: "medium" },
  { label: "高", value: "high" },
  { label: "超高", value: "xhigh" },
];

const PERMISSION_OPTIONS: Option<AgentPermissionMode>[] = [
  { label: "默认权限", value: undefined, image: "hand.raised.fill" },
  { label: "自动审查", value: "workspace_write", image: "lock.shield.fill" },
  { label: "完全访问权限", value: "full_access", image: "lock.open.fill" },
];

const MAX_IMAGE_ATTACHMENTS = 3;
const MAX_IMAGE_DATA_URL_LENGTH = 4_000_000;
const DEFAULT_OPTION_ID = "__default__";

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
  return null;
}

function permissionMeta(mode: AgentPermissionMode | undefined, theme: Theme) {
  if (mode === "full_access") {
    return { label: "完全访问权限", icon: "lock.open.fill", color: theme.warning, bg: theme.accentLight };
  }
  if (mode === "workspace_write") {
    return { label: "自动审查", icon: "lock.shield.fill", color: theme.accent, bg: theme.accentLight };
  }
  return { label: "默认权限", icon: "hand.raised.fill", color: theme.textSecondary, bg: theme.bgInput };
}

function formatModel(model?: string): string {
  return MODEL_OPTIONS.find((item) => item.value === model)?.label ?? model ?? "默认模型";
}

function formatEffort(effort?: AgentReasoningEffort): string {
  if (!effort) return "默认";
  if (effort === "xhigh") return "超高";
  if (effort === "high") return "高";
  if (effort === "medium") return "中";
  if (effort === "low") return "低";
  return "极低";
}

function formatRuntime(model?: string, effort?: AgentReasoningEffort): string {
  const modelLabel = formatModel(model).replace(/^GPT-/, "");
  return `${modelLabel} · ${formatEffort(effort)}`;
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

type MessagePart =
  | { type: "text"; text: string }
  | { type: "code"; language?: string; code: string };

type FileDiffEntry = {
  path: string;
  added: number;
  removed: number;
};

function parseParts(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) parts.push({ type: "text", text: content.slice(lastIndex, match.index) });
    parts.push({ type: "code", language: match[1]?.trim() || undefined, code: match[2] ?? "" });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) parts.push({ type: "text", text: content.slice(lastIndex) });
  return parts.length > 0 ? parts : [{ type: "text", text: content }];
}

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
          <RichText key={`text-${index}`} text={block.text} theme={theme} inverse={inverse} />
        ) : null;
      })}
    </View>
  );
}

function RichText({ text, theme, inverse = false }: { text: string; theme: Theme; inverse?: boolean }) {
  const color = inverse ? "#fff" : theme.text;
  return (
    <View style={{ gap: 8 }}>
      {parseParts(text).map((part, index) =>
        part.type === "code" ? (
          <CodeBlock key={`code-${index}`} label={part.language || "代码"} code={part.code} theme={theme} />
        ) : (
          <Text key={`text-${index}`} selectable style={{ color, fontSize: 14, lineHeight: 21 }}>
            {part.text.split(/(`[^`\n]+`)/g).map((chunk, chunkIndex) => {
              const isCode = chunk.startsWith("`") && chunk.endsWith("`") && chunk.length > 1;
              return (
                <Text
                  key={chunkIndex}
                  style={isCode ? {
                    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
                    backgroundColor: inverse ? "rgba(255,255,255,0.18)" : theme.bgInput,
                  } : undefined}
                >
                  {isCode ? chunk.slice(1, -1) : chunk}
                </Text>
              );
            })}
          </Text>
        ),
      )}
    </View>
  );
}

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
        borderRadius: 12,
        borderCurve: "continuous",
        backgroundColor: theme.bgCard,
        overflow: "hidden",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.separator,
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

  return (
    <View
      style={{
        borderRadius: 12,
        borderCurve: "continuous",
        backgroundColor: theme.bgCard,
        overflow: "hidden",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.separator,
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
        <AppSymbol name={tool.name.includes("MCP") ? "server.rack" : "terminal.fill"} size={15} color={theme.textTertiary} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text selectable style={{ color: theme.textSecondary, fontSize: 13, fontWeight: "700" }} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text selectable style={{ color: theme.textTertiary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {meta ? (
          <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: meta.bg }}>
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
        paddingVertical: 4,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
      }}
    >
      <AppSymbol name={icon} size={14} color={theme.textTertiary} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "800" }} numberOfLines={1}>
            {title}
          </Text>
          {running ? <ActivityIndicator size="small" color={theme.textTertiary} /> : null}
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
        borderRadius: 12,
        borderCurve: "continuous",
        backgroundColor: theme.bgCard,
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
  error,
  onSubmit,
}: {
  input: AgentStructuredInput;
  theme: Theme;
  submitted?: boolean;
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
    !submitted;

  const toggleOption = useCallback((questionId: string, label: string, limit?: number) => {
    setSelected((current) => {
      const max = Math.max(limit ?? 1, 1);
      const existing = current[questionId] ?? [];
      const hasValue = existing.includes(label);
      const nextValues = hasValue
        ? existing.filter((value) => value !== label)
        : max === 1
          ? [label]
          : existing.length < max
            ? [...existing, label]
            : existing;
      return { ...current, [questionId]: nextValues };
    });
  }, []);

  return (
    <View
      style={{
        borderRadius: 12,
        borderCurve: "continuous",
        backgroundColor: theme.bgCard,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.separator,
        padding: 12,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AppSymbol name="questionmark.circle.fill" size={15} color={theme.accent} />
        <Text style={{ color: theme.text, fontSize: 14, fontWeight: "800" }}>
          {submitted ? "已发送补充信息" : "Agent 需要补充信息"}
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
              {question.options.map((option) => (
                <Pressable
                  key={option.id}
                  disabled={submitted}
                  onPress={() => toggleOption(question.id, option.label, question.selectionLimit)}
                  style={{
                    borderRadius: 10,
                    borderCurve: "continuous",
                    paddingHorizontal: 10,
                    paddingVertical: 9,
                    backgroundColor: (selected[question.id] ?? []).includes(option.label)
                      ? theme.accentLight
                      : theme.bgInput,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: (selected[question.id] ?? []).includes(option.label)
                      ? theme.accent
                      : theme.separator,
                    opacity: submitted ? 0.65 : 1,
                  }}
                >
                  <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "800" }}>
                    {option.label}
                  </Text>
                  {option.description ? (
                    <Text style={{ color: theme.textTertiary, fontSize: 11, marginTop: 2 }}>
                      {option.description}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          ) : null}
          {question.options?.length && !question.isOther ? null : (
            <TextInput
              value={typed[question.id] ?? ""}
              onChangeText={(value) => setTyped((current) => ({ ...current, [question.id]: value }))}
              editable={!submitted}
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
            发送回答
          </Text>
        </Pressable>
      ) : null}
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

function TimelineItemView({
  item,
  theme,
  onPermission,
  onStructuredInput,
}: {
  item: AgentTimelineItem;
  theme: Theme;
  onPermission: (requestId: string, outcome: "allow" | "deny" | "cancelled", optionId?: string) => void;
  onStructuredInput: (requestId: string, answers: Record<string, string[]>) => void;
}) {
  if (item.kind === "subagent_action" && item.subagent) {
    return <SubagentCard action={item.subagent} theme={theme} running={item.isStreaming} />;
  }

  if (item.kind === "user_input_prompt" && item.structuredInput) {
    return (
      <StructuredInputCard
        input={item.structuredInput}
        theme={theme}
        submitted={item.metadata?.inputSubmitted === true}
        error={typeof item.metadata?.inputError === "string" ? item.metadata.inputError : undefined}
        onSubmit={(answers) => onStructuredInput(item.structuredInput!.requestId, answers)}
      />
    );
  }

  if (item.kind === "thinking") {
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
    return (
      <View
        style={{
          alignSelf: isUser ? "flex-end" : "stretch",
          maxWidth: isUser ? "88%" : "100%",
          borderRadius: 12,
          borderCurve: "continuous",
          backgroundColor: isUser ? theme.accent : "transparent",
          paddingVertical: isUser ? 10 : 2,
          paddingHorizontal: isUser ? 12 : 0,
          gap: 6,
        }}
      >
        {text || item.content?.length ? (
          <MessageContent blocks={item.content} fallbackText={text} theme={theme} inverse={isUser} />
        ) : item.isStreaming ? (
          <StreamingPill theme={theme} />
        ) : null}
        {!isUser && item.isStreaming && (text || item.content?.length) ? <StreamingPill theme={theme} /> : null}
      </View>
    );
  }

  if (item.type === "tool_call" && item.toolCall) {
    return <ToolCard tool={item.toolCall} theme={theme} />;
  }

  if (item.type === "plan" && item.plan?.length) {
    return (
      <View style={{ borderRadius: 12, borderCurve: "continuous", backgroundColor: theme.bgCard, padding: 12, gap: 9 }}>
        <Text style={{ color: theme.text, fontSize: 14, fontWeight: "700" }}>执行计划</Text>
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
    );
  }

  if (item.type === "permission" && item.permission) {
    const outcome = item.metadata?.permissionOutcome;
    const selectedOptionId = item.metadata?.optionId;
    const permissionError = typeof item.metadata?.permissionError === "string"
      ? item.metadata.permissionError
      : undefined;
    const options = item.permission.options.length > 0
      ? item.permission.options
      : [
          { id: "deny", label: "拒绝", kind: "deny" as const },
          { id: "allow_once", label: "允许一次", kind: "allow" as const },
        ];
    return (
      <View
        style={{
          borderRadius: 14,
          borderCurve: "continuous",
          backgroundColor: theme.accentLight,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.separator,
          padding: 12,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <AppSymbol name="checkmark.shield" size={16} color={theme.warning} />
          <Text style={{ flex: 1, color: theme.text, fontSize: 15, fontWeight: "800" }} numberOfLines={1}>
            {outcome ? "授权已处理" : "需要授权"}{item.permission.toolName ? ` · ${item.permission.toolName}` : ""}
          </Text>
        </View>
        {item.permission.context ? (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
            {item.permission.context}
          </Text>
        ) : null}
        {item.permission.toolInput ? <CodeBlock label="请求内容" code={item.permission.toolInput} theme={theme} maxLines={5} /> : null}
        {permissionError ? (
          <Text style={{ color: theme.error, fontSize: 12, fontWeight: "700" }}>
            {permissionError}
          </Text>
        ) : null}
        {outcome ? (
          <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
            {options.find((option) => option.id === selectedOptionId)?.label ??
              (outcome === "allow" ? "已允许" : outcome === "deny" ? "已拒绝" : "已取消")}
          </Text>
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {options.map((option) => {
              const optionOutcome = option.kind === "allow" ? "allow" : option.kind === "deny" ? "deny" : "cancelled";
              const isAllow = option.kind === "allow";
              const isDeny = option.kind === "deny";
              return (
                <Pressable
                  key={option.id}
                  onPress={() => onPermission(item.permission!.requestId, optionOutcome, option.id)}
                  style={({ pressed }) => ({
                    minWidth: options.length > 2 ? "47%" : undefined,
                    flexGrow: 1,
                    borderRadius: 10,
                    borderCurve: "continuous",
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    alignItems: "center",
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: isAllow ? "transparent" : isDeny ? theme.error : theme.separator,
                    backgroundColor: isAllow
                      ? pressed ? theme.accentSecondary : theme.accent
                      : pressed ? theme.bgInput : theme.bg,
                  })}
                >
                  <Text style={{ color: isAllow ? "#fff" : isDeny ? theme.error : theme.textSecondary, fontWeight: "700" }}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    );
  }

  if (item.type === "error") {
    return (
      <View style={{ borderRadius: 12, borderCurve: "continuous", backgroundColor: theme.errorLight, padding: 12 }}>
        <Text selectable style={{ color: theme.error, fontSize: 13, lineHeight: 18 }}>
          {item.error || item.text || "Agent 出错了"}
        </Text>
      </View>
    );
  }

  return null;
}

export function AgentConversationScreen({
  conversationId,
  workspace,
  onBack,
}: AgentConversationScreenProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const conversation = workspace.getConversation(conversationId);
  const timeline = workspace.getTimeline(conversationId);
  const visibleTimeline = useMemo(() => dedupeTimelineItems(timeline), [timeline]);
  const timelineRef = useRef<ScrollView>(null);
  const [text, setText] = useState("");
  const [model, setModel] = useState<string | undefined>(conversation?.model);
  const [effort, setEffort] = useState<AgentReasoningEffort | undefined>(conversation?.reasoningEffort);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode | undefined>(
    conversation?.permissionMode,
  );
  const [attachments, setAttachments] = useState<AgentContentBlock[]>([]);
  const capabilities = conversation ? workspace.capabilitiesBySessionId.get(conversation.sessionId) : undefined;
  const supportsImages = Boolean(capabilities?.enabled && capabilities.supportsImages);
  const running = conversation?.status === "running" || conversation?.status === "waiting_permission";
  const meta = visibleConversationStatus(conversation?.status, theme);
  const permission = permissionMeta(permissionMode, theme);
  const canSend = Boolean(text.trim() || attachments.length > 0);
  const runtimeMenuActions = useMemo(
    () => [
      ...MODEL_OPTIONS.map((option) => ({
        id: `model:${option.value ?? DEFAULT_OPTION_ID}`,
        title: `模型 · ${option.label}`,
        image: "square.stack.3d.up",
        state: option.value === model ? "on" as const : "off" as const,
      })),
      ...EFFORT_OPTIONS.map((option) => ({
        id: `effort:${option.value ?? DEFAULT_OPTION_ID}`,
        title: `推理强度 · ${option.label}`,
        image: "textformat.size.larger",
        state: option.value === effort ? "on" as const : "off" as const,
      })),
    ],
    [effort, model],
  );
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

  useEffect(() => {
    if (visibleTimeline.length === 0) return;
    requestAnimationFrame(() => {
      timelineRef.current?.scrollToEnd({ animated: true });
    });
  }, [timelineAutoScrollKey, visibleTimeline.length]);

  const send = useCallback(() => {
    const value = text.trim();
    if (!canSend || !conversation) return;
    workspace.sendPrompt(conversation.id, value, {
      model,
      reasoningEffort: effort,
      permissionMode,
      attachments,
    });
    setText("");
    setAttachments([]);
  }, [attachments, canSend, conversation, effort, model, permissionMode, text, workspace]);

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
      Alert.alert("当前 Agent 不支持图片", "请升级 CLI 或切换到支持图片输入的 Codex Agent。");
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
      Alert.alert("当前 Agent 不支持图片", "请升级 CLI 或切换到支持图片输入的 Codex Agent。");
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
      style={{ flex: 1, backgroundColor: theme.bg }}
    >
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingHorizontal: 12,
          paddingBottom: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.separator,
          backgroundColor: theme.bg,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <Pressable onPress={onBack} hitSlop={8} style={{ width: 34, height: 34, alignItems: "center", justifyContent: "center" }}>
          <AppSymbol name="chevron.left" size={20} color={theme.text} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.text, fontSize: 16, fontWeight: "800" }} numberOfLines={1}>
            {conversation.title || "Agent"}
          </Text>
          <Text style={{ color: theme.textTertiary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
            {[displayProvider(conversation.provider), shortPath(conversation.cwd)].filter(Boolean).join(" · ")}
          </Text>
        </View>
        {running ? <ActivityIndicator size="small" color={theme.accent} /> : null}
        {meta ? (
          <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: meta.bg }}>
            <Text style={{ color: meta.color, fontSize: 11, fontWeight: "700" }}>{meta.label}</Text>
          </View>
        ) : null}
        <MenuView
          actions={[
            { id: "refresh", title: "刷新快照", image: "arrow.clockwise" },
            { id: "archive", title: conversation.archived ? "取消归档" : "归档", image: "archivebox" },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "refresh") {
              workspace.requestCapabilities(conversation.sessionId);
            }
            if (nativeEvent.event === "archive") {
              workspace.archive(conversation.id, !conversation.archived).then(onBack).catch(() => {});
            }
          }}
        >
          <View style={{ width: 34, height: 34, alignItems: "center", justifyContent: "center" }}>
            <AppSymbol name="ellipsis.circle" size={20} color={theme.textSecondary} />
          </View>
        </MenuView>
      </View>

      <ScrollView
        ref={timelineRef}
        contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: 16 }}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => timelineRef.current?.scrollToEnd({ animated: true })}
      >
        {visibleTimeline.length === 0 ? (
          <View style={{ borderRadius: 12, borderCurve: "continuous", backgroundColor: theme.bgCard, padding: 18, alignItems: "center", gap: 8 }}>
            <AppSymbol name="sparkles" size={24} color={theme.accent} />
            <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>开始一个 Agent 对话</Text>
            <Text style={{ color: theme.textTertiary, fontSize: 13, lineHeight: 18, textAlign: "center" }}>
              发送 prompt 后，回复、代码、工具调用和权限请求都会在这里按时间线展示。
            </Text>
          </View>
        ) : visibleTimeline.map((item) => (
          <TimelineItemView
            key={item.id}
            item={item}
            theme={theme}
            onPermission={(requestId, outcome, optionId) =>
              workspace.respondPermission(conversation.id, requestId, outcome, optionId)
            }
            onStructuredInput={(requestId, answers) =>
              workspace.respondStructuredInput(conversation.id, requestId, answers)
            }
          />
        ))}
      </ScrollView>

      <View
        style={{
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.separator,
          paddingHorizontal: 10,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 10),
          backgroundColor: theme.bg,
        }}
      >
        <View
          style={{
            borderRadius: 18,
            borderCurve: "continuous",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.separator,
            backgroundColor: theme.bgCard,
            paddingHorizontal: 10,
            paddingTop: 8,
            paddingBottom: 8,
            gap: 7,
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
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="给 Agent 发送消息"
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
              minHeight: 48,
              maxHeight: 132,
              color: theme.text,
              fontSize: 15,
              lineHeight: 21,
              paddingHorizontal: 4,
              paddingVertical: 4,
            }}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {supportsImages ? (
              <Pressable
                onPress={showAttachSheet}
                style={({ pressed }) => ({
                  width: 34,
                  height: 34,
                  borderRadius: 17,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? theme.accentLight : theme.bgInput,
                })}
              >
                <AppSymbol name="photo" size={17} color={theme.textSecondary} />
              </Pressable>
            ) : null}
            <MenuView
              actions={menuActions(PERMISSION_OPTIONS, permissionMode)}
              onPressAction={({ nativeEvent }) =>
                setPermissionMode(valueFromMenuId<AgentPermissionMode>(nativeEvent.event))
              }
            >
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 999,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: permission.bg,
                }}
              >
                <AppSymbol name={permission.icon} size={13} color={permission.color} />
              </View>
            </MenuView>
            <MenuView
              actions={runtimeMenuActions}
              onPressAction={({ nativeEvent }) => {
                const event = nativeEvent.event;
                if (event.startsWith("model:")) {
                  setModel(valueFromMenuId<string>(event.slice("model:".length)));
                }
                if (event.startsWith("effort:")) {
                  setEffort(valueFromMenuId<AgentReasoningEffort>(event.slice("effort:".length)));
                }
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 7,
                  backgroundColor: theme.bgInput,
                  maxWidth: 160,
                }}
              >
                <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
                  {formatRuntime(model, effort)}
                </Text>
                <AppSymbol name="chevron.down" size={9} color={theme.textTertiary} />
              </View>
            </MenuView>
            <View style={{ flex: 1 }} />
            {running ? (
              <Pressable
                onPress={() => workspace.cancel(conversation.id)}
                style={({ pressed }) => ({
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? theme.errorLight : theme.bgInput,
                })}
              >
                <AppSymbol name="stop.circle.fill" size={20} color={theme.error} />
              </Pressable>
            ) : (
              <Pressable
                onPress={send}
                disabled={!canSend}
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
            )}
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
