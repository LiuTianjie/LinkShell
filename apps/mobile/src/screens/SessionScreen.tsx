import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Clipboard,
  FlatList,
  Keyboard,
  KeyboardEvent,
  LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import { TerminalView } from "../components/TerminalView";
import type { TerminalViewHandle } from "../components/TerminalView";
import { ScreenView } from "../components/ScreenView";
import type { ConnectionStatus, TerminalStream } from "../hooks/useSession";
import type { TerminalInfo } from "../hooks/useSessionManager";
import { useTheme } from "../theme";
import type { Theme } from "../theme";

const SHORTCUT_BAR_HEIGHT = 44;

const SHORTCUTS = [
  { label: "⇧Tab", value: "\u001b[Z" },
  { label: "Esc", value: "\u001b" },
  { label: "Tab", value: "\t" },
  { label: "Ctrl+C", value: "\u0003" },
  { label: "Ctrl+D", value: "\u0004" },
  { label: "Ctrl+L", value: "\u000c" },
  { label: "\u2191", value: "\u001b[A" },
  { label: "\u2193", value: "\u001b[B" },
  { label: "\u2192", value: "\u001b[C" },
  { label: "\u2190", value: "\u001b[D" },
];

export interface SessionTab {
  sessionId: string;
  label: string;
  status: ConnectionStatus;
}

export interface TerminalTab {
  terminalId: string;
  label: string;
  status: "running" | "exited";
}

interface SessionScreenProps {
  sessionId: string;
  status: ConnectionStatus;
  deviceId: string;
  controllerId: string | null;
  connectionDetail: string | null;
  terminalStream: TerminalStream;
  screenStatus: { active: boolean; mode: "webrtc" | "fallback" | "off"; error?: string };
  screenFrame: { data: string; width: number; height: number; frameId: number } | null;
  pendingOffer: { sdp: string } | null;
  pendingIceCandidates: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }[];
  onSendInput: (data: string) => void;
  onSendImage: (base64Data: string, filename: string) => void;
  onSendResize: (cols: number, rows: number) => void;
  onClaimControl: () => void;
  onReleaseControl: () => void;
  onStartScreen: (fps: number, quality: number, scale: number) => void;
  onStopScreen: () => void;
  onScreenSignal: (type: "screen.answer" | "screen.ice", payload: any) => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  // Multi-session tabs
  sessionTabs?: SessionTab[];
  activeTabId?: string | null;
  onSwitchSession?: (sessionId: string) => void;
  onCloseSession?: (sessionId: string) => void;
  // Multi-terminal tabs within session
  terminalTabs?: TerminalTab[];
  activeTerminalId?: string | null;
  onSwitchTerminal?: (terminalId: string) => void;
  onAddTerminal?: () => void;
  terminals?: Map<string, TerminalInfo>;
}

export function SessionScreen({
  sessionId,
  status,
  deviceId,
  controllerId,
  connectionDetail,
  terminalStream,
  screenStatus,
  screenFrame,
  pendingOffer,
  pendingIceCandidates,
  onSendInput,
  onSendImage,
  onSendResize,
  onClaimControl,
  onReleaseControl,
  onStartScreen,
  onStopScreen,
  onScreenSignal,
  onReconnect,
  onDisconnect,
  sessionTabs,
  activeTabId,
  onSwitchSession,
  onCloseSession,
  terminalTabs,
  activeTerminalId,
  onSwitchTerminal,
  onAddTerminal,
  terminals,
}: SessionScreenProps) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { theme } = useTheme();
  const termRef = useRef<TerminalViewHandle>(null);
  const termRefsMap = useRef(new Map<string, React.RefObject<TerminalViewHandle | null>>());

  // Helper: get or create a ref for a terminal
  const getTermRef = useCallback((terminalId: string) => {
    let r = termRefsMap.current.get(terminalId);
    if (!r) {
      r = React.createRef<TerminalViewHandle | null>();
      termRefsMap.current.set(terminalId, r);
    }
    return r;
  }, []);

  // Keep termRef synced to active terminal's ref (so existing zoom/refit/focus code works)
  const activeTermRef = activeTerminalId ? termRefsMap.current.get(activeTerminalId) : null;
  if (activeTermRef) {
    (termRef as any).current = activeTermRef.current;
  }
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [keyboardHintVisible, setKeyboardHintVisible] = useState(true);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [activeTab, setActiveTab] = useState<"terminal" | "desktop">("terminal");
  const [showTerminalGrid, setShowTerminalGrid] = useState(false);

  const keyboardVisible = keyboardInset > 0;
  const stageBottomInset = keyboardVisible ? keyboardInset : insets.bottom;

  const switchToDesktop = useCallback(() => {
    setActiveTab("desktop");
    Keyboard.dismiss();
    termRef.current?.blurCursor();
  }, []);

  const switchToTerminal = useCallback(() => {
    setActiveTab("terminal");
    onStopScreen();
  }, [onStopScreen]);

  const hasControl = controllerId === deviceId;
  const isControlledByOther = Boolean(controllerId && controllerId !== deviceId);
  const inputDisabled =
    !hasControl ||
    status === "reconnecting" ||
    status === "session_exited" ||
    status === "disconnected" ||
    status === "host_disconnected";

  useEffect(() => {
    lastResizeRef.current = null;
  }, [sessionId]);

  const handleTerminalInput = useCallback((data: string) => {
    onSendInput(data);
  }, [onSendInput]);

  const handlePickImage = useCallback(async (source: "library" | "camera") => {
    const picker = source === "camera"
      ? ImagePicker.launchCameraAsync
      : ImagePicker.launchImageLibraryAsync;
    try {
      const result = await picker({
        mediaTypes: ["images"],
        base64: true,
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.[0]?.base64) return;
      const asset = result.assets[0]!;
      const ext = asset.uri.split(".").pop() || "png";
      onSendImage(asset.base64!, `image.${ext}`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [onSendImage]);

  const showImagePicker = useCallback(() => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["取消", "相册", "拍照"], cancelButtonIndex: 0 },
        (index) => {
          if (index === 1) handlePickImage("library");
          else if (index === 2) handlePickImage("camera");
        },
      );
    } else {
      Alert.alert("发送图片", undefined, [
        { text: "取消", style: "cancel" },
        { text: "相册", onPress: () => handlePickImage("library") },
        { text: "拍照", onPress: () => handlePickImage("camera") },
      ]);
    }
  }, [handlePickImage]);

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    if (
      lastResizeRef.current &&
      lastResizeRef.current.cols === cols &&
      lastResizeRef.current.rows === rows
    ) {
      return;
    }
    lastResizeRef.current = { cols, rows };
    onSendResize(cols, rows);
  }, [onSendResize]);

  const handleTerminalLayout = useCallback((event: LayoutChangeEvent) => {
    if (event.nativeEvent.layout.height <= 0 || event.nativeEvent.layout.width <= 0) return;
    requestAnimationFrame(() => {
      termRef.current?.refit(keyboardVisible);
    });
  }, [keyboardVisible]);

  const focusTerminalInput = useCallback(() => {
    if (inputDisabled) return;
    setKeyboardHintVisible(false);
    termRef.current?.scrollToBottom();
    requestAnimationFrame(() => {
      termRef.current?.focusCursor();
    });
  }, [inputDisabled]);

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
    const applyKeyboardFrame = (event: KeyboardEvent) => {
      if (typeof Keyboard.scheduleLayoutAnimation === "function") {
        Keyboard.scheduleLayoutAnimation(event);
      }

      const nextInset = Platform.OS === "ios"
        ? Math.max(0, windowHeight - event.endCoordinates.screenY)
        : Math.max(0, event.endCoordinates.height);

      setKeyboardInset(nextInset);
    };

    const clearKeyboardFrame = (event?: KeyboardEvent) => {
      if (event && typeof Keyboard.scheduleLayoutAnimation === "function") {
        Keyboard.scheduleLayoutAnimation(event);
      }
      setKeyboardInset(0);
    };

    if (Platform.OS === "ios") {
      const frameSub = Keyboard.addListener("keyboardWillChangeFrame", applyKeyboardFrame);
      const hideSub = Keyboard.addListener("keyboardWillHide", clearKeyboardFrame);

      return () => {
        frameSub.remove();
        hideSub.remove();
      };
    }

    const showSub = Keyboard.addListener("keyboardDidShow", applyKeyboardFrame);
    const hideSub = Keyboard.addListener("keyboardDidHide", clearKeyboardFrame);

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [insets.bottom, windowHeight]);

  useEffect(() => {
    if (activeTab !== "terminal") return;

    requestAnimationFrame(() => {
      termRef.current?.refit(keyboardVisible);
      if (keyboardVisible) {
        setTimeout(() => {
          termRef.current?.scrollToBottom();
        }, 250);
      }
    });
  }, [activeTab, keyboardVisible, keyboardInset]);

  const banner = getSessionBanner(status);
  const showReconnectButton = status === "disconnected" || (status.startsWith("error:") && Boolean(sessionId));

  const isConnecting = status === "connecting" || status === "claiming";
  const isHostOffline = status === "host_disconnected";
  const isErrorState = status === "disconnected" || status.startsWith("error:");
  const showFullOverlay = isConnecting || isHostOffline || isErrorState;

  // Host status tag
  const hostOnline = status === "connected" || status === "session_exited";
  const hostTagColor = isConnecting ? "#fbbf24" : hostOnline ? "#4ade80" : "#ef4444";
  const hostTagText = isConnecting ? "连接中" : hostOnline ? "主机在线" : isHostOffline ? "主机离线" : status === "reconnecting" ? "重连中" : "已断开";
  const hostTagBg = isConnecting ? "rgba(251,191,36,0.12)" : hostOnline ? "rgba(74,222,128,0.12)" : "rgba(239,68,68,0.10)";

  // Session status tag
  const sessionExited = status === "session_exited";
  const sessionUnknown = !hostOnline && !sessionExited && !isConnecting;
  const sessionTagColor = sessionExited ? "#6b7280" : isConnecting || sessionUnknown ? theme.textTertiary : "#4ade80";
  const sessionTagText = sessionExited ? "进程已退出" : isConnecting ? "等待中" : sessionUnknown ? "状态未知" : "进程运行中";
  const sessionTagBg = sessionExited ? "rgba(107,114,128,0.12)" : isConnecting || sessionUnknown ? "rgba(107,114,128,0.08)" : "rgba(74,222,128,0.12)";

  const toolbarBg = theme.mode === "light" ? "#e5e5ea" : "rgba(255,255,255,0.1)";

  return (
    <View style={{ flex: 1, backgroundColor: theme.bgTerminal }}>
      <View style={{ height: insets.top, backgroundColor: theme.mode === "light" ? theme.bgCard : theme.bgElevated }} />

      {sessionTabs && sessionTabs.length > 1 ? (
        <SessionTabBar
          tabs={sessionTabs}
          activeTabId={activeTabId ?? sessionId}
          onSwitch={onSwitchSession}
          onClose={onCloseSession}
          theme={theme}
        />
      ) : null}

      {terminalTabs && terminalTabs.length > 0 ? null : null}

      <SessionHeader
        activeTab={activeTab}
        hasControl={hasControl}
        hostTagBg={hostTagBg}
        hostTagColor={hostTagColor}
        hostTagText={hostTagText}
        isControlledByOther={isControlledByOther}
        onClaimControl={onClaimControl}
        onLeave={handleLeave}
        onReleaseControl={onReleaseControl}
        onSwitchDesktop={switchToDesktop}
        onSwitchTerminal={switchToTerminal}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
        sessionId={sessionId}
        sessionTagBg={sessionTagBg}
        sessionTagColor={sessionTagColor}
        sessionTagText={sessionTagText}
        status={status}
        theme={theme}
        toolbarBg={toolbarBg}
        zoomPercent={zoomPercent}
        terminalCount={terminalTabs?.length ?? 0}
        activeTerminalLabel={terminalTabs?.find((t) => t.terminalId === activeTerminalId)?.label}
        onShowTerminalGrid={() => setShowTerminalGrid(true)}
      />

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

      <View style={{ flex: 1, backgroundColor: theme.bgTerminal }}>
        <View style={{ flex: 1, position: "relative", backgroundColor: theme.bgTerminal }}>
          <View
            pointerEvents={activeTab === "terminal" ? "auto" : "none"}
            style={[StyleSheet.absoluteFillObject, { opacity: activeTab === "terminal" ? 1 : 0 }]}
          >
            <TerminalStage
              bottomInset={stageBottomInset}
              inputDisabled={inputDisabled}
              keyboardHintVisible={keyboardHintVisible && !keyboardVisible}
              onInput={handleTerminalInput}
              onLayout={handleTerminalLayout}
              onResize={handleTerminalResize}
              onRequestFocus={focusTerminalInput}
              onImagePicker={showImagePicker}
              stream={terminalStream}
              termRef={termRef}
              theme={theme}
              terminals={terminals}
              activeTerminalId={activeTerminalId}
              getTermRef={getTermRef}
            />
          </View>

          <View
            pointerEvents={activeTab === "desktop" ? "auto" : "none"}
            style={[StyleSheet.absoluteFillObject, { bottom: stageBottomInset, opacity: activeTab === "desktop" ? 1 : 0 }]}
          >
            <DesktopStage
              error={screenStatus.error}
              mode={screenStatus.mode}
              onStart={onStartScreen}
              onStop={onStopScreen}
              onSignal={onScreenSignal}
              screenFrame={screenFrame}
              pendingOffer={pendingOffer}
              pendingIceCandidates={pendingIceCandidates}
              sessionId={sessionId}
              theme={theme}
              active={screenStatus.active}
            />
          </View>

          {showFullOverlay ? (
            <SessionOverlay
              connectionDetail={connectionDetail}
              isConnecting={isConnecting}
              isHostOffline={isHostOffline}
              onLeave={handleLeave}
              onReconnect={onReconnect}
              status={status}
              bottomInset={stageBottomInset}
              theme={theme}
            />
          ) : null}
        </View>
      </View>

      {showTerminalGrid ? (
        <TerminalGridOverlay
          terminalTabs={terminalTabs ?? []}
          activeTerminalId={activeTerminalId}
          terminals={terminals}
          onSwitch={(tid) => { onSwitchTerminal?.(tid); setShowTerminalGrid(false); }}
          onAdd={() => { setShowTerminalGrid(false); onAddTerminal?.(); }}
          onClose={() => setShowTerminalGrid(false)}
          theme={theme}
          insetTop={insets.top}
        />
      ) : null}
    </View>
  );
}

const SessionHeader = memo(function SessionHeader({
  activeTab,
  hasControl,
  hostTagBg,
  hostTagColor,
  hostTagText,
  isControlledByOther,
  onClaimControl,
  onLeave,
  onReleaseControl,
  onSwitchDesktop,
  onSwitchTerminal,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  sessionId,
  sessionTagBg,
  sessionTagColor,
  sessionTagText,
  status,
  theme,
  toolbarBg,
  zoomPercent,
  terminalCount,
  activeTerminalLabel,
  onShowTerminalGrid,
}: {
  activeTab: "terminal" | "desktop";
  hasControl: boolean;
  hostTagBg: string;
  hostTagColor: string;
  hostTagText: string;
  isControlledByOther: boolean;
  onClaimControl: () => void;
  onLeave: () => void;
  onReleaseControl: () => void;
  onSwitchDesktop: () => void;
  onSwitchTerminal: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  sessionId: string;
  sessionTagBg: string;
  sessionTagColor: string;
  sessionTagText: string;
  status: ConnectionStatus;
  theme: Theme;
  toolbarBg: string;
  zoomPercent: number;
  terminalCount?: number;
  activeTerminalLabel?: string;
  onShowTerminalGrid?: () => void;
}) {
  return (
    <View style={{
      backgroundColor: theme.mode === "light" ? theme.bgCard : theme.bgElevated,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.separator,
      paddingHorizontal: 12,
      paddingTop: 6,
      paddingBottom: 6,
      gap: 6,
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: hostTagBg, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, borderCurve: "continuous" as const }}>
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: hostTagColor }} />
            <Text style={{ fontSize: 10, fontWeight: "600", color: hostTagColor }}>{hostTagText}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: sessionTagBg, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, borderCurve: "continuous" as const }}>
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: sessionTagColor }} />
            <Text style={{ fontSize: 10, fontWeight: "600", color: sessionTagColor }}>{sessionTagText}</Text>
          </View>
          <Text style={{ fontSize: 10, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", color: theme.textTertiary }} numberOfLines={1}>
            {activeTerminalLabel || sessionId.slice(0, 8)}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {(terminalCount ?? 0) > 0 && onShowTerminalGrid ? (
            <Pressable
              style={({ pressed }) => ({
                width: 28,
                height: 28,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 7,
                borderWidth: 1.5,
                borderColor: pressed ? theme.accent : theme.textSecondary,
                backgroundColor: pressed ? theme.accentLight : "transparent",
              })}
              onPress={onShowTerminalGrid}
              hitSlop={6}
            >
              <Text style={{ fontSize: 12, fontWeight: "700", color: theme.textSecondary, fontVariant: ["tabular-nums"] }}>{terminalCount}</Text>
            </Pressable>
          ) : null}
          <Pressable
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 12,
            borderCurve: "continuous" as const,
            backgroundColor: pressed ? "rgba(255,59,48,0.2)" : "rgba(255,59,48,0.12)",
          })}
          onPress={onLeave}
          hitSlop={10}
        >
          <AppSymbol name="xmark.circle.fill" size={14} color={theme.error} />
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.error }}>退出</Text>
        </Pressable>
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 12,
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
            size={13}
            color={hasControl ? theme.accent : theme.textSecondary}
          />
          <Text style={{ fontSize: 12, fontWeight: "500", color: hasControl ? theme.accent : theme.textSecondary }}>
            {hasControl ? "已接管 · 释放" : isControlledByOther ? "只读 · 接管" : "接管控制"}
          </Text>
        </Pressable>

        <View style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          borderRadius: 10,
          borderCurve: "continuous",
          backgroundColor: toolbarBg,
          overflow: "hidden",
        }}>
          <Pressable
            style={({ pressed }) => ({
              flex: 1,
              height: 30,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: activeTab === "terminal"
                ? theme.mode === "light" ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.08)"
                : (pressed ? "rgba(128,128,128,0.2)" : "transparent"),
            })}
            onPress={onSwitchTerminal}
          >
            <Text style={{ fontSize: 12, fontWeight: "600", color: activeTab === "terminal" ? theme.accent : theme.textTertiary }}>
              Terminal
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => ({
              flex: 1,
              height: 30,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: activeTab === "desktop"
                ? theme.mode === "light" ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.08)"
                : (pressed ? "rgba(128,128,128,0.2)" : "transparent"),
            })}
            onPress={onSwitchDesktop}
          >
            <Text style={{ fontSize: 12, fontWeight: "600", color: activeTab === "desktop" ? theme.accent : theme.textTertiary }}>
              Desktop
            </Text>
          </Pressable>
        </View>

        <View style={{
          flexDirection: "row",
          alignItems: "center",
          borderRadius: 8,
          borderCurve: "continuous" as const,
          backgroundColor: toolbarBg,
          overflow: "hidden",
        }}>
        <Pressable
          style={({ pressed }) => ({
            width: 30,
            height: 28,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: pressed ? "rgba(128,128,128,0.2)" : "transparent",
          })}
          onPress={onZoomOut}
        >
          <AppSymbol name="textformat.size.smaller" size={13} color={theme.textSecondary} />
        </Pressable>
        <Pressable
          style={({ pressed }) => ({
            minWidth: 42,
            height: 28,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 4,
            backgroundColor: pressed ? "rgba(128,128,128,0.2)" : "transparent",
          })}
          onPress={onZoomReset}
        >
          <Text style={{ fontSize: 11, fontWeight: "600", color: theme.accent, fontVariant: ["tabular-nums"] }}>{zoomPercent}%</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => ({
            width: 30,
            height: 28,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: pressed ? "rgba(128,128,128,0.2)" : "transparent",
          })}
          onPress={onZoomIn}
        >
          <AppSymbol name="textformat.size.larger" size={13} color={theme.textSecondary} />
        </Pressable>
      </View>
      </View>
    </View>
  );
});

const TerminalStage = memo(function TerminalStage({
  bottomInset,
  inputDisabled,
  keyboardHintVisible,
  onInput,
  onLayout,
  onResize,
  onRequestFocus,
  onImagePicker,
  stream,
  termRef,
  theme,
  terminals,
  activeTerminalId,
  getTermRef,
}: {
  bottomInset: number;
  inputDisabled: boolean;
  keyboardHintVisible: boolean;
  onInput: (data: string) => void;
  onLayout: (event: LayoutChangeEvent) => void;
  onResize: (cols: number, rows: number) => void;
  onRequestFocus: () => void;
  onImagePicker: () => void;
  stream: TerminalStream;
  termRef: React.RefObject<TerminalViewHandle | null>;
  theme: Theme;
  terminals?: Map<string, TerminalInfo>;
  activeTerminalId?: string | null;
  getTermRef?: (terminalId: string) => React.RefObject<TerminalViewHandle | null>;
}) {
  const keyboardUp = bottomInset > 0;
  const showShortcutBar = keyboardUp && !inputDisabled;
  const terminalPadding = bottomInset + (showShortcutBar ? SHORTCUT_BAR_HEIGHT : 0);

  // If we have multiple terminals, render each with its own TerminalView
  const hasMultipleTerminals = terminals && terminals.size > 0 && getTermRef;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bgTerminal }} onLayout={onLayout}>
      <View style={{ flex: 1, paddingBottom: terminalPadding }}>
        {hasMultipleTerminals ? (
          Array.from(terminals.entries()).map(([tid, tInfo]) => {
            const isActive = tid === activeTerminalId;
            return (
              <View
                key={tid}
                style={{ flex: isActive ? 1 : 0, display: isActive ? "flex" : "none" }}
                pointerEvents={isActive ? "auto" : "none"}
              >
                <TerminalView
                  ref={getTermRef(tid)}
                  stream={tInfo.terminalStream}
                  onInput={isActive ? onInput : undefined}
                  onResize={isActive ? onResize : undefined}
                />
              </View>
            );
          })
        ) : (
          <TerminalView
            ref={termRef}
            stream={stream}
            onInput={onInput}
            onResize={onResize}
          />
        )}
      </View>
      {showShortcutBar ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: bottomInset,
            height: SHORTCUT_BAR_HEIGHT,
            paddingHorizontal: 6,
            paddingVertical: 5,
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            backgroundColor: theme.bgTerminal,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.separator,
          }}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={{ alignItems: "center", gap: 4, paddingRight: 8 }}
            style={{ flex: 1 }}
          >
            {SHORTCUTS.map((item) => (
              <Pressable
                key={item.label}
                style={({ pressed }) => ({
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  borderRadius: 8,
                  borderCurve: "continuous",
                  backgroundColor: pressed ? theme.bgCard : theme.bgElevated,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: theme.separator,
                })}
                onPress={() => onInput(item.value)}
              >
                <Text style={{ fontSize: 12, fontWeight: "600", color: theme.text }}>{item.label}</Text>
              </Pressable>
            ))}
            <Pressable
              key="paste"
              style={({ pressed }) => ({
                paddingHorizontal: 8,
                paddingVertical: 6,
                borderRadius: 8,
                borderCurve: "continuous",
                backgroundColor: pressed ? theme.bgCard : theme.bgElevated,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
              })}
              onPress={async () => {
                const text = await Clipboard.getString();
                if (text) onInput(text);
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "600", color: theme.accent }}>Paste</Text>
            </Pressable>
            <Pressable
              key="image"
              style={({ pressed }) => ({
                paddingHorizontal: 8,
                paddingVertical: 6,
                borderRadius: 8,
                borderCurve: "continuous",
                backgroundColor: pressed ? theme.bgCard : theme.bgElevated,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
              })}
              onPress={onImagePicker}
            >
              <Text style={{ fontSize: 12, fontWeight: "600", color: theme.accent }}>Image</Text>
            </Pressable>
          </ScrollView>
          <Pressable
            style={({ pressed }) => ({
              paddingHorizontal: 8,
              paddingVertical: 6,
              borderRadius: 8,
              borderCurve: "continuous",
              backgroundColor: pressed ? theme.bgCard : "transparent",
            })}
            onPress={() => {
              Keyboard.dismiss();
              termRef.current?.blurCursor();
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.accent }}>完成</Text>
          </Pressable>
        </View>
      ) : null}
      {keyboardHintVisible && !inputDisabled && bottomInset === 0 ? (
        <View pointerEvents="box-none" style={{ ...StyleSheet.absoluteFillObject, justifyContent: "flex-end", alignItems: "center" }}>
          <Pressable
            style={{
              position: "absolute",
              bottom: 16,
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
            onPress={onRequestFocus}
          >
            <AppSymbol name="keyboard" size={16} color={theme.accent} />
            <Text style={{ fontSize: 13, fontWeight: "500", color: theme.text }}>点按开始输入</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

const DesktopStage = memo(function DesktopStage({
  active,
  error,
  mode,
  onStart,
  onStop,
  onSignal,
  screenFrame,
  pendingOffer,
  pendingIceCandidates,
  sessionId,
  theme,
}: {
  active: boolean;
  error?: string;
  mode: "webrtc" | "fallback" | "off";
  onStart: (fps: number, quality: number, scale: number) => void;
  onStop: () => void;
  onSignal: (type: "screen.answer" | "screen.ice", payload: any) => void;
  screenFrame: { data: string; width: number; height: number; frameId: number } | null;
  pendingOffer: { sdp: string } | null;
  pendingIceCandidates: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }[];
  sessionId: string;
  theme: Theme;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: theme.bgTerminal }}>
      <ScreenView
        sessionId={sessionId}
        active={active}
        mode={mode}
        error={error}
        screenFrame={screenFrame}
        pendingOffer={pendingOffer}
        pendingIceCandidates={pendingIceCandidates}
        onStart={onStart}
        onStop={onStop}
        onSignal={onSignal}
      />
    </View>
  );
});

const SessionOverlay = memo(function SessionOverlay({
  bottomInset,
  connectionDetail,
  isConnecting,
  isHostOffline,
  onLeave,
  onReconnect,
  status,
  theme,
}: {
  bottomInset: number;
  connectionDetail: string | null;
  isConnecting: boolean;
  isHostOffline: boolean;
  onLeave: () => void;
  onReconnect: () => void;
  status: ConnectionStatus;
  theme: Theme;
}) {
  return (
    <View style={{
      ...StyleSheet.absoluteFillObject,
      bottom: bottomInset,
      backgroundColor: theme.mode === "dark" ? "rgba(14,14,15,0.92)" : "rgba(255,255,255,0.92)",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 40,
      gap: 16,
    }}>
      {isConnecting ? (
        <>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={{ fontSize: 17, fontWeight: "600", color: theme.text, textAlign: "center" }}>
            {status === "claiming" ? "正在配对…" : "正在连接…"}
          </Text>
          <Text style={{ fontSize: 14, color: theme.textTertiary, textAlign: "center" }}>
            {connectionDetail ?? "正在建立与主机的连接"}
          </Text>
          <Pressable
            style={({ pressed }) => ({
              marginTop: 8,
              paddingHorizontal: 20,
              paddingVertical: 10,
              borderRadius: 10,
              borderCurve: "continuous" as const,
              backgroundColor: pressed ? "rgba(255,59,48,0.2)" : "rgba(255,59,48,0.12)",
            })}
            onPress={onLeave}
          >
            <Text style={{ fontSize: 15, fontWeight: "600", color: theme.error }}>取消</Text>
          </Pressable>
        </>
      ) : isHostOffline ? (
        <>
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: "rgba(251,191,36,0.15)", alignItems: "center", justifyContent: "center" }}>
            <AppSymbol name="wifi.slash" size={26} color="#fbbf24" />
          </View>
          <Text style={{ fontSize: 17, fontWeight: "600", color: theme.text, textAlign: "center" }}>
            主机离线
          </Text>
          <Text style={{ fontSize: 14, color: theme.textTertiary, textAlign: "center", lineHeight: 20 }}>
            主机当前不可用，可以等待主机恢复后重试，{"\n"}或退出返回会话列表。
          </Text>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 4 }}>
            <Pressable
              style={({ pressed }) => ({
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 10,
                borderCurve: "continuous" as const,
                backgroundColor: pressed ? "rgba(255,59,48,0.2)" : "rgba(255,59,48,0.12)",
              })}
              onPress={onLeave}
            >
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.error }}>退出</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => ({
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 10,
                borderCurve: "continuous" as const,
                backgroundColor: pressed ? theme.accent : theme.accentLight,
              })}
              onPress={onReconnect}
            >
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.accent }}>重试</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: "rgba(239,68,68,0.12)", alignItems: "center", justifyContent: "center" }}>
            <AppSymbol name="exclamationmark.triangle.fill" size={26} color={theme.error} />
          </View>
          <Text style={{ fontSize: 17, fontWeight: "600", color: theme.text, textAlign: "center" }}>
            连接失败
          </Text>
          <Text style={{ fontSize: 14, color: theme.textTertiary, textAlign: "center", lineHeight: 20 }}>
            {connectionDetail ?? "无法连接到主机"}
          </Text>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 4 }}>
            <Pressable
              style={({ pressed }) => ({
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 10,
                borderCurve: "continuous" as const,
                backgroundColor: pressed ? "rgba(255,59,48,0.2)" : "rgba(255,59,48,0.12)",
              })}
              onPress={onLeave}
            >
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.error }}>退出</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => ({
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 10,
                borderCurve: "continuous" as const,
                backgroundColor: pressed ? theme.accent : theme.accentLight,
              })}
              onPress={onReconnect}
            >
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.accent }}>重试</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
});

const SessionTabBar = memo(function SessionTabBar({
  tabs,
  activeTabId,
  onSwitch,
  onClose,
  theme,
}: {
  tabs: SessionTab[];
  activeTabId: string;
  onSwitch?: (sessionId: string) => void;
  onClose?: (sessionId: string) => void;
  theme: Theme;
}) {
  const statusDot = (status: ConnectionStatus) => {
    if (status === "connected") return "#4ade80";
    if (status === "connecting" || status === "claiming" || status === "reconnecting") return "#fbbf24";
    return "#ef4444";
  };

  return (
    <View style={{
      backgroundColor: theme.mode === "light" ? theme.bgCard : theme.bgElevated,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.separator,
    }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 8, gap: 2, alignItems: "center" }}
        style={{ height: 36 }}
      >
        {tabs.map((tab) => {
          const isActive = tab.sessionId === activeTabId;
          return (
            <Pressable
              key={tab.sessionId}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                borderCurve: "continuous" as const,
                backgroundColor: isActive
                  ? (theme.mode === "light" ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.08)")
                  : (pressed ? "rgba(128,128,128,0.1)" : "transparent"),
              })}
              onPress={() => onSwitch?.(tab.sessionId)}
            >
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusDot(tab.status) }} />
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 12,
                  fontWeight: isActive ? "600" : "400",
                  color: isActive ? theme.text : theme.textSecondary,
                  maxWidth: 120,
                }}
              >
                {tab.label}
              </Text>
              {onClose ? (
                <Pressable
                  hitSlop={8}
                  onPress={(e) => {
                    e.stopPropagation();
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onClose(tab.sessionId);
                  }}
                  style={({ pressed }) => ({
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: pressed ? "rgba(128,128,128,0.3)" : "transparent",
                  })}
                >
                  <Text style={{ fontSize: 10, fontWeight: "700", color: theme.textTertiary, lineHeight: 12 }}>✕</Text>
                </Pressable>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
});

const TerminalGridOverlay = memo(function TerminalGridOverlay({
  terminalTabs,
  activeTerminalId,
  terminals,
  onSwitch,
  onAdd,
  onClose,
  theme,
  insetTop,
}: {
  terminalTabs: TerminalTab[];
  activeTerminalId?: string | null;
  terminals?: Map<string, TerminalInfo>;
  onSwitch: (terminalId: string) => void;
  onAdd: () => void;
  onClose: () => void;
  theme: Theme;
  insetTop: number;
}) {
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.85)", zIndex: 100 }]}>
      <View style={{ paddingTop: insetTop + 8, paddingHorizontal: 16, paddingBottom: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: "700" }}>终端</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Pressable onPress={onAdd} hitSlop={8}>
            <AppSymbol name="plus" size={20} color={theme.accent} />
          </Pressable>
          <Pressable onPress={onClose} hitSlop={8}>
            <Text style={{ color: theme.accent, fontSize: 15, fontWeight: "500" }}>完成</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={terminalTabs}
        numColumns={2}
        keyExtractor={(item) => item.terminalId}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 40 }}
        columnWrapperStyle={{ gap: 10, marginBottom: 10 }}
        renderItem={({ item }) => {
          const isActive = item.terminalId === activeTerminalId;
          const tInfo = terminals?.get(item.terminalId);
          const isRunning = item.status === "running";
          return (
            <Pressable
              onPress={() => onSwitch(item.terminalId)}
              style={({ pressed }) => ({
                flex: 1,
                borderRadius: 14,
                borderCurve: "continuous" as const,
                overflow: "hidden",
                borderWidth: isActive ? 2 : 1,
                borderColor: isActive ? theme.accent : "rgba(255,255,255,0.1)",
                backgroundColor: pressed ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
              })}
            >
              <View style={{ height: 120, backgroundColor: theme.bgTerminal, justifyContent: "center", alignItems: "center" }}>
                <AppSymbol name="terminal.fill" size={32} color={isRunning ? theme.accent : theme.textTertiary} />
              </View>
              <View style={{ paddingHorizontal: 10, paddingVertical: 8, gap: 2 }}>
                <Text style={{ color: theme.text, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
                  {item.label}
                </Text>
                {tInfo?.cwd ? (
                  <Text style={{ color: theme.textTertiary, fontSize: 10 }} numberOfLines={1}>
                    {tInfo.cwd}
                  </Text>
                ) : null}
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 }}>
                  <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: isRunning ? "#4ade80" : "#6b7280" }} />
                  <Text style={{ fontSize: 9, color: isRunning ? "#4ade80" : "#6b7280", fontWeight: "500" }}>
                    {isRunning ? "运行中" : "已退出"}
                  </Text>
                </View>
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={{ alignItems: "center", paddingTop: 60 }}>
            <Text style={{ color: theme.textTertiary, fontSize: 14 }}>暂无终端</Text>
          </View>
        }
      />
    </View>
  );
});

const TerminalTabBar = memo(function TerminalTabBar({
  tabs,
  activeTabId,
  onSwitch,
  onAdd,
  theme,
}: {
  tabs: TerminalTab[];
  activeTabId: string;
  onSwitch?: (terminalId: string) => void;
  onAdd?: () => void;
  theme: Theme;
}) {
  return (
    <View style={{
      backgroundColor: theme.mode === "light" ? theme.bgCard : theme.bgElevated,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.separator,
    }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 8, gap: 2, alignItems: "center" }}
        style={{ height: 34 }}
      >
        {tabs.map((tab) => {
          const isActive = tab.terminalId === activeTabId;
          const isExited = tab.status === "exited";
          return (
            <Pressable
              key={tab.terminalId}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 7,
                borderCurve: "continuous" as const,
                backgroundColor: isActive
                  ? (theme.mode === "light" ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.08)")
                  : (pressed ? "rgba(128,128,128,0.1)" : "transparent"),
              })}
              onPress={() => onSwitch?.(tab.terminalId)}
            >
              <AppSymbol
                name={isExited ? "xmark.circle" : "terminal.fill"}
                size={12}
                color={isActive ? theme.accent : (isExited ? theme.textTertiary : theme.textSecondary)}
              />
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 12,
                  fontWeight: isActive ? "600" : "400",
                  color: isActive ? theme.text : (isExited ? theme.textTertiary : theme.textSecondary),
                  maxWidth: 100,
                }}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
        {onAdd ? (
          <Pressable
            style={({ pressed }) => ({
              width: 28,
              height: 28,
              borderRadius: 7,
              borderCurve: "continuous" as const,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? "rgba(128,128,128,0.15)" : "transparent",
            })}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onAdd();
            }}
          >
            <AppSymbol name="plus" size={13} color={theme.textTertiary} />
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
});

function getSessionBanner(status: ConnectionStatus): { text: string; tone: "warn" | "error" } | null {
  switch (status) {
    case "reconnecting": return { text: "连接暂时中断，正在自动重连…", tone: "warn" };
    case "disconnected": return { text: "连接已断开。", tone: "error" };
    case "host_disconnected": return { text: "主机当前离线，恢复后会继续同步。", tone: "warn" };
    case "session_exited": return { text: "当前会话已结束。", tone: "error" };
    default: return null;
  }
}
