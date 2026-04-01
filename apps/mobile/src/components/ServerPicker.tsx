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
}

const ACCESSORY_ID = "server-form-accessory";

export function ServerPicker({ selectedUrl, onSelect }: ServerPickerProps) {
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [showModal, setShowModal] = useState(false);
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

  const selected = servers.find((s) => s.url === selectedUrl);
  const selectedLabel = selected?.name ?? (selectedUrl || "请选择网关");
  const selectedHost = selectedUrl ? safeHost(selectedUrl) : "未选择服务器";

  return (
    <View>
      <Pressable style={styles.selector} onPress={() => setShowModal(true)}>
        <View style={styles.selectorLeft}>
          <View
            style={[
              styles.dot,
              selected ? styles.dotActive : styles.dotInactive,
            ]}
          />
          <View style={styles.selectorTextWrap}>
            <Text style={styles.selectorText} numberOfLines={1}>
              {selectedLabel}
            </Text>
            <Text style={styles.selectorSubtext} numberOfLines={1}>
              {selectedHost}
            </Text>
          </View>
        </View>
        <Text style={styles.manageText}>管理</Text>
      </Pressable>

      <Modal
        visible={showModal}
        animationType="slide"
        transparent={Platform.OS !== "ios"}
        presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
        onRequestClose={() => setShowModal(false)}
      >
        <View style={styles.modalOverlay}>
          <KeyboardAvoidingView
            style={styles.modal}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>网关服务器</Text>
              <Pressable onPress={() => setShowModal(false)}>
                <Text style={styles.closeText}>完成</Text>
              </Pressable>
            </View>

            <FlatList
              data={servers}
              keyExtractor={(item) => item.url}
              keyboardDismissMode={
                Platform.OS === "ios" ? "interactive" : "on-drag"
              }
              keyboardShouldPersistTaps="handled"
              style={styles.list}
              renderItem={({ item }) => {
                const isSelected = item.url === selectedUrl;
                const result = testResult[item.url];
                return (
                  <Pressable
                    style={[
                      styles.serverRow,
                      isSelected && styles.serverRowSelected,
                    ]}
                    onPress={() => {
                      onSelect(item.url);
                      setShowModal(false);
                    }}
                  >
                    <View style={styles.serverInfo}>
                      <View style={styles.serverNameRow}>
                        <Text style={styles.serverName}>{item.name}</Text>
                        {item.isDefault ? (
                          <Text style={styles.defaultBadge}>默认</Text>
                        ) : null}
                      </View>
                      <Text style={styles.serverUrl}>{item.url}</Text>
                    </View>

                    <View style={styles.serverActions}>
                      <Pressable
                        style={styles.actionBtn}
                        onPress={() => handleTest(item.url)}
                      >
                        <Text
                          style={[
                            styles.actionText,
                            result === true && styles.actionOk,
                            result === false && styles.actionFail,
                          ]}
                        >
                          {testing === item.url
                            ? "检测中"
                            : result === true
                              ? "可用"
                              : result === false
                                ? "失败"
                                : "检测"}
                        </Text>
                      </Pressable>

                      {!item.isDefault ? (
                        <Pressable
                          style={styles.actionBtn}
                          onPress={() => handleSetDefault(item.url)}
                        >
                          <Text style={styles.actionText}>设为默认</Text>
                        </Pressable>
                      ) : null}

                      <Pressable
                        style={styles.actionBtnDanger}
                        onPress={() => handleRemove(item.url)}
                      >
                        <Text style={styles.actionDangerText}>删除</Text>
                      </Pressable>
                    </View>
                  </Pressable>
                );
              }}
              ListEmptyComponent={
                <Text style={styles.emptyText}>
                  还没有保存网关，先添加一个。
                </Text>
              }
              ListFooterComponent={
                <View style={styles.addSection}>
                  <Text style={styles.addTitle}>新增网关</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="http://192.168.1.12:8787"
                    placeholderTextColor="#9ca3af"
                    value={newUrl}
                    onChangeText={setNewUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    clearButtonMode="while-editing"
                    inputAccessoryViewID={ACCESSORY_ID}
                    keyboardType="url"
                    returnKeyType="next"
                    onSubmitEditing={() => nameInputRef.current?.focus()}
                  />
                  <TextInput
                    ref={nameInputRef}
                    style={styles.input}
                    placeholder="显示名称（可选）"
                    placeholderTextColor="#9ca3af"
                    value={newName}
                    onChangeText={setNewName}
                    autoCapitalize="words"
                    clearButtonMode="while-editing"
                    inputAccessoryViewID={ACCESSORY_ID}
                    returnKeyType="done"
                    onSubmitEditing={handleAdd}
                  />
                  <Pressable
                    style={[
                      styles.addBtn,
                      !newUrl.trim() && styles.addBtnDisabled,
                    ]}
                    onPress={handleAdd}
                    disabled={!newUrl.trim()}
                  >
                    <Text style={styles.addBtnText}>添加并使用</Text>
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

const styles = StyleSheet.create({
  selector: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "transparent",
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  selectorLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  selectorTextWrap: {
    flex: 1,
    gap: 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotActive: {
    backgroundColor: "#22c55e",
  },
  dotInactive: {
    backgroundColor: "#9ca3af",
  },
  selectorText: {
    color: "#111827",
    fontSize: 14,
    fontWeight: "600",
  },
  selectorSubtext: {
    color: "#6b7280",
    fontSize: 12,
  },
  manageText: {
    color: "#2563eb",
    fontSize: 13,
    fontWeight: "600",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: Platform.OS === "ios" ? "#f2f2f7" : "rgba(0,0,0,0.25)",
    justifyContent: "flex-end",
  },
  modal: {
    flex: 1,
    backgroundColor: "#f2f2f7",
    borderTopLeftRadius: Platform.OS === "ios" ? 0 : 18,
    borderTopRightRadius: Platform.OS === "ios" ? 0 : 18,
    maxHeight: Platform.OS === "ios" ? undefined : "92%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  modalTitle: {
    color: "#111827",
    fontSize: 18,
    fontWeight: "700",
  },
  closeText: {
    color: "#2563eb",
    fontSize: 16,
    fontWeight: "600",
  },
  list: {
    flex: 1,
  },
  serverRow: {
    backgroundColor: "#ffffff",
    marginHorizontal: 12,
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    padding: 12,
    gap: 10,
  },
  serverRowSelected: {
    borderColor: "#93c5fd",
    backgroundColor: "#f8fbff",
  },
  serverInfo: {
    gap: 3,
  },
  serverNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  serverName: {
    color: "#111827",
    fontSize: 15,
    fontWeight: "600",
  },
  defaultBadge: {
    color: "#1d4ed8",
    fontSize: 11,
    fontWeight: "600",
    backgroundColor: "#dbeafe",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: "hidden",
  },
  serverUrl: {
    color: "#6b7280",
    fontSize: 12,
  },
  serverActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  actionBtn: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#f3f4f6",
    alignItems: "center",
    justifyContent: "center",
  },
  actionBtnDanger: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#fff1f2",
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    color: "#374151",
    fontSize: 12,
    fontWeight: "600",
  },
  actionDangerText: {
    color: "#dc2626",
    fontSize: 12,
    fontWeight: "600",
  },
  actionOk: {
    color: "#15803d",
  },
  actionFail: {
    color: "#b91c1c",
  },
  emptyText: {
    color: "#6b7280",
    textAlign: "center",
    padding: 24,
    fontSize: 14,
  },
  addSection: {
    backgroundColor: "#ffffff",
    margin: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    padding: 12,
    gap: 10,
  },
  addTitle: {
    color: "#111827",
    fontSize: 16,
    fontWeight: "700",
  },
  input: {
    minHeight: 46,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
    color: "#111827",
    paddingHorizontal: 12,
    fontSize: 15,
  },
  addBtn: {
    minHeight: 46,
    borderRadius: 10,
    backgroundColor: "#2563eb",
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnDisabled: {
    opacity: 0.45,
  },
  addBtnText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
});
