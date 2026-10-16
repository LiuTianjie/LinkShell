import { describe, expect, it } from "vitest";
import { permissionChoices, buildLiveActivitySnapshot, isLiveActivityActionCurrent, liveActivityActions, liveActivityContent, liveActivityContentSchema, liveActivityDetailLink, liveActivitySessionTask, type LiveActivityTask } from "../src/live-activity.js";
import type { PendingPermissionSummary, Question, SessionSummary } from "../src/model.js";

const session: SessionSummary = { id: "s-1", nativeId: "n-1", agent: "codex", cwd: "/test", state: "running", title: "处理任务", archived: false, createdAt: 1, updatedAt: 2, lastSeq: 1, pendingPermissions: 0 };

// A custom ID guards the open adapter contract as well as today's built-in agents.
describe.each(["codex", "claude", "gemini", "antigravity", "copilot", "grok", "opencode", "cursor", "custom-acp"])("Live Activity action contract: %s", (agent) => {
  const permission: PendingPermissionSummary = {
    requestId: `${agent}/request-1`, title: "允许执行？",
    options: [{ optionId: `${agent}/allow-once`, name: "允许", kind: "allow_once" }],
  };

  it("preserves native approval IDs and rejects another computer or a replaced request", () => {
    const waiting: SessionSummary = { ...session, agent, state: "waiting", permission, pendingPermissions: 1 };
    const action = liveActivityActions(waiting, "computer-A").actions[0]!;
    expect(action).toMatchObject({ kind: "permission", requestId: permission.requestId, optionId: permission.options[0]!.optionId });
    expect(isLiveActivityActionCurrent(action, "computer-A", waiting)).toBe(true);
    expect(isLiveActivityActionCurrent(action, "computer-B", waiting)).toBe(false);
    expect(isLiveActivityActionCurrent(action, "computer-A", { ...waiting, permission: { ...permission, requestId: "replaced" } })).toBe(false);
    const payload = liveActivityContent(buildLiveActivitySnapshot("Mac", [waiting], [], true, "computer-A"));
    expect(payload).toMatchObject({ agent, phase: "waiting_for_approval", actions: [action] });
  });

  it("submits choice values, while retaining full forms in the app", () => {
    const question: Question = { id: "database", text: "数据库？", kind: "choice", options: [{ value: "pg-native-id", label: "Postgres" }] };
    const waiting: SessionSummary = { ...session, agent, state: "waiting", permission: { ...permission, questions: [question] } };
    const action = liveActivityActions(waiting, "computer-A").actions[0]!;
    expect(action).toMatchObject({ kind: "answer", questionId: "database", optionId: "pg-native-id" });
    expect(isLiveActivityActionCurrent(action, "computer-A", waiting)).toBe(true);
    expect(liveActivitySessionTask(waiting).phase).toBe("waiting_for_input");
    for (const questions of [[{ ...question, kind: "choices" as const }], [{ ...question, kind: "text" as const }], [{ ...question, secret: true }], [question, { ...question, id: "other" }]]) {
      const form = { ...waiting, permission: { ...permission, questions } };
      expect(liveActivityActions(form, "computer-A")).toEqual({ actions: [], hasMoreActions: true });
      expect(isLiveActivityActionCurrent(action, "computer-A", form)).toBe(false);
    }
    expect(liveActivityActions({ ...waiting, permission: { ...permission, url: { url: "https://example.com/auth", elicitationId: "auth" } } }, "computer-A")).toEqual({ actions: [], hasMoreActions: true });
  });
});

describe("Live Activity task browsing payloads", () => {
  it("keeps task identities for multiple sessions from the same agent", () => {
    const payload = buildLiveActivitySnapshot("Mac", [session, { ...session, id: "s-2", updatedAt: 3 }], [], true, "computer:1");
    expect(payload.agents).toEqual(["codex"]);
    expect(payload.tasks?.map((task) => task.id)).toEqual(["s-1", "s-2"]);
    expect(payload.deepLink).toBe(liveActivityDetailLink("computer:1", "session", "s-2"));
    const changed = buildLiveActivitySnapshot("Mac", [{ ...session, updatedAt: 9 }, { ...session, id: "s-2", updatedAt: 3 }], [], true, "computer:1");
    expect(changed.tasks?.map((task) => task.id)).toEqual(payload.tasks?.map((task) => task.id));
  });

  it("shows readable progress for common commands while keeping unknown tool context", () => {
    for (const [title, expected] of [["rg --files --hidden node_modules/", "正在查找项目文件与代码"], ["pnpm --filter app test", "正在运行测试"], ["git diff --stat", "正在检查分支与代码改动"]]) {
      expect(liveActivitySessionTask({ ...session, activity: { kind: "tool", toolKind: "execute", title } }).subtitle).toBe(expected);
    }
    expect(liveActivitySessionTask({ ...session, activity: { kind: "tool", title: "验证锁屏布局" } }).subtitle).toBe("验证锁屏布局");
  });

  it("bounds multibyte previews without changing action or task identifiers", () => {
    const tasks: LiveActivityTask[] = Array.from({ length: 6 }, (_, index) => ({ id: `s-${index}`, kind: "session", phase: "running", title: "测试🧪".repeat(100), subtitle: "这是一段进展".repeat(100), project: "项目".repeat(100), agent: "codex" }));
    const state = liveActivityContent({ active: true, computerName: "Mac", title: "测试".repeat(80), subtitle: "进展".repeat(180), project: "项目".repeat(80), tasks, deepLink: liveActivityDetailLink("computer:1", "session", "s-0"), actions: [{ id: "request:allow", label: "允许", role: "allow", kind: "permission", computerKey: "computer:1", sessionId: "s-0", requestId: "request", optionId: "allow" }] });
    expect(liveActivityContentSchema.safeParse(state).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeLessThanOrEqual(3300);
    expect(state.tasks?.length).toBeGreaterThanOrEqual(2);
    expect(state.tasks?.map((task) => task.id)).toEqual(tasks.slice(0, state.tasks?.length).map((task) => task.id));
    for (const action of state.actions ?? []) expect(action.optionId).toBe("allow");
  });

  it("encodes special characters in the computer and task links losslessly", () => {
    const url = new URL(liveActivityDetailLink("gateway:phone&name", "session", "task?/中文"));
    expect(url.searchParams.get("computer")).toBe("gateway:phone&name");
    expect(url.searchParams.get("session")).toBe("task?/中文");
  });
});


describe("agent-local approval options", () => {
  it("keeps Gemini's sole cancel option visible as a rejection", () => {
    const options = [
      { optionId: "proceed_always", name: "Allow for this session", kind: "allow_always" as const },
      { optionId: "proceed_once", name: "Allow", kind: "allow_once" as const },
      { optionId: "cancel", name: "Reject", kind: "reject_once" as const },
    ];
    expect(permissionChoices(options).map(({ label, role }) => ({ label, role }))).toEqual([
      { label: "拒绝", role: "reject" }, { label: "允许", role: "allow" }, { label: "总是允许", role: "always" },
    ]);
    const actions = liveActivityActions({ ...session, permission: { requestId: "gemini-1", title: "Run command", options } }, "computer-A").actions;
    expect(actions.some((action) => action.optionId === "cancel")).toBe(true);
  });
  it("retains Codex's separate decline and stop actions", () => {
    expect(permissionChoices([
      { optionId: "decline", name: "Decline", kind: "reject_once" },
      { optionId: "cancel", name: "Stop", kind: "reject_once" },
    ]).map((choice) => choice.role)).toEqual(["reject", "stop"]);
  });
});
