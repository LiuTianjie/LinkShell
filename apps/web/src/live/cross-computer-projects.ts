import type { ProjectGroup } from "@linkshell/client-core";
import type { ProjectSummary, SessionSummary } from "@linkshell/wire";
import { desktopSessionTree } from "./desktop-session-tree";

export interface ProjectComputer {
  key: string;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
}

export interface CrossComputerProject {
  key: string;
  name: string;
  generated: boolean;
  createdAt: number;
  members: { computerKey: string; project: ProjectGroup }[];
}

/** Same-name projects share a heading, never their paths, session ids or actions. */
export function crossComputerProjects(computers: ProjectComputer[]): CrossComputerProject[] {
  const grouped = new Map<string, CrossComputerProject>();
  for (const computer of [...computers].sort((a, b) => a.key.localeCompare(b.key))) {
    for (const project of desktopSessionTree(computer.projects, computer.sessions).groups) {
      const key = JSON.stringify([project.generated, project.name]);
      const group: CrossComputerProject = grouped.get(key) ?? {
        key, name: project.name, generated: project.generated,
        createdAt: project.createdAt ?? 0, members: [],
      };
      group.createdAt = Math.min(group.createdAt, project.createdAt ?? 0);
      group.members.push({ computerKey: computer.key, project });
      grouped.set(key, group);
    }
  }
  for (const group of grouped.values()) group.members.sort((a, b) =>
    a.computerKey.localeCompare(b.computerKey) || a.project.key.localeCompare(b.project.key));
  return [...grouped.values()].sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key));
}
