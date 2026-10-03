import { subagentKey, type SessionView, type TimelineItem } from "@linkshell/client-core";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, LoadingState } from "@/components/state-views";
import { TimelineSession } from "@/components/timeline/context";
import { StatusMark, SubagentGlyph, useSubagentProgress } from "@/components/timeline/subagent";
import { Timeline } from "@/components/timeline/timeline";
import { useActions, useClient, useSessionSubscription } from "@/lib/client";
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
      <View style={{ flex: 1, backgroundColor: colors.plain, justifyContent: "center" }}>
        {gallery || missing ? (
          <EmptyState icon={{ sf: "square.stack.3d.up", md: "layers" }} title="找不到这个子 Agent" message="它可能属于一个已经关闭的会话。" />
        ) : (
          <LoadingState label="正在载入…" />
        )}
      </View>
    );
  }
  return (
    <TimelineSession.Provider value={id}>
      <SubagentSheet item={item} fullScreen={fullScreen} />
    </TimelineSession.Provider>
  );
}

function SubagentSheet({ item, fullScreen }: { item: ToolItem; fullScreen: boolean }) {
  const insets = useSafeAreaInsets();
  const bottom = useSharedValue(insets.bottom + 16);
  const [taskOpen, setTaskOpen] = useState(false);
  const progress = useSubagentProgress(item);

  return (
    <View style={{ flex: 1, backgroundColor: colors.plain }}>
      {!fullScreen && Platform.OS === "android" ? (
        <View style={{ alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginTop: 10, backgroundColor: colors.separator }} />
      ) : null}
      <View style={{ paddingTop: fullScreen ? 16 : Platform.OS === "android" ? 14 : 22, paddingHorizontal: 20, paddingBottom: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <SubagentGlyph failed={progress.failed} size={40} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={1} style={[type.headline, { color: colors.label }]}>
              {progress.name}
            </Text>
            <Text numberOfLines={1} style={[type.footnote, { color: colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}>
              {[progress.model, progress.paused || progress.stopped || progress.unknown ? null : progress.running ? "运行中" : progress.failed ? null : "已完成", progress.summary].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <StatusMark running={progress.running && !progress.paused} failed={progress.failed} paused={progress.paused} stopped={progress.stopped} unknown={progress.unknown} />
        </View>
        {progress.task ? (
          <Pressable onPress={() => setTaskOpen((open) => !open)} accessibilityRole="button" accessibilityState={{ expanded: taskOpen }}>
            <Text numberOfLines={taskOpen ? undefined : 3} style={[type.subhead, { color: colors.secondaryLabel }]}>
              {progress.task}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View style={{ height: 0.5, backgroundColor: colors.separator }} />
      {progress.children.length === 0 ? (
        <EmptyState
          icon={{ sf: "hourglass", md: "hourglass_empty" }}
          title={progress.running ? "正在启动…" : "没有过程记录"}
          message={progress.running ? undefined : "这个 Agent 没有上报它的步骤。"}
        />
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
