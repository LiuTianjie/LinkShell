import { describe, expect, it } from "vitest";
import { questionAnswerError } from "../src/questions.js";
import type { Question } from "../src/model.js";

describe("question answer validation", () => {
  it.each<{ name: string; options?: Question["options"] }>([
    { name: "omitted" }, { name: "empty", options: [] },
  ])("accepts free text with $name options", ({ options }) => {
    const question: Question = { id: "link", text: "帖子链接是什么？", kind: "text", options, required: true };
    expect(questionAnswerError(question, { id: question.id, values: ["5k120fps 远程桌面\nhttps://xhslink.cn/o/AcCMdkfg6oN"] })).toBeUndefined();
    expect(questionAnswerError(question, undefined)).toContain("还没回答");
    expect(questionAnswerError(question, { id: question.id, values: ["one", "two"] })).toContain("只能填写一个答案");
  });

  it.each(["choice", "choices"] as const)("still rejects unknown %s values, including an empty allowed set", (kind) => {
    const question: Question = { id: "pick", text: "选择", kind, options: [{ value: "a", label: "A" }], other: true };
    expect(questionAnswerError(question, { id: question.id, values: ["a"] })).toBeUndefined();
    expect(questionAnswerError(question, { id: question.id, values: ["unknown"] })).toContain("包含无效选项");
    expect(questionAnswerError({ ...question, options: [] }, { id: question.id, values: ["unknown"] })).toContain("包含无效选项");
    expect(questionAnswerError(question, { id: question.id, values: [], other: "自己写的回答" })).toBeUndefined();
  });

  it("retains text and numeric constraints when an adapter supplies empty options", () => {
    const question: Question = { id: "value", text: "填写", kind: "text", options: [] };
    expect(questionAnswerError({ ...question, constraints: { type: "string", minLength: 3 } }, { id: question.id, values: ["ab"] })).toContain("至少需要 3 个字符");
    expect(questionAnswerError({ ...question, constraints: { type: "integer", minimum: 1 } }, { id: question.id, values: ["0"] })).toContain("不能小于 1");
  });
});
