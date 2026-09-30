import { LegendList } from "@legendapp/list/react-native";
import type { SessionSummary } from "@linkshell/wire";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { SessionRow, positionOf } from "@/components/session-row";
import { EmptyState, LoadingState } from "@/components/state-views";
import { useActions, useClient } from "@/lib/client";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";

/** Archived sessions: out of the way, one long-press from coming back. */
export function ArchivedScreen() {
  const sessionsById = useClient((state) => state.sessions);
  const { loadArchived } = useActions();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    loadArchived().then(
      () => setLoaded(true),
      (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [loadArchived]);

  const archived = useMemo(
    () =>
      Object.values(sessionsById)
        .filter((session) => session.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessionsById],
  );

  return (
    <LegendList<SessionSummary>
      data={archived}
      keyExtractor={(session) => session.id}
      renderItem={({ item, index }) => <SessionRow session={item} position={positionOf(index, archived.length)} now={now} />}
      estimatedItemSize={64}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16 }}
      style={{ flex: 1, backgroundColor: colors.background }}
      ListEmptyComponent={
        error ? (
          <EmptyState icon={{ sf: "exclamationmark.triangle", md: "warning" }} title="读取失败" message={error} />
        ) : !loaded ? (
          <LoadingState label="正在读取…" />
        ) : (
          <View style={{ paddingTop: 40 }}>
            <EmptyState icon={{ sf: "archivebox", md: "archive" }} title="没有归档的会话" message="长按会话可以归档，归档后不会出现在首页。" />
          </View>
        )
      }
    />
  );
}
