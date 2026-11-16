import type { ProjectSummary, SessionSummary } from "@linkshell/wire";

export interface ProjectGroup extends ProjectSummary {
  key: string;
  /** Codex's automatically created chat workspaces, kept separate from ordinary projects. */
  generated: boolean;
  paths: string[];
  sessions: SessionSummary[];
}

export function projectLocation(cwd: string): { key: string; generated: boolean; name?: string } {
  // Codex creates dated chat directories here. A directory merely named "chat" is still a project.
  const generated = /^(.*[/\\]Documents[/\\]Codex)[/\\]\d{4}-\d{2}-\d{2}[/\\][^/\\]+[/\\]?$/i.exec(cwd);
  return generated ? { key: generated[1]!, generated: true, name: "Codex Chats" } : { key: cwd, generated: false };
}

/**
 * One directory, however it is spelled. Windows names are not case-sensitive and are written with
 * either slash: the same folder reaches a host as `C:\Users\me\shop` from one terminal and as
 * `c:\Users\me\shop` from another (an editor's), and was listed as two projects.
 */
function sameDirectoryKey(key: string): string {
  if (!/^(?:[A-Za-z]:(?:[\\/]|$)|\\\\)/.test(key)) return key;
  return key.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Whether two working directories are the same folder (a route keeps one spelling, a group another). */
export function sameProjectDirectory(a: string, b: string): boolean {
  return a === b || sameDirectoryKey(a) === sameDirectoryKey(b);
}

/** Presentation only: session working directories and project actions keep their original paths. */
export function groupProjects(projects: ProjectSummary[], sessions: SessionSummary[] = []): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  const ensure = (project: ProjectSummary) => {
    const location = projectLocation(project.cwd);
    const key = location.generated ? `codex-chats:${location.key}` : location.key;
    // Found by what the directory is; `key` stays the first spelling seen, as routes hold it.
    const found = sameDirectoryKey(key);
    let group = groups.get(found);
    if (!group) {
      group = { ...project, key, cwd: location.key, name: location.name ?? project.name, generated: location.generated,
        branch: location.generated ? undefined : project.branch, paths: [], sessions: [], sessionCount: 0, lastActiveAt: 0 };
      groups.set(found, group);
    }
    if (project.createdAt !== undefined) group.createdAt = Math.min(group.createdAt ?? project.createdAt, project.createdAt);
    if (!group.paths.includes(project.cwd)) {
      group.paths.push(project.cwd);
      group.sessionCount += project.sessionCount;
    }
    group.lastActiveAt = Math.max(group.lastActiveAt, project.lastActiveAt);
    return group;
  };
  for (const project of projects) ensure(project);
  for (const session of sessions) {
    if (session.archived) continue;
    const cwd = session.worktree?.source ?? session.cwd;
    const group = ensure({ cwd, name: cwd.replace(/[\\/]$/, "").split(/[\\/]/).pop() || cwd, sessionCount: 0, createdAt: session.createdAt, lastActiveAt: session.updatedAt });
    group.sessions.push(session);
    group.sessionCount = Math.max(group.sessionCount, group.sessions.length);
  }
  for (const group of groups.values()) group.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return [...groups.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}
