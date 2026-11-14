import { useCallback } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { AgentInfo } from "@linkshell/wire";
import { createTextDrafts } from "../../core/composer-draft";
import { STORAGE_KEYS, readLocal, saveLocal, subscribeStorageReady } from "../../core/storage";
import { inspectorScopeKey, openInspectorTab } from "./inspector-tabs-store";

/** Whether the session's agent has a side conversation of its own (`sessions.side`). */
export function agentHasSide(agents: readonly AgentInfo[] | undefined, agentId: string | undefined): boolean {
  if (!agentId) return false;
  return Boolean(agents?.find((agent) => agent.id === agentId)?.capabilities?.side);
}

/** What the agent calls its side conversation: Codex's `/side`, Claude's and Grok's `/btw`. */
export function sideCommandName(agentId: string | undefined): string {
  return agentId === "codex" ? "side" : "btw";
}

/** A selection quoted as Markdown, one `>` per line, so the agent reads it as cited text. */
export function quoteMarkdown(text: string): string {
  const body = text.replace(/\r\n?/g, "\n").trim();
  if (!body) return "";
  return body
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

// Per session, like the composer's draft: switching sessions or closing the tab keeps what was typed.
export const sideChatDrafts = createTextDrafts({
  read: (key) => {
    const text = readLocal<unknown>(key, "");
    return typeof text === "string" ? text : "";
  },
  write: (key, text) => saveLocal(key, text),
});

subscribeStorageReady(() => sideChatDrafts.getState().resetCache());

export function sideDraftKey(computerKey: string | undefined, sessionId: string | undefined): string {
  return STORAGE_KEYS.sideDraft(computerKey || "default", sessionId ?? "");
}

export function useSideChatDraft(computerKey: string | undefined, sessionId: string | undefined) {
  const key = sideDraftKey(computerKey, sessionId);
  const draft = useStore(sideChatDrafts, (state) => state.read(key));
  const setDraft = useCallback(
    (text: string) => sideChatDrafts.getState().update(key, text),
    [key],
  );
  // Only what was asked goes: words typed while the question was on its way stay.
  const clearSubmitted = useCallback(
    (submitted: string) => sideChatDrafts.getState().clearSubmitted(key, submitted),
    [key],
  );
  return { draft, setDraft, clearSubmitted };
}

/**
 * "Ask in side chat" from somewhere else (a selection in the timeline): the panel may not be
 * mounted yet, so the request waits here until the side tab for that scope picks it up.
 */
export const sideChatRequests = createStore<{ pending: Record<string, number> }>(() => ({
  pending: {},
}));

export function usePendingSideChatRequest(computerKey: string | undefined, sessionId: string | undefined): number | undefined {
  const scope = inspectorScopeKey(computerKey ?? "", sessionId);
  return useStore(sideChatRequests, (state) => state.pending[scope]);
}

export function consumeSideChatRequest(computerKey: string | undefined, sessionId: string | undefined): void {
  const scope = inspectorScopeKey(computerKey ?? "", sessionId);
  sideChatRequests.setState((state) => {
    if (!(scope in state.pending)) return state;
    const pending = { ...state.pending };
    delete pending[scope];
    return { pending };
  });
}

/** Opens a new side conversation with `quote` cited in its draft, ready for the question. */
export function askInSideChat(computerKey: string, sessionId: string, quote: string): void {
  const quoted = quoteMarkdown(quote);
  if (!quoted) return;
  const key = sideDraftKey(computerKey, sessionId);
  sideChatDrafts.getState().update(key, (current) => {
    // The new quote takes the place of an earlier one; whatever was typed stays below it.
    const kept = current.replace(/^(?:>.*(?:\n|$))+/, "").trim();
    return kept ? `${quoted}\n\n${kept}` : `${quoted}\n\n`;
  });
  const scope = inspectorScopeKey(computerKey, sessionId);
  sideChatRequests.setState((state) => ({ pending: { ...state.pending, [scope]: Date.now() } }));
  openInspectorTab(computerKey, sessionId, { id: "side", kind: "side" });
}
