import { RpcError, type SessionSummary, type WorktreeEntry } from "@linkshell/wire";
import { groupProjects, projectLocation } from "@linkshell/client-core";
import { router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { BranchTag } from "@/components/branch-tag";
import { SessionRow } from "@/components/session-row";
import { TerminalRow } from "@/components/terminal-row";
import { useTerminals } from "@/lib/terminals";
import { EmptyState, LoadingState, WaitingForComputer, unreachable } from "@/components/state-views";
import { useActions, useClient, useConnection, useConnectionRecovering, useConnectionStatus } from "@/lib/client";
import { listComputers, retryComputerDiscovery, useComputerDiscovery, useComputers } from "@/lib/computers";
import { haptics } from "@/lib/haptics";
import { baseName, shortPath } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { useFloatingTabInset } from "@/components/floating-tabs";
import { HeaderActions } from "@/components/header-actions";
import { useContentWidth } from "@/lib/content-width";

/**
 * Worktrees of this project that no session uses any more: what is still in
 * them, and a way to remove them. Nothing when there are none.
 */
function UnusedWorktrees({ source, sessionCount }: { source: string; sessionCount: number }) {
  const stacked = useContentWidth() < 480;
  const { listWorktrees, removeWorktree } = useActions();
  const online = useClient((state) => state.status === "online");
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = () =>
    listWorktrees().then(
      (all) => setWorktrees(all.filter((entry) => entry.source === source && entry.sessions.length === 0)),
      () => {},
    );
  // (Again when a session of the project goes: its worktree may have been kept.)
  useEffect(() => {
    if (online) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, source, sessionCount]);

  if (!worktrees.length) return null;

  const run = (entry: WorktreeEntry, force: boolean) => {
    setRemoving(entry.path);
    removeWorktree(entry.path, force)
      .then(() => haptics.success())
      .catch((reason: unknown) => {
        const code = reason instanceof RpcError ? reason.appCode : undefined;
        if (code === "dirty") {
          Alert.alert("里面还有没保存到别处的工作", "未提交的改动或没合并的提交会一起丢掉，无法恢复。", [
            { text: "取消", style: "cancel" },
            { text: "仍然删除", style: "destructive", onPress: () => run(entry, true) },
          ]);
        } else if (code === "busy") {
          Alert.alert("还有会话在用这个 worktree", "先删除那些会话，再删除它。");
        } else {
          haptics.error();
          Alert.alert("没能删除", reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        setRemoving(null);
        void load();
      });
  };
  const remove = (entry: WorktreeEntry) => {
    Alert.alert(`删除 worktree「${entry.branch.replace(/^linkshell\//, "")}」？`, "它的目录和分支会一起删除。", [
      { text: "取消", style: "cancel" },
      { text: "删除", style: "destructive", onPress: () => run(entry, false) },
    ]);
  };

  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      <Text style={[type.footnote, { color: colors.tertiaryLabel, paddingHorizontal: 4 }]}>未使用的 worktree</Text>
      <View style={{ backgroundColor: colors.card, borderRadius: 18, borderCurve: "continuous", paddingLeft: 14 }}>
        {worktrees.map((entry, index) => {
          const state = [entry.dirty ? "有未提交改动" : null, entry.ahead ? `领先 ${entry.ahead} 个提交` : null].filter(Boolean).join(" · ");
          return (
            <View
              key={entry.path}
              style={{
                flexDirection: stacked ? "column" : "row",
                alignItems: stacked ? "stretch" : "center",
                gap: 8,
                minHeight: 44,
                paddingVertical: stacked ? 10 : 0,
                paddingRight: 8,
                opacity: removing === entry.path ? 0.4 : 1,
                borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                borderTopColor: colors.separator,
              }}
            >
              <BranchTag branch={entry.branch} size={14} max={26} color={colors.label} />
              <Text numberOfLines={stacked ? 2 : 1} style={[type.footnote, { flex: stacked ? undefined : 1, color: colors.secondaryLabel }]}>
                {state}
              </Text>
              <Pressable
                onPress={() => remove(entry)}
                accessibilityRole="button"
                accessibilityLabel={`删除 worktree ${entry.branch}`}
                hitSlop={8}
                style={({ pressed }) => ({ alignSelf: stacked ? "flex-end" : undefined, paddingHorizontal: 8, paddingVertical: 8, opacity: pressed ? 0.5 : 1 })}
              >
                <Text style={[type.subhead, { color: colors.danger }]}>删除</Text>
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export function ProjectDetailScreen() {
  const contentWidth = useContentWidth();
  const wide = contentWidth >= 768;
  const entryWidth = wide ? (contentWidth - 48) / 2 : "100%";
  const tabInset = useFloatingTabInset();
  const { cwd, computerKey, generated: generatedParam } = useLocalSearchParams<{ cwd: string; computerKey?: string; generated?: string }>();
  const focused = useIsFocused();
  const discovery = useComputerDiscovery();
  const recovering = useConnectionRecovering();
  const displayStatus = useConnectionStatus();
  const { computer } = useConnection();
  const matchingComputer = !computerKey || computerKey === computer.key;
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const hasTarget = !computerKey || listComputers({ saved, live }).some((entry) => entry.key === computerKey);
  const sessionsById = useClient((state) => state.sessions);
  const projects = useClient((state) => state.projects);
  const loaded = useClient((state) => state.sessionsLoaded);
  const status = useClient((state) => state.status);
  const sessionsError = useClient((state) => state.sessionsError);
  const offline = useClient((state) => unreachable(state.status));
  const nextBefore = useClient((state) => state.sessionsNextBefore);
  const { loadMoreSessions, refresh } = useActions();
  const [loadingMore, setLoadingMore] = useState(false);
  const generated = generatedParam === "1";
  const group = useMemo(() => groupProjects(projects, Object.values(sessionsById)).find((project) => project.cwd === cwd && project.generated === generated), [projects, sessionsById, cwd, generated]);
  const now = useNow();
  const branch = group?.branch;
  const { terminals } = useTerminals();
  useEffect(() => {
    // Tab stacks stay mounted: a hidden project must not undo a computer selected elsewhere.
    if (focused && computerKey && hasTarget && !matchingComputer) useComputers.getState().select(computerKey);
  }, [computerKey, matchingComputer, hasTarget, focused]);
  // Agent sessions and terminals in this directory, newest first.
  const entries = useMemo(
    () =>
      [
        ...Object.values(sessionsById)
          // Sessions in a worktree of this project are this project's, in with the rest by time.
          .filter((session: SessionSummary) => {
            const source = session.worktree?.source ?? session.cwd;
            const location = projectLocation(source);
            return !session.archived && (generated ? location.generated && location.key === cwd : source === cwd);
          })
          .map((session) => ({ key: session.id, at: session.updatedAt, session })),
        ...terminals.filter((terminal) => {
          const location = projectLocation(terminal.cwd);
          return generated ? location.generated && location.key === cwd : terminal.cwd === cwd;
        }).map((terminal) => ({ key: `t-${terminal.id}`, at: terminal.activeAt, terminal })),
      ].sort((a, b) => b.at - a.at),
    [sessionsById, terminals, cwd, generated],
  );

  if (!hasTarget) return <><Stack.Screen options={{ title: "项目" }} />{
    discovery === "loading" || (discovery === "failed" && recovering) ? <LoadingState label="正在恢复电脑列表…" />
      : discovery === "failed" || discovery === "refused" ? <EmptyState icon={{ sf: "wifi.exclamationmark", md: "wifi_off" }} title="暂时无法读取电脑列表" action={{ title: "重新连接", onPress: retryComputerDiscovery }} />
        : <EmptyState icon={{ sf: "laptopcomputer", md: "computer" }} title="这台电脑已不在列表中" message="连接电脑后，可重新打开它的项目。" action={{ title: "查看电脑", onPress: () => router.push("/computers") }} />
  }</>;
  if (matchingComputer && status === "locked") return <><Stack.Screen options={{ title: "项目" }} /><EmptyState icon={{ sf: "lock", md: "lock" }} title="这台电脑需要访问密码" action={{ title: "输入访问密码", onPress: () => router.push("/unlock") }} /></>;
  if (!matchingComputer || !loaded) return <><Stack.Screen options={{ title: "项目" }} />{matchingComputer && sessionsError && displayStatus !== "connecting" ? <EmptyState icon={{ sf: "exclamationmark.circle", md: "error" }} title="未能读取项目" message={sessionsError} action={{ title: "重试", onPress: () => void refresh() }} /> : matchingComputer && unreachable(displayStatus) ? <WaitingForComputer what="这个项目的会话" /> : <LoadingState label="正在读取项目…" />}</>;

  return (
    <>
      <Stack.Screen options={{ title: group?.name ?? (generated ? "Codex Chats" : baseName(cwd ?? "")) }} />
      <HeaderActions
        actions={[
          {
            kind: "button",
            key: "new",
            icon: { sf: "plus", md: "add" },
            label: "在这个项目里新建会话",
            onPress: () => router.push({ pathname: "/new", params: generated ? {} : { cwd } }),
          },
        ]}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 + tabInset, paddingTop: 8, gap: 12 }}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
          <Text selectable numberOfLines={1} style={[type.footnote, { flexShrink: 1, color: colors.secondaryLabel }]}>
            {generated ? "Codex 自动创建的会话目录，按最近活动汇总" : shortPath(cwd ?? "")}
          </Text>
          {branch ? (
            <View style={{ flexShrink: 1, maxWidth: "100%" }}>
              <BranchTag branch={branch} size={13} max={20} />
            </View>
          ) : null}
        </View>
        {entries.length === 0 ? (
          <EmptyState
            icon={{ sf: "bubble.left.and.bubble.right", md: "forum" }}
            title="这个项目还没有会话"
            action={{ title: "新建会话", onPress: () => router.push({ pathname: "/new", params: generated ? {} : { cwd } }) }}
          />
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: wide ? 16 : 0 }}>
            {entries.map((entry, index) => {
              const position = wide || entries.length === 1 ? "only" : index === 0 ? "first" : index === entries.length - 1 ? "last" : "middle";
              return (
                <View key={entry.key} style={{ width: entryWidth, minWidth: 0 }}>
                  {"session" in entry ? (
                    <SessionRow session={entry.session} showProject={false} now={now} position={position} />
                  ) : (
                    <TerminalRow terminal={entry.terminal} showProject={false} now={now} position={position} />
                  )}
                </View>
              );
            })}
          </View>
        )}
        {nextBefore !== undefined ? <Pressable accessibilityRole="button" disabled={loadingMore || offline} onPress={() => {
          setLoadingMore(true);
          void loadMoreSessions().catch((error: unknown) => Alert.alert("加载失败", error instanceof Error ? error.message : String(error))).finally(() => setLoadingMore(false));
        }} style={{ paddingVertical: 14, alignItems: "center", opacity: loadingMore || offline ? 0.5 : 1 }}><Text style={[type.subhead, { color: colors.accent }]}>{loadingMore ? "正在加载…" : "加载更早的会话"}</Text></Pressable> : null}
        {!generated ? <UnusedWorktrees source={cwd ?? ""} sessionCount={entries.length} /> : null}
      </ScrollView>
    </>
  );
}
