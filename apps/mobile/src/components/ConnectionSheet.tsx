import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAccessory } from "./KeyboardAccessory";
import { useTheme } from "../theme";
import { getDefaultServer, touchServer } from "../storage/servers";

interface ConnectionSheetProps {
  visible: boolean;
  gatewayBaseUrl: string;
  status: string;
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
  onClose,
  onGatewayChange,
  onClaim,
  onOpenScanner,
}: ConnectionSheetProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [pairingCode, setPairingCode] = useState("");

  useEffect(() => {
    if (!visible) return;
    getDefaultServer()
      .then((server) => {
        if (server && server.url !== gatewayBaseUrl) {
          onGatewayChange(server.url);
        }
      })
      .catch(() => {});
  }, [gatewayBaseUrl, onGatewayChange, visible]);

  const handleClaim = useCallback(async () => {
    const normalized = pairingCode.trim();
    if (!normalized) return;
    await touchServer(gatewayBaseUrl).catch(() => {});
    onClaim(normalized);
    setPairingCode("");
  }, [gatewayBaseUrl, onClaim, pairingCode]);

  const statusCopy = useMemo(() => getStatusCopy(status), [status]);

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      presentationStyle="overFullScreen"
      onRequestClose={onClose}
    >
      <View style={StyleSheet.absoluteFill}>
        <Pressable
          style={[styles.overlay, { backgroundColor: "rgba(7, 10, 18, 0.32)" }]}
          onPress={onClose}
        />
        <KeyboardAvoidingView
          style={styles.sheetFrame}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: theme.bgCard,
                borderColor: theme.border,
                paddingBottom: Math.max(insets.bottom, 16),
              },
            ]}
          >
            <View style={[styles.sheetHandle, { backgroundColor: theme.border }]} />
            <View style={styles.sheetHeader}>
              <View style={styles.sheetHeaderCopy}>
                <Text style={[styles.sheetTitle, { color: theme.text }]}>新建连接</Text>
                <Text style={[styles.sheetSubtitle, { color: theme.textSecondary }]}>{statusCopy}</Text>
              </View>
              <Pressable onPress={onClose} hitSlop={8}>
                <Text style={[styles.closeText, { color: theme.accent }]}>关闭</Text>
              </Pressable>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.scrollContent}
            >
              <Pressable style={[styles.scanCard, { backgroundColor: theme.bgInput }]} onPress={onOpenScanner}>
                <Text style={[styles.actionGlyph, { color: theme.accent }]}>QR</Text>
                <Text style={[styles.actionTitle, { color: theme.text }]}>扫码连接</Text>
                <Text style={[styles.actionBody, { color: theme.textSecondary }]}>打开摄像头，直接识别终端里显示的配对二维码。</Text>
              </Pressable>

              <View style={[styles.section, { backgroundColor: theme.bgInput }]}> 
                <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>手动配对</Text>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>输入 6 位配对码</Text>
                <View style={styles.codeRow}>
                  <TextInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    clearButtonMode="while-editing"
                    inputAccessoryViewID={ACCESSORY_ID}
                    keyboardType="number-pad"
                    maxLength={6}
                    onChangeText={setPairingCode}
                    onSubmitEditing={handleClaim}
                    placeholder="000000"
                    placeholderTextColor={theme.textTertiary}
                    style={[styles.codeInput, { color: theme.text, backgroundColor: theme.bgCard, borderColor: theme.border }]}
                    textAlign="center"
                    value={pairingCode}
                  />
                  <Pressable
                    style={[styles.connectButton, { backgroundColor: theme.accent }, !pairingCode.trim() && styles.connectButtonDisabled]}
                    onPress={handleClaim}
                    disabled={!pairingCode.trim()}
                  >
                    <Text style={styles.connectButtonText}>连接</Text>
                  </Pressable>
                </View>
                <Text style={[styles.sectionHint, { color: theme.textTertiary }]}>如果你在桌面端或 CLI 中看到了 6 位数字配对码，直接在这里输入即可。</Text>
              </View>
            </ScrollView>

            <KeyboardAccessory nativeID={ACCESSORY_ID} title="配对码输入" actionLabel="连接" onActionPress={handleClaim} />
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function getStatusCopy(status: string): string {
  if (status.startsWith("error:")) return "上一次连接失败了，你可以在这里重新发起连接。";
  switch (status) {
    case "claiming":
    case "connecting":
      return "正在建立连接，请稍候。";
    case "reconnecting":
      return "会话正在重连。";
    default:
      return "可以直接扫码，或者输入 6 位数字配对码。";
  }
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  sheetFrame: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    maxHeight: 430,
    paddingHorizontal: 18,
    paddingTop: 10,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 999,
    marginBottom: 14,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 16,
  },
  sheetHeaderCopy: {
    flex: 1,
    gap: 4,
  },
  sheetTitle: {
    fontSize: 24,
    fontWeight: "800",
  },
  sheetSubtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
  closeText: {
    fontSize: 15,
    fontWeight: "700",
  },
  scrollContent: {
    gap: 14,
    paddingBottom: 16,
  },
  scanCard: {
    borderRadius: 22,
    padding: 16,
    gap: 8,
    minHeight: 120,
  },
  actionTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  actionGlyph: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
  },
  actionBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  section: {
    borderRadius: 22,
    padding: 16,
    gap: 10,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
  },
  sectionHint: {
    fontSize: 12,
    lineHeight: 18,
  },
  codeRow: {
    flexDirection: "row",
    gap: 10,
  },
  codeInput: {
    flex: 1,
    minHeight: 52,
    borderRadius: 16,
    borderWidth: 1,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 3,
  },
  connectButton: {
    minWidth: 108,
    minHeight: 52,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  connectButtonDisabled: {
    opacity: 0.45,
  },
  connectButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
});