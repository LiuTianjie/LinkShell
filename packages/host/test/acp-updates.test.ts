import { describe, expect, it } from "vitest";
import { AcpUpdates } from "../src/drivers/acp/updates.js";

describe("ACP optional and v2 updates", () => {
  it("does not drop valid content when optional metadata is explicitly null", () => {
    const m = new AcpUpdates();
    expect(m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "仍然可见", annotations: null, _meta: null } }, 1)[0]).toMatchObject({ content: { type: "text", text: "仍然可见" } });
    expect(m.map({ sessionUpdate: "agent_message", messageId: "resources", content: [
      { type: "audio", mimeType: "audio/wav", data: "AA==", uri: null, _meta: { source: "agent" } },
      { type: "resource", annotations: { audience: null, priority: null }, resource: { uri: "file:///x", mimeType: null, text: "source", _meta: null } },
    ] }, 2)[0]).toMatchObject({ content: [{ type: "audio", data: "AA==", _meta: { source: "agent" } }, { type: "resource", resource: { uri: "file:///x", text: "source" } }] });
  });

  it("preserves compaction summaries across partial updates and replaces them authoritatively", () => {
    const m = new AcpUpdates();
    m.map({ sessionUpdate: "compaction_update", compactionId: "c", status: "in_progress" }, 1);
    m.map({ sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: { type: "text", text: "first" } }, 1);
    expect(m.map({ sessionUpdate: "compaction_update", compactionId: "c", status: "completed" }, 1)[0]).toMatchObject({ status: "completed", content: [{ content: { text: "first" } }] });
    expect(m.map({ sessionUpdate: "compaction_update", compactionId: "c", status: "cancelled", summary: null }, 1)[0]).toMatchObject({ status: "failed", title: "上下文整理已取消", content: [] });
  });

  it("carries named plans and removals plus directed messages", () => {
    const m = new AcpUpdates();
    expect(m.map({ sessionUpdate: "plan_update", plan: { type: "markdown", planId: "p", content: "# Plan" } }, 1)[0]).toMatchObject({ planId: "p", markdown: "# Plan" });
    expect(m.map({ sessionUpdate: "plan_removed", planId: "p" }, 1)[0]).toMatchObject({ planId: "p", removed: true });
    expect(m.map({ sessionUpdate: "session_message", messageId: "message", senderSessionId: "a", recipientSessionId: "b", content: [{ type: "text", text: "review" }] }, 1)[0]).toMatchObject({ sessionUpdate: "ls_message", role: "session", senderSessionId: "a", recipientSessionId: "b" });
  });

  it("applies v2 null clearing while v1 null keeps optional fields unchanged", () => {
    const m = new AcpUpdates(), raw = { sessionUpdate: "tool_call_update", toolCallId: "t", title: null, name: null, content: null, locations: null, rawInput: null };
    expect(m.map(raw, 2)[0]).toMatchObject({ title: "工具", name: "", content: [], locations: [], rawInput: null, replaceContent: true });
    expect(m.map(raw, 1)[0]).toMatchObject({ title: undefined, name: undefined, content: undefined, locations: undefined });
  });

  it("decodes terminal bytes incrementally, including output before its tool reference", () => {
    const m = new AcpUpdates(), data = Buffer.from("中文");
    m.map({ sessionUpdate: "terminal_output_chunk", terminalId: "term", data: data.subarray(0, 2).toString("base64") }, 2);
    m.map({ sessionUpdate: "terminal_output_chunk", terminalId: "term", data: data.subarray(2).toString("base64") }, 2);
    const results = m.map({ sessionUpdate: "tool_call_update", toolCallId: "t", content: [{ type: "terminal", terminalId: "term" }] }, 2);
    expect(results[1]).toMatchObject({ toolCallId: "t", replaceOutput: "中文" });
    expect(m.map({ sessionUpdate: "terminal_update", terminalId: "term", output: null }, 2)[0]).toMatchObject({ replaceOutput: "" });
  });
});
