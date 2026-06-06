import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { AppSymbol } from "../../../components/AppSymbol";
import type { Theme } from "../../../theme";
import {
  FILE_PREVIEW_MAX_BYTES,
  MONO_FONT,
  fileName,
  formatBytes,
  languageFromPath,
  parentPath,
  timelineSurface,
} from "../lib/format";
import { commandCategoryLabel, filteredCommands } from "../lib/commands";
import { queuedFollowUpText } from "../lib/timeline";
import type {
  AgentCommandDescriptor,
  AgentFileEntry,
  AgentFileReadResult,
  AgentTimelineItem,
  AgentWorkspaceHandle,
} from "../types";
import { HighlightedCodeLine } from "./content";

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

export function SlashCommandPanel({
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

export function MentionPanel({
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

export function QueuedFollowUpList({
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

export function FilePreviewDrawer({
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
