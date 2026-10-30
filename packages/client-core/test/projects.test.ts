import { expect, it } from "vitest";
import type { ProjectSummary, SessionSummary } from "@linkshell/wire";
import { groupProjects, projectLocation } from "../src/projects.js";

const project = (cwd: string, count = 1): ProjectSummary => ({ cwd, name: cwd.split(/[\\/]/).pop()!, sessionCount: count, lastActiveAt: count });

it("groups Codex's dated chat workspaces without folding ordinary projects into them", () => {
  const root = "/Users/me/Documents/Codex";
  const first = `${root}/2026-10-29/new-chat`;
  const second = `${root}/2026-10-30/fix-shell`;
  const groups = groupProjects([project(first, 2), project(second, 3), project(root), project("/work/chat"), project("/work/2026-10-30/new-chat")]);
  const generated = groups.find((group) => group.generated)!;
  expect(generated.paths).toEqual([first, second]);
  expect(generated.sessionCount).toBe(5);
  expect(groups.filter((group) => !group.generated).map((group) => group.cwd)).toEqual([root, "/work/chat", "/work/2026-10-30/new-chat"]);
  expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length);
});

it("recognizes Windows chat directories while leaving paths and real worktree attribution intact", () => {
  const cwd = "C:\\Users\\me\\Documents\\Codex\\2026-10-30\\new-chat";
  expect(projectLocation(cwd)).toEqual({ key: "C:\\Users\\me\\Documents\\Codex", name: "Codex Chats", generated: true });
  const session = { id: "s", cwd: "/worktrees/one", updatedAt: 4, worktree: { source: cwd } } as SessionSummary;
  const groups = groupProjects([], [session, { ...session, id: "archived", archived: true }]);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.paths).toEqual([cwd]);
  expect(groups[0]!.sessions).toEqual([session]);
  expect(session.cwd).toBe("/worktrees/one");
});
