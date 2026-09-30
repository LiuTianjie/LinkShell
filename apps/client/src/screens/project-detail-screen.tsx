import type { SessionSummary } from "@linkshell/wire";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { SessionRow } from "@/components/session-row";
import { TerminalRow } from "@/components/terminal-row";
import { useTerminals } from "@/lib/terminals";
import { EmptyState } from "@/components/state-views";
import { useClient } from "@/lib/client";
import { baseName, shortPath } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { useFloatingTabInset } from "@/components/floating-tabs";
import { HeaderActions } from "@/components/header-actions";

export function ProjectDetailScreen() {
  const tabInset = useFloatingTabInset();
  const { cwd } = useLocalSearchParams<{ cwd: string }>();
  const sessionsById = useClient((state) => state.sessions);
  const now = useNow();
  const { terminals } = useTerminals();
  // Agent sessions and terminals in this directory, newest first.
  const entries = useMemo(
    () =>
      [
        ...Object.values(sessionsById)
          .filter((session: SessionSummary) => session.cwd === cwd && !session.archived)
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
        <Text selectable style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
          {shortPath(cwd ?? "")}
        </Text>
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
      </ScrollView>
    </>
  );
}
