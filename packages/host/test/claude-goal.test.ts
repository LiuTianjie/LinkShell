import { describe, expect, it } from "vitest";
import { transcriptLine } from "../src/drivers/claude/transcript.js";

describe("Claude desktop Goal records", () => {
  const line = (attachment: object, isSidechain = false) => JSON.stringify({ type: "attachment", uuid: "goal-check", sessionId: "s", isSidechain, attachment: { type: "goal_status", condition: "测试全部通过", ...attachment } });
  it("restores progress and completion from native transcript attachments", () => {
    expect(transcriptLine(line({ met: false, iterations: 2, tokens: 300, durationMs: 1200, reason: "还有一个失败" })).updates).toEqual([{ sessionUpdate: "ls_goal", goal: { objective: "测试全部通过", status: "active", iterations: 2, tokensUsed: 300, timeUsedSeconds: 1.2, lastReason: "还有一个失败" } }]);
    expect(transcriptLine(line({ met: true, iterations: 3 })).updates[0]).toMatchObject({ goal: { status: "complete" } });
    expect(transcriptLine(line({ met: true, sentinel: true })).updates).toEqual([{ sessionUpdate: "ls_goal", goal: null }]);
  });
  it("ignores malformed snapshots and sub-agent goals", () => {
    expect(transcriptLine(line({ met: false }, true)).updates).toEqual([]);
    expect(transcriptLine(line({ met: "yes" })).updates).toEqual([]);
    expect(transcriptLine(line({ met: false, tokens: -1 })).updates).toEqual([]);
  });
});
