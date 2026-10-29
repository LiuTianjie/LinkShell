import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionUpdate } from "@linkshell/wire";
import { applyEvents, emptyView, questionOptionName, questionTitle, recommendedLabel } from "../src/index.js";

let seq = 0;
const ev = (update: SessionUpdate): SessionEvent => ({ sessionId: "s", seq: ++seq, ts: 1000 + seq, update });
// What hosts send beside an agent's questions (packages/host/src/questions.ts).
const questionOptions = [
  { optionId: "skip", name: "Skip", kind: "reject_once" as const },
  { optionId: "cancel", name: "Stop", kind: "reject_once" as const },
];

describe("question wording", () => {
  it("rewords the English that question requests arrive with, and nothing else", () => {
    expect(questionTitle("Please answer the following questions.")).toBe("请回答以下问题");
    expect(questionTitle("Which database should it use?")).toBe("Which database should it use?");
    expect(questionTitle("Codex 有几个问题")).toBe("Codex 有几个问题");
    expect(questionOptions.map(questionOptionName)).toEqual(["跳过", "停止"]);
    // An agent's own option keeps its own words, even when it is called the same.
    expect(questionOptionName({ optionId: "agent-skip", name: "Skip" })).toBe("Skip");
    expect(questionOptionName({ optionId: "cancel", name: "拒绝并停止" })).toBe("拒绝并停止");
  });

  it("turns an agent's (Recommended) mark into a flag, wherever the agent put it", () => {
    expect(recommendedLabel("结果窗口边缘可拖动 (Recommended)")).toEqual({ text: "结果窗口边缘可拖动", recommended: true });
    expect(recommendedLabel("PNG(recommended)")).toEqual({ text: "PNG", recommended: true });
    expect(recommendedLabel("(Recommended) Keep alive while running")).toEqual({ text: "Keep alive while running", recommended: true });
    expect(recommendedLabel("Use the recommended defaults")).toEqual({ text: "Use the recommended defaults", recommended: false });
    expect(recommendedLabel("(Recommended)")).toEqual({ text: "(Recommended)", recommended: false });
  });

  it("records an answered or skipped question in the same words", () => {
    seq = 0;
    const questions = [
      { id: "question_0", header: "框选调整", text: "怎么调整？", kind: "choice" as const, options: [{ value: "边缘可拖动 (Recommended)", label: "边缘可拖动 (Recommended)" }, { value: "固定大小", label: "固定大小" }] },
      { id: "question_1", text: "格式？", kind: "choice" as const, options: [{ value: "PNG", label: "PNG" }] },
    ];
    const asked = (requestId: string) => ev({ sessionUpdate: "ls_permission", requestId, title: "Please answer the following questions.", questions, options: questionOptions });
    const view = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "ls_turn", state: "started" }),
      asked("r1"),
      ev({ sessionUpdate: "ls_permission_resolved", requestId: "r1", answers: [{ id: "question_0", values: ["边缘可拖动 (Recommended)"] }] }),
      asked("r2"),
      ev({ sessionUpdate: "ls_permission_resolved", requestId: "r2", optionId: "skip" }),
    ]);
    const results = view.items.filter((item) => item.kind === "permission-result");
    expect(results[0]).toMatchObject({ title: "请回答以下问题", asked: true, answers: [{ question: "框选调整", answer: "边缘可拖动" }] });
    expect(results[1]).toMatchObject({ title: "请回答以下问题", asked: true, optionName: "跳过" });
  });
});
