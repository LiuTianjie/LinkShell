import type { ComponentProps, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { questionAnswerError, type AsyncQuestion } from "@linkshell/wire";
import { AsyncQuestionCard } from "../src/components/async-question-card";
import type { QuestionCard } from "../src/components/question-card";

const actions = vi.hoisted(() => ({ answerAsync: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/client", () => ({ useActions: () => actions }));
vi.mock("../src/components/question-card", () => ({ QuestionCard: () => null }));

function card(question: AsyncQuestion) {
  return (AsyncQuestionCard({ sessionId: "codex:test", questions: [question], agentName: "Codex", disabled: false }) as ReactElement<ComponentProps<typeof QuestionCard>>).props;
}

describe("async question answer card", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts and sends a pasted multiline link for a question without options", async () => {
    const question = { id: "question", title: "帖子链接或产品名是什么？", options: [] };
    const props = card(question);
    const field = props.request.questions![0]!;
    const answer = { id: question.id, values: ["5k120fps 超低延迟远程桌面\nhttps://xhslink.cn/o/AcCMdkfg6oN\n复制一下，打开【小红书】就能阅读全文。"] };
    expect(field.kind).toBe("text");
    expect(field.options).toBeUndefined();
    expect(questionAnswerError(field, answer)).toBeUndefined();
    await props.onAnswer(props.request.requestId, [answer]);
    expect(actions.answerAsync).toHaveBeenCalledExactlyOnceWith("codex:test", question, answer.values[0]);
  });

  it("requires an answer for submission while preserving explicit skip", async () => {
    const question = { id: "question", title: "链接是什么？", options: [] };
    const props = card(question);
    expect(questionAnswerError(props.request.questions![0]!, undefined)).toContain("还没回答");
    await props.onChoose(props.request.requestId, "skip");
    expect(actions.answerAsync).toHaveBeenCalledExactlyOnceWith("codex:test", question, "");
  });

  it("keeps suggested choices and a user's own answer valid", async () => {
    const question = { id: "question", title: "哪个终端？", options: ["Claude Code", "Shell"] };
    const props = card(question);
    const field = props.request.questions![0]!;
    expect(field.kind).toBe("choice");
    expect(questionAnswerError(field, { id: question.id, values: ["Claude Code"] })).toBeUndefined();
    const answer = { id: question.id, values: [], other: "另一个终端" };
    expect(questionAnswerError(field, answer)).toBeUndefined();
    await props.onAnswer(props.request.requestId, [answer]);
    expect(actions.answerAsync).toHaveBeenCalledExactlyOnceWith("codex:test", question, "另一个终端");
  });
});
