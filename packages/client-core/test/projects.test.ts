import { expect, it } from "vitest";
import type { ProjectSummary, SessionSummary } from "@linkshell/wire";
import { groupProjects, projectDirectoryKey, projectLocation, sameProjectDirectory } from "../src/projects.js";

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

it("retains the first project creation across grouped chats and partial session lists", () => {
  const root = "/Users/me/Documents/Codex";
  const first = `${root}/2026-10-29/new-chat`;
  const second = `${root}/2026-10-30/fix-shell`;
  const summaries = [
    { ...project(first), createdAt: 100 },
    { ...project(second), createdAt: 200 },
    project("/legacy"),
  ];
  const sessions = [
    { id: "recent", cwd: second, createdAt: 400, updatedAt: 900 },
    { id: "legacy", cwd: "/legacy", createdAt: 150, updatedAt: 800 },
  ] as SessionSummary[];
  const creation = (entries: SessionSummary[]) => Object.fromEntries(groupProjects(summaries, entries).map((group) => [group.cwd, group.createdAt]));
  expect(creation(sessions)).toEqual({ [root]: 100, "/legacy": 150 });
  expect(creation(sessions.map((session) => ({ ...session, updatedAt: session.updatedAt + 1000 })).reverse()))
    .toEqual({ [root]: 100, "/legacy": 150 });
});

it("lists a Windows folder once, however its drive letter and slashes are written", () => {
  const session = (id: string, cwd: string) => ({ id, cwd, updatedAt: 5 }) as SessionSummary;
  const groups = groupProjects(
    [project("C:\\Users\\me\\shop", 2), project("c:\\Users\\me\\shop", 1), project("C:/Users/me/Shop/", 1), project("C:\\Users\\me\\other")],
    [session("a", "c:\\users\\me\\shop"), session("b", "C:\\Users\\me\\shop")],
  );
  expect(groups.map((group) => group.cwd).sort()).toEqual(["C:\\Users\\me\\other", "C:\\Users\\me\\shop"]);
  const shop = groups.find((group) => group.name === "shop")!;
  expect(shop.sessionCount).toBe(4);
  expect(shop.sessions.map((s) => s.id).sort()).toEqual(["a", "b"]);
  expect(sameProjectDirectory("c:\\users\\ME\\shop\\", shop.cwd)).toBe(true);
  expect(projectDirectoryKey("C:\\Users\\me\\shop\\")).toBe(projectDirectoryKey("c:/users/me/Shop"));
  expect(groupProjects([
    project("C:\\Users\\me\\Documents\\Codex\\2026-10-29\\a"),
    project("c:\\users\\me\\Documents\\Codex\\2026-10-30\\b"),
  ])).toHaveLength(1);
  // Elsewhere a name's case is part of it.
  expect(groupProjects([project("/Users/me/shop"), project("/Users/me/Shop")])).toHaveLength(2);
  expect(sameProjectDirectory("/Users/me/shop", "/Users/me/Shop")).toBe(false);
});
