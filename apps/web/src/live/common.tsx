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
// Session states use the names every end shares (docs/design/visual-system.md); a task's or a
// workflow's own outcomes (已完成, 失败, 等待中) keep theirs.
export const stateLabel = (state: string) =>
  ({
    idle: "空闲",
    waiting: "等你处理",
    running: "运行中",
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
const AGENT_KEY_ALIASES: Record<string, string> = {
  claude: "claude",
  "claude-code": "claude",
  anthropic: "claude",
  codex: "codex",
  "codex-cli": "codex",
  openai: "codex",
  gemini: "gemini",
  "gemini-cli": "gemini",
  google: "gemini",
  cursor: "cursor",
  "cursor-agent": "cursor",
  opencode: "opencode",
  cline: "cline",
  kilo: "kilo",
  kilocode: "kilo",
  "kilo-code": "kilo",
  copilot: "copilot",
  "github-copilot": "copilot",
  grok: "grok",
  xai: "grok",
  antigravity: "antigravity",
  agy: "antigravity",
  qwen: "qwen",
  "qwen-code": "qwen",
  kimi: "kimi",
  "kimi-code": "kimi",
  moonshot: "kimi",
  codebuddy: "codebuddy",
  "codebuddy-code": "codebuddy",
  cbc: "codebuddy",
  qoder: "qoder",
  qodercli: "qoder",
  minimax: "minimax",
  "minimax-code": "minimax",
  mcode: "minimax",
  "code-acp": "minimax",
  trae: "trae",
  traecli: "trae",
  "trae-cli": "trae",
  deepseek: "deepseek",
  "deepseek-harness": "deepseek",
  dsh: "deepseek",
  glm: "glm",
  "glm-acp-agent": "glm",
  zhipu: "glm",
  zai: "glm",
  iflow: "iflow",
  "iflow-cli": "iflow",
  comate: "comate",
  "comate-acp": "comate",
  zulu: "comate",
};

const AGENT_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  gemini: "Gemini",
  antigravity: "Antigravity",
  copilot: "Copilot",
  grok: "Grok",
  opencode: "OpenCode",
  cursor: "Cursor",
  cline: "Cline",
  kilo: "Kilo Code",
  qwen: "Qwen Code",
  kimi: "Kimi Code",
  codebuddy: "CodeBuddy",
  qoder: "Qoder",
  minimax: "MiniMax Code",
  trae: "TRAE",
  deepseek: "DeepSeek",
  glm: "GLM",
  iflow: "iFlow",
  comate: "Comate",
};

export function normalizeAgentKey(agent: string): string {
  const cleaned = agent.trim().toLowerCase();
  return AGENT_KEY_ALIASES[cleaned] ?? cleaned;
}

export function agentLabel(agent: string, knownLabel?: string): string {
  const custom = knownLabel?.trim();
  if (custom) return custom;
  const normalized = normalizeAgentKey(agent);
  return AGENT_LABELS[normalized] ?? (agent.trim() || "Agent");
}

function agentMarkSrc(svg: string, inkColor: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.replaceAll("currentColor", inkColor))}`;
}

/** sm = list rows (18px), md = headings (24px). The size lives here so no row can crowd its title. */
export function AgentMark({
  agent,
  size = "sm",
}: {
  agent: string;
  size?: "sm" | "md";
}) {
  const normalized = normalizeAgentKey(agent);
  const mark = agentMarks[normalized];
  const label = agentLabel(agent);
  const style = mark?.bg
    ? ({
        "--agent-mark-bg-light": mark.bg.light,
        "--agent-mark-bg-dark": mark.bg.dark,
        boxShadow: "none",
      } as CSSProperties)
    : undefined;
  const lightInk = mark?.fg?.light ?? "#333";
  const darkInk = mark?.fg?.dark;
  const dualTone = Boolean(mark && darkInk && darkInk !== lightInk);
  return (
    <span
      data-size={size}
      data-agent={normalized}
      className={`agent-mark ${normalized} ${mark?.full ? "full-mark" : ""}`}
      style={style}
    >
      {mark ? (
        dualTone ? (
          <>
            <img
              className="agent-mark-light"
              src={agentMarkSrc(mark.svg, lightInk)}
              alt={label}
            />
            <img
              className="agent-mark-dark"
              src={agentMarkSrc(mark.svg, darkInk!)}
              alt=""
              aria-hidden="true"
            />
          </>
        ) : (
          <img
            src={agentMarkSrc(mark.svg, lightInk)}
            alt={label}
          />
        )
      ) : (
        (agent.trim().slice(0, 1) || "A").toUpperCase()
      )}
    </span>
  );
}
/** A state as a badge, coloured like StatusText: only running, waiting on the person and errors. */
export function Badge({ state, label }: { state: string; label?: string }) {
  return (
    <StatusBadge
      variant={
        ["error", "failed"].includes(state)
          ? "destructive"
          : ["waiting", "blocked"].includes(state)
            ? "warning"
            : ["running", "active"].includes(state)
              ? "info"
              : "secondary"
      }
    >
      <span className="status-dot" />
      {label ?? stateLabel(state)}
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
/** "Load earlier": on the desktop a 28 px secondary button under the list; on the web a full-width row. */
export function LoadMore(props: { disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className="list-row-more" {...props} />;
}
export function Modal({
  title,
  description,
  icon,
  children,
  close,
  wide = false,
  returnFocus,
  className,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
  returnFocus?: () => void;
  className?: string;
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
          className,
        )}
      >
        <DialogHeader className={icon ? "modal-header-with-icon" : undefined}>
          {icon}
          <div className="modal-header-copy">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className={description ? undefined : "sr-only"}>
              {description ?? `${title}设置与操作`}
            </DialogDescription>
          </div>
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
