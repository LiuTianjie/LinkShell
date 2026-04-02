import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "./AppSymbol";
import { KeyboardAccessory } from "./KeyboardAccessory";
import { useTheme } from "../theme";
import { getDefaultServer, touchServer } from "../storage/servers";

type ConnectionMode = "scan" | "manual";

interface ConnectionSheetProps {
  visible: boolean;
  gatewayBaseUrl: string;
  status: string;
  connectionDetail?: string | null;
  onClose: () => void;
  onGatewayChange: (url: string) => void;
  onClaim: (code: string) => void;
  onOpenScanner: () => void;
}

const ACCESSORY_ID = "connection-sheet-accessory";

export function ConnectionSheet({
  visible,
  gatewayBaseUrl,
  status,
  connectionDetail,
  onClose,
  onGatewayChange,
  onClaim,
  onOpenScanner,
}: ConnectionSheetProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<ConnectionMode>("scan");
  const [pairingCode, setPairingCode] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState(gatewayBaseUrl);
  const codeInputRef = useRef<TextInput>(null);

  const isLoading = status === "claiming" || status === "connecting";

  useEffect(() => {
    if (!visible) return;
    setGatewayUrl(gatewayBaseUrl);
    getDefaultServer()
      .then((server) => {
        if (server && server.url !== gatewayBaseUrl) {
          onGatewayChange(server.url);
          setGatewayUrl(server.url);
        }
      })
      .catch(() => {});
  }, [gatewayBaseUrl, onGatewayChange, visible]);

  // Reset state when sheet closes
  useEffect(() => {
    if (!visible) {
      setPairingCode("");
    }
  }, [visible]);

  const handleClaim = useCallback(async () => {
    const normalized = pairingCode.trim();
    if (!normalized) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Apply gateway URL change if user modified it
    const normalizedUrl = gatewayUrl.trim().replace(/\/+$/, "");
    if (normalizedUrl && normalizedUrl !== gatewayBaseUrl) {
      onGatewayChange(normalizedUrl);
    }
    await touchServer(normalizedUrl || gatewayBaseUrl).catch(() => {});
    onClaim(normalized);
  }, [gatewayBaseUrl, gatewayUrl, onClaim, onGatewayChange, pairingCode]);

  const handleSwitchMode = useCallback((newMode: ConnectionMode) => {
    Haptics.selectionAsync();
    setMode(newMode);
    if (newMode === "manual") {
      setTimeout(() => codeInputRef.current?.focus(), 300);
    }
  }, []);

  const statusCopy = useMemo(() => getStatusCopy(status, connectionDetail), [connectionDetail, status]);

  const segmentBg = theme.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
  const segmentActiveBg = theme.mode === "dark" ? "rgba(255,255,255,0.18)" : "#ffffff";

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      {...Platform.select({
        ios: {
          sheetAllowedDetents: mode === "manual" ? [0.7, "large"] : [0.55, 0.7],
          sheetCornerRadius: 20,
          sheetGrabberVisible: true,
        },
        default: {},
      })}
    >
      <View style={{ flex: 1, backgroundColor: theme.bgElevated }}>
        {/* Header */}
        <View style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 20,
          paddingTop: Platform.OS === "ios" ? 14 : Math.max(insets.top, 16),
          paddingBottom: 12,
        }}>
          <Text style={{ fontSize: 20, fontWeight: "700", color: theme.text }}>新建连接</Text>
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

        {/* Segmented Control */}
        <View style={{
          marginHorizontal: 20,
          marginBottom: 16,
          flexDirection: "row",
          backgroundColor: segmentBg,
          borderRadius: 10,
          padding: 3,
        }}>
          <Pressable
            style={{
              flex: 1,
              paddingVertical: 8,
              borderRadius: 8,
              alignItems: "center",
              backgroundColor: mode === "scan" ? segmentActiveBg : "transparent",
            }}
            onPress={() => handleSwitchMode("scan")}
          >
            <Text style={{
              fontSize: 14,
              fontWeight: "600",
              color: mode === "scan" ? theme.text : theme.textTertiary,
            }}>扫码</Text>
          </Pressable>
          <Pressable
            style={{
              flex: 1,
              paddingVertical: 8,
              borderRadius: 8,
              alignItems: "center",
              backgroundColor: mode === "manual" ? segmentActiveBg : "transparent",
            }}
            onPress={() => handleSwitchMode("manual")}
          >
            <Text style={{
              fontSize: 14,
              fontWeight: "600",
              color: mode === "manual" ? theme.text : theme.textTertiary,
            }}>手动</Text>
          </Pressable>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 20, gap: 16, paddingBottom: Math.max(insets.bottom, 20) }}
        >
          {/* Status / Error */}
          {statusCopy ? (
            <View style={{
              backgroundColor: status.startsWith("error:") ? theme.errorLight : theme.accentLight,
              borderRadius: 10,
              borderCurve: "continuous" as const,
              paddingHorizontal: 14,
              paddingVertical: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}>
              {isLoading ? (
                <ActivityIndicator size="small" color={theme.accent} />
              ) : status.startsWith("error:") ? (
                <AppSymbol name="exclamationmark.triangle.fill" size={16} color={theme.error} />
              ) : null}
              <Text style={{
                flex: 1,
                fontSize: 13,
                color: status.startsWith("error:") ? theme.error : theme.accent,
              }}>{statusCopy}</Text>
            </View>
          ) : null}

          {mode === "scan" ? (
            /* ── Scan Mode ── */
            <View style={{ gap: 20, paddingTop: 8 }}>
              <Pressable
                style={({ pressed }) => ({
                  backgroundColor: theme.bgCard,
                  borderRadius: 16,
                  borderCurve: "continuous" as const,
                  borderWidth: 1,
                  borderColor: theme.borderLight,
                  paddingVertical: 36,
                  paddingHorizontal: 24,
                  alignItems: "center",
                  gap: 16,
                  opacity: pressed ? 0.7 : 1,
                })}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  onOpenScanner();
                }}
              >
                <View style={{
                  width: 64, height: 64, borderRadius: 16,
                  backgroundColor: theme.accentLight,
                  alignItems: "center", justifyContent: "center",
                }}>
                  <AppSymbol name="qrcode.viewfinder" size={32} color={theme.accent} />
                </View>
                <View style={{ alignItems: "center", gap: 6 }}>
                  <Text style={{ color: theme.text, fontSize: 18, fontWeight: "600" }}>扫描配对码</Text>
                  <Text style={{ color: theme.textTertiary, fontSize: 14, textAlign: "center", lineHeight: 20 }}>
                    对准桌面终端中的二维码{"\n"}自动识别网关地址与配对码
                  </Text>
                </View>
              </Pressable>

              <View style={{ alignItems: "center", gap: 4 }}>
                <Text style={{ color: theme.textTertiary, fontSize: 13 }}>没有二维码？</Text>
                <Pressable onPress={() => handleSwitchMode("manual")}>
                  <Text style={{ color: theme.accent, fontSize: 14, fontWeight: "600" }}>切换到手动输入</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            /* ── Manual Mode ── */
            <View style={{ gap: 16 }}>
              {/* Gateway URL */}
              <View style={{
                backgroundColor: theme.bgCard,
                borderRadius: 12,
                borderCurve: "continuous" as const,
                padding: 16,
                gap: 10,
              }}>
                <Text style={{ fontSize: 13, fontWeight: "500", color: theme.textTertiary, textTransform: "uppercase", letterSpacing: 0.5 }}>网关地址</Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                  inputAccessoryViewID={ACCESSORY_ID}
                  keyboardType="url"
                  keyboardAppearance={theme.mode}
                  onChangeText={setGatewayUrl}
                  placeholder="http://192.168.1.10:8787"
                  placeholderTextColor={theme.textTertiary}
                  returnKeyType="next"
                  onSubmitEditing={() => codeInputRef.current?.focus()}
                  style={{
                    minHeight: 44,
                    borderRadius: 10,
                    borderCurve: "continuous" as const,
                    backgroundColor: theme.bgInput,
                    color: theme.text,
                    fontSize: 15,
                    paddingHorizontal: 14,
                  }}
                  value={gatewayUrl}
                />
              </View>

              {/* Pairing Code */}
              <View style={{
                backgroundColor: theme.bgCard,
                borderRadius: 12,
                borderCurve: "continuous" as const,
                padding: 16,
                gap: 10,
              }}>
                <Text style={{ fontSize: 13, fontWeight: "500", color: theme.textTertiary, textTransform: "uppercase", letterSpacing: 0.5 }}>配对码</Text>
                <TextInput
                  ref={codeInputRef}
                  autoCapitalize="none"
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                  inputAccessoryViewID={ACCESSORY_ID}
                  keyboardType="number-pad"
                  keyboardAppearance={theme.mode}
                  maxLength={6}
                  onChangeText={setPairingCode}
                  onSubmitEditing={handleClaim}
                  placeholder="000000"
                  placeholderTextColor={theme.textTertiary}
                  style={{
                    minHeight: 52,
                    borderRadius: 10,
                    borderCurve: "continuous" as const,
                    backgroundColor: theme.bgInput,
                    color: theme.text,
                    fontSize: 28,
                    fontWeight: "700",
                    letterSpacing: 8,
                    textAlign: "center",
                    paddingHorizontal: 12,
                  }}
                  textContentType="oneTimeCode"
                  value={pairingCode}
                />
                <Text style={{ fontSize: 13, color: theme.textTertiary }}>输入桌面端 CLI 显示的 6 位数字</Text>
              </View>

              {/* Connect Button */}
              <Pressable
                style={({ pressed }) => ({
                  minHeight: 50,
                  borderRadius: 12,
                  borderCurve: "continuous" as const,
                  backgroundColor: theme.accent,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                  gap: 8,
                  opacity: (!pairingCode.trim() || isLoading) ? 0.5 : pressed ? 0.85 : 1,
                })}
                onPress={handleClaim}
                disabled={!pairingCode.trim() || isLoading}
              >
                {isLoading ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : null}
                <Text style={{ color: "#ffffff", fontSize: 17, fontWeight: "600" }}>
                  {isLoading ? "连接中…" : "连接"}
                </Text>
              </Pressable>

              <View style={{ alignItems: "center", gap: 4 }}>
                <Text style={{ color: theme.textTertiary, fontSize: 13 }}>有二维码？</Text>
                <Pressable onPress={() => handleSwitchMode("scan")}>
                  <Text style={{ color: theme.accent, fontSize: 14, fontWeight: "600" }}>切换到扫码连接</Text>
                </Pressable>
              </View>
            </View>
          )}
        </ScrollView>

        <KeyboardAccessory nativeID={ACCESSORY_ID} title="配对" actionLabel="连接" onActionPress={handleClaim} />
      </View>
    </Modal>
  );
}

function getStatusCopy(status: string, connectionDetail?: string | null): string | null {
  if (status.startsWith("error:")) return connectionDetail ?? "上一次连接失败，可以重新发起连接。";
  switch (status) {
    case "claiming":
      return "正在校验配对码…";
    case "connecting":
      return "正在建立终端连接…";
    case "reconnecting":
      return "会话正在重连中。";
    default:
      return null;
  }
}