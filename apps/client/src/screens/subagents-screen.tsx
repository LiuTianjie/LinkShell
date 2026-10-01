import type { SubagentInfo } from "@linkshell/wire";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/icon";
import { PressableScale } from "@/components/pressable-scale";
import { EmptyState, LoadingState } from "@/components/state-views";
import { LiveDot } from "@/components/status";
import { SubagentGlyph } from "@/components/timeline/subagent";
import { useActions, useClient } from "@/lib/client";
import { duration, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

function Row({ entry, last, now, onPress }: { entry: SubagentInfo; last: boolean; now: number; onPress: () => void }) {
  const failed = entry.failed === true;
  const state = entry.running
    ? `已运行 ${duration(now - entry.startedAt)}`
    : `${failed ? "失败" : "已完成"} · ${relativeTime(entry.endedAt ?? entry.startedAt, now)}`;
  return (
    <PressableScale
      onPress={onPress}
      pressedScale={0.985}
      accessibilityRole="button"
      accessibilityLabel={[entry.agentType ?? "子 Agent", entry.task, entry.running ? "运行中" : failed ? "失败" : "已完成"].join("，")}
      accessibilityHint="查看这个子 Agent 的全部过程"
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 14 }}>
        <SubagentGlyph failed={failed} size={32} />
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 11,
            paddingRight: 14,
            borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
            borderBottomColor: colors.separator,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={2} style={[type.subhead, { color: colors.label, fontWeight: "500" }]}>
              {entry.task || entry.agentType || "子 Agent"}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              {entry.running ? <LiveDot size={6} /> : null}
              <Text
                numberOfLines={1}
                style={[type.footnote, { flex: 1, color: entry.running ? colors.running : failed ? colors.danger : colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}
              >
                {entry.agentType && entry.task ? <Text style={{ color: colors.secondaryLabel }}>{entry.agentType} · </Text> : null}
                {state}
              </Text>
            </View>
          </View>
          <Icon sf="chevron.right" md="chevron_right" size={11} color={colors.tertiaryLabel} weight="semibold" />
        </View>
      </View>
    </PressableScale>
  );
}

/**
 * The session's sub-agents, newest first: the ones still working and the ones
 * that finished long ago, without scrolling back to where each was started.
 */
export function SubagentsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { loadSubagents } = useActions();
  const listed = useClient((state) => state.subagents[id]);
  // The ones still working first, then newest first (as the computer lists them).
  const list = useMemo(() => (listed ? [...listed].sort((a, b) => Number(b.running) - Number(a.running)) : undefined), [listed]);
  const counts = useClient((state) => state.sessions[id]?.subagents);
  const online = useClient((state) => state.status === "online");
  const [error, setError] = useState<string | null>(null);
  const running = list?.some((entry) => entry.running) ?? false;
  const now = useNow(running ? 1000 : 30_000);

  // (Again) whenever one starts or finishes.
  useEffect(() => {
    if (!online) return;
    setError(null);
    loadSubagents(id).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [loadSubagents, id, online, counts?.total, counts?.running]);

  const open = (entry: SubagentInfo) => {
    haptics.selection();
    router.push({ pathname: "/session/[id]/agent/[call]", params: { id, call: entry.toolCallId } });
  };

  return (
    <View style={{ flex: 1 }}>
      {Platform.OS === "android" ? (
        <View style={{ alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginTop: 10, backgroundColor: colors.separator }} />
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: Platform.OS === "android" ? 12 : 22, paddingBottom: 10 }}>
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={[type.title, { color: colors.label }]}>子 Agent</Text>
          {list?.length ? (
            <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
              共 {list.length} 个{counts?.running ? ` · ${counts.running} 个运行中` : ""}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="关闭"
          hitSlop={10}
          style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
        >
          <Icon sf="xmark" md="close" size={13} color={colors.secondaryLabel} weight="bold" />
        </Pressable>
      </View>
      {/* Wrapped: a sheet stretches a scroll view that's a direct child of the screen over the whole sheet. */}
      <View style={{ flex: 1, overflow: "hidden" }}>
        <ScrollView contentInsetAdjustmentBehavior="never" style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: insets.bottom + 24 }}>
          {!list ? (
            error ? (
              <EmptyState icon={{ sf: "exclamationmark.triangle", md: "warning" }} title="读取失败" message={error} />
            ) : (
              <LoadingState label="正在读取…" />
            )
          ) : list.length === 0 ? (
            <EmptyState icon={{ sf: "square.stack.3d.up", md: "layers" }} title="这个会话没有子 Agent" message="Agent 把任务分给子 Agent 后，会列在这里。" />
          ) : (
            <View style={{ backgroundColor: colors.sheetCard, borderRadius: 20, borderCurve: "continuous", overflow: "hidden" }}>
              {list.map((entry, index) => (
                <Row key={entry.toolCallId} entry={entry} last={index === list.length - 1} now={now} onPress={() => open(entry)} />
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}
