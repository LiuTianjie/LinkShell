import { needsAttention, terminalState, type SessionSummary, type TerminalInfo } from "@linkshell/wire";

export type ActivityFilter = "all" | "attention" | "running" | "failed" | "completed";
export interface ActivityRoute { action?: string; computer?: string; session?: string; terminal?: string; filter: ActivityFilter }

/** Old activities and repeated query parameters must still resolve to a usable screen. */
export function activityRoute(params: Record<string, string | string[] | undefined>): ActivityRoute {
  const first = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  };
  const filter = first("filter");
  return {
    action: first("action"), computer: first("computer"), session: first("session"), terminal: first("terminal"),
    filter: filter === "attention" || filter === "running" || filter === "failed" || filter === "completed" ? filter : "all",
  };
}

export type ActivityEntry = { kind: "session"; session: SessionSummary; at: number } | { kind: "terminal"; terminal: TerminalInfo; at: number };

export function activityEntries(sessions: SessionSummary[], terminals: TerminalInfo[], filter: ActivityFilter): ActivityEntry[] {
  const entries: ActivityEntry[] = sessions.filter((session) => {
    if (session.archived) return false;
    const attention = needsAttention(session);
    if (filter === "attention") return attention;
    if (filter === "running") return !attention && session.state === "running";
    if (filter === "failed") return !attention && session.state === "error";
    if (filter === "completed") return !attention && session.state === "idle";
    return attention || session.state === "running" || session.state === "error";
  }).map((session) => ({ kind: "session", session, at: session.updatedAt }));
  for (const terminal of terminals) {
    const state = terminalState(terminal);
    if (filter === "attention") continue;
    if ((filter === "all" || filter === "running") && !state.busy) continue;
    if (filter === "failed" && !state.failed) continue;
    if (filter === "completed" && (!state.ended || state.failed || terminal.interrupted)) continue;
    entries.push({ kind: "terminal", terminal, at: terminal.activeAt });
  }
  return entries.sort((a, b) => b.at - a.at);
}

/** External task links leave one detail above home, never another task or the activity trampoline. */
export function activityDetailStack(routes: readonly { name: string; key?: string; params?: object }[], kind: "session" | "terminal", id: string) {
  const home = routes.find((route) => route.name === "(tabs)") ?? { name: "(tabs)" };
  const name = kind === "session" ? "session/[id]/index" : "terminal/[id]";
  const existing = routes.findLast((route) => route.name === name && (route.params as { id?: string } | undefined)?.id === id);
  const detail = existing ? { ...existing, params: { id } } : { name, params: { id } };
  return { index: 1, routes: [home, detail] };
}
