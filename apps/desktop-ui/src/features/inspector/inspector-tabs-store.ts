import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { readOpenPortTabs, saveOpenPortTabs } from "../../core/port-tabs";
import { routerStore, type InspectorTab } from "../../core/router-store";

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
}

export interface InspectorScopeTabs {
  tabs: InspectorTabItem[];
  activeId: string;
}

interface InspectorTabsState {
  byScope: Record<string, InspectorScopeTabs>;
}

const NEW_TAB_ITEM: InspectorTabItem = { id: "new-tab", kind: "new-tab" };

const DEFAULT_SCOPE_TABS: InspectorScopeTabs = {
  tabs: [NEW_TAB_ITEM],
  activeId: "new-tab",
};

export const INSPECTOR_OPEN_PORT_EVENT = "linkshell-inspector-open-port";

export function inspectorScopeKey(
  computerKey: string,
  sessionId?: string,
): string {
  return `${computerKey || "default"}::${sessionId ?? ""}`;
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
}));

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
    const remaining = current.tabs.filter((t) => t.id !== tabId);
    if (remaining.length === 0) {
      nextActiveKind = "new-tab";
      return {
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
  openInspectorTab(
    computerKey,
    sessionId,
    {
      id: `file:${parsed.path}`,
      kind: "file",
      path: parsed.path,
      lineSpec: trimmed,
      title: basenameOfFile(parsed.path),
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

  openInspectorTab(
    computerKey,
    sessionId,
    { id: "ports", kind: "ports", port, path },
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
  inspectorTabsStore.setState({ byScope: {} });
}
