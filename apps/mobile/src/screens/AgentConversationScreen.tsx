import React, { memo, useCallback, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Clipboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { MenuView } from "@react-native-menu/menu";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import type { AgentWorkspaceHandle } from "../hooks/useAgentWorkspace";
import type {
  AgentConversationRecord,
  AgentPermissionMode,
  AgentReasoningEffort,
  AgentTimelineItem,
  AgentToolCall,
} from "../storage/agent-workspace";
import { useTheme, type Theme } from "../theme";

interface AgentConversationScreenProps {
  conversationId: string;
  workspace: AgentWorkspaceHandle;
  onBack: () => void;
}

type Option<T extends string> = { label: string; value?: T };

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
  { label: "只读", value: "read_only" },
  { label: "工作区写入", value: "workspace_write" },
  { label: "完全访问", value: "full_access" },
];

const PROMPT_CHIPS = ["继续", "解释", "修复", "写测试", "总结当前改动"];

function showOptionSheet<T extends string>(
  title: string,
  options: Option<T>[],
  currentValue: T | undefined,
  onSelect: (value: T | undefined) => void,
) {
  const labels = options.map((option) =>
    option.value === currentValue ? `${option.label} ✓` : option.label,
  );
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: ["取消", ...labels], cancelButtonIndex: 0 },
      (index) => {
        if (index <= 0) return;
        onSelect(options[index - 1]?.value);
      },
    );
    return;
  }
  Alert.alert(title, undefined, [
    { text: "取消", style: "cancel" },
    ...options.map((option, index) => ({
      text: labels[index],
      onPress: () => onSelect(option.value),
    })),
  ]);
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

function permissionMeta(mode: AgentPermissionMode | undefined, theme: Theme) {
  if (mode === "full_access") {
    return { label: "完全访问", icon: "lock.open.fill", color: theme.warning, bg: theme.accentLight };
  }
  if (mode === "workspace_write") {
    return { label: "工作区写入", icon: "folder.fill", color: theme.accent, bg: theme.accentLight };
  }
  return { label: "只读", icon: "eye.fill", color: theme.textTertiary, bg: theme.bgInput };
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

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

function copy(value: string): void {
  Clipboard.setString(value);
  Haptics.selectionAsync().catch(() => {});
}

type MessagePart =
  | { type: "text"; text: string }
  | { type: "code"; language?: string; code: string };

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
        <Pressable onPress={() => copy(code)} hitSlop={8}>
          <AppSymbol name="doc.on.doc" size={13} color={theme.textTertiary} />
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

const ToolCard = memo(function ToolCard({ tool, theme }: { tool: AgentToolCall; theme: Theme }) {
  const [expanded, setExpanded] = useState(false);
  const input = tool.input?.trim();
  const output = tool.output?.trim();
  const long = Boolean((input && input.length > 900) || (output && output.length > 1200));
  const meta = statusMeta(tool.status, theme);
  const language = tool.name.includes("命令") ? "shell" : tool.name.includes("文件") ? "diff" : "text";

  return (
    <View style={{ borderRadius: 12, borderCurve: "continuous", backgroundColor: theme.bgCard, padding: 12, gap: 10 }}>
      <Pressable
        onPress={() => long && setExpanded((value) => !value)}
        disabled={!long}
        style={{ flexDirection: "row", alignItems: "center", gap: 9 }}
      >
        <AppSymbol name={tool.name.includes("文件") ? "doc.text" : tool.name.includes("MCP") ? "server.rack" : "terminal.fill"} size={16} color={theme.accent} />
        <Text selectable style={{ flex: 1, color: theme.text, fontSize: 14, fontWeight: "700" }} numberOfLines={1}>
          {tool.name}
        </Text>
        {long ? <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={13} color={theme.textTertiary} /> : null}
        <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: meta.bg }}>
          <Text style={{ color: meta.color, fontSize: 11, fontWeight: "700" }}>{meta.label}</Text>
        </View>
      </Pressable>
      {input ? <CodeBlock label={`输入 · ${language}`} code={expanded ? input : input.slice(0, 900)} theme={theme} maxLines={expanded ? 24 : 6} /> : null}
      {output ? <CodeBlock label={`输出 · ${language}`} code={expanded ? output : output.slice(0, 1200)} theme={theme} maxLines={expanded ? 28 : 8} /> : null}
      {long ? (
        <Pressable onPress={() => setExpanded((value) => !value)} hitSlop={8}>
          <Text style={{ color: theme.accent, fontSize: 12, fontWeight: "700" }}>
            {expanded ? "收起" : "展开更多"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

function TimelineItemView({
  item,
  theme,
  onPermission,
}: {
  item: AgentTimelineItem;
  theme: Theme;
  onPermission: (requestId: string, outcome: "allow" | "deny", optionId?: string) => void;
}) {
  if (item.type === "message") {
    const isUser = item.role === "user";
    const text = item.text || (item.content ?? []).map((block) => block.text ?? "").join("\n");
    return (
      <View
        style={{
          alignSelf: isUser ? "flex-end" : "stretch",
          maxWidth: isUser ? "88%" : "100%",
          borderRadius: 12,
          borderCurve: "continuous",
          backgroundColor: isUser ? theme.accent : theme.bgCard,
          paddingVertical: 10,
          paddingHorizontal: 12,
          gap: 7,
        }}
      >
        {!isUser ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <AppSymbol name="sparkles" size={13} color={theme.textTertiary} />
            <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "700" }}>
              Agent{item.isStreaming ? " 正在输入" : ""}
            </Text>
          </View>
        ) : null}
        <RichText text={text} theme={theme} inverse={isUser} />
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
    const allow = item.permission.options.find((option) => option.kind === "allow");
    const deny = item.permission.options.find((option) => option.kind === "deny");
    return (
      <View style={{ borderRadius: 12, borderCurve: "continuous", backgroundColor: theme.accentLight, padding: 12, gap: 8 }}>
        <Text style={{ color: theme.warning, fontSize: 15, fontWeight: "700" }}>
          需要授权{item.permission.toolName ? ` · ${item.permission.toolName}` : ""}
        </Text>
        {item.permission.context ? (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
            {item.permission.context}
          </Text>
        ) : null}
        {item.permission.toolInput ? <CodeBlock label="请求内容" code={item.permission.toolInput} theme={theme} maxLines={5} /> : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable
            onPress={() => onPermission(item.permission!.requestId, "deny", deny?.id)}
            style={({ pressed }) => ({
              flex: 1,
              borderRadius: 9,
              paddingVertical: 10,
              alignItems: "center",
              backgroundColor: pressed ? theme.bgInput : theme.bgCard,
            })}
          >
            <Text style={{ color: theme.error, fontWeight: "700" }}>{deny?.label ?? "拒绝"}</Text>
          </Pressable>
          <Pressable
            onPress={() => onPermission(item.permission!.requestId, "allow", allow?.id)}
            style={({ pressed }) => ({
              flex: 1,
              borderRadius: 9,
              paddingVertical: 10,
              alignItems: "center",
              backgroundColor: pressed ? theme.accentSecondary : theme.accent,
            })}
          >
            <Text style={{ color: "#fff", fontWeight: "700" }}>{allow?.label ?? "允许"}</Text>
          </Pressable>
        </View>
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
  const [text, setText] = useState("");
  const [model, setModel] = useState<string | undefined>(conversation?.model);
  const [effort, setEffort] = useState<AgentReasoningEffort | undefined>(conversation?.reasoningEffort);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode | undefined>(
    conversation?.permissionMode ?? "read_only",
  );
  const running = conversation?.status === "running" || conversation?.status === "waiting_permission";
  const meta = statusMeta(conversation?.status ?? "unavailable", theme);
  const permission = permissionMeta(permissionMode, theme);

  const send = useCallback(() => {
    const value = text.trim();
    if (!value || !conversation) return;
    workspace.sendPrompt(conversation.id, value, { model, reasoningEffort: effort, permissionMode });
    setText("");
  }, [conversation, effort, model, permissionMode, text, workspace]);

  const sendChip = useCallback((value: string) => {
    setText((current) => current ? `${current}\n${value}` : value);
  }, []);

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
            {[conversation.provider, shortPath(conversation.cwd)].filter(Boolean).join(" · ")}
          </Text>
        </View>
        {running ? <ActivityIndicator size="small" color={theme.accent} /> : null}
        <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: meta.bg }}>
          <Text style={{ color: meta.color, fontSize: 11, fontWeight: "700" }}>{meta.label}</Text>
        </View>
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
        contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        {timeline.length === 0 ? (
          <View style={{ borderRadius: 12, borderCurve: "continuous", backgroundColor: theme.bgCard, padding: 18, alignItems: "center", gap: 8 }}>
            <AppSymbol name="sparkles" size={24} color={theme.accent} />
            <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>开始一个 Agent 对话</Text>
            <Text style={{ color: theme.textTertiary, fontSize: 13, lineHeight: 18, textAlign: "center" }}>
              发送 prompt 后，回复、代码、工具调用和权限请求都会在这里按时间线展示。
            </Text>
          </View>
        ) : timeline.map((item) => (
          <TimelineItemView
            key={item.id}
            item={item}
            theme={theme}
            onPermission={(requestId, outcome, optionId) =>
              workspace.respondPermission(conversation.id, requestId, outcome, optionId)
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
            gap: 8,
          }}
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <View style={{ flexDirection: "row", gap: 6 }}>
              {PROMPT_CHIPS.map((chip) => (
                <Pressable
                  key={chip}
                  onPress={() => sendChip(chip)}
                  style={({ pressed }) => ({
                    borderRadius: 999,
                    paddingHorizontal: 9,
                    paddingVertical: 5,
                    backgroundColor: pressed ? theme.accentLight : theme.bgInput,
                  })}
                >
                  <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "700" }}>{chip}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="给 Agent 发送消息"
            placeholderTextColor={theme.textTertiary}
            multiline
            style={{
              minHeight: 54,
              maxHeight: 132,
              color: theme.text,
              fontSize: 15,
              lineHeight: 21,
              paddingHorizontal: 4,
              paddingVertical: 4,
            }}
          />
          <View style={{ gap: 7 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Pressable
                onPress={() => showOptionSheet("Agent 权限", PERMISSION_OPTIONS, permissionMode, setPermissionMode)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  borderRadius: 999,
                  paddingHorizontal: 9,
                  paddingVertical: 6,
                  backgroundColor: pressed ? theme.bgInput : permission.bg,
                  maxWidth: "72%",
                })}
              >
                <AppSymbol name={permission.icon} size={13} color={permission.color} />
                <Text style={{ color: permission.color, fontSize: 12, fontWeight: "700" }} numberOfLines={1}>
                  {permission.label}
                </Text>
                <AppSymbol name="chevron.down" size={10} color={permission.color} />
              </Pressable>
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
                  disabled={!text.trim()}
                  style={({ pressed }) => ({
                    width: 38,
                    height: 38,
                    borderRadius: 19,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: pressed ? theme.accentSecondary : theme.accent,
                    opacity: text.trim() ? 1 : 0.45,
                  })}
                >
                  <AppSymbol name="arrow.up" size={18} color="#fff" />
                </Pressable>
              )}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Pressable
                onPress={() => showOptionSheet("选择模型", MODEL_OPTIONS, model, setModel)}
                style={({ pressed }) => ({
                  flex: 1,
                  minWidth: 0,
                  borderRadius: 999,
                  paddingHorizontal: 9,
                  paddingVertical: 6,
                  backgroundColor: pressed ? theme.accentLight : theme.bgInput,
                })}
              >
                <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "700" }} numberOfLines={1}>
                  {formatModel(model)}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => showOptionSheet("推理强度", EFFORT_OPTIONS, effort, setEffort)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                  borderRadius: 999,
                  paddingHorizontal: 9,
                  paddingVertical: 6,
                  minWidth: 78,
                  backgroundColor: pressed ? theme.accentLight : theme.bgInput,
                })}
              >
                <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "700" }} numberOfLines={1}>
                  {formatEffort(effort)}
                </Text>
                <AppSymbol name="chevron.down" size={10} color={theme.textTertiary} />
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
