import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "./AppSymbol";
import type { BrowseEntry } from "../hooks/useSessionManager";

export function FolderPickerModal({
  visible,
  browseResult,
  terminals,
  onBrowse,
  onSelect,
  onMkdir,
  onClose,
  theme,
  initialPath,
  selectLabel,
  switchLabel,
  connectionStatus,
}: {
  visible: boolean;
  browseResult: { path: string; entries: BrowseEntry[]; error?: string } | null;
  terminals: Map<string, { cwd: string; status: string }>;
  onBrowse: (path: string) => void;
  onSelect: (path: string) => void;
  onMkdir?: (path: string) => void;
  onClose: () => void;
  theme: any;
  initialPath?: string;
  selectLabel?: string;
  switchLabel?: string;
  connectionStatus?: string;
}) {
  const insets = useSafeAreaInsets();
  const [manualPath, setManualPath] = useState("");
  const currentPath = browseResult?.path ?? initialPath ?? "~";
  const isConnected = !connectionStatus || connectionStatus === "connected";
  const isConnecting = visible && !browseResult && !isConnected;
  const isReading = visible && !browseResult && isConnected;
  const hasManualPath = manualPath.trim().length > 0;
  const initialPathRef = React.useRef(initialPath);
  initialPathRef.current = initialPath;

  useEffect(() => {
    if (visible && !browseResult) onBrowse(initialPathRef.current || "~");
  }, [visible]);

  const getRunningTerminalId = (path: string): string | null => {
    for (const [tid, t] of terminals) {
      if (t.cwd === path && t.status === "running") return tid;
    }
    return null;
  };

  const handleNewFolder = useCallback(() => {
    if (!onMkdir) return;
    Alert.prompt(
      "新建文件夹",
      `在 ${currentPath} 下创建`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "创建",
          onPress: (name?: string) => {
            const n = name?.trim();
            if (!n) return;
            const newPath = currentPath.endsWith("/")
              ? `${currentPath}${n}`
              : `${currentPath}/${n}`;
            onMkdir(newPath);
          },
        },
      ],
      "plain-text",
      "",
      "default",
    );
  }, [currentPath, onMkdir]);

  const pathParts = currentPath.split("/").filter(Boolean);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      {...Platform.select({
        ios: {
          sheetAllowedDetents: [0.7, "large"],
          sheetCornerRadius: 20,
          sheetGrabberVisible: true,
        },
        default: {},
      })}
    >
      <View style={{ flex: 1, backgroundColor: theme.bgElevated ?? theme.bg }}>
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 20, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }}>
          <Text style={{ color: theme.text, fontSize: 17, fontWeight: "600" }}>选择文件夹</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <View style={{
              width: 30, height: 30, borderRadius: 15,
              backgroundColor: theme.mode === "dark" ? "#48484a" : "#e5e5ea",
              alignItems: "center", justifyContent: "center",
            }}>
              <AppSymbol name="xmark" size={11} color={theme.textSecondary} />
            </View>
          </Pressable>
        </View>

        {/* Breadcrumb */}
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, flexWrap: "wrap" }}>
          <Pressable onPress={() => onBrowse("/")} hitSlop={4}>
            <Text style={{ color: theme.accent, fontSize: 13 }}>/</Text>
          </Pressable>
          {pathParts.map((part, i) => {
            const fullPath = "/" + pathParts.slice(0, i + 1).join("/");
            const isLast = i === pathParts.length - 1;
            return (
              <View key={fullPath} style={{ flexDirection: "row", alignItems: "center" }}>
                {i > 0 && <Text style={{ color: theme.textTertiary, fontSize: 13, marginHorizontal: 2 }}>/</Text>}
                <Pressable onPress={() => !isLast && onBrowse(fullPath)} hitSlop={4}>
                  <Text style={{ color: isLast ? theme.text : theme.accent, fontSize: 13, fontWeight: isLast ? "600" : "400" }}>{part}</Text>
                </Pressable>
              </View>
            );
          })}
        </View>

        {/* Action buttons */}
        <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingBottom: 10, gap: 8 }}>
          <Pressable
            onPress={() => { onSelect(currentPath); onClose(); }}
            style={{ flex: 1, backgroundColor: getRunningTerminalId(currentPath) ? theme.success + "30" : theme.accentLight, borderRadius: 8, paddingVertical: 10, alignItems: "center" }}
          >
            <Text style={{ color: getRunningTerminalId(currentPath) ? theme.success : theme.accent, fontWeight: "600", fontSize: 14 }}>
              {getRunningTerminalId(currentPath) ? (switchLabel ?? "切换到此终端") : (selectLabel ?? "选择此目录")}
            </Text>
          </Pressable>
          {onMkdir && (
            <Pressable
              onPress={handleNewFolder}
              style={{ backgroundColor: theme.bgCard, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" }}
            >
              <AppSymbol name="folder.badge.plus" size={16} color={theme.accent} />
            </Pressable>
          )}
        </View>

        {browseResult?.error && (
          <View style={{ paddingHorizontal: 20, paddingBottom: 8, gap: 8 }}>
            <Text selectable style={{ color: theme.error, fontSize: 12, lineHeight: 17 }}>{browseResult.error}</Text>
            <Pressable
              onPress={() => onBrowse(currentPath)}
              style={({ pressed }) => ({
                alignSelf: "flex-start",
                borderRadius: 999,
                paddingHorizontal: 10,
                paddingVertical: 6,
                backgroundColor: pressed ? theme.bgInput : theme.errorLight,
              })}
            >
              <Text style={{ color: theme.error, fontSize: 12, fontWeight: "800" }}>重试</Text>
            </Pressable>
          </View>
        )}

        <FlatList
          data={browseResult?.entries ?? []}
          keyExtractor={(item) => item.path}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16 }}
          ListEmptyComponent={
            <View style={{ alignItems: "center", gap: 8, paddingTop: 28 }}>
              {isConnecting || isReading ? <ActivityIndicator size="small" color={theme.textTertiary} /> : null}
              <Text style={{ color: theme.textTertiary, fontSize: 13, textAlign: "center" }}>
                {browseResult
                  ? "空目录"
                  : isConnecting
                    ? "正在连接主机…"
                    : "正在读取目录…"}
              </Text>
              {!browseResult && (
                <Text style={{ color: theme.textTertiary, fontSize: 12, textAlign: "center", lineHeight: 17 }}>
                  也可以在下方手动输入路径后直接使用。
                </Text>
              )}
            </View>
          }
          renderItem={({ item }) => {
            const running = getRunningTerminalId(item.path);
            return (
              <Pressable
                onPress={() => onBrowse(item.path)}
                style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.borderLight }}
              >
                <AppSymbol name="folder.fill" size={18} color={running ? theme.success : theme.accent} />
                <Text style={{ color: theme.text, fontSize: 15, marginLeft: 10, flex: 1 }} numberOfLines={1}>{item.name}</Text>
                {running && (
                  <View style={{ backgroundColor: theme.success + "25", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                    <Text style={{ color: theme.success, fontSize: 10, fontWeight: "600" }}>运行中</Text>
                  </View>
                )}
                <AppSymbol name="chevron.right" size={12} color={theme.textTertiary} />
              </Pressable>
            );
          }}
        />

        {/* Bottom input */}
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 10, paddingBottom: Math.max(insets.bottom, 12), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border }}>
            <TextInput
              value={manualPath}
              onChangeText={setManualPath}
              placeholder="手动输入路径…"
              placeholderTextColor={theme.textTertiary}
              style={{ flex: 1, color: theme.text, fontSize: 14, backgroundColor: theme.bgInput, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={() => {
                const p = manualPath.trim();
                if (p) { onSelect(p); onClose(); setManualPath(""); }
              }}
            />
            <Pressable
              onPress={() => {
                const p = manualPath.trim();
                if (p) onBrowse(p);
              }}
              disabled={!hasManualPath}
              style={{ marginLeft: 8, backgroundColor: theme.bgInput, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, opacity: hasManualPath ? 1 : 0.45 }}
            >
              <Text style={{ color: theme.textSecondary, fontWeight: "600", fontSize: 14 }}>跳转</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                const p = manualPath.trim();
                if (p) { onSelect(p); onClose(); setManualPath(""); }
              }}
              disabled={!hasManualPath}
              style={{ marginLeft: 8, backgroundColor: theme.accentLight, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, opacity: hasManualPath ? 1 : 0.45 }}
            >
              <Text style={{ color: theme.accent, fontWeight: "700", fontSize: 14 }}>使用</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
