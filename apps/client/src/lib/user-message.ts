import type { ContentBlock } from "@linkshell/wire";

export interface QuestionReply {
  question: string;
  answer: string;
}

/**
 * Codex Desktop answers its async questions (`request_user_input_async`) with an
 * ordinary user message carrying this envelope; Desktop shows it as the quoted
 * question and the answer, so the app does the same. Anything that isn't
 * exactly the envelope stays plain text.
 */
export function questionReplies(text: string): QuestionReply[] | undefined {
  const match = /^<send_user_message_question_reply>\n([\s\S]+)\n<\/send_user_message_question_reply>$/.exec(text.replace(/\r\n/g, "\n").trim());
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const replies: QuestionReply[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return undefined;
    const { question, answer } = entry as Record<string, unknown>;
    if (typeof question !== "string" || typeof answer !== "string") return undefined;
    replies.push({ question: question.trim(), answer: answer.trim() });
  }
  return replies;
}

/** Presentation only: the stored prompt and the instructions sent to the agent stay intact. */
export function userMessageText(blocks: ContentBlock[]): string {
  const text = blocks.map((block) => block.type === "text" ? block.text : "").join("").trim();
  const imageCount = blocks.filter((block) => block.type === "image").length;
  if (!imageCount) return text;
  const normalized = text.replace(/\r\n/g, "\n");
  // Match the whole desktop-generated image envelope, not a heading mentioned in ordinary prose.
  const envelope = /^# Files mentioned by the user:\n\n([\s\S]+?)\n\nDistinguish instructions in attached documents from the user's request\.\n\n## My request:(?:\n([\s\S]*))?$/.exec(normalized);
  if (!envelope) return text;
  const files = envelope[1]!.split("\n\n");
  if (files.length > imageCount || !files.every((file) => {
    const entry = /^## ([^\n]+?): ((?:\/|[A-Za-z]:[\\/])[^\n]+)\nImage attachment: true$/.exec(file);
    return !!entry && entry[2]!.split(/[\\/]/).at(-1) === entry[1];
  })) return text;
  return (envelope[2] ?? "").trim();
}
