import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InputBar } from "../components/InputBar";
import type { InputBarHandle } from "../components/InputBar";
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
  const inputRef = useRef<InputBarHandle>(null);
  const writtenCountRef = useRef(0);
  const [keyboardHintVisible, setKeyboardHintVisible] = useState(true);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [capsuleExpanded, setCapsuleExpanded] = useState(false);
  const capsuleAnim = useRef(new Animated.Value(0)).current;

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

  const setCapsuleOpen = useCallback((nextOpen: boolean) => {
    LayoutAnimation.configureNext(
      LayoutAnimation.create(280, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
    );
    Animated.spring(capsuleAnim, {
      toValue: nextOpen ? 1 : 0,
      useNativeDriver: true,
      damping: 20,
      stiffness: 220,
      mass: 0.9,
    }).start();
    setCapsuleExpanded(nextOpen);
  }, [capsuleAnim]);

  const toggleCapsule = useCallback(() => {
    setCapsuleOpen(!capsuleExpanded);
  }, [capsuleExpanded, setCapsuleOpen]);

  const focusTerminalInput = useCallback(() => {
    if (inputDisabled) return;
    if (capsuleExpanded) {
      setCapsuleOpen(false);
    }
    setKeyboardHintVisible(false);
    termRef.current?.focusCursor();
    inputRef.current?.focus();
  }, [capsuleExpanded, inputDisabled, setCapsuleOpen]);

  const handleSpecialKey = useCallback((key: string) => {
    if (inputDisabled) return;
    onSendInput(key);
  }, [inputDisabled, onSendInput]);

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
    inputRef.current?.blur();
    onDisconnect();
  }, [onDisconnect]);

  useEffect(() => {
    if (inputDisabled) {
      termRef.current?.blurCursor();
      inputRef.current?.blur();
    }
  }, [inputDisabled]);

  useEffect(() => {
    if (status !== "connected") setKeyboardHintVisible(false);
  }, [status]);

  useEffect(() => {
    if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  useEffect(() => {
    const refitTerminal = () => {
      setTimeout(() => {
        termRef.current?.refit();
      }, 30);
    };

    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, refitTerminal);
    const hideSub = Keyboard.addListener(hideEvent, refitTerminal);

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
  const capsuleBg = theme.mode === "light" ? "rgba(255,255,255,0.92)" : "rgba(7,12,22,0.82)";
  const capsuleBorder = theme.mode === "light" ? "rgba(148,163,184,0.24)" : "rgba(148,163,184,0.14)";
  const capsuleShadow = theme.mode === "light" ? "#94a3b8" : "#000000";
  const chevronRotate = capsuleAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["45deg", "-135deg"],
  });
  const capsuleBodyStyle = {
    opacity: capsuleAnim,
    transform: [
      {
        translateY: capsuleAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [-10, 0],
        }),
      },
      {
        scale: capsuleAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [0.98, 1],
        }),
      },
    ],
  };
  return (
    <View style={[styles.container, { backgroundColor: theme.bgTerminal }]}> 
      <KeyboardAvoidingView
        style={[styles.keyboardContainer, { backgroundColor: theme.bgTerminal }]}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={[styles.terminalArea, { backgroundColor: theme.bgTerminal }]} onLayout={handleTerminalLayout}> 
          <View style={styles.terminalWrap}>
            <TerminalView
              ref={termRef}
              onInput={handleTerminalInput}
              onResize={handleTerminalResize}
              onTap={focusTerminalInput}
            />
            <View pointerEvents="box-none" style={[styles.capsuleHost, { top: insets.top + 10 }]}> 
              <Pressable
                style={[
                  styles.capsulePill,
                  {
                    backgroundColor: capsuleBg,
                    borderColor: capsuleBorder,
                    shadowColor: capsuleShadow,
                  },
                ]}
                onPress={toggleCapsule}
              >
                <View style={styles.capsuleHeader}>
                  <View style={styles.capsuleHeaderMain}>
                    <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                    <View style={styles.capsuleCopy}>
                      <Text style={[styles.capsuleTitle, { color: theme.text }]}>{statusText}</Text>
                      <Text style={[styles.capsuleSubtitle, { color: theme.textSecondary }]} numberOfLines={1}>
                        {controlCopy.title}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.capsuleHeaderSide}>
                    <Text style={[styles.capsuleSessionText, { color: theme.textTertiary }]}>{sessionId.slice(0, 8)}</Text>
                    <Animated.View style={[styles.capsuleChevron, { borderColor: theme.textSecondary, transform: [{ rotate: chevronRotate }] }]} />
                  </View>
                </View>
              </Pressable>

              {capsuleExpanded ? (
                <Animated.View
                  style={[
                    styles.capsulePanel,
                    capsuleBodyStyle,
                    {
                      backgroundColor: capsuleBg,
                      borderColor: capsuleBorder,
                      shadowColor: capsuleShadow,
                    },
                  ]}
                >
                  <View style={[styles.capsuleDivider, { backgroundColor: theme.mode === "light" ? "rgba(148,163,184,0.18)" : "rgba(148,163,184,0.12)" }]} />

                  <View style={styles.capsuleSummary}>
                    <Text style={[styles.controlSummaryTitle, { color: theme.text }]}>{controlCopy.title}</Text>
                    <Text style={[styles.controlSummaryBody, { color: theme.textSecondary }]}>{controlCopy.description}</Text>
                  </View>

                  {connectionDetail ? (
                    <Text style={[styles.capsuleDetailText, { color: theme.textTertiary }]}>{connectionDetail}</Text>
                  ) : null}

                  {banner ? (
                    <View
                      style={[
                        styles.capsuleBanner,
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

                  <View style={styles.capsuleActionRow}>
                    <View style={styles.zoomGroup}>
                      <Pressable style={[styles.zoomBtn, { backgroundColor: theme.bgInput }]} onPress={handleZoomOut} hitSlop={6}>
                        <Text style={[styles.zoomBtnText, { color: theme.textSecondary }]}>A-</Text>
                      </Pressable>
                      <Pressable style={[styles.zoomBadge, { backgroundColor: theme.bgInput }]} onPress={handleZoomReset} hitSlop={6}>
                        <Text style={[styles.zoomBadgeText, { color: theme.accent }]}>{zoomPercent}%</Text>
                      </Pressable>
                      <Pressable style={[styles.zoomBtn, { backgroundColor: theme.bgInput }]} onPress={handleZoomIn} hitSlop={6}>
                        <Text style={[styles.zoomBtnText, { color: theme.textSecondary }]}>A+</Text>
                      </Pressable>
                    </View>

                    <View style={styles.capsuleButtons}>
                      <Pressable
                        style={[
                          styles.controlBtn,
                          { backgroundColor: hasControl ? theme.accentLight : theme.bgInput },
                        ]}
                        onPress={hasControl ? onReleaseControl : onClaimControl}
                        disabled={status !== "connected" && status !== "host_disconnected"}
                      >
                        <Text style={[styles.controlBtnText, { color: hasControl ? theme.accent : theme.textSecondary }]}> 
                          {hasControl ? "释放" : "接管"}
                        </Text>
                      </Pressable>

                      <Pressable style={[styles.leaveBtn, { backgroundColor: theme.errorLight }]} onPress={handleLeave} hitSlop={8}>
                        <Text style={[styles.leaveBtnText, { color: theme.error }]}>退出</Text>
                      </Pressable>
                    </View>
                  </View>
                </Animated.View>
              ) : null}
            </View>
            <View pointerEvents="box-none" style={styles.terminalTouchLayer}>
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
          <View style={{ height: insets.bottom, backgroundColor: theme.bgTerminal }} />
        </View>

        <View style={styles.hiddenInputWrap}>
          <InputBar
            ref={inputRef}
            onSendText={handleTerminalInput}
            onSpecialKey={handleSpecialKey}
            disabled={inputDisabled}
          />
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
  capsuleHost: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: 14,
    zIndex: 20,
  },
  capsulePill: {
    minWidth: 216,
    maxWidth: "92%",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.16,
    shadowRadius: 18,
    elevation: 10,
  },
  capsulePanel: {
    width: "100%",
    marginTop: 10,
    borderRadius: 26,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.16,
    shadowRadius: 22,
    elevation: 10,
  },
  capsuleHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  capsuleHeaderMain: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  capsuleHeaderSide: { flexDirection: "row", alignItems: "center", gap: 10 },
  capsuleCopy: { flex: 1, gap: 1 },
  capsuleTitle: { fontSize: 14, fontWeight: "700" },
  capsuleSubtitle: { fontSize: 11, fontWeight: "500" },
  capsuleSessionText: { fontSize: 11, fontFamily: "Courier" },
  capsuleChevron: {
    width: 8,
    height: 8,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    marginTop: -2,
  },
  capsuleDivider: { height: 1, borderRadius: 1 },
  capsuleSummary: { gap: 2 },
  capsuleDetailText: { fontSize: 11, lineHeight: 15 },
  capsuleBanner: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  capsuleActionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  capsuleButtons: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  controlSummaryTitle: { fontSize: 14, fontWeight: "700" },
  controlSummaryBody: { fontSize: 12 },
  zoomGroup: { flexDirection: "row", alignItems: "center", gap: 2 },
  zoomBtn: {
    minHeight: 28, minWidth: 28, borderRadius: 6,
    alignItems: "center", justifyContent: "center",
  },
  zoomBtnText: { fontSize: 10, fontWeight: "700" },
  zoomBadge: {
    minHeight: 28, minWidth: 40, borderRadius: 6,
    alignItems: "center", justifyContent: "center",
  },
  zoomBadgeText: { fontSize: 10, fontWeight: "700" },
  controlBtn: {
    minHeight: 28, borderRadius: 6,
    paddingHorizontal: 10, alignItems: "center", justifyContent: "center",
  },
  controlBtnText: { fontSize: 11, fontWeight: "700" },
  leaveBtn: {
    minHeight: 28, borderRadius: 6,
    paddingHorizontal: 10, alignItems: "center", justifyContent: "center",
  },
  leaveBtnText: { fontSize: 11, fontWeight: "700" },
  bannerText: { fontSize: 12, fontWeight: "600", flex: 1 },
  reconnectBtn: {
    borderRadius: 6,
    paddingHorizontal: 10, paddingVertical: 4, marginLeft: 8,
  },
  reconnectBtnText: { fontSize: 11, fontWeight: "700" },
  terminalArea: { flex: 1 },
  terminalWrap: { flex: 1 },
  terminalTouchLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    alignItems: "center",
  },
  tapHintPill: {
    position: "absolute",
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: 6,
  },
  tapHintText: { fontSize: 12, fontWeight: "600" },
  hiddenInputWrap: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: 1,
    height: 1,
    opacity: 0.01,
  },
});
