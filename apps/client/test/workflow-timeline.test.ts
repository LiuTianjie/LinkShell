import { applyUpdate, emptyView, findTool, type TimelineItem, type WorkflowRecords } from "@linkshell/client-core";
import type { SubagentInfo, Workflow } from "@linkshell/wire";
import { describe, expect, it } from "vitest";
import { buildRows } from "@/lib/timeline-rows";
import { sessionTimelineItems } from "@/lib/workflows";

type Tool = Extract<TimelineItem, { kind: "tool" }>;
const agent = (id: string, text = id): TimelineItem => ({ kind: "agent", id, text, ts: 1000, streaming: false });
const tool = (id: string): Tool => ({ kind: "tool", id, title: "Sub-agent", ts: 1000, toolKind: "other", status: "completed", content: [], output: "", detail: { type: "subagent", action: "spawn" } });
const finishedTool = (id: string): Tool => ({ ...tool(id), detail: { type: "subagent", action: "spawn", state: "completed" } });
const record = (workflow: Workflow): WorkflowRecords => ({ wf: { toolCallId: "wf", task: "Build", startedAt: 1000, lastSeq: 100, workflow } });
const rows = (items: TimelineItem[], open = new Set<string>(), seams = new Set<string>()) => buildRows(items, 2000, open, seams, false);
const entry = (toolCallId: string, parentToolCallId?: string): SubagentInfo => ({ toolCallId, parentToolCallId, task: toolCallId, running: false, startedAt: 1000 });

describe("workflow agents in the main conversation", () => {
  it("removes a page of orphan worker cards using the roster, retaining main replies and every transcript", () => {
    let view = emptyView("s");
    view = applyUpdate(view, { sessionUpdate: "agent_message_chunk", messageId: "before", content: { type: "text", text: "开始工作" } }, 1000, "before");
    const agents = Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, toolCallId: `worker-${i}`, title: `Agent ${i}`, state: "completed" as const }));
    for (const worker of agents) {
      // The worker launch and its parent workflow are on an unloaded page.
      view = applyUpdate(view, { sessionUpdate: "agent_message_chunk", messageId: worker.id, parentToolCallId: worker.toolCallId, content: { type: "text", text: "工作结果" } }, 1001, worker.id);
    }
    view = applyUpdate(view, { sessionUpdate: "agent_message_chunk", messageId: "after", content: { type: "text", text: "主要结论" } }, 1002, "after");
    expect(view.items).toHaveLength(62);
    const shown = sessionTimelineItems(view.items, record({ state: "completed", agents }), undefined);
    expect(shown.map((item) => item.id)).toEqual(["before", "after"]);
    expect(findTool(view, "worker-20")?.sub?.items[0]).toMatchObject({ kind: "agent", text: "工作结果" });
    expect(view.items).toHaveLength(62);
  });

  it("uses parent relationships for descendants and agents with no transcript address in the roster", () => {
    const items = [tool("wf"), tool("worker"), tool("nested"), tool("independent"), agent("reply")];
    const listed = [entry("nested", "worker"), entry("worker", "wf"), { ...entry("wf"), workflow: { state: "running" as const } }];
    const shown = sessionTimelineItems(items, undefined, listed);
    expect(shown.map((item) => item.id)).toEqual(["wf", "independent", "reply"]);
    expect((shown[0] as Tool).detail).toMatchObject({ workflow: { state: "running" } });
  });

  it("uses relationships in loaded history and preserves workflow details when no list is available", () => {
    const worker = tool("worker");
    const workflow: Tool = { ...tool("wf"), detail: { type: "subagent", action: "spawn", workflow: { state: "completed" } }, sub: { ...emptyView("s"), items: [worker] } };
    const shown = sessionTimelineItems([worker, workflow, agent("reply")], undefined, undefined);
    expect(shown.map((item) => item.id)).toEqual(["wf", "reply"]);
    expect((shown[0] as Tool).sub).toBe(workflow.sub);
  });

  it("promotes a workflow placeholder using the latest snapshot without losing its key or history", () => {
    const placeholder = tool("wf");
    const saved = record({ name: "Build UI", state: "paused", agents: [] });
    const shown = sessionTimelineItems([placeholder], saved, [{ ...entry("wf"), workflow: { state: "running" } }]);
    expect(shown[0]).toMatchObject({ id: placeholder.id, ts: placeholder.ts, detail: { workflow: { name: "Build UI", state: "paused" } } });
    expect(placeholder.detail).not.toHaveProperty("workflow");
  });

  it("does not hide unassociated agents, messages, errors, or permission results", () => {
    const items: TimelineItem[] = [tool("standalone"), agent("reply"), { kind: "error", id: "err", code: "error", message: "失败", ts: 1000 }, { kind: "permission-result", id: "permission", title: "确认", ts: 1000 }];
    expect(sessionTimelineItems(items, record({ state: "running" }), [entry("cycle-a", "cycle-b"), entry("cycle-b", "cycle-a")])).toEqual(items);
  });

  it("does not use matching names, tasks, timestamps, or an id prefix as membership evidence", () => {
    const items = [tool("wf"), tool("standalone"), tool("workflow:wf:unlisted"), agent("reply")];
    const shown = sessionTimelineItems(items, record({ name: "Sub-agent", state: "running", agents: [{ id: "standalone", title: "Sub-agent", state: "running" }] }), undefined);
    // A provider agent id is not a transcript toolCallId, even if the strings happen to match.
    expect(shown.map((item) => item.id)).toEqual(items.map((item) => item.id));
  });

  it("keeps separate workflows separate even with the same name and provider agent id", () => {
    const saved: WorkflowRecords = {
      first: { toolCallId: "first", task: "Build", startedAt: 1000, lastSeq: 10, workflow: { name: "Build", agents: [{ id: "a", toolCallId: "workflow:first:a", title: "Build", state: "completed" }] } },
      second: { toolCallId: "second", task: "Build", startedAt: 1000, lastSeq: 20, workflow: { name: "Build", agents: [{ id: "a", toolCallId: "workflow:second:a", title: "Build", state: "running" }] } },
    };
    const items = [tool("first"), tool("workflow:first:a"), tool("second"), tool("workflow:second:a"), tool("standalone")];
    const shown = sessionTimelineItems(items, saved, undefined);
    expect(shown.map((item) => item.id)).toEqual(["first", "second", "standalone"]);
    expect((shown[0] as Tool).detail).toMatchObject({ workflow: saved.first!.workflow });
    expect((shown[1] as Tool).detail).toMatchObject({ workflow: saved.second!.workflow });
  });
});

describe("folding completed agent activity", () => {
  it("folds many completed agents between main replies and expands without losing items", () => {
    const items = [agent("before"), ...Array.from({ length: 50 }, (_, i) => finishedTool(`a${i}`)), agent("after")];
    const folded = rows(items);
    expect(folded.map((row) => row.type)).toEqual(["item", "steps", "item"]);
    expect(folded[1]).toMatchObject({ steps: items.slice(1, -1), open: false });
    expect(folded[2]).toMatchObject({ item: { id: "after" }, last: true });
    expect(rows(items, new Set(["steps-a0"])).filter((row) => row.type === "item").map((row) => row.item.id)).toEqual(items.map((item) => item.id));
  });

  it("does not fold a completed launch while its background work is still running or paused", () => {
    for (const state of ["running", "paused"] as const) {
      const items = [tool("a"), tool("b"), tool("c")];
      const shown = sessionTimelineItems(items, undefined, items.map((item) => ({ ...entry(item.id), running: true, state })));
      expect(rows(shown).every((row) => row.type === "item")).toBe(true);
    }
    const live: Tool = { ...tool("live"), detail: { type: "subagent", action: "spawn" }, sub: { ...emptyView("s"), turnActive: true } };
    expect(rows([finishedTool("a"), finishedTool("b"), live]).every((row) => row.type === "item")).toBe(true);
  });

  it("prefers a live event's state over an older subagent list", () => {
    const items = ["a", "b", "c"].map((id): Tool => ({ ...tool(id), detail: { type: "subagent", action: "spawn", state: "running" } }));
    const shown = sessionTimelineItems(items, undefined, items.map((item) => ({ ...entry(item.id), state: "completed" })));
    expect(rows(shown).every((row) => row.type === "item")).toBe(true);
  });

  it("does not infer completion from a returned launch or a non-running list entry without an outcome", () => {
    const items = ["a", "b", "c"].map((id): Tool => ({ ...tool(id), detail: { type: "subagent", action: "spawn" } }));
    expect(rows(items).every((row) => row.type === "item")).toBe(true);
    const shown = sessionTimelineItems(items, undefined, items.map((item) => entry(item.id)));
    expect(rows(shown).every((row) => row.type === "item")).toBe(true);
  });

  it("keeps workflows with live workers visible even when stopped, and folds completed workflows", () => {
    const workflows = ["a", "b", "c"].map((id): Tool => ({ ...tool(id), detail: { type: "subagent", action: "spawn", workflow: { state: "completed" } } }));
    expect(rows(workflows)[0]?.type).toBe("steps");
    const live: Tool = { ...tool("live"), detail: { type: "subagent", action: "spawn", workflow: { state: "stopped", agents: [{ id: "worker", title: "Worker", state: "running" }] } } };
    expect(rows([workflows[0]!, workflows[1]!, live]).every((row) => row.type === "item")).toBe(true);
  });

  it("respects pagination seams and never folds across a main-agent message", () => {
    const items = [finishedTool("a"), finishedTool("b"), finishedTool("c")];
    expect(rows(items, new Set(), new Set(["c"])).every((row) => row.type === "item")).toBe(true);
    expect(rows([finishedTool("a"), finishedTool("b"), agent("reply"), finishedTool("c")]).every((row) => row.type === "item")).toBe(true);
  });
});
