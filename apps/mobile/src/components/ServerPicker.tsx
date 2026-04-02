import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAccessory } from "./KeyboardAccessory";
import { useTheme } from "../theme";
import type { SavedServer } from "../storage/servers";
import {
  addServer,
  loadServers,
  removeServer,
  setDefaultServer,
} from "../storage/servers";
import { fetchWithTimeout } from "../utils/fetch-with-timeout";

interface ServerPickerProps {
  selectedUrl: string;
  onSelect: (url: string) => void;
  /** When provided, the modal is controlled externally (no inline trigger rendered). */
  visible?: boolean;
  onDismiss?: () => void;
}

const ACCESSORY_ID = "server-form-accessory";

export function ServerPicker({ selectedUrl, onSelect, visible, onDismiss }: ServerPickerProps) {
  const { theme } = useTheme();
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [showModal, setShowModal] = useState(false);
  const isControlled = visible !== undefined;
  const modalVisible = isControlled ? visible : showModal;
  const [newUrl, setNewUrl] = useState("");
  const [newName, setNewName] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, boolean | null>>(
    {},
  );
  const nameInputRef = useRef<TextInput>(null);

  useEffect(() => {
    loadServers().then(setServers);
  }, []);

  const handleAdd = useCallback(async () => {
    if (!newUrl.trim()) return;
    const normalized = newUrl.trim().replace(/\/+$/, "");
    const updated = await addServer(normalized, newName.trim() || undefined);
    setServers(updated);
    onSelect(normalized);
    setNewUrl("");
    setNewName("");
  }, [newName, newUrl, onSelect]);

  const handleRemove = useCallback(
    async (url: string) => {
      const updated = await removeServer(url);
      setServers(updated);
      if (url === selectedUrl && updated.length > 0) {
        onSelect(updated[0]!.url);
      }
    },
    [onSelect, selectedUrl],
  );

  const handleSetDefault = useCallback(async (url: string) => {
    const updated = await setDefaultServer(url);
    setServers(updated);
  }, []);

  const handleTest = useCallback(async (url: string) => {
    setTesting(url);
    setTestResult((prev) => ({ ...prev, [url]: null }));
    try {
      const res = await fetchWithTimeout(`${url}/healthz`);
      setTestResult((prev) => ({ ...prev, [url]: res.ok }));
    } catch {
      setTestResult((prev) => ({ ...prev, [url]: false }));
    }
    setTesting(null);
  }, []);

  const closeModal = useCallback(() => {
    if (isControlled) {
      onDismiss?.();
    } else {
      setShowModal(false);
    }
  }, [isControlled, onDismiss]);

  const selected = servers.find((s) => s.url === selectedUrl);
  const selectedLabel = selected?.name ?? (selectedUrl || "请选择网关");
  const selectedHost = selectedUrl ? safeHost(selectedUrl) : "未选择服务器";

  const trigger = isControlled ? null : (
    <Pressable
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 16 }}
      onPress={() => setShowModal(true)}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: selected ? theme.success : theme.textTertiary }} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.text, fontSize: 14, fontWeight: "600" }} numberOfLines={1}>{selectedLabel}</Text>
          <Text style={{ color: theme.textTertiary, fontSize: 12 }} numberOfLines={1}>{selectedHost}</Text>
        </View>
      </View>
      <Text style={{ color: theme.accent, fontSize: 13, fontWeight: "600" }}>管理</Text>
    </Pressable>
  );

  return (
    <View>
      {trigger}

      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent={Platform.OS !== "ios"}
        presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
        onRequestClose={closeModal}
      >
        <View style={{ flex: 1, backgroundColor: theme.bgElevated }}>
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            {/* Header */}
            <View style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.separator,
            }}>
              <Text style={{ color: theme.text, fontSize: 18, fontWeight: "700" }}>网关服务器</Text>
              <Pressable onPress={closeModal}>
                <Text style={{ color: theme.accent, fontSize: 16, fontWeight: "600" }}>完成</Text>
              </Pressable>
            </View>

            <FlatList
              data={servers}
              keyExtractor={(item) => item.url}
              keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
              keyboardShouldPersistTaps="handled"
              style={{ flex: 1 }}
              renderItem={({ item }) => {
                const isSelected = item.url === selectedUrl;
                const result = testResult[item.url];
                return (
                  <Pressable
                    style={({ pressed }) => ({
                      backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                      marginHorizontal: 12,
                      marginTop: 10,
                      borderRadius: 12,
                      borderCurve: "continuous" as const,
                      borderWidth: 1,
                      borderColor: isSelected ? theme.accent : theme.borderLight,
                      padding: 12,
                      gap: 10,
                    })}
                    onPress={() => {
                      onSelect(item.url);
                      closeModal();
                    }}
                  >
                    <View style={{ gap: 3 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Text style={{ color: theme.text, fontSize: 15, fontWeight: "600" }}>{item.name}</Text>
                        {item.isDefault ? (
                          <Text style={{
                            color: theme.accent,
                            fontSize: 11,
                            fontWeight: "600",
                            backgroundColor: theme.accentLight,
                            paddingHorizontal: 6,
                            paddingVertical: 2,
                            borderRadius: 999,
                            overflow: "hidden",
                          }}>默认</Text>
                        ) : null}
                      </View>
                      <Text style={{ color: theme.textTertiary, fontSize: 12 }}>{item.url}</Text>
                    </View>

                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      <Pressable
                        style={{ minHeight: 30, paddingHorizontal: 10, borderRadius: 8, backgroundColor: theme.bgInput, alignItems: "center", justifyContent: "center" }}
                        onPress={() => handleTest(item.url)}
                      >
                        <Text style={[
                          { color: theme.textSecondary, fontSize: 12, fontWeight: "600" },
                          result === true && { color: theme.success },
                          result === false && { color: theme.error },
                        ]}>
                          {testing === item.url ? "检测中" : result === true ? "可用" : result === false ? "失败" : "检测"}
                        </Text>
                      </Pressable>

                      {!item.isDefault ? (
                        <Pressable
                          style={{ minHeight: 30, paddingHorizontal: 10, borderRadius: 8, backgroundColor: theme.bgInput, alignItems: "center", justifyContent: "center" }}
                          onPress={() => handleSetDefault(item.url)}
                        >
                          <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "600" }}>设为默认</Text>
                        </Pressable>
                      ) : null}

                      <Pressable
                        style={{ minHeight: 30, paddingHorizontal: 10, borderRadius: 8, backgroundColor: theme.errorLight, alignItems: "center", justifyContent: "center" }}
                        onPress={() => handleRemove(item.url)}
                      >
                        <Text style={{ color: theme.error, fontSize: 12, fontWeight: "600" }}>删除</Text>
                      </Pressable>
                    </View>
                  </Pressable>
                );
              }}
              ListEmptyComponent={
                <Text style={{ color: theme.textTertiary, textAlign: "center", padding: 24, fontSize: 14 }}>
                  还没有保存网关，先添加一个。
                </Text>
              }
              ListFooterComponent={
                <View style={{
                  backgroundColor: theme.bgCard,
                  margin: 12,
                  borderRadius: 14,
                  borderCurve: "continuous" as const,
                  borderWidth: 1,
                  borderColor: theme.borderLight,
                  padding: 12,
                  gap: 10,
                }}>
                  <Text style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}>新增网关</Text>
                  <TextInput
                    style={{
                      minHeight: 46,
                      borderRadius: 10,
                      borderCurve: "continuous" as const,
                      backgroundColor: theme.bgInput,
                      color: theme.text,
                      paddingHorizontal: 12,
                      fontSize: 15,
                    }}
                    placeholder="http://192.168.1.12:8787"
                    placeholderTextColor={theme.textTertiary}
                    value={newUrl}
                    onChangeText={setNewUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    clearButtonMode="while-editing"
                    inputAccessoryViewID={ACCESSORY_ID}
                    keyboardType="url"
                    keyboardAppearance={theme.mode}
                    returnKeyType="next"
                    onSubmitEditing={() => nameInputRef.current?.focus()}
                  />
                  <TextInput
                    ref={nameInputRef}
                    style={{
                      minHeight: 46,
                      borderRadius: 10,
                      borderCurve: "continuous" as const,
                      backgroundColor: theme.bgInput,
                      color: theme.text,
                      paddingHorizontal: 12,
                      fontSize: 15,
                    }}
                    placeholder="显示名称（可选）"
                    placeholderTextColor={theme.textTertiary}
                    value={newName}
                    onChangeText={setNewName}
                    autoCapitalize="words"
                    clearButtonMode="while-editing"
                    inputAccessoryViewID={ACCESSORY_ID}
                    keyboardAppearance={theme.mode}
                    returnKeyType="done"
                    onSubmitEditing={handleAdd}
                  />
                  <Pressable
                    style={({ pressed }) => ({
                      minHeight: 46,
                      borderRadius: 10,
                      borderCurve: "continuous" as const,
                      backgroundColor: theme.accent,
                      alignItems: "center",
                      justifyContent: "center",
                      opacity: !newUrl.trim() ? 0.45 : pressed ? 0.85 : 1,
                    })}
                    onPress={handleAdd}
                    disabled={!newUrl.trim()}
                  >
                    <Text style={{ color: "#ffffff", fontSize: 14, fontWeight: "700" }}>添加并使用</Text>
                  </Pressable>
                </View>
              }
            />
            <KeyboardAccessory nativeID={ACCESSORY_ID} title="网关配置" />
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
