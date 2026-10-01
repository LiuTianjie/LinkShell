import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTranscript, settingsOf } from "../src/drivers/claude/transcript.js";

// An agent Claude starts in the background outlives the call that started it:
// it is working from the launch until its task notification, whatever the
// main conversation does in between.

const line = (entry: Record<string, unknown>) => JSON.stringify({ isSidechain: false, sessionId: "s", cwd: "/w", entrypoint: "cli", timestamp: "2026-09-30T03:21:30.000Z", ...entry });

function transcript(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "lsh-agents-"));
  const path = join(dir, "s.jsonl");
  writeFileSync(path, lines.map((entry) => `${entry}\n`).join(""));
  return readTranscript(path);
}

const launch = (id: string, task: string) => [
  line({ type: "assistant", uuid: `a-${id}`, message: { id: `m-${id}`, role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "Agent", input: { description: task, prompt: "do it", subagent_type: "general-purpose", run_in_background: true } }] } }),
  line({
    type: "user",
    uuid: `r-${id}`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "Async agent launched successfully. (This tool result is internal metadata…)" }] }] },
    toolUseResult: { isAsync: true, status: "async_launched", agentId: `agent-${id}`, description: task },
  }),
];

const notification = (id: string, status: string, result?: string) =>
  line({
    type: "attachment",
    uuid: `n-${id}`,
    attachment: {
      type: "queued_command",
      commandMode: "task-notification",
      origin: { kind: "task-notification", producer: "session-task" },
      prompt: `<task-notification>\n<task-id>agent-${id}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>Agent finished</summary>${result ? `\n<result>${result}</result>` : ""}\n</task-notification>`,
    },
  });

const about = (updates: ReturnType<typeof transcript>["updates"], id: string) =>
  updates.flatMap((update) => {
    const u = update as { sessionUpdate: string; toolCallId?: string; parentToolCallId?: string; status?: string; state?: string; stopReason?: string };
    if (u.toolCallId !== id && u.parentToolCallId !== id) return [];
    return [[u.sessionUpdate, u.status ?? u.state, u.stopReason].filter(Boolean).join(" ")];
  });

describe("Claude background agents", () => {
  it("are working from their launch until their task notification", () => {
    const { updates, agents } = transcript([
      line({ type: "user", uuid: "u1", message: { role: "user", content: "look into two things" } }),
      ...launch("toolu_A", "map the api"),
      ...launch("toolu_B", "check the tests"),
      line({ type: "assistant", uuid: "a9", message: { id: "m9", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Both are running." }] } }),
      notification("toolu_B", "completed", "3 tests cover it."),
    ]);
    // A: launched, its call still open, its turn under way. The launch text itself is not shown.
    expect(about(updates, "toolu_A")).toEqual(["tool_call in_progress", "ls_turn started"]);
    // B: reported back, with its report as the call's result.
    expect(about(updates, "toolu_B")).toEqual(["tool_call in_progress", "ls_turn started", "tool_call_update completed", "ls_turn ended end_turn"]);
    const done = updates.find((update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === "toolu_B") as { content?: unknown };
    expect(done.content).toEqual([{ type: "content", content: { type: "text", text: "3 tests cover it." } }]);
    expect([...agents]).toEqual(["toolu_A"]);
  });

  it("stop being working when they are killed or fail", () => {
    const { updates, agents } = transcript([...launch("toolu_K", "long job"), notification("toolu_K", "killed"), ...launch("toolu_F", "bad job"), notification("toolu_F", "failed")]);
    expect(about(updates, "toolu_K")).toEqual(["tool_call in_progress", "ls_turn started", "tool_call_update failed", "ls_turn ended cancelled"]);
    expect(about(updates, "toolu_F")).toEqual(["tool_call in_progress", "ls_turn started", "tool_call_update failed", "ls_turn ended error"]);
    expect(agents.size).toBe(0);
  });

  it("leave a background shell command's notification to its own call", () => {
    const { updates } = transcript([
      line({ type: "assistant", uuid: "a1", message: { id: "m1", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_S", name: "Bash", input: { command: "make", run_in_background: true } }] } }),
      line({ type: "user", uuid: "r1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_S", content: "Command running in background with ID: b1" }] }, toolUseResult: { backgroundTaskId: "b1" } }),
      notification("toolu_S", "completed"),
    ]);
    expect(about(updates, "toolu_S")).toEqual(["tool_call in_progress", "tool_call_update completed", "tool_call_update completed"]);
  });
});

describe("Claude session settings, as the transcript shows them", () => {
  it("come from the latest reply and prompt", () => {
    const { settings } = transcript([
      line({ type: "user", uuid: "u1", permissionMode: "default", message: { role: "user", content: "hi" } }),
      line({ type: "assistant", uuid: "a1", effort: "medium", message: { id: "m1", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { speed: "standard" }, content: [{ type: "text", text: "hello" }] } }),
      line({ type: "user", uuid: "u2", permissionMode: "bypassPermissions", message: { role: "user", content: 'say "effort":"low" and "permissionMode":"plan"' } }),
      line({ type: "assistant", uuid: "a2", effort: "high", message: { id: "m2", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", usage: { speed: "fast" }, content: [{ type: "text", text: "done" }] } }),
      // A sub-agent's own model is not the session's.
      line({ type: "assistant", uuid: "a3", isSidechain: true, effort: "low", message: { id: "m3", role: "assistant", model: "claude-haiku-4-5", content: [] } }),
    ]);
    expect(settings).toEqual({ model: "claude-opus-5-5", effort: "high", mode: "bypassPermissions", fast: true });
    expect(settingsOf(line({ type: "system", subtype: "turn_duration" }))).toBeUndefined();
  });
});

