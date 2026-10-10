import { subagentKey, type SessionView, type TimelineItem } from "@linkshell/client-core";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { Button } from "@/components/button";
import { Text } from "@/components/fixed-text";
import { useSharedValue } from "react-native-reanimated";
import { usePageInsets } from "@/components/adaptive-page";
import { ScrollableState } from "@/components/scrollable-state";
import { SheetHeader } from "@/components/sheet-header";
import { EmptyState, LoadingState } from "@/components/state-views";
import { TimelineSession } from "@/components/timeline/context";
import { StatusMark, SubagentGlyph, useSubagentProgress } from "@/components/timeline/subagent";
import { Timeline } from "@/components/timeline/timeline";
import { useActions, useClient, useConnection, useSessionSubscription } from "@/lib/client";
import { useTimelineSession } from "@/components/timeline/context";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

/** Finds a tool call anywhere in a timeline, including inside other sub-agents. */
function findCall(items: TimelineItem[] | undefined, id: string): ToolItem | undefined {
  for (const item of items ?? []) {
    if (item.kind !== "tool") continue;
    if (item.id === id) return item;
    const nested = findCall(item.sub?.items, id);
    if (nested) return nested;
  }
  return undefined;
}

// The dev gallery's fixtures stand in for a session there; stripped from release builds.
const galleryItems: TimelineItem[] = __DEV__ ? require("@/dev/fixtures").galleryItems : [];

/**
 * A sheet with one sub-agent's whole run, live: the same timeline as a session.
 * Its conversation is loaded on its own, so it opens from the list of
 * sub-agents too, when the call that started it is far back in a history that
 * isn't loaded; until that arrives it shows what the session's timeline has.
 */
export function WorkflowAgentScreen() { return <SubagentScreen fullScreen />; }

export function SubagentScreen({ fullScreen = false }: { fullScreen?: boolean } = {}) {
  const { id, call } = useLocalSearchParams<{ id: string; call: string }>();
  const gallery = id === "gallery";
  const { openSubagent, closeSubagent } = useActions();
  const items = useClient((state) => (gallery ? undefined : (state.views[id] as SessionView | undefined)?.items));
  const own = useClient((state) => (gallery ? undefined : (state.subagentViews[subagentKey(id, call)] as SessionView | undefined)?.items));
  const [missing, setMissing] = useState(false);
  const ready = useClient((state) => !!state.ready[id]);
  useSessionSubscription(id, !gallery);

  useEffect(() => {
    if (gallery || !ready) return;
    setMissing(false);
    let closed = false;
    void openSubagent(id, call).then((opened) => {
      if (!closed && !opened) setMissing(true);
    });
    return () => {
      closed = true;
      closeSubagent(id, call);
    };
  }, [gallery, ready, openSubagent, closeSubagent, id, call]);

  const item = useMemo(() => findCall(own, call) ?? findCall(gallery ? galleryItems : items, call), [gallery, own, items, call]);
  if (!item) {
    return (
      <>
      {!fullScreen ? <SheetHeader title="Agent 详情" /> : null}
      <View style={{ flex: 1, backgroundColor: colors.plain }}>
        <ScrollableState>
        {gallery || missing ? (
          <EmptyState icon={{ sf: "square.stack.3d.up", md: "layers" }} title="找不到这个子 Agent" message="它可能属于一个已经关闭的会话。" />
        ) : (
          <LoadingState label="正在载入…" />
        )}
        </ScrollableState>
      </View>
      </>
    );
  }
  return (
    <TimelineSession.Provider value={id}>
      {!fullScreen ? <SheetHeader title="Agent 详情" /> : null}
      <SubagentSheet item={item} fullScreen={fullScreen} />
    </TimelineSession.Provider>
  );
}

function SubagentSheet({ item, fullScreen }: { item: ToolItem; fullScreen: boolean }) {
  const sessionId = useTimelineSession();
  const { link } = useConnection();
  const [cancelling, setCancelling] = useState(false);
  const insets = usePageInsets();
  const bottom = useSharedValue(16 + (Platform.OS === "ios" ? 0 : insets.bottom));
  const [taskOpen, setTaskOpen] = useState(false);
  const [height, setHeight] = useState(0);
  // iOS adds the scroll view's safe bottom automatically; Android needs it explicitly.
  useEffect(() => { bottom.set(16 + (Platform.OS === "ios" ? 0 : insets.bottom)); }, [bottom, insets.bottom]);
  const progress = useSubagentProgress(item);

  return (
    // Keep the native container intact: a form sheet otherwise mistakes the
    // task's flattened ScrollView for its main content and overwrites its frame.
    <View collapsable={false} onLayout={(event) => setHeight(event.nativeEvent.layout.height)} style={{ flex: 1, backgroundColor: colors.plain }}>
      <View collapsable={false} style={{ paddingTop: Math.max(12, insets.top + 8), paddingHorizontal: 20, paddingBottom: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <SubagentGlyph failed={progress.failed} size={40} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={1} style={[type.headline, { color: colors.label }]}>
              {progress.name}
            </Text>
            <Text numberOfLines={1} style={[type.footnote, { color: colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}>
              {Array.from(new Set([progress.model, progress.paused || progress.stopped || progress.unknown ? null : progress.running ? "运行中" : progress.failed ? null : "已完成", progress.summary].filter(Boolean))).join(" · ")}
            </Text>
          </View>
          <StatusMark running={progress.running && !progress.paused} failed={progress.failed} paused={progress.paused} stopped={progress.stopped} unknown={progress.unknown} />
        </View>
        {sessionId && item.detail?.type === "subagent" && item.detail.canCancel && item.detail.nativeSessionId && (progress.running || progress.paused) ? <Button title="停止这个子代理" variant="destructive" busy={cancelling} onPress={() => { setCancelling(true); void link.call("sessions.cancelSubagent", { sessionId, nativeSessionId: item.detail!.type === "subagent" ? item.detail!.nativeSessionId! : "" }).catch((error: unknown) => Alert.alert("停止失败", error instanceof Error ? error.message : String(error))).finally(() => setCancelling(false)); }} /> : null}
        {progress.task ? (
          <ScrollView style={{ flexGrow: 0, maxHeight: height ? Math.max(60, height * 0.3) : 120 }} contentInsetAdjustmentBehavior="never" automaticallyAdjustContentInsets={false} nestedScrollEnabled>
          <Pressable onPress={() => setTaskOpen((open) => !open)} accessibilityRole="button" accessibilityState={{ expanded: taskOpen }} accessibilityLabel="子 Agent 任务说明" style={{ minHeight: 44, justifyContent: "center" }}>
            <Text numberOfLines={taskOpen ? undefined : 3} style={[type.subhead, { color: colors.secondaryLabel }]}>
              {progress.task}
            </Text>
          </Pressable>
          </ScrollView>
        ) : null}
      </View>
      <View style={{ height: 0.5, backgroundColor: colors.separator }} />
      {progress.children.length === 0 ? (
        <ScrollableState>
        <EmptyState
          icon={{ sf: "hourglass", md: "hourglass_empty" }}
          title={progress.running ? "等待过程记录…" : "暂无过程记录"}
          message="暂未读取到这个 Agent 的执行步骤。"
        />
        </ScrollableState>
      ) : (
        <Timeline
          items={progress.children}
          planId={item.sub?.planId}
          turnActive={progress.running}
          composerInset={bottom}
          keyboardOffset={0}
          onFailedMessage={() => {}}
          // An Android sheet keeps its full height below the fold at the half detent,
          // so rows anchored to the bottom would start hidden.
          anchorEnd={!fullScreen && Platform.OS === "ios"}
          // No composer here: a short run reads from the top instead of leaving a gap above it.
          alignEnd={false}
        />
      )}
    </View>
  );
}
