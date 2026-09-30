import type { LegendListRef } from "@legendapp/list/react-native";
import type { TimelineItem } from "@linkshell/client-core";
import * as Clipboard from "expo-clipboard";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { confirmDelete, renameSession, toggleArchived } from "@/lib/session-actions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, type NativeScrollEvent, type NativeSyntheticEvent, Platform, Pressable, Text, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentTile } from "@/components/agent-tile";
import { Composer } from "@/components/composer";
import { Glass } from "@/components/glass";
import { Icon } from "@/components/icon";
import { TopFade } from "@/components/top-fade";
import { LiveDot } from "@/components/status";
import { EmptyState, LoadingState } from "@/components/state-views";
import { TimelineSkeleton } from "@/components/timeline/skeleton";
import { Timeline } from "@/components/timeline/timeline";
import { TimelineSession } from "@/components/timeline/context";
import { LinkBase } from "@/lib/links";
import { useActions, useClient } from "@/lib/client";
import { fileChanges, sessionTitle } from "@/lib/describe";
import { baseName } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { agentLook, tierCopy } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { HeaderActions } from "@/components/header-actions";

/** iOS 26-style title capsule: agent icon, title and where it runs, on glass. */
function HeaderTitle({ agent, title, subtitle, live }: { agent: string; title: string; subtitle: string; live: boolean }) {
  const content = (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AgentTile agent={agent} size={28} />
        <View style={{ flexShrink: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 19, fontWeight: "600", color: colors.label }}>
            {title}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {live ? <LiveDot size={5} /> : null}
            <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 15, fontWeight: "500", color: colors.secondaryLabel }}>
              {subtitle}
            </Text>
          </View>
        </View>
      </View>
  );
  // iOS: a glass capsule floating over the content. Android: plain title in a solid app bar.
  if (Platform.OS !== "ios") return <View style={{ maxWidth: 260 }}>{content}</View>;
  return <Glass style={{ borderRadius: 22, paddingLeft: 6, paddingRight: 14, paddingVertical: 5, maxWidth: 250 }}>{content}</Glass>;
}

function countChanges(items: TimelineItem[]): number {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool" || item.status === "failed") continue;
    for (const change of fileChanges(item.content)) paths.add(change.path);
  }
  return paths.size;
}

export function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const summary = useClient((state) => state.sessions[id]);
  const view = useClient((state) => state.views[id]);
  const loaded = useClient((state) => state.sessionsLoaded);
  const ready = useClient((state) => !!state.ready[id]);
  const online = useClient((state) => state.status === "online");
  const agentInfo = useClient((state) => state.machine?.agents.find((agent) => agent.id === summary?.agent));
  const actions = useActions();
  const insets = useSafeAreaInsets();
  const composerInset = useSharedValue(0);
  const headerHeight = useHeaderHeight();
  // The space between the header and the composer, for the empty-session intro.
  const introFrame = useAnimatedStyle(() => ({ bottom: composerInset.get(), paddingTop: headerHeight }));
  const listRef = useRef<LegendListRef>(null);
  const [atEnd, setAtEnd] = useState(true);

  useEffect(() => {
    actions.openSession(id);
    return () => actions.closeSession(id);
  }, [actions, id]);

  const items = view?.items ?? [];
  // Reopened sessions show what we already have straight away.
  const [cachedAtOpen] = useState(() => items.length > 0);

  const changeCount = useMemo(() => countChanges(items), [items]);
  // The host's summary is authoritative: an agent's own history can end mid-turn.
  const turnActive = summary ? summary.state === "running" || summary.state === "waiting" : false;
  const driver = view?.driver ?? summary?.driver;
  const look = agentLook(summary?.agent ?? "", agentInfo?.label);

  const onFailedMessage = useCallback(
    (item: Extract<TimelineItem, { kind: "user" }>) => {
      const clientMessageId = item.id.replace(/^local-/, "");
      Alert.alert("消息没发出去", "要重新发送吗？", [
        { text: "取消", style: "cancel" },
        { text: "删除", style: "destructive", onPress: () => actions.discard(clientMessageId) },
        { text: "重新发送", onPress: () => void actions.retry(clientMessageId) },
      ]);
    },
    [actions],
  );

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement, contentInset } = event.nativeEvent;
    const distance = contentSize.height + (contentInset?.bottom ?? 0) - (contentOffset.y + layoutMeasurement.height);
    const next = distance < 120;
    setAtEnd((current) => (current === next ? current : next));
  }, []);

  const scrollToEnd = () => {
    haptics.selection();
    void listRef.current?.scrollToEnd({ animated: true });
  };

  const guard = async (work: () => Promise<unknown>, failure: string) => {
    try {
      await work();
    } catch (error) {
      haptics.error();
      Alert.alert(failure, error instanceof Error ? error.message : String(error));
    }
  };

  if (!summary) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.plain, justifyContent: "center" }}>
        <Stack.Screen options={{ title: "" }} />
        {loaded ? (
          <EmptyState
            icon={{ sf: "questionmark.bubble", md: "help" }}
            title="找不到这个会话"
            message="它可能已经在电脑上被删除了。"
            action={{ title: "返回", onPress: () => router.back() }}
          />
        ) : (
          <LoadingState label="正在连接电脑…" />
        )}
      </View>
    );
  }

  const tier = agentInfo?.tier;
  const subtitle = [baseName(summary.cwd), look.short, tier ? tierCopy[tier].label : null].filter(Boolean).join(" · ");

  // A session with a title or preview has history, even before its first import.
  const hasHistory = summary.lastSeq > 0 || !!summary.preview || !!summary.title;
  const loading = !ready && !cachedAtOpen && online && hasHistory;
  // An empty session: the intro sits centred above the composer, outside the
  // list (which aligns its content to the bottom, as a chat should).
  const intro =
    loading || items.length > 0 ? null : (
      <View style={{ alignItems: "center", gap: 10, paddingHorizontal: 32 }}>
        <AgentTile agent={summary.agent} size={56} />
        <Text style={[type.headline, { color: colors.label }]}>{look.name}</Text>
        <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center" }]}>
          {tier ? tierCopy[tier].detail : `在 ${baseName(summary.cwd)} 里开始对话`}
        </Text>
      </View>
    );

  return (
    <View style={{ flex: 1, backgroundColor: colors.plain }}>
      <Stack.Screen
        options={{
          scrollEdgeEffects: { top: "soft" },
          ...(Platform.OS === "ios"
            ? {}
            : { headerTransparent: false, headerStyle: { backgroundColor: colors.plain as string }, headerShadowVisible: false }),
          headerTitle: () => (
            <HeaderTitle
              agent={summary.agent}
              title={sessionTitle(view?.title ? { title: view.title } : summary)}
              subtitle={subtitle}
              live={turnActive}
            />
          ),
        }}
      />
      <HeaderActions
        actions={[
          ...(changeCount > 0
            ? [
                {
                  kind: "button" as const,
                  key: "changes",
                  icon: { sf: "plus.forwardslash.minus", md: "difference" } as const,
                  label: `改动 ${changeCount} 个文件`,
                  onPress: () => router.push({ pathname: "/session/[id]/changes", params: { id } }),
                },
              ]
            : []),
          {
            kind: "menu",
            key: "more",
            icon: { sf: "ellipsis", md: "more_vert" },
            label: "更多",
            items: [
              ...(turnActive
                ? [{ title: "停止这一轮", icon: { sf: "stop.circle", md: "stop_circle" } as const, destructive: true, onPress: () => void guard(() => actions.cancel(id), "停止失败") }]
                : []),
              ...(tier === "handoff" && driver === "remote"
                ? [{ title: "交还电脑", icon: { sf: "laptopcomputer", md: "laptop_mac" } as const, onPress: () => void guard(() => actions.release(id), "交还失败") }]
                : []),
              {
                title: "预览网页",
                icon: { sf: "globe", md: "language" },
                onPress: () => router.push({ pathname: "/ports", params: { cwd: summary.cwd } }),
              },
              { title: "重命名", icon: { sf: "pencil", md: "edit" }, onPress: () => renameSession(summary) },
              {
                title: summary.archived ? "取消归档" : "归档",
                icon: summary.archived ? { sf: "tray.and.arrow.up", md: "unarchive" } : { sf: "archivebox", md: "archive" },
                onPress: () => {
                  void toggleArchived(summary, actions).then((done) => {
                    if (done && !summary.archived) router.back();
                  });
                },
              },
              {
                title: "复制会话 ID",
                icon: { sf: "doc.on.doc", md: "content_copy" },
                onPress: () => {
                  void Clipboard.setStringAsync(summary.nativeId);
                  haptics.success();
                },
              },
              {
                title: "复制项目路径",
                icon: { sf: "folder", md: "folder" },
                onPress: () => {
                  void Clipboard.setStringAsync(summary.cwd);
                  haptics.success();
                },
              },
              {
                title: "删除",
                icon: { sf: "trash", md: "delete" },
                destructive: true,
                onPress: () => confirmDelete(summary, actions, () => router.back()),
              },
            ],
          },
        ]}
      />

      {/* Mount the list once history is in, so it lays out and opens at the latest message. */}
      {loading ? null : (
      <LinkBase value={summary.cwd}>
      <TimelineSession.Provider value={id}>
      <Timeline
        ref={listRef}
        items={items}
        planId={view?.planId}
        turnActive={turnActive}
        composerInset={composerInset}
        keyboardOffset={0}
        onFailedMessage={onFailedMessage}
        onScroll={onScroll}
      />
      </TimelineSession.Provider>
      </LinkBase>
      )}

      {intro ? (
        <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, right: 0, top: 0, justifyContent: "center" }, introFrame]}>
          {intro}
        </Animated.View>
      ) : null}
      {loading ? <TimelineSkeleton label="正在载入对话…" /> : null}
      {Platform.OS === "ios" ? <TopFade height={insets.top + 60} /> : null}


      <KeyboardStickyView
        offset={{ closed: 0, opened: insets.bottom }}
        pointerEvents="box-none"
        style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
      >
        {!atEnd && items.length > 0 ? (
          <Animated.View
            entering={FadeIn.duration(160)}
            exiting={FadeOut.duration(120)}
            pointerEvents="box-none"
            style={{ alignItems: "center", paddingBottom: 2 }}
          >
            <Pressable onPress={scrollToEnd} accessibilityRole="button" accessibilityLabel="回到最新" hitSlop={8}>
              <Glass interactive style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}>
                <Icon sf="arrow.down" md="arrow_downward" size={16} color={colors.label} weight="semibold" />
              </Glass>
            </Pressable>
          </Animated.View>
        ) : null}
        <Composer
          agent={summary.agent}
          agentInfo={agentInfo}
          online={online}
          turnActive={turnActive}
          driver={driver}
          permission={view?.permissions[0]}
          permissionCount={view?.permissions.length ?? 0}
          config={view?.config ?? []}
          commands={view?.commands ?? []}
          usage={view?.usage}
          bottomInset={insets.bottom}
          onLayout={(event) => composerInset.set(event.nativeEvent.layout.height)}
          onSend={(content) => actions.send(id, content)}
          onStop={() => guard(() => actions.cancel(id), "停止失败")}
          queue={summary.queue}
          onUnqueue={(clientMessageId) => void guard(() => actions.unqueue(id, clientMessageId).then(() => {}), "取消失败")}
          onRespond={(requestId, optionId) => actions.respond(id, requestId, optionId)}
          onTakeover={() => actions.takeover(id)}
          onConfig={(optionId, value) => void guard(() => actions.setConfig(id, optionId, value), "切换失败")}
        />
      </KeyboardStickyView>
    </View>
  );
}
