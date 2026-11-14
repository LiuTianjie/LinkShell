import { liveActivity, type PromptProgress, type SessionView } from "@linkshell/client-core";
import type { SessionSummary } from "@linkshell/wire";
import { activityText } from "./describe";

export interface TurnActivityState {
  label: string;
  tone: "active" | "waiting" | "muted" | "error";
  animated: boolean;
  /** When the running turn started: the row counts the time from it, on the phone. */
  startedAt?: number;
}

/** Delivery is local; execution belongs to the host. Keep the gap visible without inventing a running turn. */
export function turnActivity({ session, progress, online, connecting, locked, ready, hasPermission, queued, view }: {
  session: SessionSummary;
  progress?: PromptProgress;
  online: boolean;
  connecting?: boolean;
  /** The computer asks for its access password first. */
  locked?: boolean;
  ready: boolean;
  hasPermission: boolean;
  queued: number;
  /** The conversation, when loaded: what the agent does right now reads from it, as on the computer. */
  view?: Pick<SessionView, "items" | "permissions" | "turnStartedAt" | "turnBreaks" | "turnActive">;
}): TurnActivityState | undefined {
  // Locked reconnects nothing by itself: the password is what it waits for.
  if (locked) return { label: "这台电脑设置了访问密码，输入后继续", tone: "muted", animated: false };
  if (!online) return connecting
    ? { label: "正在恢复连接…", tone: "muted", animated: true }
    : { label: "连接已断开，等待重连…", tone: "muted", animated: false };
  if (!ready) return { label: "正在同步会话…", tone: "muted", animated: true };
  // The request's own card sits right under the conversation and says it better.
  if (hasPermission) return undefined;
  if (session.state === "waiting") return { label: "等你处理", tone: "waiting", animated: false };
  if (progress) return { label: progress.phase === "sending" ? "正在发送…" : "已发送，等待 Agent 开始…", tone: "active", animated: true };
  if (session.state === "running") {
    if (view?.turnActive) {
      const live = liveActivity(view);
      // A running call or untitled thought already spins under its own name in the timeline;
      // naming it again here reads as two things running. The reply row has no spinner of its own.
      const label = live.echo === "tool" || live.echo === "thought" ? "本轮进行中" : live.label;
      return { label, tone: live.waiting ? "waiting" : "active", animated: !live.waiting, startedAt: live.startedAt };
    }
    return { label: activityText(session.activity), tone: "active", animated: true };
  }
  if (session.state === "error") return { label: "本轮执行出错", tone: "error", animated: false };
  if (session.state === "offline") return { label: "Agent 已离线", tone: "muted", animated: false };
  if (session.state === "unknown") return { label: "会话状态待确认", tone: "muted", animated: false };
  if (queued > 0) return { label: "已排队，等待 Agent 接收…", tone: "waiting", animated: false };
  return undefined;
}
