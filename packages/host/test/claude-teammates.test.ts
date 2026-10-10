import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionUpdateSchema, type SessionUpdate } from "@linkshell/wire";
import { ClaudeActivity } from "../src/drivers/claude/activity.js";
import { readSubagents, transcriptLine } from "../src/drivers/claude/transcript.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const row = (data: object) => JSON.stringify({ timestamp: "2026-10-10T04:27:01Z", ...data }) + "\n";
const spawn = (call = "call", agentId = "afrontend-123", name = "frontend") => [
  row({ type: "assistant", uuid: `spawn-${call}`, message: { content: [{ type: "tool_use", id: call, name: "Agent", input: { name, description: "same task", subagent_type: "general-purpose", run_in_background: true } }] } }),
  row({ type: "user", uuid: `launch-${call}`, message: { content: [{ type: "tool_result", tool_use_id: call, content: "Spawned successfully" }] },
    toolUseResult: { status: "teammate_spawned", agentId, agent_id: agentId, name, resolvedModel: "opus", teammate_id: `${name}@team`, team_name: "team" } }),
];
const assistant = (id: string, content: unknown[], stop = "tool_use") => row({ type: "assistant", isSidechain: true, uuid: id,
  message: { id, content, stop_reason: stop } });
const text = (value: string) => ({ type: "text", text: value });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "linkshell-teammates-")); dirs.push(dir);
  const main = join(dir, "s.jsonl");
  const children = join(dir, "s", "subagents"); mkdirSync(children, { recursive: true });
  writeFileSync(main, "");
  const updates: SessionUpdate[] = [];
  let desktop = true;
  const follower = new ClaudeActivity({ locate: () => main, desktop: () => desktop, onUpdate: (update) => { sessionUpdateSchema.parse(update); updates.push(update); } });
  follower.followFrom(0);
  return { dir, main, children, updates, follower, remote: (value: boolean) => { desktop = !value; } };
}
const state = (updates: SessionUpdate[], call = "call") => updates.findLast((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === call);

describe("Claude CLI teammates", () => {
  it("treats teammate_spawned as a background launch, including snake-case ids", () => {
    const agents = new Set<string>();
    const result = transcriptLine(spawn()[1]!, { agents });
    expect(result.updates).toEqual([{ sessionUpdate: "ls_turn", parentToolCallId: "call", state: "started" }]);
    expect(agents.has("call")).toBe(true);
    const snake = JSON.parse(spawn()[1]!); delete snake.toolUseResult.agentId;
    expect(transcriptLine(JSON.stringify(snake)).updates[0]?.sessionUpdate).toBe("ls_turn");
    snake.message.content[0].is_error = true;
    expect(transcriptLine(JSON.stringify(snake)).updates[0]).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
  });

  it("imports exact child ids without meta.toolUseId, even when names and descriptions collide", () => {
    const f = fixture();
    appendFileSync(f.main, [...spawn(), ...spawn("other", "afrontend-456")].join(""));
    for (const [id, body] of [["afrontend-123", "first"], ["afrontend-456", "second"]]) {
      writeFileSync(join(f.children, `agent-${id}.meta.json`), JSON.stringify({ taskKind: "in_process_teammate", name: "frontend" }));
      writeFileSync(join(f.children, `agent-${id}.jsonl`), assistant(id!, [text(body!)], "end_turn"));
    }
    f.follower.poll();
    const messages = f.updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
    expect(messages).toMatchObject([{ parentToolCallId: "call", content: text("first") }, { parentToolCallId: "other", content: text("second") }]);
    expect(state(f.updates)).toMatchObject({ status: "completed", detail: { name: "frontend", state: "completed", model: "opus" } });
    expect(readSubagents(f.main).filter((u) => u.sessionUpdate === "agent_message_chunk")).toEqual(messages);
    const count = f.updates.length; f.follower.poll(); expect(f.updates).toHaveLength(count);
  });

  it("follows late child files and ongoing tools while the main transcript is quiet; completion can start another turn", () => {
    const f = fixture(); appendFileSync(f.main, spawn().join("")); f.follower.poll();
    expect(state(f.updates)).toMatchObject({ status: "in_progress", detail: { state: "running" } });
    const path = join(f.children, "agent-afrontend-123.jsonl");
    const tool = assistant("m1", [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/repo/a.ts" } }]);
    writeFileSync(path, tool.slice(0, -1)); f.follower.poll();
    expect(f.updates.some((u) => u.sessionUpdate === "tool_call")).toBe(false);
    appendFileSync(path, "\n"); f.follower.poll();
    expect(f.updates).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "read-1", parentToolCallId: "call" }));
    appendFileSync(path, assistant("m2", [text("finished")], "end_turn")); f.follower.poll();
    expect(f.follower.isRunning("call")).toBe(false);
    expect(state(f.updates)).toMatchObject({ detail: { state: "completed" } });
    appendFileSync(path, tool); f.follower.poll(); // Compaction copies must not reopen it.
    expect(state(f.updates)).toMatchObject({ detail: { state: "completed" } });
    appendFileSync(path, assistant("m3", [text("new assignment")])); f.follower.poll();
    expect(f.follower.isRunning("call")).toBe(true);
    f.follower.lostHolder();
    expect(state(f.updates)).toMatchObject({ detail: { state: "unknown" } });
    expect(f.follower.isRunning("call")).toBe(false);
  });

  it("does not mark a progress message as completion, and preserves failure and cancellation", () => {
    const f = fixture(); appendFileSync(f.main, spawn().join(""));
    const path = join(f.children, "agent-afrontend-123.jsonl");
    writeFileSync(path, assistant("progress", [text("Done reading; implementation next.")])); f.follower.poll();
    expect(state(f.updates)).toMatchObject({ detail: { state: "running" } });
    appendFileSync(path, assistant("failed", [text("limit")], "max_tokens")); f.follower.poll();
    expect(state(f.updates)).toMatchObject({ status: "failed", detail: { state: "failed" } });
    appendFileSync(path, row({ type: "user", uuid: "cancelled", isSidechain: true, message: { content: [text("[Request interrupted by user]")] } })); f.follower.poll();
    expect(state(f.updates)).toMatchObject({ detail: { state: "stopped" } });
  });

  it("keeps lifecycle snapshots while ACP streams the child, without echoing its messages on handoff", () => {
    const f = fixture(); appendFileSync(f.main, spawn().join(""));
    const path = join(f.children, "agent-afrontend-123.jsonl");
    writeFileSync(path, assistant("m1", [text("desktop")])); f.follower.poll();
    f.remote(true); appendFileSync(path, assistant("m2", [text("already streamed by ACP")], "end_turn")); f.follower.poll();
    expect(state(f.updates)).toMatchObject({ detail: { state: "completed" } });
    f.remote(false); appendFileSync(path, assistant("m3", [text("back at desk")])); f.follower.poll();
    expect(f.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content)).toEqual([text("desktop"), text("back at desk")]);
  });

  it("does not guess an association from names, follow outside symlinks or move a resumed agent's history", () => {
    const f = fixture(); appendFileSync(f.main, [...spawn(), ...spawn("resume", "afrontend-123")].join(""));
    const path = join(f.children, "agent-afrontend-123.jsonl");
    writeFileSync(join(f.dir, "outside.jsonl"), assistant("outside", [text("outside")], "end_turn"));
    symlinkSync(join(f.dir, "outside.jsonl"), path);
    writeFileSync(join(f.children, "agent-unknown.meta.json"), JSON.stringify({ taskKind: "in_process_teammate", name: "frontend" }));
    writeFileSync(join(f.children, "agent-unknown.jsonl"), assistant("unknown", [text("unknown")], "end_turn"));
    f.follower.poll();
    expect(f.updates.some((u) => u.sessionUpdate === "agent_message_chunk")).toBe(false);
    expect(readSubagents(f.main)).toEqual([]);
    rmSync(path); writeFileSync(path, assistant("real", [text("real")], "end_turn")); f.follower.poll();
    expect(f.updates.find((u) => u.sessionUpdate === "agent_message_chunk")).toMatchObject({ parentToolCallId: "call" });
  });
});
