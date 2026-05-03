import React, { memo, useCallback, useMemo, useRef, useState } from "react";
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
  { label: "默认权限", value: "read_only", image: "hand.raised.fill" },
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

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

function copy(value: string): void {
  Clipboard.setString(value);
  Haptics.selectionAsync().catch(() => {});
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
        <MessageContent blocks={item.content} fallbackText={text} theme={theme} inverse={isUser} />
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
    const outcome = item.metadata?.permissionOutcome;
    return (
      <View style={{ borderRadius: 12, borderCurve: "continuous", backgroundColor: theme.accentLight, padding: 12, gap: 8 }}>
        <Text style={{ color: theme.warning, fontSize: 15, fontWeight: "700" }}>
          {outcome ? "已处理授权" : "需要授权"}{item.permission.toolName ? ` · ${item.permission.toolName}` : ""}
        </Text>
        {item.permission.context ? (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
            {item.permission.context}
          </Text>
        ) : null}
        {item.permission.toolInput ? <CodeBlock label="请求内容" code={item.permission.toolInput} theme={theme} maxLines={5} /> : null}
        {outcome ? (
          <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
            {outcome === "allow" ? "已允许" : outcome === "deny" ? "已拒绝" : "已取消"}
          </Text>
        ) : (
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
  const timelineRef = useRef<ScrollView>(null);
  const [text, setText] = useState("");
  const [model, setModel] = useState<string | undefined>(conversation?.model);
  const [effort, setEffort] = useState<AgentReasoningEffort | undefined>(conversation?.reasoningEffort);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode | undefined>(
    conversation?.permissionMode ?? "read_only",
  );
  const [attachments, setAttachments] = useState<AgentContentBlock[]>([]);
  const capabilities = conversation ? workspace.capabilitiesBySessionId.get(conversation.sessionId) : undefined;
  const supportsImages = Boolean(capabilities?.enabled && capabilities.supportsImages);
  const running = conversation?.status === "running" || conversation?.status === "waiting_permission";
  const meta = statusMeta(conversation?.status ?? "unavailable", theme);
  const permission = permissionMeta(permissionMode, theme);
  const canSend = Boolean(text.trim() || attachments.length > 0);

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
        ref={timelineRef}
        contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: 16 }}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => timelineRef.current?.scrollToEnd({ animated: true })}
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
              actions={menuActions(MODEL_OPTIONS, model)}
              onPressAction={({ nativeEvent }) => setModel(valueFromMenuId<string>(nativeEvent.event))}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  borderRadius: 999,
                  paddingHorizontal: 9,
                  paddingVertical: 7,
                  backgroundColor: theme.bgInput,
                  width: 86,
                }}
              >
                <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "700" }} numberOfLines={1}>
                  {formatModel(model)}
                </Text>
                <AppSymbol name="chevron.down" size={9} color={theme.textTertiary} />
              </View>
            </MenuView>
            <MenuView
              actions={menuActions(EFFORT_OPTIONS, effort)}
              onPressAction={({ nativeEvent }) =>
                setEffort(valueFromMenuId<AgentReasoningEffort>(nativeEvent.event))
              }
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  borderRadius: 999,
                  paddingHorizontal: 9,
                  paddingVertical: 7,
                  backgroundColor: theme.bgInput,
                  width: 58,
                }}
              >
                <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "700" }} numberOfLines={1}>
                  {formatEffort(effort)}
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
