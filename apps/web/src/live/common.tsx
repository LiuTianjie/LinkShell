import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
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
import { Badge as StatusBadge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
} from "@/components/ui/empty";
import { CircleAlert } from "lucide-react";

export const Runtime = createContext<Connection | null>(null);
// A socket can be online before this conversation's backlog has been restored.
// Summary-level approvals outside a conversation keep their existing connection gate.
export const SessionReady = createContext(true);
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
export function useSessionOnline() {
  const ready = useContext(SessionReady);
  const online = useClient((state) => state.status === "online");
  return online && ready;
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
/** sm = list rows (18px), md = headings (24px). The size lives here so no row can crowd its title. */
function isLightTile(hex: string): boolean {
  const value = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
  if (Number.isNaN(value)) return false;
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 160;
}

export function AgentMark({
  agent,
  size = "sm",
}: {
  agent: string;
  size?: "sm" | "md";
}) {
  const mark = agentMarks[agent.toLowerCase()];
  return (
    <span
      data-size={size}
      className={`agent-mark ${agent.toLowerCase()} ${mark?.full ? "full-mark" : ""}`}
      // The glyph is drawn in its light-scheme colour, so it needs its own tile: a white
      // Copilot or Grok mark on the page's light inset would not be seen.
      // A light tile (Claude's cream) would be the brightest thing on a dark page: the desktop's dark
      // theme swaps it for the mark's own dark tile, which keeps the glyph's colour readable.
      style={mark?.bg ? { background: mark.bg.light, boxShadow: "none", ...(isLightTile(mark.bg.light) ? { "--agent-mark-dark": mark.bg.dark } : {}) } as CSSProperties : undefined}
      data-light-tile={mark?.bg && isLightTile(mark.bg.light) ? "" : undefined}
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
    <StatusBadge
      variant={
        ["error", "failed"].includes(state)
          ? "destructive"
          : ["waiting", "pending", "blocked"].includes(state)
            ? "warning"
            : ["running", "active"].includes(state)
              ? "info"
              : ["idle", "completed", "complete"].includes(state)
                ? "success"
                : "secondary"
      }
    >
      <span className="status-dot" />
      {stateLabel(state)}
    </StatusBadge>
  );
}
export function ErrorNotice({ error }: { error?: string }) {
  return error ? (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;
}
export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
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
  // These dialogs are mounted directly, so Radix has no trigger to restore.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus) returnFocus();
          else if (opener?.isConnected) opener.focus({ preventScroll: true });
        }}
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
        <div
          className="loading-copy flex w-full flex-col gap-3"
          role="status"
          aria-label="正在加载"
        >
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-full max-w-md" />
          <span className="sr-only">正在加载…</span>
        </div>
      )}
      <ErrorNotice error={error} />
    </>
  );
}
