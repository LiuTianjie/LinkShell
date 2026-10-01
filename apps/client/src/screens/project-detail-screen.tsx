import { RpcError, type SessionSummary, type WorktreeEntry } from "@linkshell/wire";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { BranchTag } from "@/components/branch-tag";
import { SessionRow } from "@/components/session-row";
import { TerminalRow } from "@/components/terminal-row";
import { useTerminals } from "@/lib/terminals";
import { EmptyState } from "@/components/state-views";
import { useActions, useClient } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { baseName, shortPath } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { useFloatingTabInset } from "@/components/floating-tabs";
import { HeaderActions } from "@/components/header-actions";

/**
 * Worktrees of this project that no session uses any more: what is still in
 * them, and a way to remove them. Nothing when there are none.
 */
function UnusedWorktrees({ source, sessionCount }: { source: string; sessionCount: number }) {
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
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                minHeight: 44,
                paddingRight: 8,
                opacity: removing === entry.path ? 0.4 : 1,
                borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                borderTopColor: colors.separator,
              }}
            >
              <BranchTag branch={entry.branch} size={14} max={26} color={colors.label} />
              <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
                {state}
              </Text>
              <Pressable
                onPress={() => remove(entry)}
                accessibilityRole="button"
                accessibilityLabel={`删除 worktree ${entry.branch}`}
                hitSlop={8}
                style={({ pressed }) => ({ paddingHorizontal: 8, paddingVertical: 8, opacity: pressed ? 0.5 : 1 })}
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
  const tabInset = useFloatingTabInset();
  const { cwd } = useLocalSearchParams<{ cwd: string }>();
  const sessionsById = useClient((state) => state.sessions);
  const now = useNow();
  const branch = useClient((state) => state.projects.find((project) => project.cwd === cwd)?.branch);
  const { terminals } = useTerminals();
  // Agent sessions and terminals in this directory, newest first.
  const entries = useMemo(
    () =>
      [
        ...Object.values(sessionsById)
          // Sessions in a worktree of this project are this project's, in with the rest by time.
          .filter((session: SessionSummary) => (session.worktree ? session.worktree.source === cwd : session.cwd === cwd) && !session.archived)
          .map((session) => ({ key: session.id, at: session.updatedAt, session })),
        ...terminals.filter((terminal) => terminal.cwd === cwd).map((terminal) => ({ key: `t-${terminal.id}`, at: terminal.activeAt, terminal })),
      ].sort((a, b) => b.at - a.at),
    [sessionsById, terminals, cwd],
  );

  return (
    <>
      <Stack.Screen options={{ title: baseName(cwd ?? "") }} />
      <HeaderActions
        actions={[
          {
            kind: "button",
            key: "new",
            icon: { sf: "plus", md: "add" },
            label: "在这个项目里新建会话",
            onPress: () => router.push({ pathname: "/new", params: { cwd } }),
          },
        ]}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 + tabInset, paddingTop: 8, gap: 12 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
          <Text selectable numberOfLines={1} style={[type.footnote, { flexShrink: 1, color: colors.secondaryLabel }]}>
            {shortPath(cwd ?? "")}
          </Text>
          {branch ? (
            <View style={{ flexShrink: 0 }}>
              <BranchTag branch={branch} size={13} max={20} />
            </View>
          ) : null}
        </View>
        {entries.length === 0 ? (
          <EmptyState
            icon={{ sf: "bubble.left.and.bubble.right", md: "forum" }}
            title="这个项目还没有会话"
            action={{ title: "新建会话", onPress: () => router.push({ pathname: "/new", params: { cwd } }) }}
          />
        ) : (
          <View>
            {entries.map((entry, index) => {
              const position = entries.length === 1 ? "only" : index === 0 ? "first" : index === entries.length - 1 ? "last" : "middle";
              return "session" in entry ? (
                <SessionRow key={entry.key} session={entry.session} showProject={false} now={now} position={position} />
              ) : (
                <TerminalRow key={entry.key} terminal={entry.terminal} showProject={false} now={now} position={position} />
              );
            })}
          </View>
        )}
        <UnusedWorktrees source={cwd ?? ""} sessionCount={entries.length} />
      </ScrollView>
    </>
  );
}
