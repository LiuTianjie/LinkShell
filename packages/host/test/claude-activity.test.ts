import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionUpdateSchema, type SessionUpdate } from "@linkshell/wire";
import { ClaudeActivity } from "../src/drivers/claude/activity.js";
import { normalizeAcpUpdate } from "../src/drivers/acp/mapper.js";
import { transcriptLine } from "../src/drivers/claude/transcript.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const line = (data: unknown) => `${JSON.stringify(data)}\n`;
const message = (id: string, text: string, stop = "end_turn") => line({ type: "assistant", uuid: id, isSidechain: true,
  timestamp: "2026-10-03T12:00:01Z", message: { id, content: [{ type: "text", text }], stop_reason: stop } });
const launch = (extra = {}) => line({ type: "user", uuid: "launch", timestamp: "2026-10-03T12:00:00Z",
  message: { content: [{ type: "tool_result", tool_use_id: "wf-call", content: "Running in background" }] },
  toolUseResult: { status: "async_launched", taskId: "task-wf", taskType: "local_workflow", workflowName: "research", runId: "wf_run", ...extra } });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "linkshell-activity-"));
  directories.push(dir);
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, "");
  const children = join(dir, "session", "subagents");
  const run = join(children, "workflows", "wf_run");
  mkdirSync(run, { recursive: true });
  const updates: SessionUpdate[] = [];
  let desktop = true;
  const follower = new ClaudeActivity({ locate: () => transcript, desktop: () => desktop, onUpdate: (update) => {
    sessionUpdateSchema.parse(update);
    updates.push(update);
  } });
  follower.followFrom(0);
  return { dir, transcript, children, run, updates, follower, remote: (value: boolean) => { desktop = !value; } };
}

const texts = (updates: SessionUpdate[]) => updates.flatMap((update) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []);
const latest = (updates: SessionUpdate[], call = "wf-call") => updates.findLast((update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === call);

describe("Claude child transcript following", () => {
  it("discovers a new child while the main transcript stays silent; waits for complete lines and deduplicates compaction", () => {
    const f = fixture();
    f.follower.poll();
    const path = join(f.children, "agent-a.jsonl");
    const first = message("m1", "first");
    writeFileSync(path, first.slice(0, -1));
    f.follower.poll();
    expect(f.updates).toEqual([]);
    writeFileSync(join(f.children, "agent-a.meta.json"), JSON.stringify({ toolUseId: "agent-call" }));
    f.follower.poll();
    expect(f.updates).toEqual([]);
    appendFileSync(path, "\n");
    f.follower.poll();
    expect(texts(f.updates)).toEqual(["first"]);
    expect(f.updates[0]).toMatchObject({ parentToolCallId: "agent-call" });
    appendFileSync(path, first + message("m2", "second"));
    f.follower.poll();
    f.follower.poll();
    expect(texts(f.updates)).toEqual(["first", "second"]);
  });

  it("advances past ACP's ordinary child output, then resumes desktop following without replaying it", () => {
    const f = fixture();
    const path = join(f.children, "agent-a.jsonl");
    writeFileSync(join(f.children, "agent-a.meta.json"), JSON.stringify({ toolUseId: "agent-call" }));
    writeFileSync(path, message("m1", "desktop"));
    f.follower.poll();
    f.remote(true);
    appendFileSync(path, message("m2", "ACP already sent this"));
    f.follower.poll();
    f.remote(false);
    appendFileSync(path, message("m3", "back at desk"));
    f.follower.poll();
    expect(texts(f.updates)).toEqual(["desktop", "back at desk"]);
  });
});

describe("Claude workflow lifecycle", () => {
  it("does not interpret a successful background launch as completion in either transcript or ACP", () => {
    const agents = new Set<string>();
    const updates = transcriptLine(launch(), { agents }).updates;
    expect(agents.has("wf-call")).toBe(true);
    expect(updates).toEqual([{ sessionUpdate: "ls_turn", state: "started", parentToolCallId: "wf-call" }]);
    expect(normalizeAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "wf-call", status: "completed", _meta: { claudeCode: { toolName: "Workflow" } } })).toMatchObject({ status: "in_progress" });
    expect(normalizeAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "wf-call", status: "failed", _meta: { claudeCode: { toolName: "Workflow" } } })).toMatchObject({ status: "failed" });
  });

  it("shows live worker output and observed counts; only the run's final artifact finishes the workflow", () => {
    const f = fixture();
    f.remote(true); // Workflow artifacts must follow during phone-driven turns too.
    appendFileSync(f.transcript, launch());
    writeFileSync(join(f.run, "journal.jsonl"), line({ type: "started", key: "k1", agentId: "a1" }));
    writeFileSync(join(f.run, "agent-a1.jsonl"), message("m1", "researching"));
    f.follower.poll();
    expect(texts(f.updates)).toEqual(["researching"]);
    expect(f.updates.find((update) => update.sessionUpdate === "agent_message_chunk")).toMatchObject({ parentToolCallId: "workflow:wf_run:a1" });
    expect(latest(f.updates)).toMatchObject({ status: "in_progress", detail: { workflow: { started: 1, completed: 0 } } });
    const count = f.updates.length;
    f.follower.poll();
    expect(f.updates).toHaveLength(count);
    appendFileSync(join(f.run, "journal.jsonl"), line({ type: "result", key: "k1", agentId: "a1", result: "found it", echo: { type: "started", agentId: "ghost" } }));
    f.follower.poll();
    expect(latest(f.updates)).toMatchObject({ status: "in_progress", detail: { workflow: { started: 1, completed: 1 } } });
    const finals = join(f.dir, "session", "workflows");
    mkdirSync(finals);
    writeFileSync(join(finals, "wf_run.json"), JSON.stringify({ runId: "wf_run", workflowName: "research", status: "completed", totalTokens: 1234, durationMs: 2000,
      timestamp: "2026-10-03T12:00:02Z", workflowProgress: [{ type: "workflow_agent", agentId: "a1", label: "Read sources", phaseTitle: "Research", state: "done" }] }));
    f.follower.poll();
    expect(latest(f.updates)).toMatchObject({ status: "completed", detail: { workflow: { state: "completed", tokens: 1234, durationMs: 2000 } } });
    expect(latest(f.updates, "workflow:wf_run:a1")).toMatchObject({ detail: { agentType: "Research", task: "Read sources" } });
    expect(f.follower.isRunning("wf-call")).toBe(false);
  });

  it("handles partial journals, late metadata, pauses and cancellation without declaring all workers successful", () => {
    const f = fixture();
    appendFileSync(f.transcript, launch());
    const journal = line({ type: "started", agentId: "a1" });
    writeFileSync(join(f.run, "journal.jsonl"), journal.slice(0, -1));
    f.follower.poll();
    expect(latest(f.updates)).toMatchObject({ detail: { workflow: { started: 0 } } });
    appendFileSync(join(f.run, "journal.jsonl"), "\n");
    appendFileSync(f.transcript, line({ type: "system", subtype: "task_updated", task_id: "task-wf", patch: { status: "paused" } }));
    f.follower.poll();
    expect(latest(f.updates)).toMatchObject({ status: "in_progress", detail: { workflow: { state: "paused", started: 1 } } });
    appendFileSync(f.transcript, line({ type: "system", subtype: "task_notification", task_id: "task-wf", status: "stopped" }));
    f.follower.poll();
    expect(latest(f.updates)).toMatchObject({ status: "completed", detail: { workflow: { state: "stopped", completed: 0 } } });
    expect(latest(f.updates, "workflow:wf_run:a1")).toMatchObject({ status: "in_progress", detail: { state: "running" } });
    expect(f.follower.isRunning("wf-call")).toBe(true);
    appendFileSync(f.transcript, line({ type: "system", subtype: "task_progress", task_id: "task-wf", workflow_progress: [{ type: "workflow_agent", agentId: "a1", state: "killed" }] }));
    f.follower.poll();
    expect(latest(f.updates, "workflow:wf_run:a1")).toMatchObject({ status: "completed", detail: { state: "stopped" } });
    expect(f.follower.isRunning("wf-call")).toBe(false);
  });

  it("groups live progress before a final file exists, and joins provisional agents to their later transcript ids", () => {
    const f = fixture();
    appendFileSync(f.transcript, launch());
    const phase = { type: "workflow_phase", index: 2, title: "Implementation" };
    const agent = { type: "workflow_agent", index: 0, label: "Mobile UI", state: "pending", phaseIndex: 2 };
    appendFileSync(f.transcript, line({ type: "system", subtype: "task_progress", task_id: "task-wf", workflow_progress: [phase, agent] }));
    f.follower.poll();
    expect(latest(f.updates)).toMatchObject({ detail: { workflow: { started: 0, phases: [{ id: "phase:2", title: "Implementation" }], agents: [{ id: "pending:0", state: "pending", phaseId: "phase:2" }] } } });
    expect(f.updates.some((update) => update.sessionUpdate === "tool_call" && update.parentToolCallId === "wf-call")).toBe(false);

    appendFileSync(f.transcript, line({ type: "system", subtype: "task_progress", task_id: "task-wf", usage: { total_tokens: 900, duration_ms: 2000 }, workflow_progress: [phase, { ...agent, agentId: "a1", state: "running", tokens: 900, toolCalls: 3 }] }));
    writeFileSync(join(f.run, "journal.jsonl"), line({ type: "started", agentId: "a1" }));
    f.follower.poll();
    expect(latest(f.updates)).toMatchObject({ detail: { workflow: { started: 1, agents: [{ id: "a1", title: "Mobile UI", state: "running", phaseId: "phase:2", tokens: 900, toolCalls: 3 }] } } });
    const before = latest(f.updates) as Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>;
    expect(before.detail?.type === "subagent" && before.detail.workflow?.agents?.[0]?.toolCallId).toBeUndefined();

    writeFileSync(join(f.run, "agent-a1.meta.json"), JSON.stringify({ model: "sonnet" }));
    writeFileSync(join(f.run, "agent-a1.jsonl"), line({ type: "user", uuid: "prompt", message: { content: "Build the mobile overview and check navigation in both themes." } }) + message("worker-message", "working"));
    f.follower.poll();
    expect(latest(f.updates)).toMatchObject({ detail: { workflow: { agents: [{ id: "a1", title: "Mobile UI", model: "sonnet", toolCallId: "workflow:wf_run:a1" }] } } });
    expect(latest(f.updates, "workflow:wf_run:a1")).toMatchObject({ detail: { task: "Build the mobile overview and check navigation in both themes." } });
  });

  it("keeps concurrent runs separate even when their agent indices match", () => {
    const f = fixture();
    const second = JSON.parse(launch({ taskId: "task-second", runId: "wf_second", workflowName: "second" }));
    second.uuid = "second-launch";
    second.message.content[0].tool_use_id = "second-call";
    appendFileSync(f.transcript, launch() + line(second));
    for (const [task, title] of [["task-wf", "Research"], ["task-second", "Review"]]) {
      appendFileSync(f.transcript, line({ type: "system", subtype: "task_progress", task_id: task, workflow_progress: [
        { type: "workflow_phase", index: 1, title },
        { type: "workflow_agent", index: 0, agentId: "same-id", label: title, state: "running", phaseIndex: 1 },
      ] }));
    }
    f.follower.poll();
    expect(latest(f.updates)).toMatchObject({ detail: { workflow: { name: "research", agents: [{ title: "Research" }] } } });
    expect(latest(f.updates, "second-call")).toMatchObject({ detail: { workflow: { name: "second", agents: [{ title: "Review" }] } } });
    expect(f.follower.isRunning("workflow:wf_run:same-id")).toBe(true);
    expect(f.follower.isRunning("workflow:wf_second:same-id")).toBe(true);
  });

  it("does not count a null journal result as successful work", () => {
    const f = fixture();
    appendFileSync(f.transcript, launch());
    writeFileSync(join(f.run, "journal.jsonl"), line({ type: "result", agentId: "a1", result: null }));
    f.follower.poll();
    expect(latest(f.updates)).toMatchObject({ detail: { workflow: { completed: 0, agents: [{ state: "unknown" }] } } });
    expect(f.follower.isRunning("workflow:wf_run:a1")).toBe(false);
  });

  it("replaces a transcript-tail error when the agent retries successfully", () => {
    const f = fixture();
    appendFileSync(f.transcript, launch());
    writeFileSync(join(f.run, "journal.jsonl"), line({ type: "started", agentId: "a1" }));
    const path = join(f.run, "agent-a1.jsonl");
    writeFileSync(path, line({ type: "assistant", uuid: "api-error", isSidechain: true, isApiErrorMessage: true, message: { id: "error", content: [{ type: "text", text: "API error" }] } }));
    f.follower.poll();
    expect(latest(f.updates, "workflow:wf_run:a1")).toMatchObject({ detail: { state: "failed" } });
    appendFileSync(path, message("retry", "working again"));
    f.follower.poll();
    expect(latest(f.updates, "workflow:wf_run:a1")).toMatchObject({ status: "in_progress", detail: { state: "running" } });
  });

  it("does not follow artifact symlinks outside the session", () => {
    const f = fixture();
    appendFileSync(f.transcript, launch());
    writeFileSync(join(f.run, "journal.jsonl"), line({ type: "started", agentId: "a1" }));
    const outside = join(f.dir, "outside.jsonl");
    writeFileSync(outside, message("secret", "outside session"));
    symlinkSync(outside, join(f.run, "agent-a1.jsonl"));
    f.follower.poll();
    expect(texts(f.updates)).toEqual([]);
  });
});
