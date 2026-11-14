import { LegendList } from "@legendapp/list/react-native";
import type { SessionSummary } from "@linkshell/wire";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { SessionRow, positionOf } from "@/components/session-row";
import { EmptyState, LoadingState, unreachable, WaitingForComputer } from "@/components/state-views";
import { useActions, useClient } from "@/lib/client";
import { describeActionError } from "@/lib/locale";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";

/** Archived sessions: out of the way, one long-press from coming back. */
export function ArchivedScreen() {
  const sessionsById = useClient((state) => state.sessions);
  const { loadArchived } = useActions();
  const [loaded, setLoaded] = useState(false);
  const offline = useClient((state) => unreachable(state.status));
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const online = useClient((state) => state.status === "online");
  // (Again) whenever the computer comes back.
  const nextBefore = useClient((state) => state.archivedNextBefore);
  const paging = useRef(false);
  useEffect(() => {
    if (!online) return;
    setError(null);
    loadArchived().then(
      () => setLoaded(true),
      (reason: unknown) => setError(describeActionError(reason)),
    );
  }, [loadArchived, online]);

  const archived = useMemo(
    () =>
      Object.values(sessionsById)
        .filter((session) => session.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessionsById],
  );

  // A page is the newest sessions of every kind, so one can hold few archived ones or none:
  // keep going while the screen isn't full, and on from there as the list is scrolled.
  const more = useCallback(() => {
    if (!online || !loaded || nextBefore === undefined || paging.current) return;
    paging.current = true;
    void loadArchived(nextBefore).catch(() => undefined).finally(() => { paging.current = false; });
  }, [loadArchived, loaded, nextBefore, online]);
  useEffect(() => {
    if (archived.length < 20) more();
  }, [archived.length, more]);

  return (
    <LegendList<SessionSummary>
      onEndReached={more}
      onEndReachedThreshold={0.5}
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
        ) : !loaded || nextBefore !== undefined ? (
          offline ? <WaitingForComputer what="归档的会话" /> : <LoadingState label="正在读取…" />
        ) : (
          <View style={{ paddingTop: 40 }}>
            <EmptyState icon={{ sf: "archivebox", md: "archive" }} title="没有归档的会话" message="长按会话可以归档，归档后不会出现在首页。" />
          </View>
        )
      }
    />
  );
}
