import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { ClientState, ClientActions } from "@linkshell/client-core";
import { agentMarks } from "../../../client/src/theme/agent-marks";
import type { Connection } from "./engine";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export const Runtime = createContext<Connection | null>(null);
export function useConnection() {
  const value = useContext(Runtime);
  if (!value) throw new Error("尚未连接电脑");
  return value;
}
export function useClient<T>(
  selector: (state: ClientState & ClientActions) => T,
): T {
  return useStore(useConnection().store, selector);
}
export function useActions() {
  return useConnection().store.getState();
}
export const messageOf = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
export const baseName = (path: string) =>
  path.replace(/\/$/, "").split("/").pop() ?? path;
export const titleOf = (session: { title?: string; cwd: string }) =>
  session.title || baseName(session.cwd) || "未命名会话";
export const stateLabel = (state: string) =>
  ({
    idle: "已完成",
    waiting: "需要你",
    running: "进行中",
    error: "出错",
    offline: "离线",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止",
    pending: "等待中",
    active: "进行中",
    paused: "已暂停",
    complete: "已完成",
    blocked: "待处理",
    usageLimited: "用量受限",
    budgetLimited: "预算已用完",
    unknown: "未知",
  })[state] ?? state;
export function AgentMark({ agent }: { agent: string }) {
  const mark = agentMarks[agent.toLowerCase()];
  return (
    <span
      className={`agent-mark ${agent.toLowerCase()} ${mark?.full ? "full-mark" : ""}`}
    >
      {mark ? (
        <img
          src={`data:image/svg+xml,${encodeURIComponent(mark.svg.replaceAll("currentColor", mark.fg?.light ?? "#333"))}`}
          alt={agent}
        />
      ) : (
        agent.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
export function Badge({ state }: { state: string }) {
  return (
    <span
      className={`badge ${state === "idle" || state === "completed" ? "done" : state}`}
    >
      <span className="status-dot" />
      {stateLabel(state)}
    </span>
  );
}
export function ErrorNotice({ error }: { error?: string }) {
  return error ? (
    <p role="alert" className="form-error">
      {error}
    </p>
  ) : null;
}
export function Modal({
  title,
  children,
  close,
  wide = false,
  returnFocus,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
  returnFocus?: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        onCloseAutoFocus={
          returnFocus
            ? (event) => {
                event.preventDefault();
                returnFocus();
              }
            : undefined
        }
        className={cn(
          "max-h-[85dvh] overflow-y-auto p-6 sm:max-w-xl",
          wide && "sm:max-w-5xl",
        )}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {title}设置与操作
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function useJob() {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (error) {
      setError(messageOf(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { error, busy, run, clear: () => setError(undefined) };
}
export function useLoad<T>(
  load: () => Promise<T>,
  dependencies: readonly unknown[],
  poll = 0,
) {
  const [state, setState] = useState<{
    value?: T;
    error?: string;
    loading: boolean;
  }>({ loading: true });
  const [revision, setRevision] = useState(0);
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    let alive = true;
    let pending = false;
    const fetch = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await latest.current();
        if (alive) setState({ value, loading: false });
      } catch (error) {
        if (alive)
          setState((previous) => ({
            ...previous,
            error: messageOf(error),
            loading: false,
          }));
      } finally {
        pending = false;
      }
    };
    setState({ loading: true });
    void fetch();
    const timer = poll ? setInterval(() => void fetch(), poll) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // Callers supply the identity of the request; changing UI callbacks shouldn't restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, revision, poll]);
  return { ...state, reload: () => setRevision((value) => value + 1) };
}
export function LoadState({
  loading,
  error,
}: {
  loading: boolean;
  error?: string;
}) {
  return (
    <>
      {loading && (
        <p className="muted loading-copy" role="status">
          正在加载…
        </p>
      )}
      <ErrorNotice error={error} />
    </>
  );
}
