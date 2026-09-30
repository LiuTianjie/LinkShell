import { describe, expect, it } from "vitest";
import { normalizeAcpUpdate } from "../src/drivers/acp/mapper.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript, transcriptLine } from "../src/drivers/claude/transcript.js";
import { itemToHistory } from "../src/drivers/codex/mapper.js";

// Every driver reports the same generic tool detail, whatever the agent calls it.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function toolCall(updates: { sessionUpdate: string }[] | undefined) {
  return updates?.find((u) => u.sessionUpdate === "tool_call") as Record<string, unknown> | undefined;
}

describe("tool detail", () => {
  it("Codex: MCP, web search, sub-agent and image generation", () => {
    const mcp = itemToHistory({
      type: "mcpToolCall",
      id: "m1",
      server: "playwright",
      tool: "browser_take_screenshot",
      status: "completed",
      arguments: { fullPage: true },
      result: { content: [{ type: "text", text: "saved" }, { type: "image", data: PNG, mimeType: "image/png" }] },
    });
    expect(toolCall(mcp?.updates)?.detail).toEqual({ type: "mcp", server: "playwright", tool: "browser_take_screenshot" });
    const finish = mcp?.updates.find((u) => u.sessionUpdate === "tool_call_update") as { content?: unknown[] };
    expect(finish.content).toEqual([
      { type: "content", content: { type: "text", text: "saved" } },
      { type: "content", content: { type: "image", mimeType: "image/png", data: PNG } },
    ]);

    expect(toolCall(itemToHistory({ type: "webSearch", id: "w", query: "expo" })?.updates)?.detail).toEqual({ type: "web_search", query: "expo" });
    const spawn = itemToHistory({
      type: "collabAgentToolCall",
      id: "s",
      tool: "spawnAgent",
      status: "completed",
      prompt: "check pages",
      model: "gpt-5",
      receiverThreadIds: ["child"],
    });
    expect(toolCall(spawn?.updates)?.detail).toEqual({ type: "subagent", action: "spawn", task: "check pages", model: "gpt-5" });
    const wait = itemToHistory({ type: "collabAgentToolCall", id: "w2", tool: "wait", status: "inProgress", receiverThreadIds: ["child"] });
    expect(toolCall(wait?.updates)?.detail).toMatchObject({ type: "subagent", action: "wait" });
    expect(itemToHistory({ type: "subAgentActivity", id: "a", kind: "started", agentThreadId: "child", agentPath: "x" })).toBeUndefined();
    const image = itemToHistory({ type: "imageGeneration", id: "g", status: "completed", revisedPrompt: "a cat", result: PNG });
    expect(toolCall(image?.updates)?.detail).toEqual({ type: "image_generation", prompt: "a cat" });
  });

  it("Claude transcript: MCP and Task tools, with tool-result images", () => {
    const line = (message: unknown, type = "assistant") => JSON.stringify({ type, uuid: "u", timestamp: "2026-09-30T00:00:00Z", message });
    const mcp = transcriptLine(line({ id: "msg", content: [{ type: "tool_use", id: "t1", name: "mcp__playwright__browser_click", input: { ref: "e1" } }] }));
    expect(toolCall(mcp.updates)?.detail).toEqual({ type: "mcp", server: "playwright", tool: "browser_click" });
    const task = transcriptLine(line({ id: "msg", content: [{ type: "tool_use", id: "t2", name: "Task", input: { description: "Audit pages" } }] }));
    expect(toolCall(task.updates)?.detail).toEqual({ type: "subagent", action: "spawn", task: "Audit pages" });
    const skill = transcriptLine(line({ id: "msg", content: [{ type: "tool_use", id: "t3", name: "Skill", input: { skill: "pdf" } }] }));
    expect(toolCall(skill.updates)?.detail).toEqual({ type: "skill", name: "pdf" });
    const command = transcriptLine(
      line({ role: "user", content: "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src/app</command-args>" }, "user"),
    );
    const note = transcriptLine(
      line({ role: "user", content: "<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>task1</tool-use-id>\n<status>completed</status>\n</task-notification>" }, "user"),
    );
    expect(note.updates.map((u) => u.sessionUpdate)).toEqual(["tool_call_update", "ls_turn"]);
    expect(note.updates[0]).toMatchObject({ toolCallId: "task1", status: "completed" });
    const queued = transcriptLine(
      JSON.stringify({
        type: "attachment",
        uuid: "q1",
        timestamp: "2026-09-30T00:00:00Z",
        attachment: { type: "queued_command", prompt: "就是我新发的话", source_uuid: "src1", commandMode: "prompt", origin: { kind: "human" } },
      }),
    );
    expect(queued.updates).toEqual([{ sessionUpdate: "user_message_chunk", messageId: "src1", content: { type: "text", text: "就是我新发的话" } }]);
    const system = transcriptLine(JSON.stringify({ type: "attachment", attachment: { type: "skill_listing", content: "…" } }));
    expect(system.updates).toEqual([]);
    expect(command.updates[0]).toMatchObject({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "/review src/app" } });

    const result = transcriptLine(
      line(
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] },
        "user",
      ),
    );
    expect(result.updates[0]).toMatchObject({ sessionUpdate: "tool_call_update", content: [{ type: "content", content: { type: "image", data: PNG } }] });
  });

  it("Claude: TodoWrite shows as the plan, not as a tool call too", () => {
    const line = (message: unknown, type = "assistant") => JSON.stringify({ type, uuid: "u", timestamp: "2026-09-30T00:00:00Z", message });
    const hidden = new Set<string>();
    const todos = { todos: [{ content: "跑测试", status: "completed", activeForm: "跑测试" }] };
    const call = transcriptLine(line({ id: "msg", content: [{ type: "tool_use", id: "todo1", name: "TodoWrite", input: todos }] }), { hidden });
    expect(call.updates.map((u) => u.sessionUpdate)).toEqual(["plan"]);
    const result = transcriptLine(line({ role: "user", content: [{ type: "tool_result", tool_use_id: "todo1", content: "Todos updated" }] }, "user"), { hidden });
    expect(result.updates).toEqual([]);
    expect(hidden.size).toBe(0);
  });

  it("Claude: imports sub-agent transcripts nested under their Task call", () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-sub-"));
    const main = join(dir, "s.jsonl");
    const at = (s: number) => `2026-09-30T00:00:0${s}Z`;
    writeFileSync(
      main,
      [
        { type: "assistant", uuid: "a", timestamp: at(1), message: { id: "m1", content: [{ type: "tool_use", id: "task1", name: "Task", input: { description: "Audit" } }] } },
        { type: "user", uuid: "b", timestamp: at(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "task1", content: "done" }] } },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    mkdirSync(join(dir, "s", "subagents"), { recursive: true });
    writeFileSync(join(dir, "s", "subagents", "agent-x.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "task1" }));
    writeFileSync(
      join(dir, "s", "subagents", "agent-x.jsonl"),
      [
        { type: "user", isSidechain: true, uuid: "c", timestamp: at(2), message: { role: "user", content: "Audit the pages" } },
        { type: "assistant", isSidechain: true, uuid: "d", timestamp: at(3), message: { id: "m2", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/a.ts" } }] } },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    const { updates } = readTranscript(main);
    expect(updates.map((u) => [u.sessionUpdate, (u as { parentToolCallId?: string }).parentToolCallId])).toEqual([
      ["tool_call", undefined],
      ["ls_turn", "task1"],
      ["tool_call", "task1"],
      ["tool_call_update", undefined],
    ]);
  });

  it("ACP: reads Claude's tool name from _meta, stays generic otherwise", () => {
    const claude = normalizeAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "a",
      title: "browser_click",
      kind: "other",
      rawInput: {},
      _meta: { claudeCode: { toolName: "mcp__playwright__browser_click" } },
    });
    expect((claude as Record<string, unknown>).detail).toEqual({ type: "mcp", server: "playwright", tool: "browser_click" });
    const child = normalizeAcpUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "c1",
      content: { type: "text", text: "hi" },
      _meta: { claudeCode: { parentToolUseId: "task1" } },
    });
    expect(child).toMatchObject({ parentToolCallId: "task1" });
    const prompt = normalizeAcpUpdate({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Audit" },
      _meta: { claudeCode: { parentToolUseId: "task1" } },
    });
    expect(prompt).toBeUndefined();
    const other = normalizeAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "b", title: "Read file", kind: "read" });
    expect((other as Record<string, unknown>).detail).toBeUndefined();
  });
});
