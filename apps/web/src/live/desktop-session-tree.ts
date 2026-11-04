import type { ProjectSummary, SessionSummary } from "@linkshell/wire";
import { groupProjects } from "@linkshell/client-core";
import { sessionGroup } from "./session-list";

function byCreation(a: SessionSummary, b: SessionSummary): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

/** Activity changes membership and row contents, never the position of an existing session. */
export function desktopSessionTree(projects: ProjectSummary[], sessions: SessionSummary[]) {
  const live = sessions.filter((session) => !session.archived);
  return {
    active: live.filter((session) => sessionGroup(session) !== "recent").sort(byCreation),
    groups: groupProjects(projects, live)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.key.localeCompare(b.key))
      .map((project) => ({ ...project,
        sessions: project.sessions.sort(byCreation),
        running: project.sessions.filter((session) => sessionGroup(session) === "running").length,
      })),
  };
}

interface Family { root: SessionSummary; children: SessionSummary[] }

/** Descendants stay under their oldest visible ancestor, each level ordered by creation. */
export function sessionFamilies(sessions: SessionSummary[]): Family[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const rootOf = (session: SessionSummary) => {
    const seen = new Set([session.id]);
    let current = session;
    for (;;) {
      const up = current.parentId ?? current.forkedFrom;
      const parent = up ? byId.get(up) : undefined;
      if (!parent || seen.has(parent.id)) return current;
      seen.add(parent.id);
      current = parent;
    }
  };
  const byRoot = new Map<string, Family>();
  for (const session of sessions) {
    const root = rootOf(session);
    const family = byRoot.get(root.id) ?? { root, children: [] };
    if (session !== root) family.children.push(session);
    byRoot.set(root.id, family);
  }
  for (const family of byRoot.values()) family.children.sort(byCreation);
  return [...byRoot.values()].sort((a, b) => byCreation(a.root, b.root));
}
