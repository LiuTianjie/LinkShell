import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  appState: "active",
  onChange: undefined as undefined | ((state: string) => void),
  remove: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("expo-sqlite/kv-store", () => ({ default: { getItemSync: () => null } }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    get currentState() { return harness.appState; },
    addEventListener: (_name: string, callback: (state: string) => void) => {
      harness.onChange = callback;
      return { remove: harness.remove };
    },
  },
}));
vi.mock("../src/lib/client", () => ({ useConnection: vi.fn() }));
vi.mock("../modules/link-layout", () => ({ setNativeShortcutItems: vi.fn(), syncNativeLiveActivity: harness.sync }));
const { useIOSAttentionSync } = await import("../src/lib/session-attention");

describe("Live Activity foreground synchronization", () => {
  let cleanups: Array<() => void>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    harness.effects = [];
    harness.appState = "active";
    useIOSAttentionSync("Mac", [{
      id: "s1", nativeId: "n1", agent: "codex", cwd: "/test", state: "running",
      archived: false, createdAt: 1, updatedAt: 1, lastSeq: 1, pendingPermissions: 0,
    }], [], true);
    cleanups = harness.effects.map((effect) => effect()).filter((cleanup): cleanup is () => void => !!cleanup);
  });
  afterEach(() => {
    cleanups.forEach((cleanup) => cleanup());
    vi.useRealTimers();
  });

  it("reconciles unchanged foreground content periodically", () => {
    expect(harness.sync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(180_000);
    expect(harness.sync).toHaveBeenCalledTimes(4);
    expect(harness.sync).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, phase: "running" }));
  });

  it("continues syncing active sessions in the background while online, and refreshes on return", () => {
    harness.appState = "background";
    harness.onChange?.("background");
    const backgroundCalls = harness.sync.mock.calls.length;
    vi.advanceTimersByTime(300_000);
    expect(harness.sync).toHaveBeenCalledTimes(backgroundCalls + 5);
    harness.appState = "active";
    harness.onChange?.("active");
    expect(harness.sync).toHaveBeenCalledTimes(backgroundCalls + 6);
  });

  it("removes its timer and listener on unmount", () => {
    cleanups.forEach((cleanup) => cleanup());
    cleanups = [];
    vi.advanceTimersByTime(180_000);
    expect(harness.sync).toHaveBeenCalledTimes(1);
    expect(harness.remove).toHaveBeenCalledOnce();
  });
});
