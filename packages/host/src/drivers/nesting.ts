import type { SessionUpdate } from "@linkshell/wire";
import type { HistoryItem } from "./types.js";

// Sub-agents, for every driver: a sub-agent's own messages, tool calls and turn
// state are carried on the parent session, marked with the tool call that
// spawned it. Clients nest them under that call.

/** Marks a sub-agent's update as belonging to `parent`; drops what a sub-agent can't own (its prompt, usage, config…). */
export function nestUnder(update: SessionUpdate, parent: string): SessionUpdate | undefined {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
    case "ls_message_done":
    case "ls_turn":
      return { ...update, parentToolCallId: parent };
    default:
      return undefined;
  }
}

/** A sub-agent's history items, nested under `parent`, with ids that can't collide with the parent's. */
export function nestHistory(items: HistoryItem[], parent: string): HistoryItem[] {
  return items.flatMap((item) => {
    const updates = item.updates.flatMap((update) => nestUnder(update, parent) ?? []);
    return updates.length > 0 ? [{ ...item, itemId: `sub:${parent}:${item.itemId}`, updates }] : [];
  });
}
