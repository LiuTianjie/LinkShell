import type { AgentStatus, SessionSummary } from "./types";

// Product vocabulary for list / tree / permission cards.
//
// The session list is a "do I need to tap this now?" surface, not a field dump.
// Urgency: waiting_permission > running > error > idle. Idle is silence —
// showing 「空闲」 on every card makes the one card that needs you look the same.
//
// The permission card is a decision, not a status badge. Ask what happens if
// they allow; put the consequence (command / path) in the body.

export function sessionUrgency(s: SessionSummary): number {
  if (s.agentStatus === "waiting_permission") return 0;
  if (s.agentStatus === "running") return 1;
  if (s.agentStatus === "error") return 2;
  if (!s.hasHost) return 20;
  return 10;
}

export function sessionHeadline(s: SessionSummary): string {
  const title = s.agentTitle?.trim();
  if (title) return title;
  return s.projectName || s.hostname || s.id.slice(0, 8);
}

export function folderName(cwd?: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

export function formatRelativeActivity(ts?: number | null): string | null {
  if (!ts || ts <= 0) return null;
  const delta = Date.now() - ts;
  if (delta < 45_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))} 分钟前`;
  if (delta < 86_400_000) return `${Math.max(1, Math.round(delta / 3_600_000))} 小时前`;
  return `${Math.max(1, Math.round(delta / 86_400_000))} 天前`;
}

export function sessionStory(
  s: SessionSummary,
  opts?: { showHost?: boolean },
): { text: string; tone: "warning" | "danger" | "muted" } {
  if (!s.hasHost) return { text: "主机离线", tone: "muted" };
  if (s.agentStatus === "waiting_permission") {
    return { text: s.agentDetail?.trim() || "等你授权才能继续", tone: "warning" };
  }
  if (s.agentStatus === "error") {
    return { text: s.agentDetail?.trim() || "刚刚异常", tone: "danger" };
  }
  if (s.agentStatus === "running" && s.agentDetail?.trim() && s.agentDetail.trim() !== s.agentTitle?.trim()) {
    return { text: s.agentDetail.trim(), tone: "muted" };
  }
  const bits = [
    opts?.showHost && s.hostname ? s.hostname : null,
    folderName(s.cwd),
    formatRelativeActivity(s.agentLastActivity ?? s.lastActivity),
  ].filter(Boolean);
  return { text: bits.join(" · ") || "在线", tone: "muted" };
}

export function attentionStatus(status?: AgentStatus | null): {
  text: string;
  className: string;
  pulsing?: boolean;
} | null {
  switch (status) {
    case "waiting_permission":
      return { text: "等你授权", className: "border-warning/40 bg-warning/10 text-warning", pulsing: true };
    case "running":
      return { text: "运行中", className: "border-success/30 bg-success/10 text-success", pulsing: true };
    case "error":
      return { text: "异常", className: "border-danger/30 bg-danger/10 text-danger" };
    default:
      return null;
  }
}

export function permissionHeadline(toolName?: string): string {
  const n = (toolName || "").toLowerCase();
  if (/bash|shell|command/.test(n)) return "允许运行这条命令？";
  if (/write|edit|multiedit/.test(n)) return "允许改这个文件？";
  if (/(^|_)read(_|$)|readfile|read_file/.test(n)) return "允许读取这个文件？";
  if (/webfetch|web_search|websearch|fetch/.test(n)) return "允许访问网络？";
  const bare = toolName?.split(/ · |__/).pop();
  if (bare) return `允许使用 ${bare}？`;
  return "需要你的授权才能继续";
}
