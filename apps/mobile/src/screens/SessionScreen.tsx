import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Animated,
  Clipboard,
  FlatList,
  Keyboard,
  KeyboardEvent,
  LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { MenuView } from "@react-native-menu/menu";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import { GlassBar } from "../components/GlassBar";
import { TerminalView } from "../components/TerminalView";
import type { TerminalViewHandle } from "../components/TerminalView";
import { ScreenView } from "../components/ScreenView";
import { BrowserView } from "../components/BrowserView";
import type { ConnectionStatus, TerminalStream } from "../hooks/useSession";
import type {
  AgentMessage,
  AgentPermissionMode,
  AgentReasoningEffort,
  AgentState,
  AgentToolCall,
  TerminalInfo,
} from "../hooks/useSessionManager";
import { useTheme } from "../theme";
import type { Theme } from "../theme";

import { useVoiceInput } from "../hooks/useVoiceInput";
import { HistorySheet } from "../components/HistorySheet";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";

const SHORTCUT_BAR_HEIGHT = 44;
const VOICE_BAR_HEIGHT = 40;

const SHORTCUTS = [
  { label: "⇧Tab", value: "\u001b[Z" },
  { label: "Ctrl+V", value: "\x10paste\x10" },
  { label: "Esc", value: "\u001b" },
  { label: "Tab", value: "\t" },
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
  screenStatus: {
    active: boolean;
    mode: "webrtc" | "fallback" | "off";
    error?: string;
  };
  screenFrame: {
    data: string;
    width: number;
    height: number;
    frameId: number;
  } | null;
  pendingOffer: { sdp: string } | null;
  pendingIceCandidates: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }[];
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
  onKillTerminal?: (terminalId: string) => void;
  onRemoveTerminal?: (terminalId: string) => void;
  // Tunnel browser
  gatewayUrl?: string;
  deviceToken?: string | null;
  authToken?: string | null;
  // Shell history
  historyEntries?: string[];
  onRequestHistory?: () => void;
  agent: AgentState;
  onInitializeAgent: () => void;
  onSendAgentPrompt: (
    text: string,
    options?: {
      model?: string;
      reasoningEffort?: AgentReasoningEffort;
      permissionMode?: AgentPermissionMode;
    },
  ) => void;
  onCancelAgent: () => void;
  onSendAgentPermissionResponse: (
    requestId: string,
    outcome: "allow" | "deny",
    optionId?: string,
  ) => void;
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
  onKillTerminal,
  onRemoveTerminal,
  gatewayUrl,
  deviceToken,
  authToken,
  historyEntries,
  onRequestHistory,
  agent,
  onInitializeAgent,
  onSendAgentPrompt,
  onCancelAgent,
  onSendAgentPermissionResponse,
}: SessionScreenProps) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { theme } = useTheme();
  const termRef = useRef<TerminalViewHandle>(null);
  const termRefsMap = useRef(
    new Map<string, React.RefObject<TerminalViewHandle | null>>(),
  );

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
  const activeTermRef = activeTerminalId
    ? termRefsMap.current.get(activeTerminalId)
    : null;
  if (activeTermRef) {
    (termRef as any).current = activeTermRef.current;
  }
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [keyboardHintVisible, setKeyboardHintVisible] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [activeTab, setActiveTab] = useState<
    "terminal" | "desktop" | "browser" | "agent"
  >("terminal");
  const [showTerminalGrid, setShowTerminalGrid] = useState(false);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);

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

  const switchToBrowser = useCallback(() => {
    setActiveTab("browser");
    Keyboard.dismiss();
    termRef.current?.blurCursor();
  }, []);

  const switchToAgent = useCallback(() => {
    setActiveTab("agent");
    Keyboard.dismiss();
    termRef.current?.blurCursor();
    onInitializeAgent();
  }, [onInitializeAgent]);

  const hasControl = controllerId === deviceId;
  const isControlledByOther = Boolean(
    controllerId && controllerId !== deviceId,
  );
  const inputDisabled =
    !hasControl ||
    status === "reconnecting" ||
    status === "session_exited" ||
    status === "disconnected" ||
    status === "host_disconnected";

  useEffect(() => {
    lastResizeRef.current = null;
  }, [sessionId]);

  const ctrlDRef = useRef<{
    count: number;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ count: 0, timer: null });

  const handleTerminalInput = useCallback(
    (data: string) => {
      // Ctrl+D safety: block if pressed more than 1 time within 2s
      if (data === "\u0004") {
        const cd = ctrlDRef.current;
        cd.count++;
        if (cd.timer) clearTimeout(cd.timer);
        cd.timer = setTimeout(() => {
          cd.count = 0;
        }, 2000);
        if (cd.count > 1) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          return;
        }
      }
      onSendInput(data);
    },
    [onSendInput],
  );

  const handlePickImage = useCallback(
    async (source: "library" | "camera") => {
      const picker =
        source === "camera"
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
    },
    [onSendImage],
  );

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

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      if (
        lastResizeRef.current &&
        lastResizeRef.current.cols === cols &&
        lastResizeRef.current.rows === rows
      ) {
        return;
      }
      lastResizeRef.current = { cols, rows };
      onSendResize(cols, rows);
    },
    [onSendResize],
  );

  const handleTerminalLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (
        event.nativeEvent.layout.height <= 0 ||
        event.nativeEvent.layout.width <= 0
      )
        return;
      requestAnimationFrame(() => {
        termRef.current?.refit(keyboardVisible);
      });
    },
    [keyboardVisible],
  );

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

      const nextInset =
        Platform.OS === "ios"
          ? Math.max(0, windowHeight - event.endCoordinates.screenY)
          : Math.max(
              0,
              windowHeight - event.endCoordinates.screenY,
              event.endCoordinates.height,
            );

      setKeyboardInset(nextInset);
    };

    const clearKeyboardFrame = (event?: KeyboardEvent) => {
      if (event && typeof Keyboard.scheduleLayoutAnimation === "function") {
        Keyboard.scheduleLayoutAnimation(event);
      }
      setKeyboardInset(0);
    };

    if (Platform.OS === "ios") {
      const frameSub = Keyboard.addListener(
        "keyboardWillChangeFrame",
        applyKeyboardFrame,
      );
      const hideSub = Keyboard.addListener(
        "keyboardWillHide",
        clearKeyboardFrame,
      );

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
    });
  }, [activeTab, keyboardVisible, keyboardInset]);

  // Refit when switching terminals
  useEffect(() => {
    if (!activeTerminalId) return;
    requestAnimationFrame(() => {
      termRef.current?.refit(false);
      termRef.current?.scrollToBottom();
    });
  }, [activeTerminalId]);

  const banner = getSessionBanner(status);
  const showReconnectButton =
    status === "disconnected" ||
    (status.startsWith("error:") && Boolean(sessionId));

  const isConnecting = status === "connecting" || status === "claiming";
  const isHostOffline = status === "host_disconnected";
  const isErrorState = status === "disconnected" || status.startsWith("error:");
  const showFullOverlay = isConnecting || isHostOffline || isErrorState;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bgTerminal }}>
      <View style={{ flex: 1, backgroundColor: theme.bgTerminal }}>
        <View
          style={{
            flex: 1,
            position: "relative",
            backgroundColor: theme.bgTerminal,
          }}
        >
          <View
            pointerEvents={activeTab === "terminal" ? "auto" : "none"}
            style={[
              StyleSheet.absoluteFillObject,
              { opacity: activeTab === "terminal" ? 1 : 0 },
            ]}
          >
            <TerminalStage
              bottomInset={stageBottomInset}
              headerPadding={insets.top}
              keyboardUp={keyboardVisible}
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
              historyEntries={historyEntries}
              onRequestHistory={onRequestHistory}
            />
          </View>

          <View
            pointerEvents={activeTab === "desktop" ? "auto" : "none"}
            style={[
              StyleSheet.absoluteFillObject,
              {
                bottom: stageBottomInset,
                opacity: activeTab === "desktop" ? 1 : 0,
              },
            ]}
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

          {gatewayUrl ? (
            <View
              pointerEvents={activeTab === "browser" ? "auto" : "none"}
              style={[
                StyleSheet.absoluteFillObject,
                browserFullscreen
                  ? { top: 0, bottom: 0 }
                  : { top: insets.top + 40, bottom: stageBottomInset },
                { opacity: activeTab === "browser" ? 1 : 0 },
              ]}
            >
              <BrowserView
                gatewayUrl={gatewayUrl}
                sessionId={sessionId}
                deviceToken={deviceToken ?? null}
                authToken={authToken ?? null}
                isFullscreen={browserFullscreen}
                onToggleFullscreen={() => setBrowserFullscreen((f) => !f)}
              />
            </View>
          ) : null}

          <View
            pointerEvents={activeTab === "agent" ? "auto" : "none"}
            style={[
              StyleSheet.absoluteFillObject,
              {
                top: insets.top + 40,
                bottom: stageBottomInset,
                opacity: activeTab === "agent" ? 1 : 0,
              },
            ]}
          >
            <AgentStage
              agent={agent}
              hasControl={hasControl}
              onInitialize={onInitializeAgent}
              onSendPrompt={onSendAgentPrompt}
              onCancel={onCancelAgent}
              onPermissionResponse={onSendAgentPermissionResponse}
              theme={theme}
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

      {/* Top overlay — floating elements over terminal content */}
      {!(activeTab === "browser" && browserFullscreen) && (
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 20, height: insets.top + 90 }} pointerEvents="box-none">
          <SessionHeader
            activeTab={activeTab}
            hasControl={hasControl}
            isControlledByOther={isControlledByOther}
            onClaimControl={onClaimControl}
            onLeave={handleLeave}
            onReleaseControl={onReleaseControl}
            onSwitchDesktop={switchToDesktop}
            onSwitchTerminal={switchToTerminal}
            onSwitchBrowser={switchToBrowser}
            onSwitchAgent={switchToAgent}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onZoomReset={handleZoomReset}
            sessionId={sessionId}
            status={status}
            theme={theme}
            zoomPercent={zoomPercent}
            insetTop={insets.top}
            terminalCount={
              terminalTabs?.filter((t) => t.status === "running").length ?? 0
            }
            activeTerminalLabel={
              terminalTabs?.find((t) => t.terminalId === activeTerminalId)
                ?.label
            }
            onShowTerminalGrid={() => {
              Keyboard.dismiss();
              setShowTerminalGrid(true);
            }}
          />

          {banner ? (
            <View
              style={{
                position: "absolute",
                top: insets.top + 48,
                left: 12,
                right: 12,
                borderRadius: 10,
                borderCurve: "continuous",
                overflow: "hidden",
                paddingHorizontal: 16,
                paddingVertical: 8,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                backgroundColor:
                  banner.tone === "error"
                    ? theme.errorLight
                    : theme.accentLight,
              }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: "500",
                  color: banner.tone === "error" ? theme.error : theme.accent,
                  flex: 1,
                }}
              >
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
                    backgroundColor: pressed
                      ? "rgba(128,128,128,0.2)"
                      : theme.bgCard,
                  })}
                  onPress={onReconnect}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: "600",
                      color: theme.accent,
                    }}
                  >
                    重试
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {connectionDetail && !banner ? (
            <View
              style={{
                position: "absolute",
                top: insets.top + 48,
                left: 12,
                right: 12,
                borderRadius: 10,
                borderCurve: "continuous",
                overflow: "hidden",
                paddingHorizontal: 16,
                paddingVertical: 4,
              }}
            >
              <Text style={{ fontSize: 11, color: theme.textTertiary }}>
                {connectionDetail}
              </Text>
            </View>
          ) : null}
        </View>
      )}

      {showTerminalGrid ? (
        <TerminalGridOverlay
          terminalTabs={terminalTabs ?? []}
          activeTerminalId={activeTerminalId}
          terminals={terminals}
          onSwitch={(tid) => {
            onSwitchTerminal?.(tid);
            setShowTerminalGrid(false);
          }}
          onAdd={() => {
            setShowTerminalGrid(false);
            onAddTerminal?.();
          }}
          onClose={() => setShowTerminalGrid(false)}
          onKillTerminal={onKillTerminal}
          onRemoveTerminal={onRemoveTerminal}
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
  isControlledByOther,
  onClaimControl,
  onLeave,
  onReleaseControl,
  onSwitchDesktop,
  onSwitchTerminal,
  onSwitchBrowser,
  onSwitchAgent,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  sessionId,
  status,
  theme,
  zoomPercent,
  insetTop,
  terminalCount,
  activeTerminalLabel,
  onShowTerminalGrid,
}: {
  activeTab: "terminal" | "desktop" | "browser" | "agent";
  hasControl: boolean;
  isControlledByOther: boolean;
  onClaimControl: () => void;
  onLeave: () => void;
  onReleaseControl: () => void;
  onSwitchDesktop: () => void;
  onSwitchTerminal: () => void;
  onSwitchBrowser: () => void;
  onSwitchAgent: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  sessionId: string;
  status: ConnectionStatus;
  theme: Theme;
  zoomPercent: number;
  insetTop?: number;
  terminalCount?: number;
  activeTerminalLabel?: string;
  onShowTerminalGrid?: () => void;
}) {
  // Extract folder name from activeTerminalLabel (last path segment)
  const folderName = activeTerminalLabel
    ? activeTerminalLabel.split("/").filter(Boolean).pop() ||
      activeTerminalLabel
    : sessionId.slice(0, 8);

  // Derive status display
  const statusConfig = (() => {
    if (status === "connected")
      return { color: "#4ade80", bg: "rgba(74,222,128,0.12)", text: "已连接" };
    if (
      status === "reconnecting" ||
      status === "connecting" ||
      status === "claiming"
    )
      return { color: "#facc15", bg: "rgba(250,204,21,0.12)", text: "连接中" };
    if (status === "host_disconnected")
      return {
        color: "#facc15",
        bg: "rgba(250,204,21,0.12)",
        text: "主机离线",
      };
    return { color: "#f87171", bg: "rgba(248,113,113,0.12)", text: "已断开" };
  })();

  const controlDisabled =
    status !== "connected" && status !== "host_disconnected";

  // Build menu actions
  const menuActions: any[] = [
    {
      id: "control",
      title: hasControl ? "释放控制权" : "获取控制权",
      image: Platform.select({
        ios: hasControl ? "hand.raised.fill" : "hand.raised",
      }),
      attributes: controlDisabled ? { disabled: true } : {},
      state: hasControl ? "on" : undefined,
    },
    {
      id: "zoom-reset",
      title: `重置缩放 (${zoomPercent}%)`,
      image: Platform.select({ ios: "arrow.counterclockwise" }),
    },
  ];

  // Tab switching — inline submenu to group (iOS only, Android gets flat list)
  const switchActions: any[] = [];
  if (activeTab !== "desktop") {
    switchActions.push({
      id: "switch-desktop",
      title: "远程桌面",
      image: Platform.select({ ios: "rectangle.on.rectangle" }),
    });
  }
  if (activeTab !== "browser") {
    switchActions.push({
      id: "switch-browser",
      title: "浏览器",
      image: Platform.select({ ios: "globe" }),
    });
  }
  if (activeTab !== "agent") {
    switchActions.push({
      id: "switch-agent",
      title: "Agent",
      image: Platform.select({ ios: "sparkles" }),
    });
  }
  if (activeTab !== "terminal") {
    switchActions.push({
      id: "switch-terminal",
      title: "终端",
      image: Platform.select({ ios: "terminal.fill" }),
    });
  }
  if (switchActions.length > 0) {
    if (Platform.OS === "ios") {
      menuActions.push({
        id: "switch-group",
        title: "",
        displayInline: true,
        subactions: switchActions,
      });
    } else {
      menuActions.push(...switchActions);
    }
  }

  if ((terminalCount ?? 0) > 0 && onShowTerminalGrid) {
    menuActions.push({
      id: "terminal-grid",
      title: `终端列表 (${terminalCount})`,
      image: Platform.select({ ios: "square.grid.2x2" }),
    });
  }

  if (Platform.OS === "ios") {
    menuActions.push({
      id: "disconnect-group",
      title: "",
      displayInline: true,
      subactions: [
        {
          id: "disconnect",
          title: "返回首页",
          image: Platform.select({ ios: "house.fill" }),
          attributes: { destructive: true },
        },
      ],
    });
  } else {
    menuActions.push({
      id: "disconnect",
      title: "返回首页",
      attributes: { destructive: true },
    });
  }

  return (
    <View
      style={{
        position: "absolute",
        top: (insetTop ?? 0) + 4,
        left: 12,
        right: 12,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
      pointerEvents="box-none"
    >
      {/* Left: status pill */}
      <GlassBar
        blurTint={
          theme.mode === "dark"
            ? "systemUltraThinMaterialDark"
            : "systemUltraThinMaterialLight"
        }
        fallbackColor={
          theme.mode === "light"
            ? "rgba(250,250,250,0.6)"
            : "rgba(42,42,43,0.55)"
        }
        style={{
          borderRadius: 14,
          borderCurve: "continuous",
          paddingHorizontal: 12,
          paddingVertical: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          flexShrink: 1,
        }}
      >
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: statusConfig.color,
          }}
        />
        <Text
          style={{
            fontSize: 15,
            fontWeight: "600",
            color: theme.text,
          }}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {folderName}
        </Text>
      </GlassBar>

      {/* Right: action buttons */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {/* Contextual mode toggle button — appears when not on terminal */}
        {activeTab !== "terminal" ? (
          <GlassBar
            blurTint={
              theme.mode === "dark"
                ? "systemUltraThinMaterialDark"
                : "systemUltraThinMaterialLight"
            }
            fallbackColor={
              theme.mode === "light"
                ? "rgba(250,250,250,0.6)"
                : "rgba(42,42,43,0.55)"
            }
            style={{
              borderRadius: 14,
              borderCurve: "continuous",
            }}
          >
            <Pressable
              onPress={onSwitchTerminal}
              hitSlop={6}
              style={({ pressed }) => ({
                width: 36,
                height: 36,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed
                  ? "rgba(128,128,128,0.2)"
                  : "transparent",
                borderRadius: 14,
              })}
            >
              <AppSymbol name="terminal.fill" size={16} color={theme.textSecondary} />
            </Pressable>
          </GlassBar>
        ) : null}

        {/* Zoom — only on terminal tab */}
        {activeTab === "terminal" ? (
          <GlassBar
            blurTint={
              theme.mode === "dark"
                ? "systemUltraThinMaterialDark"
                : "systemUltraThinMaterialLight"
            }
            fallbackColor={
              theme.mode === "light"
                ? "rgba(250,250,250,0.6)"
                : "rgba(42,42,43,0.55)"
            }
            style={{
              borderRadius: 14,
              borderCurve: "continuous",
            }}
          >
            <MenuView
              title=""
              onPressAction={({ nativeEvent }) => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                switch (nativeEvent.event) {
                  case "zoom-in":
                    onZoomIn();
                    break;
                  case "zoom-out":
                    onZoomOut();
                    break;
                  case "zoom-reset":
                    onZoomReset();
                    break;
                }
              }}
              actions={[
                {
                  id: "zoom-in",
                  title: "放大",
                  image: Platform.select({ ios: "plus.magnifyingglass" }),
                },
                {
                  id: "zoom-reset",
                  title: `重置 (${zoomPercent}%)`,
                  image: Platform.select({ ios: "arrow.counterclockwise" }),
                },
                {
                  id: "zoom-out",
                  title: "缩小",
                  image: Platform.select({ ios: "minus.magnifyingglass" }),
                },
              ]}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <AppSymbol name="magnifyingglass" size={16} color={theme.textSecondary} />
              </View>
            </MenuView>
          </GlassBar>
        ) : null}

        {/* Ellipsis menu — native UIMenu */}
        <GlassBar
          blurTint={
            theme.mode === "dark"
              ? "systemUltraThinMaterialDark"
              : "systemUltraThinMaterialLight"
          }
          fallbackColor={
            theme.mode === "light"
              ? "rgba(250,250,250,0.6)"
              : "rgba(42,42,43,0.55)"
          }
          style={{
            borderRadius: 14,
            borderCurve: "continuous",
          }}
        >
          <MenuView
            title=""
            onPressAction={({ nativeEvent }) => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              switch (nativeEvent.event) {
                case "control":
                  hasControl ? onReleaseControl() : onClaimControl();
                  break;
                case "zoom-in":
                  onZoomIn();
                  break;
                case "zoom-out":
                  onZoomOut();
                  break;
                case "zoom-reset":
                  onZoomReset();
                  break;
                case "switch-desktop":
                  onSwitchDesktop();
                  break;
                case "switch-browser":
                  onSwitchBrowser();
                  break;
                case "switch-agent":
                  onSwitchAgent();
                  break;
                case "switch-terminal":
                  onSwitchTerminal();
                  break;
                case "terminal-grid":
                  onShowTerminalGrid?.();
                  break;
                case "disconnect":
                  onLeave();
                  break;
              }
            }}
            actions={menuActions}
          >
            <View
              style={{
                width: 36,
                height: 36,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AppSymbol
                name="ellipsis.circle"
                size={20}
                color={theme.textSecondary}
              />
            </View>
          </MenuView>
        </GlassBar>
      </View>
    </View>
  );
});

const CANCEL_THRESHOLD = -80; // drag up 80pt to cancel

const AgentStage = memo(function AgentStage({
  agent,
  hasControl,
  onInitialize,
  onSendPrompt,
  onCancel,
  onPermissionResponse,
  theme,
}: {
  agent: AgentState;
  hasControl: boolean;
  onInitialize: () => void;
  onSendPrompt: (
    text: string,
    options?: {
      model?: string;
      reasoningEffort?: AgentReasoningEffort;
      permissionMode?: AgentPermissionMode;
    },
  ) => void;
  onCancel: () => void;
  onPermissionResponse: (
    requestId: string,
    outcome: "allow" | "deny",
    optionId?: string,
  ) => void;
  theme: Theme;
}) {
  const [text, setText] = useState("");
  const [model, setModel] = useState<string | undefined>();
  const [reasoningEffort, setReasoningEffort] = useState<AgentReasoningEffort | undefined>();
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>("default");
  const disabled = !hasControl || agent.status === "unavailable";
  const running = agent.status === "running" || agent.status === "waiting_permission";

  const send = useCallback(() => {
    const value = text.trim();
    if (!value || disabled) return;
    onSendPrompt(value, { model, reasoningEffort, permissionMode });
    setText("");
  }, [disabled, model, onSendPrompt, permissionMode, reasoningEffort, text]);

  useEffect(() => {
    if (!agent.capabilities) onInitialize();
  }, [agent.capabilities, onInitialize]);

  const messages = compactAgentMessages(agent.messages);
  const tools = agent.toolCalls.filter(
    (tool) => tool.input?.trim() || tool.output?.trim() || tool.name.trim(),
  );
  const statusMeta = agentStatusMeta(agent.status, theme);
  const hasAgentContent =
    messages.length > 0 ||
    tools.length > 0 ||
    agent.plan.length > 0 ||
    agent.pendingPermissions.length > 0;
  const modelLabel = formatAgentModel(model);
  const effortLabel = formatAgentEffort(reasoningEffort);
  const permissionMeta = permissionModeMeta(permissionMode, theme);
  const showPermissionPicker = useCallback(() => {
    if (!hasControl) {
      Alert.alert(
        "只读模式",
        "当前设备没有控制权，只能查看 Agent 输出。先获取控制权后才能发送消息或切换权限。",
      );
      return;
    }
    showAgentOptionSheet({
      title: "Agent 权限",
      options: AGENT_PERMISSION_OPTIONS,
      currentValue: permissionMode,
      onSelect: (value) => setPermissionMode(value ?? "default"),
    });
  }, [hasControl, permissionMode]);
  const showModelPicker = useCallback(() => {
    showAgentOptionSheet({
      title: "选择模型",
      options: AGENT_MODEL_OPTIONS,
      currentValue: model,
      onSelect: setModel,
    });
  }, [model]);
  const showEffortPicker = useCallback(() => {
    showAgentOptionSheet({
      title: "推理强度",
      options: AGENT_EFFORT_OPTIONS,
      currentValue: reasoningEffort,
      onSelect: setReasoningEffort,
    });
  }, [reasoningEffort]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: 16 }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: 16,
          gap: 10,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={{
            borderRadius: 12,
            borderCurve: "continuous",
            backgroundColor: theme.bgCard,
            padding: 12,
            gap: 10,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: agent.capabilities?.enabled
                  ? theme.accentLight
                  : theme.bgInput,
              }}
            >
              <AppSymbol
                name="sparkles"
                size={16}
                color={agent.capabilities?.enabled ? theme.accent : theme.textTertiary}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>
                Agent GUI
              </Text>
              <Text
                style={{ color: theme.textTertiary, fontSize: 12, marginTop: 2 }}
                numberOfLines={1}
              >
                {agent.capabilities?.enabled
                  ? `${agent.capabilities.provider ?? "agent"} · ACP GUI 已连接`
                  : "未连接"}
              </Text>
            </View>
            <View
              style={{
                borderRadius: 999,
                paddingHorizontal: 9,
                paddingVertical: 5,
                backgroundColor: statusMeta.bg,
              }}
            >
              <Text style={{ color: statusMeta.color, fontSize: 11, fontWeight: "700" }}>
                {statusMeta.label}
              </Text>
            </View>
          </View>
          {!agent.capabilities?.enabled ? (
            <Text selectable style={{ color: theme.textTertiary, fontSize: 13, lineHeight: 18 }}>
              {agent.error ||
                agent.capabilities?.error ||
                "当前 CLI 未启用 Agent GUI。使用 linkshell start --daemon --provider codex --agent-ui 启动。"}
            </Text>
          ) : null}
        </View>

        {agent.plan.length > 0 ? (
          <View
            style={{
              borderRadius: 12,
              borderCurve: "continuous",
              backgroundColor: theme.bgCard,
              padding: 12,
              gap: 10,
            }}
          >
            <Text style={{ color: theme.text, fontSize: 14, fontWeight: "700" }}>
              执行计划
            </Text>
            {agent.plan.map((step) => {
              const meta = planStepMeta(step.status, theme);
              return (
                <View
                  key={step.id}
                  style={{ flexDirection: "row", alignItems: "flex-start", gap: 9 }}
                >
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 11,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: meta.bg,
                      marginTop: 1,
                    }}
                  >
                    <AppSymbol name={meta.icon} size={12} color={meta.color} />
                  </View>
                  <Text
                    selectable
                    style={{
                      flex: 1,
                      color: step.status === "completed" ? theme.textTertiary : theme.text,
                      fontSize: 13,
                      lineHeight: 19,
                    }}
                  >
                    {step.text}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : null}

        {agent.pendingPermissions.map((permission) => (
          (() => {
            const denyOption =
              permission.options.find((option) => option.kind === "deny") ??
              permission.options.find((option) => option.id === "deny");
            const allowOption =
              permission.options.find((option) => option.kind === "allow") ??
              permission.options.find((option) => option.id === "allow");
            return (
              <View
                key={permission.requestId}
                style={{
                  borderRadius: 12,
                  borderCurve: "continuous",
                  backgroundColor: theme.accentLight,
                  padding: 12,
                  gap: 8,
                }}
              >
                <Text style={{ color: theme.warning, fontSize: 15, fontWeight: "700" }}>
                  需要授权{permission.toolName ? ` · ${permission.toolName}` : ""}
                </Text>
                {permission.context ? (
                  <Text selectable style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
                    {permission.context}
                  </Text>
                ) : null}
                {permission.toolInput ? (
                  <Text
                    selectable
                    style={{
                      color: theme.textTertiary,
                      fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
                      fontSize: 12,
                    }}
                    numberOfLines={4}
                  >
                    {permission.toolInput}
                  </Text>
                ) : null}
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable
                    onPress={() => onPermissionResponse(permission.requestId, "deny", denyOption?.id)}
                    style={({ pressed }) => ({
                      flex: 1,
                      borderRadius: 8,
                      paddingVertical: 10,
                      alignItems: "center",
                      backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                    })}
                  >
                    <Text style={{ color: theme.error, fontWeight: "600" }}>
                      {denyOption?.label ?? "拒绝"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => onPermissionResponse(permission.requestId, "allow", allowOption?.id)}
                    style={({ pressed }) => ({
                      flex: 1,
                      borderRadius: 8,
                      paddingVertical: 10,
                      alignItems: "center",
                      backgroundColor: pressed ? theme.accentSecondary : theme.accent,
                    })}
                  >
                    <Text style={{ color: "#fff", fontWeight: "600" }}>
                      {allowOption?.label ?? "允许"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          })()
        ))}

        {!hasAgentContent && agent.capabilities?.enabled ? (
          <View
            style={{
              borderRadius: 12,
              borderCurve: "continuous",
              backgroundColor: theme.bgCard,
              padding: 16,
              gap: 8,
              alignItems: "center",
            }}
          >
            <AppSymbol name="bubble.left.and.text.bubble.right" size={22} color={theme.accent} />
            <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>
              像聊天一样使用 Codex
            </Text>
            <Text style={{ color: theme.textTertiary, fontSize: 13, lineHeight: 18, textAlign: "center" }}>
              回复会在这里流式展示；命令、文件修改和 MCP 调用会自动整理成工具卡片。
            </Text>
          </View>
        ) : null}

        {messages.map((message) => (
          <View
            key={message.id}
            style={{
              alignSelf: message.role === "user" ? "flex-end" : "stretch",
              maxWidth: message.role === "user" ? "88%" : "100%",
              borderRadius: 12,
              borderCurve: "continuous",
              backgroundColor:
                message.role === "user"
                  ? theme.accent
                  : message.role === "system"
                    ? theme.accentLight
                    : theme.bgCard,
              paddingVertical: 10,
              paddingHorizontal: 12,
              gap: 6,
            }}
          >
            {message.role !== "user" ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <AppSymbol
                  name={message.role === "system" ? "info.circle" : "sparkles"}
                  size={13}
                  color={theme.textTertiary}
                />
                <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "700" }}>
                  {message.role === "system" ? "系统" : "Agent"}
                  {message.isStreaming ? " 正在输入" : ""}
                </Text>
              </View>
            ) : null}
            <Text
              selectable
              style={{
                color: message.role === "user" ? "#fff" : theme.text,
                fontSize: 14,
                lineHeight: 20,
              }}
            >
              {message.content}
            </Text>
          </View>
        ))}

        {tools.length > 0 ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
              工具活动
            </Text>
            {tools.map((tool) => (
              <AgentToolCard key={tool.id} tool={tool} theme={theme} />
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View
        style={{
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.separator,
          paddingHorizontal: 10,
          paddingTop: 8,
          paddingBottom: 10,
          backgroundColor: theme.bg,
        }}
      >
        <View
          style={{
            borderRadius: 18,
            borderCurve: "continuous",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.separator,
            backgroundColor: theme.bgCard,
            paddingHorizontal: 10,
            paddingTop: 8,
            paddingBottom: 8,
            gap: 8,
          }}
        >
          <TextInput
            value={text}
            onChangeText={setText}
            editable={!disabled}
            placeholder={hasControl ? "给 Agent 发送消息" : "先获取控制权后发送"}
            placeholderTextColor={theme.textTertiary}
            multiline
            style={{
              minHeight: 54,
              maxHeight: 132,
              paddingHorizontal: 4,
              paddingVertical: 4,
              color: theme.text,
              fontSize: 15,
              lineHeight: 21,
            }}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pressable
              onPress={showPermissionPicker}
              disabled={running && hasControl}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                borderRadius: 999,
                paddingHorizontal: 9,
                paddingVertical: 6,
                backgroundColor: pressed
                  ? theme.bgInput
                  : hasControl
                    ? permissionMeta.bg
                    : theme.bgInput,
                maxWidth: "42%",
                opacity: running && hasControl ? 0.55 : 1,
              })}
              accessibilityRole="button"
              accessibilityLabel="切换 Agent 权限"
            >
              <AppSymbol
                name={hasControl ? permissionMeta.icon : "eye.fill"}
                size={13}
                color={hasControl ? permissionMeta.color : theme.textTertiary}
              />
              <Text
                style={{
                  color: hasControl ? permissionMeta.color : theme.textTertiary,
                  fontSize: 12,
                  fontWeight: "700",
                }}
                numberOfLines={1}
              >
                {hasControl ? permissionMeta.label : "只读模式"}
              </Text>
              <AppSymbol name="chevron.down" size={10} color={hasControl ? permissionMeta.color : theme.textTertiary} />
            </Pressable>

            <View style={{ flex: 1 }} />

            {running ? (
              <ActivityIndicator size="small" color={theme.textTertiary} />
            ) : null}

            <Pressable
              onPress={showModelPicker}
              disabled={running}
              style={({ pressed }) => ({
                borderRadius: 999,
                paddingHorizontal: 9,
                paddingVertical: 6,
                backgroundColor: pressed ? theme.accentLight : theme.bgInput,
                maxWidth: 96,
                opacity: running ? 0.55 : 1,
              })}
              accessibilityRole="button"
              accessibilityLabel="切换 Agent 模型"
            >
              <Text
                style={{
                  color: theme.textSecondary,
                  fontSize: 12,
                  fontWeight: "700",
                }}
                numberOfLines={1}
              >
                {modelLabel}
              </Text>
            </Pressable>

            <Pressable
              onPress={showEffortPicker}
              disabled={running}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                borderRadius: 999,
                paddingHorizontal: 9,
                paddingVertical: 6,
                backgroundColor: pressed ? theme.accentLight : theme.bgInput,
                maxWidth: 82,
                opacity: running ? 0.55 : 1,
              })}
              accessibilityRole="button"
              accessibilityLabel="切换 Agent 推理强度"
            >
              <Text
                style={{
                  color: theme.textSecondary,
                  fontSize: 12,
                  fontWeight: "700",
                }}
                numberOfLines={1}
              >
                {effortLabel}
              </Text>
              <AppSymbol name="chevron.down" size={10} color={theme.textTertiary} />
            </Pressable>

            {running ? (
              <Pressable
                onPress={onCancel}
                style={({ pressed }) => ({
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? theme.errorLight : theme.bgInput,
                })}
                accessibilityRole="button"
                accessibilityLabel="停止 Agent"
              >
                <AppSymbol name="stop.circle.fill" size={20} color={theme.error} />
              </Pressable>
            ) : (
              <Pressable
                onPress={send}
                disabled={disabled || !text.trim()}
                style={({ pressed }) => ({
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? theme.accentSecondary : theme.accent,
                  opacity: disabled || !text.trim() ? 0.45 : 1,
                })}
                accessibilityRole="button"
                accessibilityLabel="发送给 Agent"
              >
                <AppSymbol name="arrow.up" size={18} color="#fff" />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </View>
  );
});

const AGENT_MODEL_OPTIONS: Array<{ label: string; value?: string }> = [
  { label: "默认模型", value: undefined },
  { label: "GPT-5.5", value: "gpt-5.5" },
  { label: "GPT-5.4", value: "gpt-5.4" },
  { label: "GPT-5.4 Mini", value: "gpt-5.4-mini" },
  { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
];

const AGENT_EFFORT_OPTIONS: Array<{ label: string; value?: AgentReasoningEffort }> = [
  { label: "默认强度", value: undefined },
  { label: "低", value: "low" },
  { label: "中", value: "medium" },
  { label: "高", value: "high" },
  { label: "超高", value: "xhigh" },
];

const AGENT_PERMISSION_OPTIONS: Array<{ label: string; value?: AgentPermissionMode }> = [
  { label: "默认权限", value: "default" },
  { label: "只读", value: "read_only" },
  { label: "工作区写入", value: "workspace_write" },
  { label: "完全访问", value: "full_access" },
];

function showAgentOptionSheet<T extends string>({
  title,
  options,
  currentValue,
  onSelect,
}: {
  title: string;
  options: Array<{ label: string; value?: T }>;
  currentValue?: T;
  onSelect: (value: T | undefined) => void;
}) {
  const labels = options.map((option) =>
    option.value === currentValue ? `${option.label} ✓` : option.label,
  );
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: ["取消", ...labels],
        cancelButtonIndex: 0,
      },
      (index) => {
        if (index <= 0) return;
        onSelect(options[index - 1]?.value);
      },
    );
    return;
  }
  Alert.alert(
    title,
    undefined,
    [
      { text: "取消", style: "cancel" },
      ...options.map((option, index) => ({
        text: labels[index],
        onPress: () => onSelect(option.value),
      })),
    ],
  );
}

function compactAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  const compacted: AgentMessage[] = [];
  for (const message of messages) {
    const content = message.content.trim();
    if (!content || isProtocolNoise(content)) continue;

    const previous = compacted[compacted.length - 1];
    const canMergeAssistantFragment =
      message.role === "assistant" &&
      previous?.role === "assistant" &&
      !previous.content.includes("\n\n") &&
      (message.isStreaming || previous.isStreaming || content.length <= 10);

    if (canMergeAssistantFragment) {
      compacted[compacted.length - 1] = {
        ...previous,
        content: `${previous.content}${content}`,
        isStreaming: previous.isStreaming || message.isStreaming,
      };
      continue;
    }

    compacted.push({ ...message, content });
  }
  return compacted;
}

function isProtocolNoise(content: string): boolean {
  if (!content.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const eventName = typeof parsed.eventName === "string" ? parsed.eventName : "";
    const method = typeof parsed.method === "string" ? parsed.method : "";
    return Boolean(
      parsed.threadId ||
        eventName === "sessionStart" ||
        method.startsWith("thread/") ||
        method.startsWith("turn/") ||
        method.startsWith("item/"),
    );
  } catch {
    return false;
  }
}

function agentStatusMeta(status: AgentState["status"], theme: Theme) {
  switch (status) {
    case "running":
      return { label: "运行中", color: theme.accent, bg: theme.accentLight };
    case "waiting_permission":
      return { label: "待授权", color: theme.warning, bg: theme.accentLight };
    case "error":
      return { label: "错误", color: theme.error, bg: theme.errorLight };
    case "idle":
      return { label: "空闲", color: theme.success, bg: theme.accentLight };
    case "unavailable":
    default:
      return { label: "不可用", color: theme.textTertiary, bg: theme.bgInput };
  }
}

function formatAgentModel(model?: string): string {
  if (!model) return "默认模型";
  const option = AGENT_MODEL_OPTIONS.find((item) => item.value === model);
  return option?.label ?? model;
}

function formatAgentEffort(effort?: AgentReasoningEffort): string {
  if (!effort) return "默认";
  if (effort === "xhigh") return "超高";
  if (effort === "high") return "高";
  if (effort === "medium") return "中";
  if (effort === "low") return "低";
  if (effort === "minimal") return "极低";
  return "无";
}

function permissionModeMeta(mode: AgentPermissionMode, theme: Theme) {
  switch (mode) {
    case "read_only":
      return {
        label: "只读",
        icon: "eye.fill",
        color: theme.textTertiary,
        bg: theme.bgInput,
      };
    case "workspace_write":
      return {
        label: "工作区写入",
        icon: "folder.fill",
        color: theme.accent,
        bg: theme.accentLight,
      };
    case "full_access":
      return {
        label: "完全访问",
        icon: "lock.open.fill",
        color: theme.warning,
        bg: theme.accentLight,
      };
    case "default":
    default:
      return {
        label: "默认权限",
        icon: "lock.shield.fill",
        color: theme.textSecondary,
        bg: theme.bgInput,
      };
  }
}

function planStepMeta(status: "pending" | "in_progress" | "completed", theme: Theme) {
  if (status === "completed") {
    return { icon: "checkmark.circle.fill", color: theme.success, bg: theme.accentLight };
  }
  if (status === "in_progress") {
    return { icon: "clock", color: theme.accent, bg: theme.accentLight };
  }
  return { icon: "circle", color: theme.textTertiary, bg: theme.bgInput };
}

function toolStatusMeta(status: AgentToolCall["status"], theme: Theme) {
  switch (status) {
    case "completed":
      return { label: "完成", icon: "checkmark.circle.fill", color: theme.success, bg: theme.accentLight };
    case "failed":
      return { label: "失败", icon: "xmark.circle.fill", color: theme.error, bg: theme.errorLight };
    case "pending":
      return { label: "等待", icon: "clock", color: theme.textTertiary, bg: theme.bgInput };
    case "running":
    default:
      return { label: "运行中", icon: "terminal.fill", color: theme.accent, bg: theme.accentLight };
  }
}

function toolIconName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("文件") || lower.includes("file")) return "doc.text";
  if (lower.includes("mcp")) return "server.rack";
  if (lower.includes("命令") || lower.includes("command") || lower.includes("shell")) {
    return "terminal.fill";
  }
  return "gearshape.fill";
}

function compactToolText(value: string | undefined, maxLength: number): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

const AgentToolCard = memo(function AgentToolCard({
  tool,
  theme,
}: {
  tool: AgentToolCall;
  theme: Theme;
}) {
  const status = toolStatusMeta(tool.status, theme);
  const input = compactToolText(tool.input, 900);
  const output = compactToolText(tool.output, 1200);

  return (
    <View
      style={{
        borderRadius: 12,
        borderCurve: "continuous",
        backgroundColor: theme.bgCard,
        padding: 12,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.bgInput,
          }}
        >
          <AppSymbol name={toolIconName(tool.name)} size={15} color={theme.accent} />
        </View>
        <Text
          selectable
          style={{ flex: 1, color: theme.text, fontSize: 14, fontWeight: "700" }}
          numberOfLines={1}
        >
          {tool.name}
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            borderRadius: 999,
            paddingHorizontal: 8,
            paddingVertical: 4,
            backgroundColor: status.bg,
          }}
        >
          <AppSymbol name={status.icon} size={11} color={status.color} />
          <Text style={{ color: status.color, fontSize: 11, fontWeight: "700" }}>
            {status.label}
          </Text>
        </View>
      </View>

      {input ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "700" }}>
            输入
          </Text>
          <Text
            selectable
            style={{
              color: theme.textSecondary,
              fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
              fontSize: 12,
              lineHeight: 17,
            }}
            numberOfLines={6}
          >
            {input}
          </Text>
        </View>
      ) : null}

      {output ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "700" }}>
            输出
          </Text>
          <Text
            selectable
            style={{
              color: theme.textSecondary,
              fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
              fontSize: 12,
              lineHeight: 17,
            }}
            numberOfLines={8}
          >
            {output}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const VoiceBar = memo(function VoiceBar({
  bottomInset,
  theme,
  onSend,
}: {
  bottomInset: number;
  theme: Theme;
  onSend: (text: string) => void;
}) {
  const { partialText, finalText, start, stop, cancel } = useVoiceInput();
  const [pressing, setPressing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editing, setEditing] = useState(false);
  const [inCancelZone, setInCancelZone] = useState(false);
  const [waitingForResult, setWaitingForResult] = useState(false);
  const localeRef = useRef<"en-US" | "zh-CN">("zh-CN");
  // Refs to access latest recognized text inside PanResponder closure
  const partialRef = useRef("");
  const finalRef = useRef("");
  const editTextRef = useRef("");
  const selectionRef = useRef(0); // cursor position

  useEffect(() => {
    partialRef.current = partialText;
  }, [partialText]);
  useEffect(() => {
    finalRef.current = finalText;
  }, [finalText]);

  // Handle delayed final result from stop() (Android speech recognition)
  useEffect(() => {
    if (!waitingForResult || !finalText.trim()) return;
    setWaitingForResult(false);
    const prev = editTextRef.current;
    const pos = selectionRef.current;
    const before = prev.slice(0, pos);
    const after = prev.slice(pos);
    const insert = finalText.trim();
    const combined =
      before +
      (before && !before.endsWith(" ") ? " " : "") +
      insert +
      (after && !after.startsWith(" ") ? " " : "") +
      after;
    const newPos = (
      before +
      (before && !before.endsWith(" ") ? " " : "") +
      insert
    ).length;
    updateEditText(combined);
    selectionRef.current = newPos;
    setEditing(true);
  }, [finalText, waitingForResult]);

  const updateEditText = (text: string) => {
    editTextRef.current = text;
    setEditText(text);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        setPressing(true);
        setInCancelZone(false);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        start(localeRef.current).catch(() => {});
      },
      onPanResponderMove: (_evt, gestureState) => {
        const inZone = gestureState.dy < CANCEL_THRESHOLD;
        setInCancelZone(inZone);
      },
      onPanResponderRelease: (_evt, gestureState) => {
        setPressing(false);
        setInCancelZone(false);
        if (gestureState.dy < CANCEL_THRESHOLD) {
          // Dragged into cancel zone — discard this round only
          cancel();
          setWaitingForResult(false);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        } else {
          // Capture whatever text we have right now
          const captured = finalRef.current || partialRef.current;
          if (captured.trim()) {
            // Already have text — use it immediately
            cancel();
            setWaitingForResult(false);
            const prev = editTextRef.current;
            const pos = selectionRef.current;
            const before = prev.slice(0, pos);
            const after = prev.slice(pos);
            const insert = captured.trim();
            const combined =
              before +
              (before && !before.endsWith(" ") ? " " : "") +
              insert +
              (after && !after.startsWith(" ") ? " " : "") +
              after;
            const newPos = (
              before +
              (before && !before.endsWith(" ") ? " " : "") +
              insert
            ).length;
            updateEditText(combined);
            selectionRef.current = newPos;
            setEditing(true);
          } else {
            // No text yet — stop() gracefully and wait for final result
            stop();
            setWaitingForResult(true);
          }
        }
      },
      onPanResponderTerminate: () => {
        setPressing(false);
        setInCancelZone(false);
        cancel();
      },
    }),
  ).current;

  const handleConfirm = () => {
    if (editText.trim()) {
      onSend(editText.trim());
    }
    setEditing(false);
    updateEditText("");
  };

  const handleCancel = () => {
    setEditing(false);
    updateEditText("");
    cancel();
  };

  const liveText = pressing ? partialText || "正在听..." : "";

  return (
    <>
      {/* Floating overlay — shown while pressing or editing */}
      {pressing || editing ? (
        <GlassBar
          blurTint={
            theme.mode === "dark"
              ? "systemThinMaterialDark"
              : "systemThinMaterialLight"
          }
          fallbackColor={theme.bgElevated}
          style={{
            position: "absolute",
            left: 12,
            right: 12,
            bottom: bottomInset + VOICE_BAR_HEIGHT + 8,
            borderRadius: 12,
            borderCurve: "continuous",
            padding: 12,
            boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
          }}
        >
          {editing ? (
            <>
              <TextInput
                style={{
                  fontSize: 17,
                  color: theme.text,
                  fontFamily: "Menlo",
                  minHeight: 60,
                  maxHeight: 120,
                  padding: 0,
                }}
                value={editText}
                onChangeText={updateEditText}
                onSelectionChange={(e) => {
                  selectionRef.current = e.nativeEvent.selection.end;
                }}
                multiline
                autoFocus
                placeholderTextColor={theme.textTertiary}
              />
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "flex-end",
                  gap: 8,
                  marginTop: 8,
                }}
              >
                <Pressable
                  style={({ pressed }) => ({
                    paddingHorizontal: 14,
                    paddingVertical: 6,
                    borderRadius: 8,
                    borderCurve: "continuous",
                    backgroundColor: pressed ? theme.bgCard : theme.bgTerminal,
                  })}
                  onPress={handleCancel}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: "600",
                      color: theme.textSecondary,
                    }}
                  >
                    取消
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => ({
                    paddingHorizontal: 14,
                    paddingVertical: 6,
                    borderRadius: 8,
                    borderCurve: "continuous",
                    backgroundColor: editText.trim()
                      ? pressed
                        ? theme.accentLight
                        : theme.accent
                      : theme.bgCard,
                  })}
                  onPress={handleConfirm}
                  disabled={!editText.trim()}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: "600",
                      color: editText.trim()
                        ? theme.textInverse
                        : theme.textTertiary,
                    }}
                  >
                    确认
                  </Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <View
                style={{
                  minHeight: 64,
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: theme.error,
                    }}
                  />
                  <Text
                    style={{
                      flex: 1,
                      fontSize: 15,
                      color: theme.text,
                      fontFamily: "Menlo",
                    }}
                    numberOfLines={3}
                  >
                    {liveText}
                  </Text>
                </View>
              </View>
              {/* Cancel hint */}
              <View style={{ alignItems: "center", marginTop: 8 }}>
                <Text
                  style={{
                    fontSize: 12,
                    color: inCancelZone ? theme.error : theme.textTertiary,
                    fontWeight: inCancelZone ? "600" : "400",
                  }}
                >
                  {inCancelZone ? "松开取消" : "↑ 上滑取消"}
                </Text>
              </View>
            </>
          )}
        </GlassBar>
      ) : null}

      {/* Bottom bar */}
      <View
        style={{
          position: "absolute",
          left: 12,
          right: 12,
          bottom: bottomInset + 2,
          height: VOICE_BAR_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 4,
          gap: 8,
        }}
      >
        <View
          style={{
            flex: 1,
            height: 30,
            borderRadius: 10,
            borderCurve: "continuous",
            backgroundColor: pressing
              ? inCancelZone
                ? theme.errorLight
                : theme.accent
              : "rgba(128,128,128,0.15)",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "row",
            gap: 6,
          }}
          {...(editing ? {} : panResponder.panHandlers)}
        >
          <AppSymbol
            name="mic.fill"
            size={14}
            color={pressing ? theme.textInverse : theme.textSecondary}
          />
          <Text
            style={{
              fontSize: 13,
              fontWeight: "500",
              color: pressing ? theme.textInverse : theme.textSecondary,
            }}
          >
            {pressing ? (inCancelZone ? "松开取消" : "松开结束") : "按住说话"}
          </Text>
        </View>
      </View>
    </>
  );
});
const TerminalStage = memo(function TerminalStage({
  bottomInset,
  headerPadding,
  keyboardUp,
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
  historyEntries,
  onRequestHistory,
}: {
  bottomInset: number;
  headerPadding?: number;
  keyboardUp: boolean;
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
  getTermRef?: (
    terminalId: string,
  ) => React.RefObject<TerminalViewHandle | null>;
  historyEntries?: string[];
  onRequestHistory?: () => void;
}) {
  const showShortcutBar = !inputDisabled;
  const showVoiceBar = !inputDisabled;
  const [ctrlActive, setCtrlActive] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrlActive;

  const handleInput = useCallback(
    async (data: string) => {
      if (data === "\x10paste\x10") {
        const text = await Clipboard.getString();
        if (text) onInput(text);
        return;
      }
      if (ctrlRef.current && data.length === 1) {
        const ch = data.toUpperCase();
        if (ch >= "A" && ch <= "Z") {
          onInput(String.fromCharCode(ch.charCodeAt(0) - 64));
          return;
        }
      }
      onInput(data);
    },
    [onInput],
  );

  const terminalPadding =
    bottomInset +
    (showShortcutBar ? SHORTCUT_BAR_HEIGHT : 0) +
    (showVoiceBar ? VOICE_BAR_HEIGHT : 0);

  // If we have multiple terminals, render each with its own TerminalView
  const hasMultipleTerminals = terminals && terminals.size > 0 && getTermRef;

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.bgTerminal,
      }}
      onLayout={onLayout}
    >
      {/* Top gradient fade overlay — terminal content fades into safe area */}
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: (headerPadding ?? 0) + 50,
          zIndex: 10,
        }}
        pointerEvents="none"
      >
        <LinearGradient
          colors={[theme.bgTerminal, theme.bgTerminal + "CC", theme.bgTerminal + "66", theme.bgTerminal + "00"]}
          locations={[0, 0.4, 0.7, 1]}
          style={StyleSheet.absoluteFillObject}
        />
      </View>
      <View
        style={{
          flex: 1,
          paddingBottom: terminalPadding,
        }}
      >
        {hasMultipleTerminals ? (
          Array.from(terminals.entries()).map(([tid, tInfo]) => {
            const isActive = tid === activeTerminalId;
            return (
              <View
                key={tid}
                style={
                  isActive
                    ? { flex: 1 }
                    : {
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        opacity: 0,
                      }
                }
                pointerEvents={isActive ? "auto" : "none"}
              >
                <TerminalView
                  ref={getTermRef(tid)}
                  stream={tInfo.terminalStream}
                  onInput={isActive ? handleInput : undefined}
                  onResize={isActive ? onResize : undefined}
                  onRequestKeyboard={isActive ? onRequestFocus : undefined}
                  topInset={headerPadding}
                />
              </View>
            );
          })
        ) : (
          <TerminalView
            ref={termRef}
            stream={stream}
            onInput={handleInput}
            onResize={onResize}
            onRequestKeyboard={onRequestFocus}
            topInset={headerPadding}
          />
        )}
      </View>
      {showShortcutBar ? (
        <View
          style={{
            position: "absolute",
            left: 12,
            right: 12,
            bottom: bottomInset + 4,
            height: SHORTCUT_BAR_HEIGHT,
            paddingVertical: 5,
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingHorizontal: 4,
          }}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={{
              alignItems: "center",
              gap: 4,
            }}
            style={{ flex: 1 }}
          >
            {/* Ctrl toggle */}
            <Pressable
              style={({ pressed }) => ({
                paddingHorizontal: 8,
                paddingVertical: 6,
                borderRadius: 8,
                borderCurve: "continuous" as const,
                backgroundColor: ctrlActive
                  ? theme.accent
                  : pressed
                    ? "rgba(128,128,128,0.2)"
                    : "transparent",
              })}
              onPress={() => setCtrlActive((v) => !v)}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: "700",
                  color: ctrlActive ? theme.textInverse : theme.text,
                }}
              >
                Ctrl
              </Text>
            </Pressable>
            {SHORTCUTS.map((item) => (
              <Pressable
                key={item.label}
                style={({ pressed }) => ({
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  borderRadius: 8,
                  borderCurve: "continuous" as const,
                  backgroundColor: pressed
                    ? "rgba(128,128,128,0.2)"
                    : "transparent",
                })}
                onPress={() => handleInput(item.value)}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: "600",
                    color: theme.text,
                  }}
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          {/* Image picker */}
          <Pressable
            style={({ pressed }) => ({
              width: 34,
              height: 26,
              borderRadius: 8,
              borderCurve: "continuous" as const,
              backgroundColor: pressed
                ? "rgba(128,128,128,0.2)"
                : "transparent",
              alignItems: "center",
              justifyContent: "center",
            })}
            onPress={onImagePicker}
          >
            <AppSymbol name="photo" size={17} color={theme.text} />
          </Pressable>
          {/* Keyboard toggle */}
          <Pressable
            style={({ pressed }) => ({
              width: 34,
              height: 26,
              borderRadius: 8,
              borderCurve: "continuous" as const,
              backgroundColor: pressed
                ? "rgba(128,128,128,0.2)"
                : "transparent",
              alignItems: "center",
              justifyContent: "center",
            })}
            onPress={() => {
              if (keyboardUp) {
                Keyboard.dismiss();
                termRef.current?.blurCursor();
              } else {
                onRequestFocus();
              }
            }}
          >
            <AppSymbol
              name={keyboardUp ? "keyboard.chevron.compact.down" : "keyboard"}
              size={17}
              color={theme.text}
            />
          </Pressable>
        </View>
      ) : null}
      {showVoiceBar ? (
        <VoiceBar
          bottomInset={
            bottomInset + (showShortcutBar ? SHORTCUT_BAR_HEIGHT : 0)
          }
          theme={theme}
          onSend={(text) => handleInput(text + "\r")}
        />
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
  screenFrame: {
    data: string;
    width: number;
    height: number;
    frameId: number;
  } | null;
  pendingOffer: { sdp: string } | null;
  pendingIceCandidates: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }[];
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
    <View
      style={{
        ...StyleSheet.absoluteFillObject,
        bottom: bottomInset,
        backgroundColor:
          theme.mode === "dark"
            ? "rgba(14,14,15,0.92)"
            : "rgba(255,255,255,0.92)",
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 40,
        gap: 16,
      }}
    >
      {isConnecting ? (
        <>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text
            style={{
              fontSize: 17,
              fontWeight: "600",
              color: theme.text,
              textAlign: "center",
            }}
          >
            {status === "claiming" ? "正在配对…" : "正在连接…"}
          </Text>
          <Text
            style={{
              fontSize: 14,
              color: theme.textTertiary,
              textAlign: "center",
            }}
          >
            {connectionDetail ?? "正在建立与主机的连接"}
          </Text>
          <Pressable
            style={({ pressed }) => ({
              marginTop: 8,
              paddingHorizontal: 20,
              paddingVertical: 10,
              borderRadius: 10,
              borderCurve: "continuous" as const,
              backgroundColor: pressed
                ? "rgba(255,59,48,0.2)"
                : "rgba(255,59,48,0.12)",
            })}
            onPress={onLeave}
          >
            <Text
              style={{ fontSize: 15, fontWeight: "600", color: theme.error }}
            >
              取消
            </Text>
          </Pressable>
        </>
      ) : isHostOffline ? (
        <>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: "rgba(251,191,36,0.15)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <AppSymbol name="wifi.slash" size={26} color="#fbbf24" />
          </View>
          <Text
            style={{
              fontSize: 17,
              fontWeight: "600",
              color: theme.text,
              textAlign: "center",
            }}
          >
            主机离线
          </Text>
          <Text
            style={{
              fontSize: 14,
              color: theme.textTertiary,
              textAlign: "center",
              lineHeight: 20,
            }}
          >
            主机当前不可用，可以等待主机恢复后重试，{"\n"}或退出返回会话列表。
          </Text>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 4 }}>
            <Pressable
              style={({ pressed }) => ({
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 10,
                borderCurve: "continuous" as const,
                backgroundColor: pressed
                  ? "rgba(255,59,48,0.2)"
                  : "rgba(255,59,48,0.12)",
              })}
              onPress={onLeave}
            >
              <Text
                style={{ fontSize: 15, fontWeight: "600", color: theme.error }}
              >
                退出
              </Text>
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
              <Text
                style={{ fontSize: 15, fontWeight: "600", color: theme.accent }}
              >
                重试
              </Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: "rgba(239,68,68,0.12)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <AppSymbol
              name="exclamationmark.triangle.fill"
              size={26}
              color={theme.error}
            />
          </View>
          <Text
            style={{
              fontSize: 17,
              fontWeight: "600",
              color: theme.text,
              textAlign: "center",
            }}
          >
            连接失败
          </Text>
          <Text
            style={{
              fontSize: 14,
              color: theme.textTertiary,
              textAlign: "center",
              lineHeight: 20,
            }}
          >
            {connectionDetail ?? "无法连接到主机"}
          </Text>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 4 }}>
            <Pressable
              style={({ pressed }) => ({
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 10,
                borderCurve: "continuous" as const,
                backgroundColor: pressed
                  ? "rgba(255,59,48,0.2)"
                  : "rgba(255,59,48,0.12)",
              })}
              onPress={onLeave}
            >
              <Text
                style={{ fontSize: 15, fontWeight: "600", color: theme.error }}
              >
                退出
              </Text>
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
              <Text
                style={{ fontSize: 15, fontWeight: "600", color: theme.accent }}
              >
                重试
              </Text>
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
    if (
      status === "connecting" ||
      status === "claiming" ||
      status === "reconnecting"
    )
      return "#fbbf24";
    return "#ef4444";
  };

  return (
    <GlassBar
      blurTint={
        theme.mode === "dark"
          ? "systemThinMaterialDark"
          : "systemThinMaterialLight"
      }
      fallbackColor={theme.mode === "light" ? "#fafafa" : theme.bgElevated}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 8,
          gap: 2,
          alignItems: "center",
        }}
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
                  ? theme.mode === "light"
                    ? "rgba(0,0,0,0.06)"
                    : "rgba(255,255,255,0.08)"
                  : pressed
                    ? "rgba(128,128,128,0.1)"
                    : "transparent",
              })}
              onPress={() => onSwitch?.(tab.sessionId)}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: statusDot(tab.status),
                }}
              />
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
                    backgroundColor: pressed
                      ? "rgba(128,128,128,0.3)"
                      : "transparent",
                  })}
                >
                  <Text
                    style={{
                      fontSize: 10,
                      fontWeight: "700",
                      color: theme.textTertiary,
                      lineHeight: 12,
                    }}
                  >
                    ✕
                  </Text>
                </Pressable>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </GlassBar>
  );
});

const TerminalGridOverlay = memo(function TerminalGridOverlay({
  terminalTabs,
  activeTerminalId,
  terminals,
  onSwitch,
  onAdd,
  onClose,
  onKillTerminal,
  onRemoveTerminal,
  theme,
  insetTop,
}: {
  terminalTabs: TerminalTab[];
  activeTerminalId?: string | null;
  terminals?: Map<string, TerminalInfo>;
  onSwitch: (terminalId: string) => void;
  onAdd: () => void;
  onClose: () => void;
  onKillTerminal?: (terminalId: string) => void;
  onRemoveTerminal?: (terminalId: string) => void;
  theme: Theme;
  insetTop: number;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.92)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1,
        tension: 80,
        friction: 12,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  const handleClose = useCallback(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: 0.92,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => onClose());
  }, [onClose, opacity, scale]);

  const handleSwitch = useCallback(
    (tid: string) => {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1.05,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start(() => onSwitch(tid));
    },
    [onSwitch, opacity, scale],
  );

  const handleKillTerminal = useCallback(
    (tid: string, isRunning: boolean) => {
      if (isRunning) {
        Alert.alert("关闭终端", "确定关闭此终端？进程将被终止。", [
          { text: "取消", style: "cancel" },
          {
            text: "关闭",
            style: "destructive",
            onPress: () => onKillTerminal?.(tid),
          },
        ]);
      } else {
        onRemoveTerminal?.(tid);
      }
    },
    [onKillTerminal, onRemoveTerminal],
  );

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { zIndex: 100, opacity }]}>
      <Pressable
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor:
              theme.mode === "dark"
                ? "rgba(0,0,0,0.92)"
                : "rgba(245,245,247,0.95)",
          },
        ]}
        onPress={handleClose}
      />
      <Animated.View
        style={{ flex: 1, transform: [{ scale }] }}
        pointerEvents="box-none"
      >
        <View
          style={{
            paddingTop: insetTop + 8,
            paddingHorizontal: 16,
            paddingBottom: 12,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={{ color: theme.text, fontSize: 18, fontWeight: "700" }}>
            终端
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Pressable onPress={onAdd} hitSlop={8}>
              <AppSymbol name="plus" size={20} color={theme.accent} />
            </Pressable>
            <Pressable onPress={handleClose} hitSlop={8}>
              <Text
                style={{ color: theme.accent, fontSize: 15, fontWeight: "500" }}
              >
                完成
              </Text>
            </Pressable>
          </View>
        </View>

        <FlatList
          data={terminalTabs.filter((t) => t.status === "running")}
          numColumns={2}
          keyExtractor={(item) => item.terminalId}
          contentContainerStyle={{
            paddingHorizontal: 12,
            paddingBottom: 40,
            flexGrow: 1,
          }}
          columnWrapperStyle={{ gap: 10, marginBottom: 10 }}
          ListFooterComponent={
            <Pressable style={{ flex: 1 }} onPress={handleClose} />
          }
          renderItem={({ item }) => {
            const isActive = item.terminalId === activeTerminalId;
            const tInfo = terminals?.get(item.terminalId);
            const isRunning = item.status === "running";
            return (
              <Pressable
                onPress={() => handleSwitch(item.terminalId)}
                style={({ pressed }) => ({
                  flex: 1,
                  borderRadius: 14,
                  borderCurve: "continuous" as const,
                  overflow: "hidden",
                  borderWidth: isActive ? 2 : 0,
                  borderColor: isActive ? theme.accent : "transparent",
                  backgroundColor: pressed
                    ? theme.mode === "light"
                      ? "rgba(0,0,0,0.08)"
                      : "rgba(255,255,255,0.08)"
                    : theme.mode === "light"
                      ? "rgba(0,0,0,0.04)"
                      : "rgba(255,255,255,0.04)",
                })}
              >
                <View
                  style={{
                    height: 120,
                    backgroundColor: theme.bgTerminal,
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <AppSymbol
                    name="terminal.fill"
                    size={32}
                    color={isRunning ? theme.accent : theme.textTertiary}
                  />
                  {/* Close button */}
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      handleKillTerminal(item.terminalId, isRunning);
                    }}
                    hitSlop={6}
                    style={({ pressed }) => ({
                      position: "absolute",
                      top: 6,
                      right: 6,
                      width: 22,
                      height: 22,
                      borderRadius: 11,
                      backgroundColor: pressed
                        ? theme.mode === "light"
                          ? "rgba(0,0,0,0.15)"
                          : "rgba(255,255,255,0.2)"
                        : theme.mode === "light"
                          ? "rgba(0,0,0,0.08)"
                          : "rgba(255,255,255,0.1)",
                      alignItems: "center",
                      justifyContent: "center",
                    })}
                  >
                    <AppSymbol
                      name="xmark"
                      size={10}
                      color={theme.textTertiary}
                    />
                  </Pressable>
                </View>
                <View
                  style={{ paddingHorizontal: 10, paddingVertical: 8, gap: 2 }}
                >
                  <Text
                    style={{
                      color: theme.text,
                      fontSize: 13,
                      fontWeight: "600",
                    }}
                    numberOfLines={1}
                  >
                    {item.label}
                  </Text>
                  {tInfo?.cwd ? (
                    <Text
                      style={{ color: theme.textTertiary, fontSize: 10 }}
                      numberOfLines={1}
                    >
                      {tInfo.cwd}
                    </Text>
                  ) : null}
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                      marginTop: 2,
                    }}
                  >
                    <View
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: 3,
                        backgroundColor: isRunning ? "#4ade80" : "#6b7280",
                      }}
                    />
                    <Text
                      style={{
                        fontSize: 9,
                        color: isRunning ? "#4ade80" : "#6b7280",
                        fontWeight: "500",
                      }}
                    >
                      {isRunning ? "运行中" : "已退出"}
                    </Text>
                  </View>
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <Pressable
              style={{ alignItems: "center", paddingTop: 60, flex: 1 }}
              onPress={handleClose}
            >
              <Text style={{ color: theme.textTertiary, fontSize: 14 }}>
                暂无终端
              </Text>
            </Pressable>
          }
        />
      </Animated.View>
    </Animated.View>
  );
});

function getSessionBanner(
  status: ConnectionStatus,
): { text: string; tone: "warn" | "error" } | null {
  switch (status) {
    case "reconnecting":
      return { text: "连接暂时中断，正在自动重连…", tone: "warn" };
    case "disconnected":
      return { text: "连接已断开。", tone: "error" };
    case "host_disconnected":
      return { text: "主机当前离线，恢复后会继续同步。", tone: "warn" };
    case "session_exited":
      return { text: "当前会话已结束。", tone: "error" };
    default:
      return null;
  }
}
