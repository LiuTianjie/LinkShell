// Pure timeline reduction logic, ported from the mobile useAgentWorkspace. No
// React, no storage — just (state, message) -> state. The web store and hooks
// build on top of this. Keeping it pure makes the streaming behavior testable.

import type {
  AgentTimelineItem,
  AgentConversation,
  AgentV2Event,
} from "./types";

export const MAX_TIMELINE_ITEMS = 200;

/** Merge incoming items into an existing per-conversation timeline.
 *  Keyed by item.id; incoming overwrites; sorted by createdAt; capped. */
export function mergeTimeline(
  existing: AgentTimelineItem[],
  incoming: AgentTimelineItem[],
): AgentTimelineItem[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<string, AgentTimelineItem>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of incoming) {
    const prev = byId.get(item.id);
    // A locally-discarded queued item must never be resurrected by a late echo.
    if (prev?.metadata?.queuedDiscarded === true && item.metadata?.queuedDiscarded !== true) {
      continue;
    }
    // Preserve client-only queue flags when the host echo lacks them, so a
    // late echo can't clear queuedSent/discarded and cause a double-send.
    if (prev?.metadata && (prev.metadata.queuedSent || prev.metadata.queuedDiscarded || prev.metadata.delivery)) {
      const inMeta = item.metadata ?? {};
      byId.set(item.id, {
        ...item,
        metadata: {
          ...inMeta,
          queuedSent: inMeta.queuedSent ?? prev.metadata.queuedSent,
          queuedDiscarded: inMeta.queuedDiscarded ?? prev.metadata.queuedDiscarded,
          delivery: inMeta.delivery ?? prev.metadata.delivery,
        },
      });
      continue;
    }
    byId.set(item.id, item);
  }
  const merged = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  return merged.length > MAX_TIMELINE_ITEMS
    ? merged.slice(merged.length - MAX_TIMELINE_ITEMS)
    : merged;
}

/** Apply an agent.v2.event (item upsert OR incremental patch) to a timeline.
 *  `onUnmatchedPatch` fires when a patch targets an item we've never seen —
 *  the caller can use it to request a snapshot and recover the missing item. */
export function applyEvent(
  existing: AgentTimelineItem[],
  event: AgentV2Event,
  onUnmatchedPatch?: (itemId: string) => void,
): AgentTimelineItem[] {
  // Full-item upsert.
  if (event.item) {
    const item: AgentTimelineItem = {
      ...event.item,
      metadata: {
        ...(event.item.metadata ?? {}),
      },
    };
    return mergeTimeline(existing, [item]);
  }

  // Incremental patch, matched by id OR itemId.
  if (event.patch) {
    const patch = event.patch;
    let matched = false;
    const next = existing.map((item) => {
      if (item.id !== patch.itemId && item.itemId !== patch.itemId) return item;
      matched = true;
      return {
        ...item,
        kind: patch.kind ?? item.kind,
        role: patch.role ?? item.role,
        content: patch.content ?? item.content,
        // textDelta accumulates; an absolute text replaces.
        text: patch.textDelta
          ? `${patch.text ?? item.text ?? ""}${patch.textDelta}`
          : patch.text ?? item.text,
        status: patch.status ?? item.status,
        toolCall: patch.toolCall
          ? { ...(item.toolCall ?? {}), ...patch.toolCall }
          : item.toolCall,
        commandExecution: patch.commandExecution
          ? { ...(item.commandExecution ?? {}), ...patch.commandExecution }
          : item.commandExecution,
        fileChange: patch.fileChange
          ? { ...(item.fileChange ?? {}), ...patch.fileChange }
          : item.fileChange,
        subagent: patch.subagent
          ? { ...(item.subagent ?? {}), ...patch.subagent }
          : item.subagent,
        structuredInput: patch.structuredInput ?? item.structuredInput,
        plan: patch.plan ?? item.plan,
        permission: patch.permission
          ? { ...(item.permission ?? {}), ...patch.permission }
          : item.permission,
        error: patch.error ?? item.error,
        metadata: patch.metadata
          ? { ...(item.metadata ?? {}), ...patch.metadata }
          : item.metadata,
        updatedAt: patch.updatedAt ?? Date.now(),
        isStreaming: patch.isStreaming ?? item.isStreaming,
      } as AgentTimelineItem;
    });
    // A patch for an item we haven't seen yet is dropped (host will resend via
    // snapshot); this mirrors the mobile behavior of not synthesizing items.
    // Notify the caller so it can request that snapshot instead of losing data.
    if (!matched) {
      onUnmatchedPatch?.(patch.itemId);
      return existing;
    }
    return next;
  }

  return existing;
}

/** Normalize snapshot items, ensuring metadata exists. */
export function normalizeItems(items: AgentTimelineItem[]): AgentTimelineItem[] {
  return items.map((item) => ({ ...item, metadata: { ...(item.metadata ?? {}) } }));
}

/** Group a flat snapshot item list by conversationId. */
export function groupByConversation(
  items: AgentTimelineItem[],
): Map<string, AgentTimelineItem[]> {
  const grouped = new Map<string, AgentTimelineItem[]>();
  for (const item of normalizeItems(items)) {
    const arr = grouped.get(item.conversationId) ?? [];
    arr.push(item);
    grouped.set(item.conversationId, arr);
  }
  return grouped;
}

/** Merge conversation records by id. Host status always wins — a client
 *  optimistic lastActivityAt must not hide idle/error from the host. */
export function mergeConversations(
  existing: AgentConversation[],
  incoming: AgentConversation[],
): AgentConversation[] {
  const byId = new Map<string, AgentConversation>();
  for (const c of existing) byId.set(c.id, c);
  for (const c of incoming) {
    const prev = byId.get(c.id);
    if (!prev) {
      byId.set(c.id, c);
      continue;
    }
    byId.set(c.id, {
      ...prev,
      ...c,
      status: c.status,
      lastActivityAt: Math.max(prev.lastActivityAt ?? 0, c.lastActivityAt ?? 0),
    });
  }
  return [...byId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/** Host catalog is the source of truth for the tree. Cached rows not in the
 *  incoming window are dropped so a 200-session disk store cannot accumulate
 *  in the web client across reconnects. Active/keep ids survive a partial push. */
export function adoptHostCatalog(
  existing: AgentConversation[],
  incoming: AgentConversation[],
  keepIds: Iterable<string> = [],
): AgentConversation[] {
  const keep = new Set(keepIds);
  for (const conversation of incoming) keep.add(conversation.id);
  return mergeConversations(
    existing.filter((conversation) => keep.has(conversation.id)),
    incoming,
  );
}

/** A short preview string for a conversation row, derived from an item. */
export function previewFromItem(item: AgentTimelineItem): string | undefined {
  if (item.text) return item.text.slice(0, 120).replace(/\s+/g, " ").trim();
  if (item.toolCall?.name) return `🔧 ${item.toolCall.name}`;
  if (item.commandExecution?.command) return `$ ${item.commandExecution.command}`;
  if (item.fileChange?.summary) return item.fileChange.summary;
  if (item.error) return `⚠ ${item.error}`;
  return undefined;
}
