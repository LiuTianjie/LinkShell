import { z } from "zod";
import type { SessionUpdate } from "./updates.js";

/** A question an agent's message asks without stopping its turn; `id` is what the answer quotes. */
export const asyncQuestionSchema = z.object({ id: z.string(), title: z.string(), options: z.array(z.string()) });
export type AsyncQuestion = z.infer<typeof asyncQuestionSchema>;

/**
 * The message that answers async questions, as Codex Desktop writes it: the
 * agent reads it as the answer, and Desktop (and this app) shows it as one.
 */
export function asyncQuestionReply(answers: { question: AsyncQuestion; answer: string }[]): string {
  const entries = answers.map(({ question, answer }) => ({ questionItemId: question.id, question: question.title, answer }));
  return `<send_user_message_question_reply>\n${JSON.stringify(entries)}\n</send_user_message_question_reply>\n`;
}

export interface QuestionReply {
  /** The question's id, where the reply names it. */
  id?: string;
  question: string;
  answer: string;
}

/**
 * The answers in a reply to async questions, as Codex Desktop writes one (and shows it: each question with
 * its answer). Anything that isn't exactly the envelope is not a reply.
 */
export function questionReplies(text: string): QuestionReply[] | undefined {
  const match = /^<send_user_message_question_reply>\s*([\s\S]+?)\s*<\/send_user_message_question_reply>$/.exec(text.replace(/\r\n/g, "\n").trim());
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0) return undefined;
  const replies: QuestionReply[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return undefined;
    const { questionItemId, question, answer } = entry as Record<string, unknown>;
    if (typeof question !== "string" || typeof answer !== "string") return undefined;
    replies.push({ ...(typeof questionItemId === "string" ? { id: questionItemId } : {}), question: question.trim(), answer: answer.trim() });
  }
  return replies;
}

/** What a message answers, by question id, if it is such a reply. */
export function answeredQuestions(text: string): [id: string, answer: string][] {
  return (questionReplies(text) ?? []).flatMap((reply): [string, string][] => (reply.id ? [[reply.id, reply.answer]] : []));
}

/** Keeps attention separate from running: async questions do not stop the agent. */
export function updateAsyncQuestions(pending: AsyncQuestion[], update: SessionUpdate): AsyncQuestion[] {
  if ("parentToolCallId" in update && update.parentToolCallId) return pending;
  if (update.sessionUpdate === "ls_async_questions") return update.questions;
  if (update.sessionUpdate === "ls_turn") return [];
  if (update.sessionUpdate === "ls_message_done" && update.role === "agent" && update.questions?.length) {
    const merged = new Map(pending.map((question) => [question.id, question]));
    for (const question of update.questions) merged.set(question.id, question);
    return [...merged.values()];
  }
  if (update.sessionUpdate === "user_message_chunk" && update.content.type === "text") {
    const answered = new Set(answeredQuestions(update.content.text).map(([id]) => id));
    if (answered.size) return pending.filter((question) => !answered.has(question.id));
  }
  return pending;
}
