import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionUpdate } from "@linkshell/wire";
import { applyEvents, emptyView } from "../../client-core/src/timeline.js";
import { AcpUpdates } from "../src/drivers/acp/updates.js";
import { slimEvent } from "../src/slim.js";

const reference = { sessionUpdate: "tool_call_update", toolCallId: "build", content: [{ type: "terminal", terminalId: "term" }] };
const chunk = (text: string) => ({ sessionUpdate: "terminal_output_chunk", terminalId: "term", data: Buffer.from(text).toString("base64") });
function events(updates: SessionUpdate[]): SessionEvent[] {
  return updates.map((update, i) => slimEvent({ sessionId: "test", seq: i + 1, ts: i, update }, { lazyImages: true }));
}
function output(updates: SessionUpdate[]): string {
  const tool = applyEvents(emptyView("test"), events(updates)).items.find((item) => item.id === "build");
  return tool?.kind === "tool" ? tool.output : "";
}

describe("ACP terminal traffic", () => {
  it("sends 100 KB of streamed logs once, with linear event overhead and exact replay", () => {
    const mapper = new AcpUpdates(), updates = mapper.map(reference, 2);
    let expected = "";
    for (let i = 0; i < 100; i++) {
      const text = String(i).padStart(4, "0") + "x".repeat(1020);
      expected += text;
      const next = mapper.map(chunk(text), 2);
      expect(next).toEqual([{ sessionUpdate: "tool_call_update", toolCallId: "build", appendOutput: text }]);
      updates.push(...next);
    }
    const bytes = events(updates).reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);
    expect(bytes).toBeLessThan(Buffer.byteLength(expected) * 1.5);
    expect(output(updates)).toBe(expected);
  });

  it("sends a backlog only for a new reference, while explicit snapshots replace it", () => {
    const mapper = new AcpUpdates();
    mapper.map(chunk("before"), 2);
    const updates = mapper.map(reference, 2);
    expect(output(updates)).toBe("before");
    expect(mapper.map(reference, 2)).toHaveLength(1);
    updates.push(...mapper.map(chunk(" after"), 2));
    expect(output(updates)).toBe("before after");
    updates.push(...mapper.map({ sessionUpdate: "terminal_update", terminalId: "term", output: null }, 2));
    updates.push(...mapper.map(chunk("new"), 2));
    const exited = mapper.map({ sessionUpdate: "terminal_update", terminalId: "term", exitStatus: { exitCode: 0 } }, 2);
    expect(exited[0]).not.toHaveProperty("replaceOutput");
    expect(output([...updates, ...exited])).toBe("new");
  });

  it("waits for a complete UTF-8 character before sending the delta", () => {
    const mapper = new AcpUpdates(), updates = mapper.map(reference, 2), bytes = Buffer.from("中文");
    expect(mapper.map({ ...chunk(""), data: bytes.subarray(0, 2).toString("base64") }, 2)).toEqual([]);
    updates.push(...mapper.map({ ...chunk(""), data: bytes.subarray(2).toString("base64") }, 2));
    expect(output(updates)).toBe("中文");
  });
});
