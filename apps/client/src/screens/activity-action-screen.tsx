import { router, useIsFocused, useLocalSearchParams, useNavigation } from "expo-router";
import { CommonActions } from "expo-router/react-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { consumeNativeLiveActivityAction, type LiveActivityAction } from "../../modules/link-layout";
import { EmptyState, LoadingState } from "@/components/state-views";
import { useActions, useClient, useConnection, useSessionSubscription } from "@/lib/client";
import { listComputers, useComputers } from "@/lib/computers";
import { isLiveActivityActionCurrent } from "@/lib/live-activity-actions";
import { activityEntries, activityRoute, activityDetailStack, type ActivityFilter, type ActivityRoute } from "@/lib/live-activity-navigation";
import { useTerminals } from "@/lib/terminals";
import { useNow } from "@/lib/use-now";
import { Text } from "@/components/fixed-text";
import { SessionRow, positionOf } from "@/components/session-row";
import { TerminalRow } from "@/components/terminal-row";
import { colors } from "@/theme/colors";

export function ActivityActionScreen() {
  const params = activityRoute(useLocalSearchParams());
  return <ActivitySelection key={JSON.stringify(params)} {...params} />;
}

function ActivitySelection(params: ActivityRoute) {
  const navigation = useNavigation("/");
  const [selection, setSelection] = useState<LiveActivityAction | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Effect replay can read the same result, but a later visit cannot replay a choice.
  const selectionRead = useRef<Promise<LiveActivityAction | null> | null>(null);
  const started = useRef(false);
  const expired = useRef(false);
  const focused = useIsFocused();
  const sessionId = selection?.sessionId ?? params.session ?? "";
  const { computer, link } = useConnection();
  const computerKey = selection?.computerKey ?? params.computer ?? (params.action ? "" : computer.key);
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const online = useClient((state) => state.status === "online");
  const ready = useClient((state) => Boolean(state.ready[sessionId]));
  const session = useClient((state) => state.sessions[sessionId]);
  const detail = useCallback((kind: "session" | "terminal", id: string) => {
    navigation.dispatch(CommonActions.reset(activityDetailStack(navigation.getState()?.routes ?? [], kind, id)));
  }, [navigation]);
  const permissions = useClient((state) => state.views[sessionId]?.permissions);
  const actions = useActions();
  const connected = computer.key === computerKey;
  const list = !params.action && !params.session && !params.terminal;
  useSessionSubscription(sessionId, Boolean(selection && connected && online && focused));

  useEffect(() => {
    if (!params.action) return;
    let cancelled = false;
    selectionRead.current ??= consumeNativeLiveActivityAction(params.action);
    void selectionRead.current.then((action) => {
      if (cancelled) return;
      if (action) setSelection(action);
      else setError("这个操作已处理或已过期，请从实时活动重新打开。");
    }).catch(() => { if (!cancelled) setError("无法读取选中的操作，请从任务详情处理。"); });
    return () => { cancelled = true; };
  }, [params.action]);

  useEffect(() => {
    if (!computerKey || connected || !focused) return;
    if (listComputers({ saved, live }).some((item) => item.key === computerKey)) {
      useComputers.getState().select(computerKey);
    }
  }, [computerKey, connected, focused, saved, live]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (started.current || (list && connected && online)) return;
      expired.current = true;
      setError(params.action ? "暂时无法连接这台电脑，尚未提交操作。请进入详情后重新选择。" : "暂时无法连接这台电脑。请确认电脑在线后重试。");
    }, 20_000);
    return () => clearTimeout(timer);
  }, [params.action, list, connected, online, attempt]);

  useEffect(() => {
    if (!connected || !focused || started.current || expired.current || error) return;
    if (!params.action) {
      const id = params.session || params.terminal;
      if (id) {
        started.current = true;
        detail(params.session ? "session" : "terminal", id);
      }
      return;
    }
    if (!selection || !online || !ready) return;
    started.current = true;
    if (!isLiveActivityActionCurrent(selection, computer.key, session, permissions)) {
      setError("这个请求已处理或选项已变化，请在详情中查看最新状态。");
      return;
    }
    const submit = async () => {
      if (selection.kind === "permission") {
        await actions.respond(sessionId, selection.requestId, selection.optionId);
      } else if (selection.kind === "answer") {
        await actions.answer(sessionId, selection.requestId, [{ id: selection.questionId!, values: [selection.optionId] }]);
      } else {
        const question = session!.asyncQuestions!.find((item) => item.id === selection.requestId)!;
        await actions.answerAsync(sessionId, question, selection.optionId);
      }
      detail("session", sessionId);
    };
    // An uncertain response is never automatically replayed as another approval.
    void submit().catch(() => setError("未能确认操作结果，请打开任务详情查看；不会自动重复提交。"));
  }, [connected, focused, error, params.action, params.session, params.terminal, selection, online, ready,
    computer.key, session, permissions, actions, sessionId, detail]);

  if (list && connected && online && !error) return <ActivityTaskList initialFilter={params.filter} />;

  return <View style={{ flex: 1, justifyContent: "center" }}>
    {error ? <EmptyState icon={{ sf: "clock.badge.exclamationmark", md: "info_outline" }} title="请查看任务详情" message={error}
      action={{ title: connected && sessionId ? "打开详情" : params.action ? "返回首页" : "重试连接", onPress: () => {
        if (connected && sessionId) detail("session", sessionId);
        else if (params.action) router.replace("/");
        else { expired.current = false; setError(""); setAttempt((value) => value + 1); link.reconnectNow(); }
      } }} />
      : <LoadingState label={!connected || !online ? "正在连接电脑…" : selection ? `正在提交“${selection.label}”…` : "正在打开任务…"} />}
  </View>;
}

const filters: Array<[ActivityFilter, string]> = [["all", "全部活动"], ["attention", "需要你"], ["running", "运行中"], ["failed", "出错"], ["completed", "已完成"]];

function ActivityTaskList({ initialFilter }: { initialFilter: ActivityFilter }) {
  const [filter, setFilter] = useState(initialFilter);
  const [timedOut, setTimedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const actions = useActions();
  const sessions = useClient((state) => state.sessions);
  const loaded = useClient((state) => state.sessionsLoaded);
  const sessionsError = useClient((state) => state.sessionsError);
  const { terminals, loaded: terminalsLoaded, error: terminalsError, retry: retryTerminals } = useTerminals();
  const loading = !loaded || !terminalsLoaded;
  useEffect(() => {
    if (!loading) { setTimedOut(false); return; }
    const timer = setTimeout(() => setTimedOut(true), 20_000);
    return () => clearTimeout(timer);
  }, [loading, attempt]);
  const now = useNow();
  const entries = activityEntries(Object.values(sessions), terminals, filter);
  return <View style={{ flex: 1, backgroundColor: colors.background }}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 16, gap: 8 }}>
      {filters.map(([value, title]) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: value === filter }} onPress={() => setFilter(value)}
        style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18, backgroundColor: value === filter ? colors.accentSoft : colors.card }}>
        <Text style={{ color: value === filter ? colors.accent : colors.secondaryLabel, fontSize: 14, fontWeight: "600" }}>{title}</Text>
      </Pressable>)}
    </ScrollView>
    {loading && (timedOut || sessionsError || terminalsError)
      ? <EmptyState icon={{ sf: "wifi.exclamationmark", md: "wifi_off" }} title="暂时无法同步任务" message="请确认电脑在线后重试。"
        action={{ title: "重新同步", onPress: () => {
          setTimedOut(false); setAttempt((value) => value + 1); retryTerminals(); void actions.refresh();
        } }} />
      : loading ? <LoadingState label="正在同步任务…" /> : entries.length === 0
      ? <EmptyState icon={{ sf: "checkmark.circle", md: "check_circle_outline" }} title={filter === "completed" ? "还没有已完成的任务" : "这里的任务已处理完"} message="可以切换分类，或返回首页查看所有会话。" action={{ title: "返回首页", onPress: () => router.replace("/") }} />
      : <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
        {entries.map((entry, index) => entry.kind === "session"
          ? <SessionRow key={entry.session.id} session={entry.session} now={now} position={positionOf(index, entries.length)} />
          : <TerminalRow key={entry.terminal.id} terminal={entry.terminal} now={now} position={positionOf(index, entries.length)} />)}
      </ScrollView>}
  </View>;
}
