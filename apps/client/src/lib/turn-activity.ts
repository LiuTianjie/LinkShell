import type { PromptProgress } from "@linkshell/client-core";
import type { SessionSummary } from "@linkshell/wire";
import { activityText } from "./describe";

export interface TurnActivityState {
  label: string;
  tone: "active" | "waiting" | "muted" | "error";
  animated: boolean;
}

/** Delivery is local; execution belongs to the host. Keep the gap visible without inventing a running turn. */
export function turnActivity({ session, progress, online, ready, hasPermission, queued }: {
  session: SessionSummary;
  progress?: PromptProgress;
  online: boolean;
  ready: boolean;
  hasPermission: boolean;
  queued: number;
}): TurnActivityState | undefined {
  if (!online) return { label: "连接已断开，等待重连…", tone: "muted", animated: false };
  if (!ready) return { label: "正在同步会话…", tone: "muted", animated: true };
  // The request's own card sits right under the conversation and says it better.
  if (hasPermission) return undefined;
  if (session.state === "waiting") return { label: "等待你确认或回答", tone: "waiting", animated: false };
  if (progress) return { label: progress.phase === "sending" ? "正在发送…" : "已发送，等待 Agent 开始…", tone: "active", animated: true };
  if (session.state === "running") return { label: activityText(session.activity), tone: "active", animated: true };
  if (session.state === "error") return { label: "本轮执行出错", tone: "error", animated: false };
  if (session.state === "offline") return { label: "Agent 已离线", tone: "muted", animated: false };
  if (session.state === "unknown") return { label: "会话状态待确认", tone: "muted", animated: false };
  if (queued > 0) return { label: "已排队，等待 Agent 接收…", tone: "waiting", animated: false };
  return undefined;
}
