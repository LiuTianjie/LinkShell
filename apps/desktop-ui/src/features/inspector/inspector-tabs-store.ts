import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { readOpenPortTabs, saveOpenPortTabs } from "../../core/port-tabs";
import { routerStore, type InspectorTab } from "../../core/router-store";
import { registerUnsavedWork } from "../../core/unsaved-work";

export type InspectorTabKind =
  | "new-tab"
  | "changes"
  | "terminal"
  | "files"
  | "file"
  | "ports"
  | "side"
  | "tasks"
  | "subagent"
  | "mcp";

export interface InspectorTabItem {
  id: string;
  kind: InspectorTabKind;
  title?: string;
  toolCallId?: string;
  appId?: string;
  port?: number;
  path?: string;
  lineSpec?: string;
  /** Bumped when an already open file is asked for again, so the viewer re-reads it. */
  reloadNonce?: number;
  /** Bumped with each explicit port request, so the preview applies `port`/`path` again. */
  portRequestNonce?: number;
}

export interface InspectorScopeTabs {
  tabs: InspectorTabItem[];
  activeId: string;
}

/** An unsaved edit; kept outside the panel so unmounting it (session switch) loses nothing. */
export interface InspectorFileDraft {
  text: string;
  baseText: string;
  baseModifiedAt?: number;
}

interface InspectorTabsState {
  byScope: Record<string, InspectorScopeTabs>;
  drafts: Record<string, InspectorFileDraft>;
}

const NEW_TAB_ITEM: InspectorTabItem = { id: "new-tab", kind: "new-tab" };

const DEFAULT_SCOPE_TABS: InspectorScopeTabs = {
  tabs: [NEW_TAB_ITEM],
  activeId: "new-tab",
};

export const INSPECTOR_OPEN_PORT_EVENT = "linkshell-inspector-open-port";
export const INSPECTOR_FOCUS_FILE_SEARCH_EVENT = "linkshell-inspector-focus-file-search";
/** A file was written from the viewer: lists showing its folder have a stale size and time. */
export const INSPECTOR_FILE_SAVED_EVENT = "linkshell-inspector-file-saved";

export function inspectorScopeKey(
  computerKey: string,
  sessionId?: string,
): string {
  return `${computerKey || "default"}::${sessionId ?? ""}`;
}

function draftKey(scopeKey: string, tabId: string): string {
  return `${scopeKey}|${tabId}`;
}

export function kindToRouterTab(kind: InspectorTabKind): InspectorTab | undefined {
  switch (kind) {
    case "new-tab":
    case "changes":
    case "files":
    case "ports":
    case "mcp":
    case "terminal":
    case "tasks":
    case "side":
      return kind;
    case "file":
      return "files";
    case "subagent":
      return undefined;
  }
}

export function routerTabToTabItem(tab: InspectorTab): InspectorTabItem {
  return { id: tab, kind: tab };
}

export const inspectorTabsStore = createStore<InspectorTabsState>(() => ({
  byScope: {},
  drafts: {},
}));

// One window-close guard for every draft, whether or not its panel is mounted.
let releaseUnsavedGuard: (() => void) | undefined;
inspectorTabsStore.subscribe((state) => {
  const dirty = Object.keys(state.drafts).length > 0;
  if (dirty && !releaseUnsavedGuard) {
    releaseUnsavedGuard = registerUnsavedWork("inspector-file");
  } else if (!dirty && releaseUnsavedGuard) {
    releaseUnsavedGuard();
    releaseUnsavedGuard = undefined;
  }
});

export function getInspectorScopeTabs(
  computerKey: string,
  sessionId?: string,
): InspectorScopeTabs {
  const key = inspectorScopeKey(computerKey, sessionId);
  return inspectorTabsStore.getState().byScope[key] ?? DEFAULT_SCOPE_TABS;
}

export function useInspectorTabs(
  computerKey: string,
  sessionId?: string,
): InspectorScopeTabs {
  const key = inspectorScopeKey(computerKey, sessionId);
  return useStore(
    inspectorTabsStore,
    (state) => state.byScope[key] ?? DEFAULT_SCOPE_TABS,
  );
}

export function getFileDraft(
  computerKey: string,
  sessionId: string | undefined,
  tabId: string,
): InspectorFileDraft | undefined {
  return inspectorTabsStore.getState().drafts[
    draftKey(inspectorScopeKey(computerKey, sessionId), tabId)
  ];
}

export function setFileDraft(
  computerKey: string,
  sessionId: string | undefined,
  tabId: string,
  draft: InspectorFileDraft | undefined,
): void {
  const key = draftKey(inspectorScopeKey(computerKey, sessionId), tabId);
  const current = inspectorTabsStore.getState().drafts;
  if (!draft || draft.text === draft.baseText) {
    if (!(key in current)) return;
    const next = { ...current };
    delete next[key];
    inspectorTabsStore.setState({ drafts: next });
    return;
  }
  const existing = current[key];
  if (
    existing &&
    existing.text === draft.text &&
    existing.baseText === draft.baseText &&
    existing.baseModifiedAt === draft.baseModifiedAt
  ) {
    return;
  }
  inspectorTabsStore.setState({ drafts: { ...current, [key]: draft } });
}

export function useIsTabDirty(
  computerKey: string,
  sessionId: string | undefined,
  tabId: string,
): boolean {
  const key = draftKey(inspectorScopeKey(computerKey, sessionId), tabId);
  return useStore(inspectorTabsStore, (state) => key in state.drafts);
}

function isTabDirty(scopeKey: string, tabId: string): boolean {
  return draftKey(scopeKey, tabId) in inspectorTabsStore.getState().drafts;
}

export type InspectorDiscardConfirm = (tab: InspectorTabItem) => Promise<boolean>;
let discardConfirm: InspectorDiscardConfirm | undefined;

/** The mounted workbench supplies its dialog, so closing from a menu or shortcut asks too. */
export function setInspectorDiscardConfirm(
  confirm: InspectorDiscardConfirm | undefined,
): () => void {
  discardConfirm = confirm;
  return () => {
    if (discardConfirm === confirm) discardConfirm = undefined;
  };
}

let activeScope: { computerKey: string; sessionId?: string } | undefined;

/** Which scope the visible workbench shows; the target of Cmd+W and Ctrl+Tab. */
export function setActiveInspectorScope(
  scope: { computerKey: string; sessionId?: string } | undefined,
): void {
  activeScope = scope;
}

export function openInspectorTab(
  computerKey: string,
  sessionId: string | undefined,
  item: InspectorTabItem,
  options?: { replaceTabId?: string; openPanel?: boolean },
): void {
  const key = inspectorScopeKey(computerKey, sessionId);
  inspectorTabsStore.setState((state) => {
    const current = state.byScope[key] ?? DEFAULT_SCOPE_TABS;
    const existingIdx = current.tabs.findIndex((t) => t.id === item.id);
    let nextTabs: InspectorTabItem[];
    if (existingIdx >= 0) {
      nextTabs = current.tabs.map((t, idx) =>
        idx === existingIdx ? { ...t, ...item } : t,
      );
    } else if (options?.replaceTabId) {
      const replaceIdx = current.tabs.findIndex(
        (t) => t.id === options.replaceTabId,
      );
      if (replaceIdx >= 0) {
        nextTabs = current.tabs.map((t, idx) =>
          idx === replaceIdx ? item : t,
        );
      } else {
        nextTabs = [...current.tabs, item];
      }
    } else if (
      item.kind !== "new-tab" &&
      current.tabs.length === 1 &&
      current.tabs[0]?.id === "new-tab"
    ) {
      nextTabs = [item];
    } else {
      nextTabs = [...current.tabs, item];
    }
    return {
      byScope: {
        ...state.byScope,
        [key]: {
          tabs: nextTabs,
          activeId: item.id,
        },
      },
    };
  });

  const routerTab = kindToRouterTab(item.kind);
  if (options?.openPanel !== false) {
    const router = routerStore.getState();
    if (!router.inspectorOpen || (routerTab && router.inspectorTab !== routerTab)) {
      routerStore.setState({
        inspectorOpen: true,
        ...(routerTab ? { inspectorTab: routerTab } : {}),
      });
    }
  } else if (routerTab && routerStore.getState().inspectorTab !== routerTab) {
    routerStore.setState({ inspectorTab: routerTab });
  }
}

export function activateInspectorTab(
  computerKey: string,
  sessionId: string | undefined,
  tabId: string,
): void {
  const key = inspectorScopeKey(computerKey, sessionId);
  const current = inspectorTabsStore.getState().byScope[key] ?? DEFAULT_SCOPE_TABS;
  const target = current.tabs.find((t) => t.id === tabId);
  if (!target) return;
  inspectorTabsStore.setState((state) => ({
    byScope: {
      ...state.byScope,
      [key]: {
        ...(state.byScope[key] ?? DEFAULT_SCOPE_TABS),
        activeId: tabId,
      },
    },
  }));
  const routerTab = kindToRouterTab(target.kind);
  if (routerTab && routerStore.getState().inspectorTab !== routerTab) {
    routerStore.setState({ inspectorTab: routerTab });
  }
}

/** Closes without asking; discards the tab's draft. Use `requestCloseInspectorTab` from UI. */
export function closeInspectorTab(
  computerKey: string,
  sessionId: string | undefined,
  tabId: string,
): void {
  const key = inspectorScopeKey(computerKey, sessionId);
  let nextActiveKind: InspectorTabKind = "new-tab";
  inspectorTabsStore.setState((state) => {
    const current = state.byScope[key] ?? DEFAULT_SCOPE_TABS;
    const closedIdx = current.tabs.findIndex((t) => t.id === tabId);
    if (closedIdx < 0) return state;
    const drafts = { ...state.drafts };
    delete drafts[draftKey(key, tabId)];
    const remaining = current.tabs.filter((t) => t.id !== tabId);
    if (remaining.length === 0) {
      nextActiveKind = "new-tab";
      return {
        drafts,
        byScope: {
          ...state.byScope,
          [key]: DEFAULT_SCOPE_TABS,
        },
      };
    }
    const nextActive =
      current.activeId === tabId
        ? (remaining[Math.min(closedIdx, remaining.length - 1)] ?? remaining[0]!)
        : (remaining.find((t) => t.id === current.activeId) ?? remaining[0]!);
    nextActiveKind = nextActive.kind;
    return {
      drafts,
      byScope: {
        ...state.byScope,
        [key]: {
          tabs: remaining,
          activeId: nextActive.id,
        },
      },
    };
  });
  const routerTab = kindToRouterTab(nextActiveKind);
  if (routerTab && routerStore.getState().inspectorTab !== routerTab) {
    routerStore.setState({ inspectorTab: routerTab });
  }
}

/** Closes a tab, first asking when it holds an unsaved edit. Resolves whether it closed. */
export async function requestCloseInspectorTab(
  computerKey: string,
  sessionId: string | undefined,
  tabId: string,
): Promise<boolean> {
  const key = inspectorScopeKey(computerKey, sessionId);
  const tab = (inspectorTabsStore.getState().byScope[key] ?? DEFAULT_SCOPE_TABS).tabs.find(
    (t) => t.id === tabId,
  );
  if (!tab) return false;
  if (isTabDirty(key, tabId)) {
    // Without a dialog to ask through, keeping the edit is the only safe answer.
    if (!discardConfirm) return false;
    activateInspectorTab(computerKey, sessionId, tabId);
    if (!(await discardConfirm(tab))) return false;
  }
  closeInspectorTab(computerKey, sessionId, tabId);
  return true;
}

/**
 * Cmd+W inside the inspector: closes the visible scope's active tab. False when there is
 * nothing of the inspector's to close, so the caller can fall back to its own behaviour.
 */
export function closeActiveInspectorTab(): boolean {
  if (!activeScope || !routerStore.getState().inspectorOpen) return false;
  const { computerKey, sessionId } = activeScope;
  const scope = getInspectorScopeTabs(computerKey, sessionId);
  if (scope.tabs.length === 1 && scope.tabs[0]?.id === "new-tab") return false;
  const target = scope.tabs.find((t) => t.id === scope.activeId) ?? scope.tabs[0];
  if (!target) return false;
  void requestCloseInspectorTab(computerKey, sessionId, target.id);
  return true;
}

/** Ctrl+Tab / Ctrl+Shift+Tab between the visible scope's tabs. */
export function cycleInspectorTab(direction: 1 | -1): boolean {
  if (!activeScope || !routerStore.getState().inspectorOpen) return false;
  const { computerKey, sessionId } = activeScope;
  const scope = getInspectorScopeTabs(computerKey, sessionId);
  if (scope.tabs.length < 2) return false;
  const idx = Math.max(0, scope.tabs.findIndex((t) => t.id === scope.activeId));
  const next = scope.tabs[(idx + direction + scope.tabs.length) % scope.tabs.length];
  if (!next) return false;
  activateInspectorTab(computerKey, sessionId, next.id);
  return true;
}

/** Mod+P: the Files tab with its search focused. */
export function openInspectorGoToFile(): boolean {
  if (!activeScope) return false;
  const { computerKey, sessionId } = activeScope;
  openInspectorTab(computerKey, sessionId, { id: "files", kind: "files" });
  if (typeof window !== "undefined") {
    // A panel that is already there answers the event; one that mounts for this request (the
    // inspector was closed, or showed another tab) takes the pending request when it appears.
    fileSearchFocusPending = true;
    window.dispatchEvent(new CustomEvent(INSPECTOR_FOCUS_FILE_SEARCH_EVENT));
  }
  return true;
}

let fileSearchFocusPending = false;

/** The Files panel calls this once its search field exists; true when ⌘P is waiting for it. */
export function takeFileSearchFocus(): boolean {
  const pending = fileSearchFocusPending;
  fileSearchFocusPending = false;
  return pending;
}

export function openSubagentInInspector(
  computerKey: string,
  sessionId: string | undefined,
  sub: { toolCallId: string; title?: string; agent?: string },
): void {
  openInspectorTab(
    computerKey,
    sessionId,
    {
      id: `subagent:${sub.toolCallId}`,
      kind: "subagent",
      toolCallId: sub.toolCallId,
      title: sub.title || sub.agent,
    },
    { openPanel: true },
  );
}

function splitFileSpecPath(specOrPath: string): { path: string } {
  const hashIdx = specOrPath.lastIndexOf("#L");
  if (hashIdx > 0) {
    const anchor = specOrPath.slice(hashIdx + 2);
    if (/^(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.test(anchor)) {
      return { path: specOrPath.slice(0, hashIdx) };
    }
  }
  const colonMatch = /^(.*?):(\d+)(?::\d+)?$/.exec(specOrPath);
  if (colonMatch && colonMatch[1] && !/^[A-Za-z]$/.test(colonMatch[1])) {
    return { path: colonMatch[1] };
  }
  return { path: specOrPath };
}

function basenameOfFile(filePath: string): string {
  const cleaned = filePath.replace(/[\\/]+$/, "");
  if (!cleaned) return filePath;
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

export function openFileTabInInspector(
  computerKey: string,
  sessionId: string | undefined,
  specOrPath: string,
  options?: { replaceTabId?: string; openPanel?: boolean },
): void {
  const trimmed = specOrPath.trim();
  if (!trimmed) return;
  const parsed = splitFileSpecPath(trimmed);
  if (!parsed.path) return;
  const id = `file:${parsed.path}`;
  const existing = getInspectorScopeTabs(computerKey, sessionId).tabs.find(
    (t) => t.id === id,
  );
  openInspectorTab(
    computerKey,
    sessionId,
    {
      id,
      kind: "file",
      path: parsed.path,
      lineSpec: trimmed,
      title: basenameOfFile(parsed.path),
      // Asking for an open file again means "show me what is on disk now".
      reloadNonce: existing ? (existing.reloadNonce ?? 0) + 1 : 0,
    },
    {
      replaceTabId: options?.replaceTabId,
      openPanel: options?.openPanel ?? true,
    },
  );
}

export function requestOpenPortInInspector(
  computerKey: string,
  sessionId: string | undefined,
  port: number,
  path?: string,
  replaceTabId?: string,
): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  const storageKey = computerKey || "default";
  const existing = readOpenPortTabs(storageKey);
  const nextTabs = existing.tabs.some((t) => t.port === port)
    ? existing.tabs
    : [...existing.tabs, { port, revision: 0 }];
  saveOpenPortTabs(storageKey, {
    tabs: nextTabs,
    selected: port,
    focused: true,
  });

  const current = getInspectorScopeTabs(computerKey, sessionId).tabs.find(
    (t) => t.id === "ports",
  );
  // The tab item carries the request, so a Ports panel that mounts after this still sees it.
  openInspectorTab(
    computerKey,
    sessionId,
    {
      id: "ports",
      kind: "ports",
      port,
      path,
      portRequestNonce: (current?.portRequestNonce ?? 0) + 1,
    },
    { replaceTabId, openPanel: true },
  );

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(INSPECTOR_OPEN_PORT_EVENT, {
        detail: { computerKey, port, path },
      }),
    );
  }
}

export function resetInspectorTabsForTests(): void {
  inspectorTabsStore.setState({ byScope: {}, drafts: {} });
  activeScope = undefined;
  discardConfirm = undefined;
}
