import React, { useEffect, useState } from "react";
import { FlatList, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AppSymbol } from "./AppSymbol";
import type { BrowseEntry } from "../hooks/useSessionManager";

export function FolderPickerModal({
  visible,
  browseResult,
  terminals,
  onBrowse,
  onSelect,
  onClose,
  theme,
}: {
  visible: boolean;
  browseResult: { path: string; entries: BrowseEntry[]; error?: string } | null;
  terminals: Map<string, { cwd: string; status: string }>;
  onBrowse: (path: string) => void;
  onSelect: (path: string) => void;
  onClose: () => void;
  theme: any;
}) {
  const [manualPath, setManualPath] = useState("");
  const currentPath = browseResult?.path ?? "~";

  useEffect(() => {
    if (visible && !browseResult) onBrowse("~");
  }, [visible]);

  const getRunningTerminalId = (path: string): string | null => {
    for (const [tid, t] of terminals) {
      if (t.cwd === path && t.status === "running") return tid;
    }
    return null;
  };

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
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }}>
          <Text style={{ color: theme.text, fontSize: 17, fontWeight: "600" }}>选择文件夹</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <Text style={{ color: theme.accent, fontSize: 15 }}>关闭</Text>
          </Pressable>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, flexWrap: "wrap" }}>
          <Pressable onPress={() => onBrowse("/")} hitSlop={4}>
            <Text style={{ color: theme.accent, fontSize: 13 }}>/</Text>
          </Pressable>
          {pathParts.map((part, i) => {
            const fullPath = "/" + pathParts.slice(0, i + 1).join("/");
            const isLast = i === pathParts.length - 1;
            return (
              <View key={fullPath} style={{ flexDirection: "row", alignItems: "center" }}>
                <Text style={{ color: theme.textTertiary, fontSize: 13, marginHorizontal: 2 }}>/</Text>
                <Pressable onPress={() => !isLast && onBrowse(fullPath)} hitSlop={4}>
                  <Text style={{ color: isLast ? theme.text : theme.accent, fontSize: 13, fontWeight: isLast ? "600" : "400" }}>{part}</Text>
                </Pressable>
              </View>
            );
          })}
        </View>

        <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
          {getRunningTerminalId(currentPath) ? (
            <Pressable
              onPress={() => { onSelect(currentPath); onClose(); }}
              style={{ backgroundColor: theme.success + "30", borderRadius: 8, paddingVertical: 10, alignItems: "center" }}
            >
              <Text style={{ color: theme.success, fontWeight: "600", fontSize: 14 }}>切换到此终端 (运行中)</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => { onSelect(currentPath); onClose(); }}
              style={{ backgroundColor: theme.accentLight, borderRadius: 8, paddingVertical: 10, alignItems: "center" }}
            >
              <Text style={{ color: theme.accent, fontWeight: "600", fontSize: 14 }}>在此打开终端</Text>
            </Pressable>
          )}
        </View>

        {browseResult?.error && (
          <Text style={{ color: theme.error, fontSize: 12, paddingHorizontal: 16, paddingBottom: 4 }}>{browseResult.error}</Text>
        )}

        <FlatList
          data={browseResult?.entries ?? []}
          keyExtractor={(item) => item.path}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 12 }}
          ListEmptyComponent={
            <Text style={{ color: theme.textTertiary, fontSize: 13, textAlign: "center", paddingTop: 24 }}>
              {browseResult ? "空目录" : "加载中..."}
            </Text>
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

        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border }}>
          <TextInput
            value={manualPath}
            onChangeText={setManualPath}
            placeholder="手动输入路径..."
            placeholderTextColor={theme.textTertiary}
            style={{ flex: 1, color: theme.text, fontSize: 14, backgroundColor: theme.bgInput, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}
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
              if (p) { onSelect(p); onClose(); setManualPath(""); }
            }}
            style={{ marginLeft: 8, backgroundColor: theme.accentLight, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 }}
          >
            <Text style={{ color: theme.accent, fontWeight: "600", fontSize: 14 }}>打开</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
