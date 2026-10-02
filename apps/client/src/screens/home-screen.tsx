import { LegendList } from "@legendapp/list/react-native";
import type { SessionSummary, TerminalInfo } from "@linkshell/wire";
import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@/components/icon";
import { ConnectionBanner } from "@/components/connection-banner";
import { NeedCard } from "@/components/need-card";
import { SectionHeader } from "@/components/section-header";
import { SessionRow, positionOf, type RowPosition } from "@/components/session-row";
import { TerminalRow } from "@/components/terminal-row";
import { terminalState, useTerminals } from "@/lib/terminals";
import { EmptyState, LoadingState, unreachable, WaitingForComputer } from "@/components/state-views";
import { useActions, useClient, useHasComputer } from "@/lib/client";
import { Welcome } from "@/components/welcome";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { useFloatingTabInset } from "@/components/floating-tabs";
import { NEW_SESSION } from "@/components/new-session-action";
import { PageHeader, StatusBarFade } from "@/components/page-header";

type Item =
  | {
      type: "header";
      key: string;
      title: string;
      count?: number;
      warn?: boolean;
    }
  | { type: "need"; key: string; session: SessionSummary }
  | {
      type: "row";
      key: string;
      session: SessionSummary;
      position: RowPosition;
    }
  | { type: "terminal"; key: string; terminal: TerminalInfo; position: RowPosition };

type Entry = { kind: "session"; session: SessionSummary; at: number } | { kind: "terminal"; terminal: TerminalInfo; at: number };

function rowOf(entry: Entry, position: RowPosition, prefix: string): Item {
  return entry.kind === "session"
    ? { type: "row", key: `${prefix}-${entry.session.id}`, session: entry.session, position }
    : { type: "terminal", key: `${prefix}-t-${entry.terminal.id}`, terminal: entry.terminal, position };
}

const newest = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt;

const DAY = 86_400_000;

/** "今天 / 昨天 / 近 7 天 / 更早": recent sessions read as a diary, not a wall. */
function dayBucket(ts: number, now: number): string {
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= start) return "今天";
  if (ts >= start - DAY) return "昨天";
  if (ts >= start - 6 * DAY) return "近 7 天";
  return "更早";
}

function buildItems(sessions: SessionSummary[], terminals: TerminalInfo[], now: number): { items: Item[]; waiting: number; running: number } {
  const live = sessions.filter((s) => !s.archived);
  const waiting = live.filter((s) => s.state === "waiting").sort(newest);
  const busyTerminals = terminals.filter((t) => terminalState(t).busy);
  const running: Entry[] = [
    ...live.filter((s) => s.state === "running").map((session): Entry => ({ kind: "session", session, at: session.updatedAt })),
    ...busyTerminals.map((terminal): Entry => ({ kind: "terminal", terminal, at: terminal.activeAt })),
  ].sort((a, b) => b.at - a.at);
  const recent: Entry[] = [
    ...live.filter((s) => s.state !== "waiting" && s.state !== "running").map((session): Entry => ({ kind: "session", session, at: session.updatedAt })),
    ...terminals.filter((t) => !busyTerminals.includes(t)).map((terminal): Entry => ({ kind: "terminal", terminal, at: terminal.activeAt })),
  ].sort((a, b) => b.at - a.at);
  const items: Item[] = [];

  // Nothing waiting: the summary line already says so; no empty section.
  if (waiting.length) {
    items.push({ type: "header", key: "h-need", title: "需要你", count: waiting.length, warn: true });
    for (const session of waiting) items.push({ type: "need", key: `n-${session.id}`, session });
  }
  if (running.length) {
    items.push({ type: "header", key: "h-run", title: "进行中", count: running.length });
    running.forEach((entry, index) => items.push(rowOf(entry, positionOf(index, running.length), "r")));
  }
  const buckets = new Map<string, Entry[]>();
  for (const entry of recent) {
    const bucket = dayBucket(entry.at, now);
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), entry]);
  }
  for (const [title, group] of buckets) {
    items.push({ type: "header", key: `h-${title}`, title });
    group.forEach((entry, index) => items.push(rowOf(entry, positionOf(index, group.length), "c")));
  }
  return { items, waiting: waiting.length, running: running.length };
}

/** Which computer, and only the one thing worth saying: what's waiting on you. */
function Summary({ waiting }: { waiting: number }) {
  const machine = useClient((state) => state.machine);
  const online = useClient((state) => state.status === "online");
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4, paddingTop: 2 }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: online ? colors.ok : colors.tertiaryLabel }} />
      <Text numberOfLines={1} style={[type.subhead, { color: colors.secondaryLabel, flexShrink: 1 }]}>
        {machine ? machine.hostname.replace(/\.local$/, "") : "电脑"}
      </Text>
      {waiting ? <Text style={[type.subhead, { color: colors.waiting, fontWeight: "600" }]}>· {waiting} 项需要你</Text> : null}
    </View>
  );
}

export function HomeScreen() {
  const tabInset = useFloatingTabInset();
  const sessionsById = useClient((state) => state.sessions);
  const loaded = useClient((state) => state.sessionsLoaded);
  const error = useClient((state) => state.sessionsError);
  const offline = useClient((state) => unreachable(state.status));
  const hasComputer = useHasComputer();
  const { refresh } = useActions();
  const now = useNow();
  const [refreshing, setRefreshing] = useState(false);

  // Re-bucket when the day changes, not on every tick.
  const day = new Date(now).toDateString();
  const { terminals } = useTerminals();
  const { items, waiting } = useMemo(
    () => buildItems(Object.values(sessionsById), terminals, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `day` is not read: it is what says the buckets are stale.
    [sessionsById, terminals, day],
  );
  const empty = loaded && Object.keys(sessionsById).length === 0;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const renderItem = useCallback(
    ({ item }: { item: Item }) => {
      switch (item.type) {
        case "header":
          return <SectionHeader title={item.title} count={item.count} tone={item.warn ? colors.waiting : undefined} />;
        case "need":
          return (
            <View style={{ paddingBottom: 12 }}>
              <NeedCard session={item.session} now={now} />
            </View>
          );
        case "row":
          return <SessionRow session={item.session} position={item.position} now={now} />;
        case "terminal":
          return <TerminalRow terminal={item.terminal} position={item.position} now={now} />;
      }
    },
    [now],
  );

  return (
    <>
      <LegendList
        data={loaded && !empty ? items : []}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.type}
        renderItem={renderItem}
        extraData={now}
        estimatedItemSize={64}
        recycleItems
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: 32 + tabInset,
        }}
        style={{ flex: 1, backgroundColor: colors.background }}
        refreshing={refreshing}
        onRefresh={onRefresh}
        ListHeaderComponent={
          <View>
            <PageHeader title="首页" actions={[NEW_SESSION]}>
              <Summary waiting={waiting} />
            </PageHeader>
            <ConnectionBanner />
          </View>
        }
        ListFooterComponent={
          loaded && !empty ? (
            <Pressable
              onPress={() => router.push("/archived")}
              accessibilityRole="button"
              hitSlop={8}
              style={{ alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 18 }}
            >
              <Icon sf="archivebox" md="archive" size={13} color={colors.tertiaryLabel} />
              <Text style={[type.footnote, { color: colors.tertiaryLabel }]}>已归档的会话</Text>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={
          !hasComputer ? (
            <Welcome />
          ) : !loaded ? (
            error ? (
              <EmptyState
                icon={{ sf: "exclamationmark.triangle", md: "warning" }}
                title="读取会话失败"
                message={error}
                action={{ title: "重试", onPress: () => void refresh() }}
              />
            ) : offline ? (
              <WaitingForComputer what="电脑上的会话" />
            ) : (
              <LoadingState label="正在读取会话…" />
            )
          ) : (
            <EmptyState
              icon={{ sf: "bubble.left.and.text.bubble.right", md: "forum" }}
              title="还没有会话"
              message="在电脑终端里用 linkshell claude 或 linkshell codex 开始，或者直接在这里新建。"
              action={{ title: "新建会话", onPress: () => router.push("/new") }}
            />
          )
        }
      />
      <StatusBarFade />
    </>
  );
}
