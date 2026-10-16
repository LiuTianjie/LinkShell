import type { PendingPermissionSummary, SessionSummary } from "@linkshell/wire";
import { describe, expect, it } from "vitest";
import { isLiveActivityActionCurrent, liveActivityActions, liveActivityDetailLink } from "../src/lib/live-activity-actions";

const permission: PendingPermissionSummary = {
  requestId: "permission-1", title: "允许访问 Device Hub？",
  options: [
    { optionId: "accept", name: "Allow", kind: "allow_once" },
    { optionId: "decline", name: "Deny", kind: "reject_once" },
    { optionId: "acceptForSession", name: "Allow for session", kind: "allow_always" },
  ],
};
const session: SessionSummary = {
  id: "task-1", nativeId: "native-1", agent: "codex", cwd: "/test", state: "waiting",
  archived: false, createdAt: 1, updatedAt: 2, lastSeq: 1, pendingPermissions: 1, permission,
};

describe("Live Activity choices", () => {
  it("binds each permission button to an exact computer, session, request and option", () => {
    const { actions, hasMoreActions } = liveActivityActions(session, "computer-1");
    expect(actions.map((action) => action.optionId)).toEqual(["decline", "accept", "acceptForSession"]);
    expect(hasMoreActions).toBe(false);
    for (const action of actions) {
      expect(isLiveActivityActionCurrent(action, "computer-1", session)).toBe(true);
      expect(isLiveActivityActionCurrent(action, "other-computer", session)).toBe(false);
      expect(isLiveActivityActionCurrent(action, "computer-1", { ...session, archived: true })).toBe(false);
      expect(isLiveActivityActionCurrent(action, "computer-1", { ...session, permission: undefined })).toBe(false);
      expect(isLiveActivityActionCurrent(action, "computer-1", { ...session, permission: { ...permission, requestId: "permission-2" } })).toBe(false);
    }
  });

  it("rechecks the live option and pending request before sending", () => {
    const action = liveActivityActions(session, "computer-1").actions.find((item) => item.optionId === "accept")!;
    expect(isLiveActivityActionCurrent(action, "computer-1", { ...session, permission: { ...permission, options: [] } })).toBe(false);
    expect(isLiveActivityActionCurrent(action, "computer-1", { ...session, permission: undefined }, [permission])).toBe(true);
  });

  it("offers direct choices only for one nonsecret, single-select question", () => {
    const question = { id: "q", text: "先看哪里？", kind: "choice" as const, options: [{ value: "lock", label: "锁屏" }, { value: "island", label: "灵动岛" }], other: true };
    const withQuestion = { ...session, permission: { ...permission, questions: [question] } };
    const { actions, hasMoreActions } = liveActivityActions(withQuestion, "computer-1");
    expect(actions.map((action) => [action.kind, action.questionId, action.optionId])).toEqual([["answer", "q", "lock"], ["answer", "q", "island"]]);
    expect(hasMoreActions).toBe(true);
    expect(isLiveActivityActionCurrent(actions[0]!, "computer-1", withQuestion)).toBe(true);
    for (const questions of [[{ ...question, secret: true }], [{ ...question, kind: "choices" as const }], [question, { ...question, id: "q2" }]]) {
      const changed = { ...session, permission: { ...permission, questions } };
      expect(liveActivityActions(changed, "computer-1")).toEqual({ actions: [], hasMoreActions: true });
      expect(isLiveActivityActionCurrent(actions[0]!, "computer-1", changed)).toBe(false);
    }
  });

  it("opens details for URL authorizations and overlong options", () => {
    expect(liveActivityActions({ ...session, permission: { ...permission, url: { url: "https://example.com", elicitationId: "auth" } } }, "computer-1"))
      .toEqual({ actions: [], hasMoreActions: true });
    const long = { ...session, permission: undefined, asyncQuestions: [{ id: "q", title: "选择方案", options: ["这个选项很长，必须打开详情才能查看完整内容并做出选择", "简短选项"] }] };
    const result = liveActivityActions(long, "computer-1");
    expect(result.actions.map((action) => action.label)).toEqual(["简短选项"]);
    expect(result.hasMoreActions).toBe(true);
    expect(isLiveActivityActionCurrent(result.actions[0]!, "computer-1", { ...long, asyncQuestions: [] })).toBe(false);
  });

  it("caps visible choices without inventing or truncating a choice", () => {
    const result = liveActivityActions({ ...session, permission: undefined, asyncQuestions: [{ id: "q", title: "选择", options: ["A", "B", "C", "D"] }] }, "computer-1");
    expect(result.actions.map((action) => action.label)).toEqual(["A", "B", "C"]);
    expect(result.hasMoreActions).toBe(true);
  });

  it("keeps navigation separate from action execution and encodes the target", () => {
    const url = new URL(liveActivityDetailLink("relay:wss://example.com#machine", "session", "codex:abc/def"));
    expect(url.searchParams.get("computer")).toBe("relay:wss://example.com#machine");
    expect(url.searchParams.get("session")).toBe("codex:abc/def");
    expect(url.searchParams.has("action")).toBe(false);
    expect(liveActivityActions(session, "").actions).toEqual([]);
  });
});
