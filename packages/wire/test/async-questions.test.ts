import { describe, expect, it } from "vitest";
import { asyncQuestionReply, questionReplies, updateAsyncQuestions, type AsyncQuestion } from "../src/async-questions.js";
const questions: AsyncQuestion[] = [{ id: "q1", title: "Which?", options: ["A", "B"] }, { id: "q2", title: "Why?", options: [] }];
describe("async questions", () => {
  it("keeps attention while work continues, removes replies and clears ended turns", () => {
    const pending = updateAsyncQuestions([], { sessionUpdate: "ls_message_done", role: "agent", messageId: "ask", questions });
    expect(updateAsyncQuestions(pending, { sessionUpdate: "tool_call", toolCallId: "work", title: "Work", kind: "execute", status: "in_progress" })).toBe(pending);
    const rest = updateAsyncQuestions(pending, { sessionUpdate: "user_message_chunk", messageId: "reply", content: { type: "text", text: asyncQuestionReply([{ question: questions[0]!, answer: "" }]) } });
    expect(rest).toEqual([questions[1]]);
    expect(updateAsyncQuestions(rest, { sessionUpdate: "ls_turn", state: "ended", turnId: "t" })).toEqual([]);
    expect(updateAsyncQuestions(rest, { sessionUpdate: "ls_turn", state: "ended", turnId: "child", parentToolCallId: "agent" })).toBe(rest);
  });
  it("accepts desktop single-object replies and rejects prose around an envelope", () => {
    const text = '<send_user_message_question_reply>{"questionItemId":"q1","question":"Which?","answer":"A"}</send_user_message_question_reply>';
    expect(questionReplies(text)).toEqual([{ id: "q1", question: "Which?", answer: "A" }]);
    expect(questionReplies("Example: " + text)).toBeUndefined();
  });
});
