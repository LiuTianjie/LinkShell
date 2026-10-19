import { describe, expect, it } from "vitest";
import {
  initialPortTabs,
  portTabsReducer,
  type PortTabsState,
} from "../src/live/port-tabs";

const open = (state: PortTabsState, port: number, multiple = true) =>
  portTabsReducer(state, { type: "open", port, multiple });

const close = (state: PortTabsState, port: number) =>
  portTabsReducer(state, { type: "close", port });

const select = (state: PortTabsState, port: number) =>
  portTabsReducer(state, { type: "select", port });

function tabs(...ports: number[]): PortTabsState {
  return ports.reduce((state, port) => open(state, port), initialPortTabs);
}

describe("desktop port preview tabs", () => {
  it("opens ports in order without replacing the existing preview identities", () => {
    const first = open(initialPortTabs, 3000);
    const second = open(first, 5173);

    expect(first).toEqual({
      tabs: [{ port: 3000, revision: 0 }], selected: 3000, focused: false,
    });
    expect(second.tabs).toEqual([
      { port: 3000, revision: 0 }, { port: 5173, revision: 0 },
    ]);
    expect(second.selected).toBe(5173);
    expect(second.tabs[0]).toBe(first.tabs[0]);
    expect(initialPortTabs).toEqual({ tabs: [], focused: false });
  });

  it("reopens an existing desktop port by selecting it without duplication or revision changes", () => {
    const state = tabs(3000, 5173);
    const refreshed = portTabsReducer(state, { type: "refresh", port: 3000 });
    const reopened = open(refreshed, 3000);

    expect(reopened.selected).toBe(3000);
    expect(reopened.tabs).toBe(refreshed.tabs);
    expect(reopened.tabs[0].revision).toBe(1);
    expect(reopened.tabs[1]).toBe(state.tabs[1]);
    expect(open(reopened, 3000)).toBe(reopened);
  });

  it("selects existing ports without touching preview state and ignores stale selections", () => {
    const state = tabs(3000, 5173);
    const selected = select(state, 3000);

    expect(selected.selected).toBe(3000);
    expect(selected.tabs).toBe(state.tabs);
    expect(select(selected, 3000)).toBe(selected);
    expect(select(selected, 9999)).toBe(selected);
    expect(select(initialPortTabs, 3000)).toBe(initialPortTabs);
  });

  it("refreshes only the requested preview and keeps the selected port and window mode", () => {
    const state = portTabsReducer(tabs(3000, 4000, 5173), {
      type: "focus", focused: true,
    });
    const refreshed = portTabsReducer(state, {
      type: "refresh", port: state.selected!,
    });

    expect(refreshed.tabs[0]).toBe(state.tabs[0]);
    expect(refreshed.tabs[1]).toBe(state.tabs[1]);
    expect(refreshed.tabs[2]).not.toBe(state.tabs[2]);
    expect(refreshed.tabs[2]).toEqual({ port: 5173, revision: 1 });
    expect(refreshed.selected).toBe(5173);
    expect(refreshed.focused).toBe(true);
    expect(state.tabs[2].revision).toBe(0);

    const repeated = portTabsReducer(refreshed, { type: "refresh", port: 5173 });
    expect(repeated.tabs[2].revision).toBe(2);
    expect(repeated.tabs[0]).toBe(state.tabs[0]);
    expect(portTabsReducer(repeated, { type: "refresh", port: 9999 })).toBe(repeated);
  });

  it("closes the active middle tab into its right neighbor before considering the left", () => {
    const state = select(tabs(3000, 4000, 5173), 4000);
    const closed = close(state, 4000);

    expect(closed.selected).toBe(5173);
    expect(closed.tabs.map((tab) => tab.port)).toEqual([3000, 5173]);
    expect(closed.tabs[0]).toBe(state.tabs[0]);
    expect(closed.tabs[1]).toBe(state.tabs[2]);

    const lastOnRight = close(closed, 5173);
    expect(lastOnRight.selected).toBe(3000);
    expect(lastOnRight.tabs[0]).toBe(state.tabs[0]);
  });

  it("closes the first active tab into its immediate right neighbor", () => {
    const state = select(tabs(3000, 4000, 5173), 3000);
    const closed = close(state, 3000);

    expect(closed.selected).toBe(4000);
    expect(closed.tabs).toEqual(state.tabs.slice(1));
    expect(closed.tabs[0]).toBe(state.tabs[1]);
    expect(closed.tabs[1]).toBe(state.tabs[2]);
  });

  it("closing an inactive or already-closed port does not steal the active preview", () => {
    const state = portTabsReducer(tabs(3000, 4000, 5173), {
      type: "focus", focused: true,
    });
    const closed = close(state, 3000);

    expect(closed.selected).toBe(5173);
    expect(closed.focused).toBe(true);
    expect(closed.tabs[0]).toBe(state.tabs[1]);
    expect(closed.tabs[1]).toBe(state.tabs[2]);
    expect(close(closed, 3000)).toBe(closed);
  });

  it("closing the last preview clears selection and exits the focused layout", () => {
    const state = portTabsReducer(tabs(3000), { type: "focus", focused: true });
    const closed = close(state, 3000);

    expect(closed.tabs).toEqual([]);
    expect(closed.selected).toBeUndefined();
    expect(closed.focused).toBe(false);
    expect(close(closed, 3000)).toBe(closed);
    expect(open(closed, 5173)).toEqual({
      tabs: [{ port: 5173, revision: 0 }], selected: 5173, focused: false,
    });
  });

  it("toggles focused layout without changing any preview identity and rejects an empty layout", () => {
    expect(portTabsReducer(initialPortTabs, { type: "focus", focused: true })).toBe(initialPortTabs);
    const state = tabs(3000, 5173);
    const focused = portTabsReducer(state, { type: "focus", focused: true });

    expect(focused.focused).toBe(true);
    expect(focused.tabs).toBe(state.tabs);
    expect(focused.selected).toBe(5173);
    expect(portTabsReducer(focused, { type: "focus", focused: true })).toBe(focused);
    const restored = portTabsReducer(focused, { type: "focus", focused: false });
    expect(restored).toEqual(state);
    expect(restored.tabs).toBe(state.tabs);
  });
});

describe("browser single-port compatibility", () => {
  it("reopening a browser port increments its revision instead of adding a second tab", () => {
    const first = open(initialPortTabs, 3000, false);
    const reopened = open(first, 3000, false);

    expect(reopened).toEqual({
      tabs: [{ port: 3000, revision: 1 }], selected: 3000, focused: false,
    });
    expect(first.tabs[0].revision).toBe(0);
    expect(reopened.tabs[0]).not.toBe(first.tabs[0]);
  });

  it("opening another browser port replaces the single preview with a fresh revision", () => {
    const state = open(initialPortTabs, 3000, false);
    const refreshed = portTabsReducer(state, { type: "refresh", port: 3000 });
    const replaced = open(refreshed, 5173, false);

    expect(replaced.tabs).toEqual([{ port: 5173, revision: 0 }]);
    expect(replaced.selected).toBe(5173);
    expect(refreshed.tabs).toEqual([{ port: 3000, revision: 1 }]);
  });
});
