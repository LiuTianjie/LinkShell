import { describe, expect, it } from "vitest";
import {
  applyEvents,
  emptyView,
  exitNote,
  formatElapsed,
  liveActivity,
  presentError,
  reconnectLabel,
  reconnectOf,
  startedSession,
  toolLabel,
  toolLabelText,
  type SessionEvent,
  type SessionUpdate,
  type TimelineItem,
} from "../src/index.js";

type Tool = Extract<TimelineItem, { kind: "tool" }>;
const tool = (patch: Partial<Tool>): Tool => ({ kind: "tool", id: "t", title: "Tool", toolKind: "other", status: "completed", content: [], output: "", ts: 0, ...patch });
const line = (item: Tool) => toolLabelText(toolLabel(item), { note: true });

describe("tool rows", () => {
  it("word commands by their description, else their first line, with how long they took", () => {
    expect(line(tool({ toolKind: "execute", title: "Run the tests", rawInput: { command: "npm test", description: "Run the tests" }, endedTs: 3200 }))).toBe("已运行 Run the tests · 用时 3 秒");
    // Codex: the title is the command.
    expect(line(tool({ toolKind: "execute", title: "rg -n foo src", rawInput: { command: "rg -n foo src" }, rawOutput: { exitCode: 1, durationMs: 400 }, status: "failed" }))).toBe("已运行 rg -n foo src（失败）");
    expect(line(tool({ toolKind: "execute", title: "npm test", rawInput: { command: "npm test" }, status: "in_progress" }))).toBe("正在运行 npm test");
    expect(line(tool({ toolKind: "execute", title: "rm -rf x", rawInput: { command: "rm -rf x" }, rawOutput: { declined: true }, status: "failed" }))).toBe("已拒绝 rm -rf x");
    expect(exitNote(tool({ toolKind: "execute", rawOutput: { exitCode: 0 } }))).toBe("成功");
    expect(exitNote(tool({ toolKind: "execute", status: "failed", output: "Exit code 2\nboom" }))).toBe("退出码 2");
  });

  it("word files, searches and the web", () => {
    expect(toolLabel(tool({ toolKind: "read", title: "Read a.ts", rawInput: { file_path: "/w/src/a.ts" } }))).toMatchObject({ verb: "已读取", subject: "a.ts", style: "file", path: "/w/src/a.ts" });
    expect(line(tool({ toolKind: "edit", title: "Edit a.ts", status: "in_progress", content: [{ type: "diff", path: "/w/a.ts", oldText: "a", newText: "b" }] }))).toBe("编辑中 a.ts");
    expect(line(tool({ toolKind: "edit", title: "Write n.ts", content: [{ type: "diff", path: "/w/n.ts", oldText: null, newText: "b" }] }))).toBe("已创建 n.ts");
    expect(line(tool({ toolKind: "search", name: "Grep", title: "Search “foo”", rawInput: { pattern: "foo" }, output: "Found 12 files\na\nb" }))).toBe("已搜索 foo · 12 个文件");
    expect(line(tool({ toolKind: "search", title: "Find **/*.ts", rawInput: { pattern: "**/*.ts" } }))).toBe("已搜索文件 **/*.ts");
    expect(line(tool({ toolKind: "read", title: "List src", rawInput: { command: "ls src" } }))).toBe("已列出 src 中的文件");
    expect(line(tool({ toolKind: "fetch", title: "Fetch https://docs.astral.sh/uv/", rawInput: { url: "https://docs.astral.sh/uv/" } }))).toBe("已获取 docs.astral.sh");
    expect(line(tool({ toolKind: "fetch", detail: { type: "web_search", query: "vite 7" } }))).toBe("已搜索网页：vite 7");
    // Antigravity names its file tools; its kind says only "other".
    expect(line(tool({ name: "read_file", title: "read_file", rawInput: { Path: "/w/x.py" } }))).toBe("已读取 x.py");
  });

  it("word agents, skills, MCP tools and the Claude app's own", () => {
    expect(line(tool({ detail: { type: "subagent", action: "spawn", task: "Review the diff" } }))).toBe("已运行智能体：Review the diff");
    expect(line(tool({ detail: { type: "skill", name: "deploy" } }))).toBe("已运行 Skill /deploy");
    expect(line(tool({ detail: { type: "mcp", server: "github", tool: "search_issues" } }))).toBe("已使用 Github：Search issues");
    expect(line(tool({ detail: { type: "mcp", server: "codex_apps", tool: "figma.get_design_context" }, status: "in_progress" }))).toBe("正在使用 Figma：Get design context");
    expect(line(tool({ title: "ExitPlanMode", rawInput: { plan: "# Ship the fix\n\nSteps" } }))).toBe("提出了计划：Ship the fix");
    expect(line(tool({ title: "SendUserFile", rawInput: { files: ["runs/a.png"] } }))).toBe("发送了文件 a.png");
    expect(line(tool({ title: "AskUserQuestion", detail: { type: "question", text: "Which?" }, rawInput: { questions: [{ header: "部署方式", question: "Which?" }] } }))).toBe("询问了：部署方式");
  });

  it("reads the session a start_session call started", () => {
    const started = tool({ detail: { type: "mcp", server: "ccd_session", tool: "start_session" }, rawInput: { title: "Fix it" }, content: [{ type: "content", content: { type: "text", text: "Started session \"Fix it\" (session_id: local_abc-1, name: fix)." } }] });
    expect(startedSession(started)).toEqual({ title: "Fix it", state: "started", appId: "local_abc-1" });
    const proposed = tool({ detail: { type: "mcp", server: "ccd_session", tool: "start_session" }, rawInput: { title: "Later" }, output: "Proposed \"Later\" (task_id: task_1)." });
    expect(startedSession(proposed).state).toBe("proposed");
  });
});

describe("durations", () => {
  it("read in seconds, minutes and hours", () => {
    expect(formatElapsed(28_400)).toBe("28 秒");
    expect(formatElapsed(185_000)).toBe("3 分 5 秒");
    expect(formatElapsed(3_720_000)).toBe("1 小时 2 分");
  });
});

let seq = 0;
const events = (...updates: SessionUpdate[]): SessionEvent[] => updates.map((update) => ({ sessionId: "s", seq: ++seq, ts: seq * 1000, update }));

describe("the live row", () => {
  it("says what runs, what is thought, and what waits; the clock starts with the turn", () => {
    let view = applyEvents(emptyView("s"), events({ sessionUpdate: "ls_turn", state: "started" }, { sessionUpdate: "tool_call", toolCallId: "c", title: "npm test", kind: "execute", status: "in_progress", rawInput: { command: "npm test" } }));
    expect(liveActivity(view)).toMatchObject({ label: "正在运行 npm test", waiting: false });
    expect(view.turnStartedAt).toBe(seq * 1000 - 1000);
    const started = view.turnStartedAt;
    view = applyEvents(view, events({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed" }, { sessionUpdate: "agent_thought_chunk", messageId: "m", content: { type: "text", text: "**Checking the logs**\n\nThe tests" } }));
    expect(liveActivity(view).label).toBe("Checking the logs");
    // A message sent mid-turn doesn't restart the clock.
    view = applyEvents(view, events({ sessionUpdate: "ls_turn", state: "started" }));
    expect(view.turnStartedAt).toBe(started);
    view = applyEvents(view, events({ sessionUpdate: "ls_permission", requestId: "r", title: "Run?", options: [{ optionId: "a", name: "Allow", kind: "allow_once" }] }));
    expect(liveActivity(view)).toMatchObject({ label: "需要您的输入", waiting: true });
  });
});

describe("errors", () => {
  it("classify the model's API failing, with the raw words kept", () => {
    expect(presentError({ code: "server_error", message: "API Error: Repeated 529 Overloaded errors." })).toMatchObject({ kind: "overloaded", title: "服务繁忙", hint: "稍后重试，或换一个模型。" });
    expect(presentError({ code: "rate_limit", message: "You've hit your session limit · resets 5am" })).toMatchObject({ title: "请求过于频繁", detail: "You've hit your session limit · resets 5am" });
    expect(presentError({ code: "authentication_failed", message: "Not logged in · Please run /login" }).title).toBe("认证失败");
    expect(presentError({ code: "turn_failed", message: "unexpected status 413 Payload Too Large: body" }).title).toBe("请求失败");
    expect(presentError({ code: "turn_failed", message: "unexpected status 502 Bad Gateway" }).title).toBe("服务器错误");
    // LinkShell's own errors keep their words.
    expect(presentError({ code: "send_failed", message: "排队的消息没能发出：x" })).toEqual({ title: "排队的消息没能发出：x", hint: undefined });
  });

  it("read retries as reconnecting, the latest in place of the one before", () => {
    expect(reconnectOf("Reconnecting... 2/5")).toEqual({ attempt: 2, max: 5, busy: false });
    expect(reconnectOf("Retrying Claude, attempt 3 of 10.")).toMatchObject({ attempt: 3, max: 10 });
    expect(reconnectLabel(reconnectOf("Reconnecting... 2/5", "exceeded retry limit, last status: 429 Too Many Requests")!, true)).toBe("服务器繁忙，正在重新连接 2/5");
    const view = applyEvents(emptyView("s"), events(
      { sessionUpdate: "ls_notice", level: "warning", title: "Reconnecting... 1/5" },
      { sessionUpdate: "ls_notice", level: "warning", title: "Reconnecting... 2/5" },
    ));
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ kind: "notice", title: "Reconnecting... 2/5" });
  });
});
