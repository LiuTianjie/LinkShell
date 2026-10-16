import { describe, expect, it } from "vitest";
import type { SessionSummary, TerminalInfo } from "@linkshell/wire";
import { activityEntries, activityRoute } from "../src/lib/live-activity-navigation";

const session: SessionSummary = { id: "s-1", nativeId: "n-1", agent: "codex", cwd: "/test", state: "running", archived: false, createdAt: 1, updatedAt: 2, lastSeq: 1, pendingPermissions: 0 };
const terminal: TerminalInfo = { id: "t-1", title: "pnpm", command: "pnpm test", cwd: "/test", cols: 80, rows: 24, createdAt: 1, activeAt: 3 };
describe("Live Activity collection navigation", () => {
  it("resolves legacy count links and repeated query parameters into a task collection", () => {
    expect(activityRoute({ computer: ["mac-1", "other"], session: "", filter: "unknown" })).toEqual({ computer: "mac-1", session: undefined, terminal: undefined, action: undefined, filter: "all" });
    expect(activityRoute({ filter: "attention" }).filter).toBe("attention");
  });
  it("shows attention even while an agent is running and keeps completed tasks out of the running list", () => {
    const questions = { ...session, id: "question", asyncQuestions: [{ id: "q-1", title: "选择？", options: [] }] };
    const done = { ...session, id: "done", state: "idle" as const };
    const sessions = [session, questions, done, { ...session, id: "archived", archived: true }];
    expect(activityEntries(sessions, [terminal], "running").map((entry) => entry.kind)).toEqual(["terminal", "session"]);
    expect(activityEntries(sessions, [], "attention")).toEqual([{ kind: "session", session: questions, at: questions.updatedAt }]);
    expect(activityEntries(sessions, [{ ...terminal, exitCode: 0 }], "completed")).toHaveLength(2);
    expect(activityEntries([], [{ ...terminal, interrupted: true }], "completed")).toEqual([]);
  });
});
