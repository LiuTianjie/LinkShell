import { expect, it } from "vitest";
import type { SessionSummary } from "@linkshell/wire";
import { crossComputerProjects, type ProjectComputer } from "../src/live/cross-computer-projects";

const session = (id: string, cwd: string, createdAt: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id, nativeId: id, agent: "codex", cwd, createdAt, updatedAt: createdAt,
  state: "idle", pendingPermissions: 0, lastSeq: 0, archived: false, ...extra,
});

it("groups projects before computers while retaining each machine's paths and session identities", () => {
  const computers: ProjectComputer[] = [
    { key: "mac", projects: [], sessions: [session("same-id", "/Users/me/app", 10), session("other", "/work/app", 20)] },
    { key: "windows", projects: [], sessions: [session("same-id", "C:\\code\\app", 30), session("new", "C:\\code\\new", 40)] },
  ];
  const groups = crossComputerProjects(computers);
  expect(groups.map((group) => group.name)).toEqual(["new", "app"]);
  expect(groups[1]!.members.map(({ computerKey, project }) => [computerKey, project.cwd, project.sessions[0]!.id]))
    .toEqual([["mac", "/Users/me/app", "same-id"], ["mac", "/work/app", "other"], ["windows", "C:\\code\\app", "same-id"]]);
  expect(crossComputerProjects([...computers].reverse())).toEqual(groups);
});

it("keeps creation order through activity changes, excludes archived sessions and separates generated chats", () => {
  const computers: ProjectComputer[] = [{ key: "mac", projects: [
    { cwd: "/old/app", name: "app", createdAt: 1, lastActiveAt: 100, sessionCount: 1 },
  ], sessions: [
    session("old", "/old/app", 10), session("new", "/new/project", 20),
    session("archived", "/archived", 100, { archived: true }),
    session("generated", "/Users/me/Documents/Codex/2026-11-07/chat-one", 30),
    session("ordinary", "/work/Codex Chats", 40),
  ] }];
  const before = crossComputerProjects(computers);
  const after = crossComputerProjects(computers.map((computer) => ({ ...computer,
    sessions: computer.sessions.map((item) => ({ ...item, updatedAt: 10_000 - item.createdAt, state: "running" })),
  })));
  expect(after.map((project) => project.key)).toEqual(before.map((project) => project.key));
  expect(before.map((project) => project.name)).toEqual(["Codex Chats", "Codex Chats", "project", "app"]);
  expect(before.slice(0, 2).map((project) => project.generated)).toEqual([false, true]);
  expect(before.at(-1)?.createdAt).toBe(1);
});
