import { expect, it } from "vitest";
import type { ProjectSummary, SessionSummary } from "@linkshell/wire";
import { desktopSessionTree, sessionFamilies } from "../src/live/desktop-session-tree";

const session = (id: string, createdAt: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id, nativeId: id, agent: "codex", cwd: "/old", createdAt, updatedAt: createdAt,
  state: "idle", pendingPermissions: 0, lastSeq: 0, archived: false, ...extra,
});
const projects: ProjectSummary[] = [
  { cwd: "/old", name: "old", createdAt: 100, lastActiveAt: 900, sessionCount: 4 },
  { cwd: "/new", name: "new", createdAt: 200, lastActiveAt: 400, sessionCount: 1 },
];

it("keeps projects and nested sessions in creation order through streaming and refreshed snapshots", () => {
  const sessions = [
    session("parent", 100),
    session("sibling", 300),
    session("child", 400, { parentId: "parent" }),
    session("fork", 500, { forkedFrom: "parent" }),
    session("new-project", 200, { cwd: "/new" }),
  ];
  const order = (entries: SessionSummary[], summaries = projects) => desktopSessionTree(summaries, entries).groups.map((group) => ({
    project: group.key,
    families: sessionFamilies(group.sessions).map(({ root, children }) => [root.id, ...children.map((child) => child.id)]),
  }));
  const expected = [
    { project: "/new", families: [["new-project"]] },
    { project: "/old", families: [["sibling"], ["parent", "fork", "child"]] },
  ];
  expect(order(sessions)).toEqual(expected);
  expect(order(sessions.map((entry, index) => ({ ...entry, state: "running", updatedAt: 10_000 - index, preview: "new response" })).reverse(),
    projects.map((project) => ({ ...project, lastActiveAt: project.lastActiveAt + 10_000 })).reverse())).toEqual(expected);
  expect(order([...sessions, session("new-task", 600)])).toEqual([
    expected[0], { project: "/old", families: [["new-task"], ["sibling"], ["parent", "fork", "child"]] },
  ]);
});

it("updates active membership without promoting progress, approvals or replies over creation time", () => {
  const entries = [
    session("older", 100, { state: "running" }),
    session("newer", 300, { state: "running" }),
    session("question", 200, { asyncQuestions: [{ id: "q", title: "补充说明", options: [] }] }),
    session("idle", 400),
    session("archived", 500, { state: "running", archived: true }),
  ];
  const active = (sessions: SessionSummary[]) => desktopSessionTree([], sessions).active.map((entry) => entry.id);
  expect(active(entries)).toEqual(["newer", "question", "older"]);
  const waiting = entries.map((entry) => entry.id === "older" ? { ...entry, state: "waiting" as const, updatedAt: 50_000 } : entry).reverse();
  expect(active(waiting)).toEqual(["newer", "question", "older"]);
  expect(active(waiting.map((entry) => entry.id === "newer" ? { ...entry, state: "idle", preview: "已完成" } : entry)))
    .toEqual(["question", "older"]);
  expect(active(entries.map((entry) => ({ ...entry, state: "idle", asyncQuestions: [] })))).toEqual([]);
});

it("breaks creation ties consistently and lets descendants stand alone when their parent is archived", () => {
  const entries = [
    session("z", 100, { state: "running" }),
    session("a", 100, { state: "running" }),
    session("parent", 50, { archived: true }),
    session("child", 80, { parentId: "parent" }),
  ];
  for (const sessions of [entries, [...entries].reverse()]) {
    const tree = desktopSessionTree([], sessions);
    expect(tree.active.map((entry) => entry.id)).toEqual(["a", "z"]);
    expect(sessionFamilies(tree.groups[0]!.sessions).map(({ root, children }) => [root.id, ...children.map((child) => child.id)]))
      .toEqual([["a"], ["z"], ["child"]]);
  }
});
