import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  ErrorNotice,
  LoadState,
  useClient,
  useConnection,
  useLoad,
} from "./common";

/** A bookmark may point beyond the first list page, including an archived chat. */
export function SessionLookup({
  id,
  navigate,
}: {
  id: string;
  navigate: (id: string) => void;
}) {
  const { link, store } = useConnection();
  const online = useClient((state) => state.status === "online");
  const lookup = useLoad(async () => {
    if (!online) return undefined;
    try {
      const result = await link.call("sessions.subscribe", {
        sessionId: id,
        fromSeq: 0,
        lazyImages: true,
      });
      return result.session;
    } finally {
      // The conversation establishes its own resumable subscription after it mounts.
      if (!store.getState().open[id])
        await link
          .call("sessions.unsubscribe", { sessionId: id })
          .catch(() => {});
    }
  }, [link, store, id, online]);
  useEffect(() => {
    if (lookup.value?.id === id)
      store.setState((state) => ({
        sessions: { ...state.sessions, [id]: lookup.value! },
      }));
  }, [store, id, lookup.value]);
  if (!lookup.error)
    return (
      <div className="workspace-load">
        <LoadState loading />
        <p className="muted">
          {online ? "正在打开会话…" : "连接恢复后将继续打开此会话。"}
        </p>
      </div>
    );
  return (
    <EmptyState
      title="暂时无法打开会话"
      description="请确认当前电脑和会话链接。会话可能已被移除，也可能暂时无法读取。"
    >
      <ErrorNotice
        error={
          /not found/i.test(lookup.error)
            ? "当前电脑上找不到此会话。"
            : lookup.error
        }
      />
      <div className="flex gap-2">
        <Button variant="outline" disabled={!online} onClick={lookup.reload}>
          重试
        </Button>
        <Button onClick={() => navigate("home")}>返回会话概览</Button>
      </div>
    </EmptyState>
  );
}
