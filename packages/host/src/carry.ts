import type { SessionEvent, SessionUpdate } from "@linkshell/wire";

// A fork for agents that can't fork a session themselves: the new session
// shows the conversation so far (copied from our log) and the agent is told
// it, as text, ahead of the first message sent there.

/** What of a session's log is the conversation itself: what was said and done, not state that was true then. */
export function isConversation(update: SessionUpdate): boolean {
  switch (update.sessionUpdate) {
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

/** A copied event leaves nothing open: a call that was still running when the fork was made isn't running in the fork. */
export function settled(update: SessionUpdate): SessionUpdate {
  if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && (update.status === "pending" || update.status === "in_progress")) {
    return { ...update, status: "completed" };
  }
  return update;
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
    if (update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk") {
      const label = update.sessionUpdate === "user_message_chunk" ? "User" : "Assistant";
      const text = update.content.type === "text" ? update.content.text : update.content.type === "image" ? "[image]" : `[${update.content.name}]`;
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
