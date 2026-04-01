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
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  const topSurfaceColor = theme.mode === "light" ? theme.bgCard : theme.bgElevated;
  const topBorderColor = theme.mode === "light" ? theme.border : theme.borderLight;
  const toolbarBg = theme.mode === "light" ? "#f2f2f7" : "rgba(255,255,255,0.08)";
  const toolbarBorder = theme.mode === "light" ? "rgba(60,60,67,0.18)" : "rgba(255,255,255,0.1)";
  const toolbarPressedBg = theme.mode === "light" ? "#e5e7eb" : "rgba(255,255,255,0.14)";
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
  const controlCopy = getControlCopy(hasControl, isControlledByOther);
  const banner = getSessionBanner(status);
  const showReconnectButton = status === "disconnected" || (status.startsWith("error:") && Boolean(sessionId));
  return (
    <View style={[styles.container, { backgroundColor: theme.bgTerminal }]}> 
      <KeyboardAvoidingView
        style={[styles.keyboardContainer, { backgroundColor: theme.bgTerminal }]}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={{ height: insets.top, backgroundColor: topSurfaceColor }} />

        <View style={[styles.topBar, { backgroundColor: topSurfaceColor, borderBottomColor: topBorderColor }]}> 
          <View style={styles.topMetaRow}>
            <View style={styles.topLeft}>
              <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
              <Text style={[styles.statusLabel, { color: theme.textSecondary }]}>{statusText}</Text>
              <Text style={[styles.sessionText, { color: theme.textTertiary }]} numberOfLines={1}>{sessionId.slice(0, 8)}</Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.leaveBtn,
                {
                  backgroundColor: pressed ? theme.error : theme.errorLight,
                  borderColor: theme.mode === "light" ? "rgba(220,38,38,0.18)" : "rgba(239,68,68,0.18)",
                },
              ]}
              onPress={handleLeave}
              hitSlop={10}
            >
              <Text style={[styles.leaveBtnText, { color: theme.error }]}>退出</Text>
            </Pressable>
          </View>

          <View style={styles.topControlRow}>
            <View style={styles.controlSummary}>
              <Text style={[styles.controlSummaryTitle, { color: theme.text }]}>{controlCopy.title}</Text>
              <Text style={[styles.controlSummaryBody, { color: theme.textSecondary }]}>{controlCopy.description}</Text>
            </View>

            <View style={styles.topRight}>
              <View style={[styles.zoomGroup, { backgroundColor: toolbarBg, borderColor: toolbarBorder }]}>
                <Pressable
                  style={({ pressed }) => [styles.zoomBtn, pressed && { backgroundColor: toolbarPressedBg }]}
                  onPress={handleZoomOut}
                  hitSlop={10}
                >
                  <Text style={[styles.zoomBtnText, { color: theme.textSecondary }]}>A-</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.zoomBadge, pressed && { backgroundColor: toolbarPressedBg }]}
                  onPress={handleZoomReset}
                  hitSlop={10}
                >
                  <Text style={[styles.zoomBadgeText, { color: theme.accent }]}>{zoomPercent}%</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.zoomBtn, pressed && { backgroundColor: toolbarPressedBg }]}
                  onPress={handleZoomIn}
                  hitSlop={10}
                >
                  <Text style={[styles.zoomBtnText, { color: theme.textSecondary }]}>A+</Text>
                </Pressable>
              </View>
              <Pressable
                style={({ pressed }) => [
                  styles.controlBtn,
                  {
                    backgroundColor: pressed
                      ? (hasControl ? theme.accent : toolbarPressedBg)
                      : (hasControl ? theme.accentLight : toolbarBg),
                    borderColor: hasControl ? theme.accentLight : toolbarBorder,
                  },
                ]}
                onPress={hasControl ? onReleaseControl : onClaimControl}
                disabled={status !== "connected" && status !== "host_disconnected"}
                hitSlop={10}
              >
                <Text style={[styles.controlBtnText, { color: hasControl ? theme.accent : theme.textSecondary }]}> 
                  {hasControl ? "释放" : "接管"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>

        {banner ? (
          <View
            style={[
              styles.banner,
              { backgroundColor: banner.tone === "error" ? theme.errorLight : theme.accentLight },
            ]}
          >
            <Text style={[styles.bannerText, { color: banner.tone === "error" ? theme.error : theme.accent }]}>
              {banner.text}
            </Text>
            {showReconnectButton ? (
              <Pressable style={[styles.reconnectBtn, { backgroundColor: theme.bgInput }]} onPress={onReconnect}>
                <Text style={[styles.reconnectBtnText, { color: theme.accent }]}>重试</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {connectionDetail && !banner ? (
          <View style={[styles.detailBar, { backgroundColor: topSurfaceColor }]}> 
            <Text style={[styles.detailText, { color: theme.textTertiary }]}>{connectionDetail}</Text>
          </View>
        ) : null}

        <View style={[styles.terminalArea, { backgroundColor: theme.bgTerminal }]} onLayout={handleTerminalLayout}> 
          <View style={styles.terminalWrap}>
            <TerminalView
              ref={termRef}
              onInput={handleTerminalInput}
              onResize={handleTerminalResize}
            />
            <View pointerEvents="box-none" style={styles.terminalTouchLayer}>
              {showTapOverlay ? (
                <Pressable style={styles.tapCaptureLayer} onPress={focusTerminalInput} />
              ) : null}
              {keyboardHintVisible && !inputDisabled ? (
                <Pressable
                  style={[
                    styles.tapHintPill,
                    {
                      backgroundColor: theme.bgElevated,
                      borderColor: theme.border,
                      bottom: Math.max(16, insets.bottom + 8),
                    },
                  ]}
                  onPress={focusTerminalInput}
                >
                  <Text style={[styles.tapHintText, { color: theme.text }]}>点按这里开始输入</Text>
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
    case "reconnecting": return { text: "连接暂时中断，正在自动重连。", tone: "warn" };
    case "disconnected": return { text: "连接已经断开。", tone: "error" };
    case "host_disconnected": return { text: "主机当前离线，恢复后会继续同步。", tone: "warn" };
    case "session_exited": return { text: "当前会话已经结束。", tone: "error" };
    default: return null;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  keyboardContainer: { flex: 1 },
  topBar: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  topMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  topControlRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 10,
  },
  topLeft: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  topRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusLabel: { fontSize: 12, fontWeight: "600" },
  sessionText: { fontSize: 11, fontFamily: "Courier" },
  controlSummary: { flex: 1, gap: 2 },
  controlSummaryTitle: { fontSize: 14, fontWeight: "700" },
  controlSummaryBody: { fontSize: 12 },
  zoomGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  zoomBtn: {
    minHeight: 34,
    minWidth: 38,
    alignItems: "center", justifyContent: "center",
  },
  zoomBtnText: { fontSize: 12, fontWeight: "700" },
  zoomBadge: {
    minHeight: 34,
    minWidth: 56,
    alignItems: "center", justifyContent: "center",
    paddingHorizontal: 8,
  },
  zoomBadgeText: { fontSize: 12, fontWeight: "700" },
  controlBtn: {
    minHeight: 34,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  controlBtnText: { fontSize: 13, fontWeight: "700" },
  leaveBtn: {
    minHeight: 34,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  leaveBtnText: { fontSize: 13, fontWeight: "700" },
  banner: {
    paddingHorizontal: 12, paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center", justifyContent: "space-between",
  },
  bannerText: { fontSize: 12, fontWeight: "600", flex: 1 },
  reconnectBtn: {
    borderRadius: 6,
    paddingHorizontal: 10, paddingVertical: 4, marginLeft: 8,
  },
  reconnectBtnText: { fontSize: 11, fontWeight: "700" },
  detailBar: { paddingHorizontal: 12, paddingVertical: 4 },
  detailText: { fontSize: 11 },
  terminalArea: { flex: 1 },
  terminalWrap: { flex: 1 },
  terminalTouchLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    alignItems: "center",
  },
  tapCaptureLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  tapHintPill: {
    position: "absolute",
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: 6,
  },
  tapHintText: { fontSize: 12, fontWeight: "600" },
});
