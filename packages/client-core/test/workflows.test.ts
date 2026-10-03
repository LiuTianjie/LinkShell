import { describe, expect, it } from "vitest";
import type { SessionEvent, SubagentInfo } from "@linkshell/wire";
import { applyWorkflowEvent, mergeWorkflowList, workflowIsLive } from "../src/workflows.js";

const event = (seq: number, state: "running" | "stopped" | "completed" = "running"): SessionEvent => ({
  sessionId: "s", seq, ts: seq * 1000,
  update: { sessionUpdate: "tool_call_update", toolCallId: "wf", detail: { type: "subagent", action: "spawn", task: "Build mobile UI",
    workflow: { runId: "wf_native", state, started: 1, completed: state === "completed" ? 1 : 0,
      phases: [{ id: "phase:1", title: "Build", order: 1 }], agents: [{ id: "a", title: "Frontend", state: state === "completed" ? "completed" : "running" }] } } },
});

describe("workflow snapshots independent of the timeline", () => {
  it("recovers an older run from the roster and rejects a slower list response after newer live progress", () => {
    const snapshot = event(20);
    const detail = snapshot.update.sessionUpdate === "tool_call_update" && snapshot.update.detail?.type === "subagent" ? snapshot.update.detail : undefined;
    const entry: SubagentInfo = { toolCallId: "wf", task: "Build mobile UI", running: true, startedAt: 1, workflow: detail!.workflow, lastSeq: 20 };
    const recovered = mergeWorkflowList({}, [entry]);
    expect(recovered.wf?.workflow.phases?.[0]?.title).toBe("Build");
    const newer = applyWorkflowEvent(recovered, event(30, "completed"));
    expect(mergeWorkflowList(newer, [entry])).toBe(newer);
    expect(applyWorkflowEvent(newer, event(10))).toBe(newer);
    expect(newer.wf?.workflow.state).toBe("completed");
  });

  it("keeps a stopped workflow visible while one of its workers is still running", () => {
    const records = applyWorkflowEvent({}, event(20, "stopped"));
    expect(workflowIsLive(records.wf!.workflow)).toBe(true);
    expect(workflowIsLive({ ...records.wf!.workflow, agents: [{ id: "a", title: "Frontend", state: "stopped" }] })).toBe(false);
  });

  it("does not discard a complete roster when a tool shell is replayed", () => {
    const records = applyWorkflowEvent({}, event(20));
    const shell: SessionEvent = { sessionId: "s", seq: 21, ts: 21000, update: { sessionUpdate: "tool_call", toolCallId: "wf", title: "Workflow", kind: "other", status: "in_progress", detail: { type: "subagent", action: "spawn", workflow: {} } } };
    const next = applyWorkflowEvent(records, shell);
    expect(next.wf?.workflow.agents).toEqual(records.wf?.workflow.agents);
    expect(next.wf?.workflow.state).toBe("running");
  });

  it("records a failed launch even when no background workflow was created", () => {
    const shell: SessionEvent = { sessionId: "s", seq: 1, ts: 1, update: { sessionUpdate: "tool_call", toolCallId: "wf", title: "Workflow", kind: "other", status: "in_progress", detail: { type: "subagent", action: "spawn", workflow: {} } } };
    const records = applyWorkflowEvent(applyWorkflowEvent({}, shell), { sessionId: "s", seq: 2, ts: 2, update: { sessionUpdate: "tool_call_update", toolCallId: "wf", status: "failed" } });
    expect(records.wf?.workflow.state).toBe("failed");
    expect(workflowIsLive(records.wf!.workflow)).toBe(false);
  });
});
