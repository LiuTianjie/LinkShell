import type { SessionEvent, SessionUpdate } from "@linkshell/wire";

// A fork for agents that can't fork a session themselves: the new session
// shows the conversation so far (copied from our log) and the agent is told
// it, as text, ahead of the first message sent there.

/** What of a session's log is the conversation itself: what was said and done, not state that was true then. */
export function isConversation(update: SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case "ls_message":
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "ls_message_done":
    case "tool_call":
    case "tool_call_update":
    case "plan":
      return true;
    default:
      return false;
  }
}

/**
 * An event as the fork's log keeps it. Its ids are the original session's: an
 * agent that numbers its messages per session would give the fork's first reply
 * the id of the original's first, so copied ones are set apart. Nothing is left
 * open either — a call still running when the fork was made isn't running here.
 */
export function copied(update: SessionUpdate): SessionUpdate {
  const mark = (id: string) => `fork:${id}`;
  const next = { ...update } as SessionUpdate & { messageId?: string; toolCallId?: string; parentToolCallId?: string; status?: string };
  if (typeof next.messageId === "string" && next.messageId) next.messageId = mark(next.messageId);
  if (typeof next.toolCallId === "string") next.toolCallId = mark(next.toolCallId);
  if (typeof next.parentToolCallId === "string") next.parentToolCallId = mark(next.parentToolCallId);
  if ((next.sessionUpdate === "tool_call" || next.sessionUpdate === "tool_call_update") && (next.status === "pending" || next.status === "in_progress")) {
    next.status = "completed";
  }
  return next;
}

const MAX_MESSAGE = 6000;

function clip(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)} …[cut]` : text;
}

/**
 * The conversation as text for the agent: what the user and the agent said,
 * and one line per thing the agent did. The latest part, when it is too long.
 */
export function conversationDigest(events: SessionEvent[], maxBytes = 60_000): string {
  const entries: { key: string; label: string; text: string }[] = [];
  const last = () => entries[entries.length - 1];
  for (const { update } of events) {
    if ("parentToolCallId" in update && update.parentToolCallId) continue;
    if (update.sessionUpdate === "ls_message" && update.role !== "thought" && update.content) {
      const label = update.role === "user" ? "User" : "Assistant", key = `${label}:${update.messageId}`;
      const text = update.content.map((block) => block.type === "text" ? block.text : block.type === "resource" ? `${block.resource.uri}\n${block.resource.text ?? "[attachment]"}` : block.type === "resource_link" ? `[${block.name}]` : `[${block.type}]`).join("");
      const existing = entries.find((entry) => entry.key === key);
      if (existing) existing.text = (update.append ? existing.text : "") + text;
      else entries.push({ key, label, text });
    } else if (update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk") {
      const label = update.sessionUpdate === "user_message_chunk" ? "User" : "Assistant";
      const block = update.content;
      const text = block.type === "text" ? block.text : block.type === "resource" ? `${block.resource.uri}\n${block.resource.text ?? "[attachment]"}` : block.type === "resource_link" ? `[${block.name}]` : `[${block.type}]`;
      const key = `${label}:${update.messageId ?? ""}`;
      if (last()?.key === key) last()!.text += text;
      else entries.push({ key, label, text });
    } else if (update.sessionUpdate === "tool_call") {
      entries.push({ key: `tool:${update.toolCallId}`, label: "Tool", text: update.title });
    }
  }
  const lines = entries.map((entry) => (entry.label === "Tool" ? `[did: ${clip(entry.text).slice(0, 300)}]` : `${entry.label}: ${clip(entry.text.trim())}`)).filter((line) => !/^(User|Assistant): $/.test(line));
  let size = 0;
  let from = lines.length;
  while (from > 0 && size + Buffer.byteLength(lines[from - 1]!) + 2 <= maxBytes) {
    size += Buffer.byteLength(lines[from - 1]!) + 2;
    from -= 1;
  }
  const kept = lines.slice(from);
  if (kept.length === 0) return "";
  return [
    "This session continues an earlier conversation with the user, forked from another session. It is given here as a record of what was said and done; files may have changed since.",
    ...(from > 0 ? ["(The beginning of the conversation is left out.)"] : []),
    "",
    kept.join("\n\n"),
  ].join("\n");
}
