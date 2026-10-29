import { describe, expect, it } from "vitest";
import { describeFailures, describeSteps, foldStepRuns, isStep, MIN_FOLD, tallySteps, type Step, type TimelineItem } from "../src/index.js";

type Tool = Extract<TimelineItem, { kind: "tool" }>;
let next = 0;
const tool = (patch: Partial<Tool>): Tool => ({
  kind: "tool",
  id: `t${next++}`,
  title: "Tool",
  toolKind: "other",
  status: "completed",
  content: [],
  output: "",
  ts: 0,
  ...patch,
});
const read = (path: string) => tool({ title: `Read ${path.split("/").pop()}`, toolKind: "read", rawInput: { file_path: path } });
const edit = (path: string, oldText = "a\nb", newText = "a\nc\nd") => tool({ title: `Edit ${path}`, toolKind: "edit", rawInput: { file_path: path }, content: [{ type: "diff", path, oldText, newText }] });
const write = (path: string) => tool({ title: `Write ${path}`, toolKind: "edit", content: [{ type: "diff", path, oldText: null, newText: "x\ny" }] });
const bash = (command: string, patch: Partial<Tool> = {}) => tool({ title: command, toolKind: "execute", rawInput: { command }, ...patch });
const grep = (pattern: string) => tool({ title: `Search “${pattern}”`, toolKind: "search", name: "Grep", rawInput: { pattern } });
const sentence = (steps: Step[]) => describeSteps(tallySteps(steps));

describe("the summary of a run of steps", () => {
  it("names each kind of work in the order it first happened, unclassified last", () => {
    expect(sentence([edit("/w/a.ts"), bash("ls"), edit("/w/b.ts"), read("/w/c.ts"), bash("pwd")])).toBe("已编辑 2 个文件，已运行 2 个命令，已读取 1 个文件");
    expect(sentence([tool({ title: "custom" }), bash("ls"), bash("pwd")])).toBe("已运行 2 个命令，已使用 1 个工具");
  });

  it("counts files once however often they were touched", () => {
    expect(sentence([read("/w/a.ts"), read("/w/a.ts"), read("/w/b.ts"), bash("ls")])).toBe("已读取 2 个文件，已运行 1 个命令");
  });

  it("names the file when every file step was about the same one, verbs in order", () => {
    expect(sentence([edit("/w/foo.ts"), read("/w/foo.ts")])).toBe("已编辑并读取 foo.ts");
    expect(sentence([read("/w/foo.ts"), bash("npm test"), read("/w/foo.ts")])).toBe("已读取 foo.ts，已运行 1 个命令");
    expect(sentence([write("/w/new.ts"), edit("/w/new.ts")])).toBe("已创建并编辑 new.ts");
  });

  it("shows three parts and counts the rest once there are five or more", () => {
    const steps = [edit("/w/a.ts"), edit("/w/b.ts"), ...Array.from({ length: 11 }, (_, i) => bash(`echo ${i}`)), read("/w/c.ts"), read("/w/d.ts"), read("/w/e.ts"), grep("x"), grep("y"), tool({ toolKind: "fetch", title: "Fetch", rawInput: { url: "https://a.dev/x" } })];
    expect(sentence(steps)).toBe("已编辑 2 个文件，已运行 11 个命令，已读取 3 个文件，以及另外 3 项操作");
    // Four parts still all show.
    expect(sentence([edit("/w/a.ts"), bash("ls"), read("/w/c.ts"), grep("x")])).toBe("已编辑 1 个文件，已运行 1 个命令，已读取 1 个文件，已搜索代码");
  });

  it("words searches, the web, agents and sessions as the Claude app does", () => {
    expect(sentence([grep("a"), tool({ title: "Find *.ts", toolKind: "search", name: "Glob", rawInput: { pattern: "*.ts" } })])).toBe("已搜索代码，已搜索文件");
    const web = (query: string) => tool({ title: `Search web: ${query}`, toolKind: "fetch", detail: { type: "web_search", query } });
    expect(sentence([web("a"), web("b")])).toBe("已搜索网页 2 次");
    expect(sentence([web("a"), bash("ls")])).toBe("已搜索网页，已运行 1 个命令");
    const agent = tool({ title: "Agent: x", detail: { type: "subagent", action: "spawn", task: "x", state: "completed" } });
    const session = tool({ title: "ccd_session · start_session", detail: { type: "mcp", server: "ccd_session", tool: "start_session" }, rawInput: { title: "T" } });
    expect(sentence([agent, session])).toBe("已运行 1 个智能体，已启动 1 个会话");
  });

  it("says how many failed or were stopped", () => {
    const t = tallySteps([bash("false", { status: "failed" }), bash("x", { status: "failed", output: "The user doesn't want to proceed with this tool use." }), bash("ls")]);
    expect(describeFailures(t)).toBe("（1 项失败，1 项已停止）");
    expect(describeFailures(tallySteps([bash("ls"), bash("pwd")]))).toBeUndefined();
    // A command that worked and printed those words (a log it read) was neither stopped nor declined.
    expect(describeFailures(tallySteps([bash("grep -r rejected logs", { output: "app.log: The user rejected the change; interrupted by user" })]))).toBeUndefined();
  });

  it("counts lines changed the way the opened diff shows them", () => {
    const t = tallySteps([edit("/w/a.ts", "a\nb\n", "a\nc\nd\n"), write("/w/n.ts")]);
    expect({ added: t.added, removed: t.removed }).toEqual({ added: 4, removed: 1 });
  });
});

describe("folding", () => {
  it("folds two finished steps or more; one stays a plain row", () => {
    expect(MIN_FOLD).toBe(2);
    const one = foldStepRuns([bash("ls")], new Set());
    expect(one.map((row) => row.type)).toEqual(["item"]);
    const two = foldStepRuns([bash("ls"), read("/w/a")], new Set());
    expect(two.map((row) => row.type)).toEqual(["steps"]);
  });

  it("keeps a session it started or proposed as a card of its own", () => {
    const proposed = tool({ title: "ccd_session · start_session", detail: { type: "mcp", server: "ccd_session", tool: "start_session" }, rawInput: { title: "Docs only" }, status: "completed" });
    expect(isStep(proposed)).toBe(false);
    const rows = foldStepRuns([bash("ls"), read("/w/a"), proposed], new Set());
    expect(rows.map((row) => row.type)).toEqual(["steps", "item"]);
  });

  it("lets finished sub-agents join the run, and keeps a working one out", () => {
    const done = tool({ detail: { type: "subagent", action: "spawn", task: "x", state: "completed" }, status: "completed" });
    expect(isStep(done)).toBe(true);
    // A launch that returned without an outcome may still be working.
    const launched = tool({ detail: { type: "subagent", action: "spawn", task: "x" }, status: "completed" });
    expect(isStep(launched)).toBe(false);
    const rows = foldStepRuns([bash("ls"), done, read("/w/a")], new Set());
    expect(rows.map((row) => row.type)).toEqual(["steps"]);
  });

  it("leaves thinking out of the conversation: no row, not counted, no split", () => {
    const thought = (streaming: boolean): TimelineItem => ({ kind: "thought", id: `th${next++}`, text: "**Plan**", streaming, ts: 0 });
    const rows = foldStepRuns([bash("ls"), thought(false), bash("pwd"), thought(true)], new Set());
    expect(rows.map((row) => (row.type === "steps" ? `steps:${row.steps.length}` : row.item.kind))).toEqual(["steps:2"]);
    expect(describeSteps(tallySteps((rows[0] as { steps: Step[] }).steps))).toBe("已运行 2 个命令");
  });

  it("leaves the plan's own calls out without splitting the run, and stops at dividers", () => {
    const plan = tool({ detail: { type: "mcp", server: "ccd_turn", tool: "update_plan" } });
    const compacted = tool({ toolKind: "think", detail: { type: "compaction" } });
    const rows = foldStepRuns([bash("ls"), plan, bash("pwd"), compacted, bash("a"), bash("b")], new Set());
    expect(rows.map((row) => (row.type === "steps" ? `steps:${row.steps.length}` : row.item.kind))).toEqual(["steps:2", "tool", "steps:2"]);
  });
});
