import { STORAGE_KEYS, readLocal, saveLocal } from "./storage";

export interface PortTab {
  port: number;
  revision: number;
}

export interface PortTabsState {
  tabs: PortTab[];
  selected?: number;
  focused: boolean;
}

export type PortTabsAction =
  | { type: "open"; port: number; multiple: boolean }
  | { type: "select"; port: number }
  | { type: "refresh"; port: number }
  | { type: "close"; port: number }
  | { type: "focus"; focused: boolean }
  | { type: "hydrate"; ports: number[]; selected?: number };

export const initialPortTabs: PortTabsState = { tabs: [], focused: false };

export function portTabsReducer(
  state: PortTabsState,
  action: PortTabsAction,
): PortTabsState {
  switch (action.type) {
    case "open": {
      const existing = state.tabs.find((tab) => tab.port === action.port);
      if (action.multiple && existing) {
        return state.selected === action.port
          ? state
          : { ...state, selected: action.port };
      }
      const tab: PortTab = {
        port: action.port,
        revision: existing ? existing.revision + 1 : 0,
      };
      return {
        ...state,
        tabs: action.multiple ? [...state.tabs, tab] : [tab],
        selected: action.port,
      };
    }
    case "select":
      return state.selected === action.port ||
        !state.tabs.some((tab) => tab.port === action.port)
        ? state
        : { ...state, selected: action.port };
    case "refresh": {
      if (!state.tabs.some((tab) => tab.port === action.port)) return state;
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.port === action.port
            ? { ...tab, revision: tab.revision + 1 }
            : tab,
        ),
      };
    }
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.port === action.port);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.port !== action.port);
      return {
        tabs,
        selected:
          state.selected === action.port
            ? (tabs[index] ?? tabs[index - 1])?.port
            : state.selected,
        focused: tabs.length > 0 && state.focused,
      };
    }
    case "focus":
      return state.focused === action.focused ||
        (action.focused && state.tabs.length === 0)
        ? state
        : { ...state, focused: action.focused };
    case "hydrate": {
      const unique = [...new Set(action.ports.filter((p) => Number.isInteger(p) && p > 0))];
      const tabs = unique.map((port) => ({ port, revision: 0 }));
      const selected =
        action.selected && unique.includes(action.selected)
          ? action.selected
          : tabs[0]?.port;
      return {
        tabs,
        selected,
        focused: false,
      };
    }
  }
}

export function readOpenPortTabs(computerKey: string): PortTabsState {
  const saved = readLocal<{ ports?: number[]; selected?: number } | null>(
    STORAGE_KEYS.openPortTabs(computerKey),
    null,
  );
  if (!saved || !Array.isArray(saved.ports) || saved.ports.length === 0) {
    return initialPortTabs;
  }
  return portTabsReducer(initialPortTabs, {
    type: "hydrate",
    ports: saved.ports,
    selected: saved.selected,
  });
}

export function saveOpenPortTabs(computerKey: string, state: PortTabsState): void {
  if (state.tabs.length === 0) {
    saveLocal(STORAGE_KEYS.openPortTabs(computerKey), undefined);
    return;
  }
  saveLocal(STORAGE_KEYS.openPortTabs(computerKey), {
    ports: state.tabs.map((tab) => tab.port),
    selected: state.selected,
  });
}

export interface PreviewRuntimeError {
  id: string;
  port: number;
  url?: string;
  source: "error" | "unhandledrejection" | "console";
  message: string;
  stack?: string;
  timestamp: number;
}

export const MAX_PREVIEW_ERRORS = 25;

export function appendPreviewError(
  existing: readonly PreviewRuntimeError[],
  incoming: Omit<PreviewRuntimeError, "id" | "timestamp"> & { timestamp?: number },
): PreviewRuntimeError[] {
  // The same error firing repeatedly (a render loop, HMR retries) is one problem, not 25.
  if (
    existing.some(
      (err) =>
        err.source === incoming.source &&
        err.message === incoming.message &&
        err.port === incoming.port,
    )
  ) {
    return existing as PreviewRuntimeError[];
  }
  const entry: PreviewRuntimeError = {
    ...incoming,
    id: crypto.randomUUID(),
    timestamp: incoming.timestamp ?? Date.now(),
  };
  const next = [...existing, entry];
  return next.length > MAX_PREVIEW_ERRORS
    ? next.slice(next.length - MAX_PREVIEW_ERRORS)
    : next;
}

/** Formats captured preview iframe runtime errors so the user can hand them to the Agent in one click. */
export function formatPreviewErrorForAgent(
  port: number,
  errors: readonly PreviewRuntimeError[],
): string {
  if (errors.length === 0) return "";
  const formatted = errors.map((err, index) => {
    const location = err.url ? ` (${err.url})` : "";
    const stack = err.stack ? `\n\`\`\`\n${err.stack.trim()}\n\`\`\`` : "";
    return `${index + 1}. [${err.source}]${location}: ${err.message}${stack}`;
  });
  return `The local preview running on port ${port} reported the following runtime error(s). Please investigate and fix:\n\n${formatted.join("\n\n")}`;
}
