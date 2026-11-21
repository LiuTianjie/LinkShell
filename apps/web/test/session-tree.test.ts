import { expect, it } from "vitest";
import type { ProjectSummary, SessionSummary } from "@linkshell/wire";
import { sessionTree } from "../src/live/session-tree";

const session = (id: string, createdAt: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  nativeId: id,
  agent: "codex",
  cwd: "/old",
  createdAt,
  updatedAt: createdAt,
  state: "idle",
  pendingPermissions: 0,
  lastSeq: 0,
  archived: false,
  ...extra,
});

const projects: ProjectSummary[] = [
  { cwd: "/old", name: "old", createdAt: 100, lastActiveAt: 900, sessionCount: 4 },
  { cwd: "/new", name: "new", createdAt: 200, lastActiveAt: 400, sessionCount: 1 },
];

it("orders projects and sessions by creation order across status updates", () => {
  const sessions = [
    session("parent", 100),
    session("sibling", 300),
    session("child", 400, { parentId: "parent" }),
    session("new-project", 200, { cwd: "/new" }),
  ];
  const summarize = (entries: SessionSummary[], summaries = projects) =>
    sessionTree(summaries, entries).groups.map((group) => ({
      project: group.key,
      ids: group.sessions.map((entry) => entry.id),
    }));

  const expected = [
    { project: "/new", ids: ["new-project"] },
    { project: "/old", ids: ["child", "sibling", "parent"] },
  ];
  expect(summarize(sessions)).toEqual(expected);
  expect(
    summarize(
      sessions.map((entry, index) => ({ ...entry, state: "running", updatedAt: 10_000 - index })).reverse(),
      projects.map((project) => ({ ...project, lastActiveAt: project.lastActiveAt + 10_000 })).reverse(),
    ),
  ).toEqual(expected);
});

it("tracks non-archived active sessions while sorting running before recent", () => {
  const entries = [
    session("older", 100, { state: "running" }),
    session("newer", 300, { state: "running" }),
    session("question", 200, { asyncQuestions: [{ id: "q", title: "补充说明", options: [] }] }),
    session("idle", 400),
    session("archived", 500, { state: "running", archived: true }),
  ];
  expect(sessionTree([], entries).active.map((entry) => entry.id)).toEqual(["newer", "question", "older"]);
  expect(sessionTree([], entries.map((entry) => ({ ...entry, state: "idle", asyncQuestions: [] }))).active).toEqual([]);
});
