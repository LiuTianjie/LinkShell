import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  type KeyboardEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { LegendList, type LegendListRef, type LegendListRenderItemProps } from "@legendapp/list";
import { MenuView } from "@react-native-menu/menu";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppSymbol } from "../../components/AppSymbol";
import { GlassBar } from "../../components/GlassBar";
import { useTheme } from "../../theme";
import type { AgentWorkspaceHandle } from "./types";
import {
  MONO_FONT,
  displayProvider,
  formatModel,
  shortPath,
  visibleConversationStatus,
} from "./lib/format";
import { modelOptionsFor, providerCapabilityFor } from "./lib/capabilities";
import {
  type TimelineListItem,
  dedupeTimelineItems,
  isQueuedFollowUpItem,
  isQueuedFollowUpPlaceholder,
  isTimelineBottomSpacer,
} from "./lib/timeline";
import { TimelineItemView } from "./components/TimelineItemView";
import { AgentConversationSkeleton, TimelineSeparator } from "./components/message-cards";
import { FilePreviewDrawer } from "./components/panels";
import { Composer, type ComposerHandle } from "./components/Composer";

export interface AgentConversationScreenProps {
  conversationId: string;
  workspace: AgentWorkspaceHandle;
  isRestoring?: boolean;
  onBack: () => void;
}

/**
 * Top-level orchestrator for the agent console. Keeps the heavy chat surface —
 * the virtualized timeline — and delegates the entire input surface (draft,
 * model/effort/permission pickers, slash/@ palettes, dictation, attachments,
 * rename) to {@link Composer}.
 *
 * Performance contract (see the diagnosed root-cause fixes):
 * - The timeline is derived from the reactive `workspace.timelineById` Map so a
 *   streamed-token commit renders the freshly committed array on the same pass
 *   (no one-render lag from a post-commit ref read).
 * - `renderTimelineItem` and the handlers it passes to the memoized
 *   `TimelineItemView` are referentially stable, so a token patch only
 *   re-renders the single patched row, not every mounted row.
 * - Sticky-bottom is owned solely by LegendList's `maintainScrollAtEnd`; the
 *   only programmatic scrolls are the single calls from "send" / "jump to
 *   bottom". History prepends are anchored by `maintainVisibleContentPosition`.
 */
export function AgentConversationScreen({
  conversationId,
  workspace,
  isRestoring = false,
  onBack,
}: AgentConversationScreenProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  // Reactive conversation + timeline: derive from committed state, never from
  // the post-commit refs (which trail the current render by one commit).
  const conversation = useMemo(
    () =>
      workspace.conversations.find((item) => item.id === conversationId) ??
      workspace.archivedConversations.find((item) => item.id === conversationId) ??
      workspace.getConversation(conversationId),
    [workspace.conversations, workspace.archivedConversations, conversationId, workspace],
  );
  const timeline = useMemo(
    () => workspace.timelineById.get(conversationId) ?? [],
    [workspace.timelineById, conversationId],
  );

  const dedupedTimeline = useMemo(() => dedupeTimelineItems(timeline), [timeline]);
  const queuedFollowUps = useMemo(
    () => dedupedTimeline.filter((item) => isQueuedFollowUpItem(item, conversation?.status)),
    [conversation?.status, dedupedTimeline],
  );
  const visibleTimeline = useMemo(
    () => dedupedTimeline.filter((item) => !isQueuedFollowUpPlaceholder(item)),
    [dedupedTimeline],
  );
  // Mirror into a ref so renderTimelineItem can read neighbor items (for the
  // new-turn divider) without depending on `visibleTimeline` — otherwise the
  // renderer's identity changes on every streamed token and defeats row memo.
  const visibleTimelineRef = useRef(visibleTimeline);
  visibleTimelineRef.current = visibleTimeline;

  // Mirror the workspace handle so the stable handlers below can reach the
  // latest functions without listing `workspace` (a new object each render)
  // as a dependency.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const timelineRef = useRef<LegendListRef>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const timelineNearBottomRef = useRef(true);
  const [isTimelineNearBottom, setIsTimelineNearBottom] = useState(true);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const [bottomComposerHeight, setBottomComposerHeight] = useState(0);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false);

  const capabilities = conversation
    ? workspace.capabilitiesBySessionId.get(conversation.sessionId)
    : undefined;
  const providerCapability = conversation
    ? providerCapabilityFor(conversation.provider, capabilities)
    : undefined;
  const turnRunning = conversation?.status === "running";
  const waitingPermission = conversation?.status === "waiting_permission";
  const running = turnRunning || waitingPermission;
  const meta = visibleConversationStatus(conversation?.status, theme);
  const modelOpts = useMemo(
    () => modelOptionsFor(conversation?.provider ?? "codex", capabilities),
    [capabilities, conversation?.provider],
  );

  // The composer floats above the list and tracks the keyboard via its own
  // bottom offset; the list's bottom spacer is sized from the composer height +
  // safe area only (a stable value), so keyboard frames don't mutate the list
  // `data` and fight maintainScrollAtEnd.
  const composerBottomOffset = Platform.OS === "ios" ? Math.max(0, keyboardInset - insets.bottom) : 0;
  const timelineBottomInset = Math.max(bottomComposerHeight, Math.max(insets.bottom + 116, 132));

  const timelineListData = useMemo<TimelineListItem[]>(
    () =>
      visibleTimeline.length === 0
        ? []
        : [
            ...visibleTimeline,
            {
              id: "__timeline-bottom-spacer",
              type: "bottom_spacer",
              spacerHeight: timelineBottomInset + 18,
            },
          ],
    [timelineBottomInset, visibleTimeline],
  );
  // Read the current list length imperatively so scrollTimelineToBottom can stay
  // referentially stable (it's handed to the composer as `onAfterSend`).
  const timelineDataLengthRef = useRef(timelineListData.length);
  timelineDataLengthRef.current = timelineListData.length;

  // Consolidated keyboard inset tracking. A single show/hide listener pair
  // updates the offset the composer uses to clear the keyboard; the list itself
  // sticks to the bottom via maintainScrollAtEnd, so it needs no per-frame work.
  useEffect(() => {
    const applyKeyboardFrame = (event: KeyboardEvent) => {
      if (typeof Keyboard.scheduleLayoutAnimation === "function") {
        Keyboard.scheduleLayoutAnimation(event);
      }
      const nextInset =
        Platform.OS === "ios"
          ? Math.max(0, windowHeight - event.endCoordinates.screenY)
          : Math.max(0, windowHeight - event.endCoordinates.screenY, event.endCoordinates.height);
      setKeyboardInset((current) => (Math.abs(current - nextInset) > 4 ? nextInset : current));
    };
    const clearKeyboardFrame = (event?: KeyboardEvent) => {
      if (event && typeof Keyboard.scheduleLayoutAnimation === "function") {
        Keyboard.scheduleLayoutAnimation(event);
      }
      setKeyboardInset((current) => (current === 0 ? current : 0));
    };

    if (Platform.OS === "ios") {
      const showSub = Keyboard.addListener("keyboardWillShow", applyKeyboardFrame);
      const hideSub = Keyboard.addListener("keyboardWillHide", clearKeyboardFrame);
      return () => {
        showSub.remove();
        hideSub.remove();
      };
    }
    const showSub = Keyboard.addListener("keyboardDidShow", applyKeyboardFrame);
    const hideSub = Keyboard.addListener("keyboardDidHide", clearKeyboardFrame);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [windowHeight]);

  // markRead only on focus (mount / conversation change) and when the host
  // records a new response — never on every streamed item, which would write
  // conversation state and re-render the host on each token.
  useEffect(() => {
    if (conversation) workspace.markRead(conversation.id);
  }, [conversation?.id, conversation?.lastResponseAt, workspace.markRead]);
  useEffect(
    () => () => {
      if (conversationId) workspaceRef.current.markRead(conversationId);
    },
    [conversationId],
  );

  // Notices for this conversation (passed to the composer, which owns the
  // strip + auto-dismiss timers).
  const visibleNotices = useMemo(
    () =>
      workspace.notices.filter(
        (notice) => !notice.conversationId || notice.conversationId === conversationId,
      ),
    [conversationId, workspace.notices],
  );

  // Plan mode: once a planning turn finishes (plan mode on, idle, last item is
  // the agent's), the composer surfaces a one-tap "execute" affordance.
  const currentCollaborationMode =
    conversation?.collaborationMode ?? providerCapability?.currentMode ?? "default";
  const planReady = useMemo(() => {
    if (currentCollaborationMode !== "plan") return false;
    if (running) return false;
    const last = visibleTimeline[visibleTimeline.length - 1];
    return Boolean(last) && last.role !== "user";
  }, [currentCollaborationMode, running, visibleTimeline]);

  // Single scroll driver. maintainScrollAtEnd keeps the list pinned during
  // streaming; this is the only programmatic scroll — one call, no rAF/timeout
  // cascade and no MAX_SAFE_INTEGER overscroll.
  const scrollTimelineToBottom = useCallback((animated = true) => {
    const ref = timelineRef.current;
    if (!ref) return;
    const lastIndex = timelineDataLengthRef.current - 1;
    if (lastIndex >= 0) {
      try {
        ref.scrollToIndex({ index: lastIndex, animated, viewPosition: 1 });
      } catch {
        ref.scrollToEnd({ animated });
      }
    } else {
      ref.scrollToEnd({ animated });
    }
    timelineNearBottomRef.current = true;
    setIsTimelineNearBottom(true);
    setHasNewOutput(false);
  }, []);

  const handleTimelineScroll = useCallback(
    (event: any) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
      const nearBottom = distanceFromBottom < 96;
      timelineNearBottomRef.current = nearBottom;
      setIsTimelineNearBottom(nearBottom);
      if (nearBottom) setHasNewOutput(false);
      // Scrolled near the top → page in older history (matches web's scroll-up).
      if (contentOffset.y < 120 && contentSize.height > layoutMeasurement.height) {
        workspaceRef.current.loadOlderHistory(conversationId);
      }
    },
    [conversationId],
  );

  // "New output while scrolled up" affordance, driven by a lightweight length
  // comparison rather than hashing every item's text/output each render.
  const prevTimelineLengthRef = useRef(visibleTimeline.length);
  useEffect(() => {
    if (visibleTimeline.length > prevTimelineLengthRef.current && !timelineNearBottomRef.current) {
      setHasNewOutput(true);
    }
    prevTimelineLengthRef.current = visibleTimeline.length;
  }, [visibleTimeline.length]);

  // Stable handlers passed to the memoized rows. Each closes over the workspace
  // ref (latest functions) and only depends on conversationId, so a token patch
  // never changes their identity and React.memo can short-circuit every row but
  // the one whose item reference actually changed.
  const handlePermission = useCallback(
    (requestId: string, outcome: "allow" | "deny" | "cancelled", optionId?: string) =>
      workspaceRef.current.respondPermission(conversationId, requestId, outcome, optionId),
    [conversationId],
  );
  const handleStructuredInput = useCallback(
    (requestId: string, answers: Record<string, string[]>) =>
      workspaceRef.current.respondStructuredInput(conversationId, requestId, answers),
    [conversationId],
  );
  const handleEditMessage = useCallback((value: string) => {
    composerRef.current?.setDraft(value);
  }, []);

  const renderTimelineItem = useCallback(
    ({ item, index }: LegendListRenderItemProps<TimelineListItem>) => {
      if (isTimelineBottomSpacer(item)) {
        return <View style={{ height: item.spacerHeight }} />;
      }
      const previous = visibleTimelineRef.current[index - 1];
      const startsTurn = Boolean(item.turnId && previous?.turnId && item.turnId !== previous.turnId);
      return (
        <View style={{ gap: 12 }}>
          {startsTurn ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
              <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.separator }} />
              <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>新一轮</Text>
              <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.separator }} />
            </View>
          ) : null}
          <TimelineItemView
            item={item}
            theme={theme}
            onPermission={handlePermission}
            onStructuredInput={handleStructuredInput}
            onEditMessage={handleEditMessage}
          />
        </View>
      );
    },
    [theme, handlePermission, handleStructuredInput, handleEditMessage],
  );

  const timelineEmpty = useMemo(() => {
    if (isRestoring) return <AgentConversationSkeleton theme={theme} />;
    return (
      <View style={{ paddingVertical: 36, alignItems: "center", gap: 9 }}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.accentLight,
          }}
        >
          <AppSymbol name="sparkles" size={22} color={theme.accent} />
        </View>
        <Text style={{ color: theme.text, fontSize: 16, fontWeight: "800" }}>开始一个 Agent 对话</Text>
        <Text style={{ color: theme.textTertiary, fontSize: 13, lineHeight: 18, textAlign: "center" }}>
          发送 prompt 后，回复、代码、工具调用和权限请求都会在这里按时间线展示。
        </Text>
      </View>
    );
  }, [isRestoring, theme]);

  if (!conversation && !workspace.isHydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, paddingHorizontal: 16, paddingTop: insets.top + 64 }}>
        <AgentConversationSkeleton theme={theme} />
      </View>
    );
  }

  if (!conversation) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ color: theme.text, fontSize: 17, fontWeight: "700" }}>找不到对话</Text>
        <Pressable onPress={onBack} style={{ marginTop: 12 }}>
          <Text style={{ color: theme.accent, fontSize: 15, fontWeight: "700" }}>返回</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View
        style={{
          position: "absolute",
          top: insets.top + 4,
          left: 12,
          right: 12,
          zIndex: 20,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
        pointerEvents="box-none"
      >
        <GlassBar
          blurTint={theme.mode === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
          fallbackColor={theme.mode === "light" ? "rgba(250,250,250,0.62)" : "rgba(42,42,43,0.58)"}
          style={{ borderRadius: 17, borderCurve: "continuous" }}
        >
          <Pressable
            onPress={onBack}
            hitSlop={8}
            style={({ pressed }) => ({
              width: 34,
              height: 34,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? "rgba(120,120,128,0.14)" : "transparent",
            })}
          >
            <AppSymbol name="chevron.left" size={18} color={theme.text} />
          </Pressable>
        </GlassBar>
        <GlassBar
          blurTint={theme.mode === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
          fallbackColor={theme.mode === "light" ? "rgba(250,250,250,0.62)" : "rgba(42,42,43,0.58)"}
          style={{ borderRadius: 17, borderCurve: "continuous" }}
        >
          <Pressable
            onPress={() => setFileDrawerOpen(true)}
            hitSlop={8}
            style={({ pressed }) => ({
              width: 34,
              height: 34,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? "rgba(120,120,128,0.14)" : "transparent",
            })}
          >
            <AppSymbol name="doc.text.magnifyingglass" size={18} color={theme.textSecondary} />
          </Pressable>
        </GlassBar>
        <GlassBar
          blurTint={theme.mode === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
          fallbackColor={theme.mode === "light" ? "rgba(250,250,250,0.62)" : "rgba(42,42,43,0.58)"}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 38,
            borderRadius: 19,
            borderCurve: "continuous",
            paddingHorizontal: 14,
            justifyContent: "center",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
            {meta ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: meta.color }} /> : null}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.text, fontSize: 14, fontWeight: "800", fontFamily: MONO_FONT }} numberOfLines={1}>
                {conversation.title || "Agent"}
              </Text>
              <Text
                style={{ color: theme.textTertiary, fontSize: 10, marginTop: 2, fontWeight: "700", fontFamily: MONO_FONT }}
                numberOfLines={1}
              >
                {[displayProvider(conversation.provider), formatModel(conversation.model, modelOpts), shortPath(conversation.cwd)]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
            {running ? <ActivityIndicator size="small" color={theme.accent} /> : null}
          </View>
        </GlassBar>
        <GlassBar
          blurTint={theme.mode === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
          fallbackColor={theme.mode === "light" ? "rgba(250,250,250,0.62)" : "rgba(42,42,43,0.58)"}
          style={{ borderRadius: 17, borderCurve: "continuous" }}
        >
          <MenuView
            actions={[
              { id: "refresh", title: "刷新快照", image: "arrow.clockwise" },
              { id: "rename", title: "重命名", image: "pencil" },
              { id: "archive", title: conversation.archived ? "取消归档" : "归档", image: "archivebox" },
            ]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "refresh") {
                workspace.requestCapabilities(conversation.sessionId);
              }
              if (nativeEvent.event === "rename") {
                composerRef.current?.openRename();
              }
              if (nativeEvent.event === "archive") {
                workspace.archive(conversation.id, !conversation.archived).then(onBack).catch(() => {});
              }
            }}
          >
            <View style={{ width: 34, height: 34, alignItems: "center", justifyContent: "center" }}>
              <AppSymbol name="ellipsis.circle" size={20} color={theme.textSecondary} />
            </View>
          </MenuView>
        </GlassBar>
      </View>

      <View style={{ flex: 1 }}>
        <LegendList
          ref={timelineRef}
          data={timelineListData}
          style={{ flex: 1 }}
          keyExtractor={(item) => item.id}
          renderItem={renderTimelineItem}
          ListEmptyComponent={timelineEmpty}
          ListHeaderComponent={
            visibleTimeline.length > 0 && workspace.getHistoryState(conversationId)?.loading ? (
              <View
                style={{
                  paddingTop: 8,
                  paddingBottom: 14,
                  alignItems: "center",
                  flexDirection: "row",
                  justifyContent: "center",
                  gap: 7,
                }}
              >
                <ActivityIndicator size="small" color={theme.accent} />
                <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>加载更早的消息…</Text>
              </View>
            ) : null
          }
          ItemSeparatorComponent={TimelineSeparator}
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: 16,
            paddingTop: insets.top + 60,
            paddingBottom: visibleTimeline.length === 0 ? timelineBottomInset + 18 : 0,
          }}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          scrollIndicatorInsets={{ top: insets.top + 60, bottom: 18 + timelineBottomInset }}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          onScroll={handleTimelineScroll}
          scrollEventThrottle={16}
          estimatedItemSize={220}
          drawDistance={800}
          alignItemsAtEnd
          maintainScrollAtEnd={{ onDataChange: true, onItemLayout: true, onLayout: true }}
          maintainScrollAtEndThreshold={0.2}
          maintainVisibleContentPosition
        />
        {isRestoring && visibleTimeline.length > 0 ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: insets.top + 58,
              left: 0,
              right: 0,
              alignItems: "center",
              zIndex: 12,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
                borderRadius: 999,
                backgroundColor: theme.mode === "light" ? "rgba(255,255,255,0.82)" : "rgba(42,42,43,0.82)",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
                paddingHorizontal: 10,
                paddingVertical: 6,
                shadowColor: "#000",
                shadowOpacity: theme.mode === "dark" ? 0.2 : 0.08,
                shadowRadius: 10,
                shadowOffset: { width: 0, height: 4 },
              }}
            >
              <ActivityIndicator size="small" color={theme.accent} />
              <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "800" }}>正在同步最新消息…</Text>
            </View>
          </View>
        ) : null}
        {!isTimelineNearBottom || hasNewOutput ? (
          <View
            pointerEvents="box-none"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: timelineBottomInset + 12,
              alignItems: "center",
              zIndex: 20,
              elevation: 20,
            }}
          >
            <Pressable
              onPress={() => scrollTimelineToBottom(true)}
              hitSlop={8}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 22,
                borderCurve: "continuous",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
                backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                alignItems: "center",
                justifyContent: "center",
                shadowColor: "#000",
                shadowOpacity: theme.mode === "dark" ? 0.22 : 0.08,
                shadowRadius: 10,
                shadowOffset: { width: 0, height: 4 },
                elevation: 4,
              })}
            >
              <AppSymbol name="arrow.down" size={16} color={theme.text} />
            </Pressable>
          </View>
        ) : null}
      </View>

      <Composer
        ref={composerRef}
        conversation={conversation}
        capabilities={capabilities}
        workspace={workspace}
        theme={theme}
        notices={visibleNotices}
        queuedFollowUps={queuedFollowUps}
        planReady={planReady}
        bottomInset={insets.bottom}
        bottomOffset={composerBottomOffset}
        onHeightChange={(height) =>
          setBottomComposerHeight((current) => (Math.abs(current - height) > 1 ? height : current))
        }
        onAfterSend={() => scrollTimelineToBottom(true)}
      />

      <FilePreviewDrawer
        visible={fileDrawerOpen}
        conversationId={conversation.id}
        cwd={conversation.cwd || "~"}
        workspace={workspace}
        theme={theme}
        topInset={insets.top}
        bottomInset={insets.bottom}
        onClose={() => setFileDrawerOpen(false)}
      />
    </View>
  );
}
