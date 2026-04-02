import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import { TerminalView } from "../components/TerminalView";
import type { TerminalViewHandle } from "../components/TerminalView";
import type { ConnectionStatus } from "../hooks/useSession";
import { useTheme } from "../theme";

interface SessionScreenProps {
  sessionId: string;
  status: ConnectionStatus;
  deviceId: string;
  controllerId: string | null;
  connectionDetail: string | null;
  terminalLines: string[];
  onSendInput: (data: string) => void;
  onSendResize: (cols: number, rows: number) => void;
  onClaimControl: () => void;
  onReleaseControl: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}

export function SessionScreen({
  sessionId,
  status,
  deviceId,
  controllerId,
  connectionDetail,
  terminalLines,
  onSendInput,
  onSendResize,
  onClaimControl,
  onReleaseControl,
  onReconnect,
  onDisconnect,
}: SessionScreenProps) {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const termRef = useRef<TerminalViewHandle>(null);
  const writtenCountRef = useRef(0);
  const [keyboardHintVisible, setKeyboardHintVisible] = useState(true);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  const hasControl = controllerId === deviceId;
  const isControlledByOther = Boolean(controllerId && controllerId !== deviceId);
  const inputDisabled =
    !hasControl ||
    status === "reconnecting" ||
    status === "session_exited" ||
    status === "disconnected" ||
    status === "host_disconnected";

  useEffect(() => {
    termRef.current?.clear();
    writtenCountRef.current = 0;
  }, [sessionId]);

  useEffect(() => {
    if (!termRef.current) return;
    const newLines = terminalLines.slice(writtenCountRef.current);
    for (const line of newLines) {
      termRef.current.write(line);
    }
    writtenCountRef.current = terminalLines.length;
  }, [terminalLines]);

  const handleTerminalInput = useCallback((data: string) => {
    onSendInput(data);
  }, [onSendInput]);

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    onSendResize(cols, rows);
  }, [onSendResize]);

  const handleTerminalLayout = useCallback((event: LayoutChangeEvent) => {
    if (event.nativeEvent.layout.height <= 0 || event.nativeEvent.layout.width <= 0) return;
    requestAnimationFrame(() => {
      termRef.current?.refit();
    });
  }, []);

  const focusTerminalInput = useCallback(() => {
    if (inputDisabled) return;
    if (keyboardVisible) return;
    setKeyboardHintVisible(false);
    termRef.current?.focusCursor();
  }, [inputDisabled, keyboardVisible]);

  const showTapOverlay = false; // Disabled — let WebView handle touch natively to avoid scroll→keyboard issue

  const handleZoomIn = useCallback(() => {
    termRef.current?.zoomIn();
    setZoomPercent((prev) => Math.min(prev + 10, 170));
  }, []);

  const handleZoomOut = useCallback(() => {
    termRef.current?.zoomOut();
    setZoomPercent((prev) => Math.max(prev - 10, 60));
  }, []);

  const handleZoomReset = useCallback(() => {
    termRef.current?.resetZoom();
    setZoomPercent(100);
  }, []);

  const handleLeave = useCallback(() => {
    Keyboard.dismiss();
    termRef.current?.blurCursor();
    onDisconnect();
  }, [onDisconnect]);

  useEffect(() => {
    if (inputDisabled) {
      termRef.current?.blurCursor();
      Keyboard.dismiss();
    }
  }, [inputDisabled]);

  useEffect(() => {
    if (status !== "connected") setKeyboardHintVisible(false);
  }, [status]);

  useEffect(() => {
    const refitTerminal = () => {
      setTimeout(() => {
        termRef.current?.refit();
      }, 30);
    };

    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, () => { setKeyboardVisible(true); refitTerminal(); setTimeout(() => termRef.current?.scrollToBottom(), 100); });
    const hideSub = Keyboard.addListener(hideEvent, () => { setKeyboardVisible(false); refitTerminal(); });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const statusColor = STATUS_COLORS[status] ?? theme.textSecondary;
  const statusText = getStatusText(status);
  const banner = getSessionBanner(status);
  const showReconnectButton = status === "disconnected" || (status.startsWith("error:") && Boolean(sessionId));

  const toolbarBg = theme.mode === "light" ? "#e5e5ea" : "rgba(255,255,255,0.1)";

  return (
    <View style={{ flex: 1, backgroundColor: theme.bgTerminal }}>
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: theme.bgTerminal }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={{ height: insets.top, backgroundColor: theme.mode === "light" ? theme.bgCard : theme.bgElevated }} />

        {/* Top Bar */}
        <View style={{
          backgroundColor: theme.mode === "light" ? theme.bgCard : theme.bgElevated,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.separator,
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 10,
          gap: 8,
        }}>
          {/* Row 1: Status + Leave */}
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor }} />
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>{statusText}</Text>
              <Text style={{ fontSize: 11, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", color: theme.textTertiary }} numberOfLines={1}>{sessionId.slice(0, 8)}</Text>
            </View>
            <Pressable
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 14,
                borderCurve: "continuous" as const,
                backgroundColor: pressed ? "rgba(255,59,48,0.2)" : "rgba(255,59,48,0.12)",
              })}
              onPress={handleLeave}
              hitSlop={10}
            >
              <AppSymbol name="xmark.circle.fill" size={14} color={theme.error} />
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.error }}>退出</Text>
            </Pressable>
          </View>

          {/* Row 2: Control + Zoom */}
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            {/* Control button */}
            <Pressable
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 14,
                borderCurve: "continuous" as const,
                backgroundColor: hasControl
                  ? (pressed ? theme.accent : theme.accentLight)
                  : (pressed ? toolbarBg : "transparent"),
              })}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                hasControl ? onReleaseControl() : onClaimControl();
              }}
              disabled={status !== "connected" && status !== "host_disconnected"}
            >
              <AppSymbol
                name={hasControl ? "hand.raised.fill" : "hand.raised"}
                size={14}
                color={hasControl ? theme.accent : theme.textSecondary}
              />
              <Text style={{ fontSize: 13, fontWeight: "500", color: hasControl ? theme.accent : theme.textSecondary }}>
                {hasControl ? "已接管 · 释放" : isControlledByOther ? "只读 · 接管" : "接管控制"}
              </Text>
            </Pressable>

            {/* Zoom controls */}
            <View style={{
              flexDirection: "row",
              alignItems: "center",
              borderRadius: 8,
              borderCurve: "continuous",
              backgroundColor: toolbarBg,
              overflow: "hidden",
            }}>
              <Pressable
                style={({ pressed }) => ({
                  width: 34, height: 30,
                  alignItems: "center", justifyContent: "center",
                  backgroundColor: pressed ? "rgba(128,128,128,0.2)" : "transparent",
                })}
                onPress={handleZoomOut}
              >
                <AppSymbol name="textformat.size.smaller" size={14} color={theme.textSecondary} />
              </Pressable>
              <Pressable
                style={({ pressed }) => ({
                  minWidth: 44, height: 30,
                  alignItems: "center", justifyContent: "center",
                  paddingHorizontal: 4,
                  backgroundColor: pressed ? "rgba(128,128,128,0.2)" : "transparent",
                })}
                onPress={handleZoomReset}
              >
                <Text style={{ fontSize: 12, fontWeight: "600", color: theme.accent, fontVariant: ["tabular-nums"] }}>{zoomPercent}%</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => ({
                  width: 34, height: 30,
                  alignItems: "center", justifyContent: "center",
                  backgroundColor: pressed ? "rgba(128,128,128,0.2)" : "transparent",
                })}
                onPress={handleZoomIn}
              >
                <AppSymbol name="textformat.size.larger" size={14} color={theme.textSecondary} />
              </Pressable>
            </View>
          </View>
        </View>

        {banner ? (
          <View style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: banner.tone === "error" ? theme.errorLight : theme.accentLight,
          }}>
            <Text style={{ fontSize: 13, fontWeight: "500", color: banner.tone === "error" ? theme.error : theme.accent, flex: 1 }}>
              {banner.text}
            </Text>
            {showReconnectButton ? (
              <Pressable
                style={({ pressed }) => ({
                  borderRadius: 6,
                  borderCurve: "continuous" as const,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  marginLeft: 8,
                  backgroundColor: pressed ? "rgba(128,128,128,0.2)" : theme.bgCard,
                })}
                onPress={onReconnect}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: theme.accent }}>重试</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {connectionDetail && !banner ? (
          <View style={{ backgroundColor: theme.mode === "light" ? theme.bgCard : theme.bgElevated, paddingHorizontal: 16, paddingVertical: 4 }}>
            <Text style={{ fontSize: 11, color: theme.textTertiary }}>{connectionDetail}</Text>
          </View>
        ) : null}

        <View style={{ flex: 1, backgroundColor: theme.bgTerminal }} onLayout={handleTerminalLayout}>
          <View style={{ flex: 1 }}>
            <TerminalView
              ref={termRef}
              onInput={handleTerminalInput}
              onResize={handleTerminalResize}
            />
            <View pointerEvents="box-none" style={{ ...StyleSheet.absoluteFillObject, justifyContent: "flex-end", alignItems: "center" }}>
              {showTapOverlay ? (
                <Pressable style={StyleSheet.absoluteFillObject} onPress={focusTerminalInput} />
              ) : null}
              {keyboardHintVisible && !inputDisabled ? (
                <Pressable
                  style={{
                    position: "absolute",
                    bottom: Math.max(16, insets.bottom + 8),
                    borderRadius: 20,
                    borderCurve: "continuous",
                    backgroundColor: theme.bgElevated,
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    boxShadow: "0 2px 12px rgba(0,0,0,0.25)",
                  }}
                  onPress={focusTerminalInput}
                >
                    <AppSymbol name="keyboard" size={16} color={theme.accent} />
                  <Text style={{ fontSize: 13, fontWeight: "500", color: theme.text }}>点按开始输入</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
          {!keyboardVisible && <View style={{ height: insets.bottom, backgroundColor: theme.bgTerminal }} />}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const STATUS_COLORS: Record<string, string> = {
  connected: "#4ade80",
  reconnecting: "#fbbf24",
  disconnected: "#ef4444",
  session_exited: "#6b7280",
  host_disconnected: "#fbbf24",
};

function getStatusText(status: ConnectionStatus): string {
  if (status.startsWith("error:")) return "错误";
  const map: Record<string, string> = {
    connected: "已连接",
    reconnecting: "重连中",
    disconnected: "已断开",
    session_exited: "已结束",
    host_disconnected: "主机离线",
    claiming: "接管中",
    connecting: "连接中",
  };
  return map[status] ?? status;
}

function getControlCopy(hasControl: boolean, isControlledByOther: boolean) {
  if (hasControl) return { title: "当前设备已接管", description: "输入会直接发送到这台终端。" };
  if (isControlledByOther) return { title: "当前为只读", description: "有其他设备正在控制，点接管后即可输入。" };
  return { title: "等待接管", description: "当前还没有激活的控制端。" };
}

function getSessionBanner(status: ConnectionStatus): { text: string; tone: "warn" | "error" } | null {
  switch (status) {
    case "reconnecting": return { text: "连接暂时中断，正在自动重连…", tone: "warn" };
    case "disconnected": return { text: "连接已断开。", tone: "error" };
    case "host_disconnected": return { text: "主机当前离线，恢复后会继续同步。", tone: "warn" };
    case "session_exited": return { text: "当前会话已结束。", tone: "error" };
    default: return null;
  }
}
