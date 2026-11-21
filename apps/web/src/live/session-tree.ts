import type { ProjectSummary, SessionSummary } from "@linkshell/wire";
import { groupProjects } from "@linkshell/client-core";
import { sessionGroup } from "./session-list";

function byCreation(a: SessionSummary, b: SessionSummary): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

/** Activity changes membership and row contents, never the position of an existing session. */
export function sessionTree(projects: ProjectSummary[], sessions: SessionSummary[]) {
  const live = sessions.filter((session) => !session.archived);
  return {
    active: live.filter((session) => sessionGroup(session) !== "recent").sort(byCreation),
    groups: groupProjects(projects, live)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.key.localeCompare(b.key))
      .map((project) => ({
        ...project,
        sessions: project.sessions.sort(byCreation),
        running: project.sessions.filter((session) => sessionGroup(session) === "running").length,
      })),
  };
}
