export type PortTab = { port: number; revision: number };

export type PortTabsState = {
  tabs: PortTab[];
  selected?: number;
  focused: boolean;
};

export type PortTabsAction =
  | { type: "open"; port: number; multiple: boolean }
  | { type: "select"; port: number }
  | { type: "refresh"; port: number }
  | { type: "close"; port: number }
  | { type: "focus"; focused: boolean };

export const initialPortTabs: PortTabsState = { tabs: [], focused: false };

export function portTabsReducer(
  state: PortTabsState,
  action: PortTabsAction,
): PortTabsState {
  switch (action.type) {
    case "open": {
      const existing = state.tabs.find((tab) => tab.port === action.port);
      if (action.multiple && existing)
        return state.selected === action.port
          ? state
          : { ...state, selected: action.port };
      const tab = {
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
  }
}
