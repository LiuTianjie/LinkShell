import type { SessionSummary } from "@linkshell/wire";

export function sessionNeedsAttention(session: SessionSummary): boolean {
  return (
    session.state === "waiting" ||
    !!session.permission?.questions?.length ||
    !!session.asyncQuestions?.length
  );
}

export function sessionGroup(
  session: SessionSummary,
): "waiting" | "running" | "recent" {
  if (sessionNeedsAttention(session)) return "waiting";
  return session.state === "running" ? "running" : "recent";
}
