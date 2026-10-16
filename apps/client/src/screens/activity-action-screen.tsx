import { router, useIsFocused, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { consumeNativeLiveActivityAction, type LiveActivityAction } from "../../modules/link-layout";
import { EmptyState, LoadingState } from "@/components/state-views";
import { useActions, useClient, useConnection, useSessionSubscription } from "@/lib/client";
import { listComputers, useComputers } from "@/lib/computers";
import { isLiveActivityActionCurrent } from "@/lib/live-activity-actions";

function detail(kind: "session" | "terminal", id: string) {
  if (kind === "session") router.replace({ pathname: "/session/[id]", params: { id } });
  else router.replace({ pathname: "/terminal/[id]", params: { id } });
}

export function ActivityActionScreen() {
  const params = useLocalSearchParams<{ action?: string; computer?: string; session?: string; terminal?: string }>();
  return <ActivitySelection key={`${params.action ?? ""}:${params.computer ?? ""}:${params.session ?? params.terminal ?? ""}`} {...params} />;
}

function ActivitySelection(params: { action?: string; computer?: string; session?: string; terminal?: string }) {
  const [selection, setSelection] = useState<LiveActivityAction | null>(null);
  const [error, setError] = useState("");
  // Effect replay can read the same result, but a later visit cannot replay a choice.
  const selectionRead = useRef<Promise<LiveActivityAction | null> | null>(null);
  const started = useRef(false);
  const expired = useRef(false);
  const focused = useIsFocused();
  const computerKey = selection?.computerKey ?? params.computer ?? "";
  const sessionId = selection?.sessionId ?? params.session ?? "";
  const { computer } = useConnection();
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const online = useClient((state) => state.status === "online");
  const ready = useClient((state) => Boolean(state.ready[sessionId]));
  const session = useClient((state) => state.sessions[sessionId]);
  const permissions = useClient((state) => state.views[sessionId]?.permissions);
  const actions = useActions();
  const connected = computer.key === computerKey;
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
      if (started.current) return;
      expired.current = true;
      setError("暂时无法连接这台电脑，尚未提交操作。请进入详情后重新选择。");
    }, 20_000);
    return () => clearTimeout(timer);
  }, [params.action]);

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
    computer.key, session, permissions, actions, sessionId]);

  return <View style={{ flex: 1, justifyContent: "center" }}>
    {error ? <EmptyState icon={{ sf: "clock.badge.exclamationmark", md: "info_outline" }} title="请查看任务详情" message={error}
      action={{ title: connected && sessionId ? "打开详情" : "返回首页", onPress: () => connected && sessionId ? detail("session", sessionId) : router.replace("/") }} />
      : <LoadingState label={selection ? `正在提交“${selection.label}”…` : "正在打开任务…"} />}
  </View>;
}
