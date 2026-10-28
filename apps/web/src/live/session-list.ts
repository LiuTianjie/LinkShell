import type { SessionSummary } from "@linkshell/wire";
import { userMessageText } from "@linkshell/client-core";

export function sessionNeedsAttention(session: SessionSummary): boolean {
  return (
    session.state === "waiting" ||
    !!session.permission?.questions?.length ||
    !!session.asyncQuestions?.length
  );
}

export function sessionGroup(
  session: SessionSummary,
): "waiting" | "running" | "recent" {
  if (sessionNeedsAttention(session)) return "waiting";
  return session.state === "running" ? "running" : "recent";
}

/**
 * What a list row says under a session's title: what it is doing, else its last words, as one line
 * of plain text. The host keeps the agent's Markdown and a client's prompt envelope, flattened onto
 * one line and cut at 160 characters; in a list both are noise, so they are taken back to their
 * words. Nothing at all is better than a placeholder that reads like a button.
 */
export function sessionPreview(session: Pick<SessionSummary, "preview" | "activity">): string {
  const activity = session.activity?.title?.trim();
  if (activity) return plainText(activity);
  return previewText(session.preview ?? "");
}

export function previewText(raw: string): string {
  let text = userMessageText([{ type: "text", text: raw }]);
  // A prompt sent with pictures: the list of files is plumbing, the request (if it survived the
  // cut) is what was asked.
  if (/^#\s*Files mentioned by the user:/i.test(text))
    text = /##\s*My request:\s*([\s\S]*)$/i.exec(text)?.[1] ?? "";
  return plainText(text);
}

function plainText(text: string): string {
  return text
    .replace(/```[\w+-]*/g, " ")
    // Images and links read as their words, also when the cut fell inside the address.
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)?/g, "$1")
    .replace(/!?\[([^\]]*)$/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/`([^`]*)`?/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\*\*|__|~~/g, "")
    // Headings lost their line breaks; their marks are left wherever a line began. A quote or a
    // bullet is only certain at the start (mid-line, " > ", " * " and " - " are as often comparisons,
    // arithmetic and dashes).
    .replace(/(^|\s)#{1,6}(?=\s)/g, "$1")
    .replace(/^\s*(?:>\s*)+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    // A table: its rule rows go, its cells become words.
    .replace(/\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?/g, " ")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
