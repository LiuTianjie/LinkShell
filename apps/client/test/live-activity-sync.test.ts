import type { SessionSummary } from "@linkshell/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptProgress, SessionView } from "@linkshell/client-core";

interface EffectSlot {
  deps?: readonly unknown[];
  cleanup?: () => void;
}

const harness = vi.hoisted(() => {
  const refs: Array<{ current: unknown }> = [];
  const effects: EffectSlot[] = [];
  let refCursor = 0;
  let effectCursor = 0;
  const pendingEffects: Array<() => void> = [];

  return {
    appState: "active",
    onChange: undefined as undefined | ((state: string) => void),
    addEventListenerCalls: 0,
    remove: vi.fn(),
    shortcuts: vi.fn(() => Promise.resolve()),
    sync: vi.fn<(payload: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
    beginRender() {
      refCursor = 0;
      effectCursor = 0;
      pendingEffects.length = 0;
    },
    useRef<T>(initial: T) {
      const idx = refCursor++;
      if (!refs[idx]) refs[idx] = { current: initial };
      return refs[idx] as { current: T };
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
      const idx = effectCursor++;
      const prev = effects[idx];
      const changed =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.length !== prev.deps.length ||
        deps.some((dep, i) => !Object.is(dep, prev.deps![i]));
      if (changed) {
        pendingEffects.push(() => {
          prev?.cleanup?.();
          const cleanup = effect();
          effects[idx] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
        });
      }
    },
    commitRender() {
      const queue = pendingEffects.splice(0, pendingEffects.length);
      for (const run of queue) run();
    },
    unmount() {
      for (const slot of effects) slot?.cleanup?.();
      refs.length = 0;
      effects.length = 0;
      pendingEffects.length = 0;
    },
  };
});

vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => harness.useEffect(effect, deps),
  useRef: <T>(initial: T) => harness.useRef(initial),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("expo-sqlite/kv-store", () => ({ default: { getItemSync: () => null } }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    get currentState() {
      return harness.appState;
    },
    addEventListener: (_name: string, callback: (state: string) => void) => {
      harness.addEventListenerCalls += 1;
      harness.onChange = callback;
      return { remove: harness.remove };
    },
  },
}));
vi.mock("../src/lib/client", () => ({ useConnection: vi.fn() }));
vi.mock("../modules/link-layout", () => ({
  setNativeShortcutItems: harness.shortcuts,
  syncNativeLiveActivity: harness.sync,
}));

const { useIOSAttentionSync } = await import("../src/lib/session-attention");

const baseSession: SessionSummary = {
  id: "s1",
  nativeId: "n1",
  agent: "codex",
  cwd: "/test",
  state: "running",
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  lastSeq: 1,
  pendingPermissions: 0,
};

function makeStreamingView(seq: number, text: string, turnActive = true, state: SessionView["state"] = "running"): SessionView {
  return {
    sessionId: "s1",
    lastSeq: seq,
    startSeq: 0,
    items: [{ kind: "agent", id: "a1", ts: 1000 + seq, text, streaming: turnActive }],
    index: { a1: 0 },
    permissions: [],
    config: [],
    commands: [],
    state,
    turnActive,
  };
}

function renderAttention(
  sessions: SessionSummary[] = [baseSession],
  views?: Record<string, SessionView>,
  progress?: Record<string, PromptProgress>,
  enabled = true,
) {
  harness.beginRender();
  useIOSAttentionSync("Mac", sessions, [], true, views, progress, "mac-1", enabled);
  harness.commitRender();
}

describe("Live Activity & Quick Actions bridge throttling and deduplication", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    harness.unmount();
    harness.appState = "active";
    harness.addEventListenerCalls = 0;
    harness.sync.mockResolvedValue(true);
  });

  afterEach(() => {
    harness.unmount();
    vi.useRealTimers();
  });

  it("deduplicates identical shortcut and Live Activity payloads across heartbeats, AppState, and re-renders", async () => {
    renderAttention();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.sync).toHaveBeenCalledTimes(1);
    expect(harness.shortcuts).toHaveBeenCalledTimes(1);
    expect(harness.sync).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, phase: "running" }));

    // Unchanged 60s heartbeats and foreground/background transitions do not cross the RN bridge again.
    await vi.advanceTimersByTimeAsync(180_000);
    harness.appState = "background";
    harness.onChange?.("background");
    await vi.advanceTimersByTimeAsync(300_000);
    harness.appState = "active";
    harness.onChange?.("active");
    renderAttention();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.sync).toHaveBeenCalledTimes(1);
    expect(harness.shortcuts).toHaveBeenCalledTimes(1);
  });

  it("retries Activity.request on foreground return when a background start returned false", async () => {
    renderAttention([{ ...baseSession, state: "idle" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sync).toHaveBeenCalledTimes(1);

    // Session transitions to running while backgrounded, and iOS denies starting a new activity in background.
    harness.appState = "background";
    harness.sync.mockResolvedValueOnce(false).mockResolvedValue(true);
    renderAttention([{ ...baseSession, state: "running", updatedAt: 2 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sync).toHaveBeenCalledTimes(2);

    // Returning to active retries the identical payload once so the banner starts in foreground.
    harness.appState = "active";
    harness.onChange?.("active");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sync).toHaveBeenCalledTimes(3);

    // Subsequent foreground ticks stay deduplicated once accepted.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sync).toHaveBeenCalledTimes(3);
  });

  it("throttles 60Hz streaming views and promptProgress updates to at most once per 600ms without listener churn", async () => {
    renderAttention([baseSession], { s1: makeStreamingView(1, "step 0") });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sync).toHaveBeenCalledTimes(1);
    expect(harness.shortcuts).toHaveBeenCalledTimes(1);
    expect(harness.addEventListenerCalls).toBe(1);

    // 60 streaming frames over 960ms (every 16ms) must coalesce into <= 2 bridge calls after initial send.
    for (let i = 1; i <= 60; i += 1) {
      await vi.advanceTimersByTimeAsync(16);
      renderAttention(
        [{ ...baseSession, lastSeq: i + 1, activity: { kind: "tool", title: `chunk ${i}` } }],
        { s1: makeStreamingView(i + 1, `streaming chunk ${i}`) },
        { s1: { clientMessageId: `m-${i}`, phase: "sending", afterSeq: i } },
      );
    }

    expect(harness.sync.mock.calls.length).toBeLessThanOrEqual(3);
    // Quick Actions depend only on session title/cwd/agent, so 60 streaming chunks send 0 extra shortcut calls.
    expect(harness.shortcuts).toHaveBeenCalledTimes(1);
    // AppState listener is mounted once and never re-subscribed on streaming renders.
    expect(harness.addEventListenerCalls).toBe(1);
    expect(harness.remove).not.toHaveBeenCalled();

    // Trailing throttled state flushes cleanly at the end of the 600ms window.
    await vi.advanceTimersByTimeAsync(600);
    expect(harness.sync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        active: true,
        subtitle: "chunk 60",
      }),
    );
  });

  it("flushes immediately on session state, pendingPermissions, and turn start/end transitions", async () => {
    renderAttention([baseSession], { s1: makeStreamingView(1, "working") });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sync).toHaveBeenCalledTimes(1);

    // Queue a throttled streaming chunk inside the 600ms window (not flushed yet at +100ms).
    await vi.advanceTimersByTimeAsync(100);
    renderAttention(
      [{ ...baseSession, activity: { kind: "tool", title: "running step" } }],
      { s1: makeStreamingView(2, "still working") },
      { s1: { clientMessageId: "m-2", phase: "starting", afterSeq: 1 } },
    );
    expect(harness.sync).toHaveBeenCalledTimes(1);

    // Permission arrival flushes immediately without waiting the remaining 500ms!
    const waitingPerm: SessionSummary = {
      ...baseSession,
      state: "waiting",
      pendingPermissions: 1,
      permission: { requestId: "p1", title: "允许执行测试？", options: [] },
    };
    renderAttention([waitingPerm], { s1: makeStreamingView(3, "need approval", true, "waiting") });
    expect(harness.sync).toHaveBeenCalledTimes(2);
    expect(harness.sync).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: true, phase: "waiting_for_approval" }),
    );

    // Turn ending / returning to idle also flushes immediately.
    renderAttention(
      [{ ...baseSession, state: "idle", pendingPermissions: 0 }],
      { s1: makeStreamingView(4, "done", false, "idle") },
    );
    expect(harness.sync).toHaveBeenCalledTimes(3);
    expect(harness.sync).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
  });

  it("removes its timer and listener on unmount", () => {
    renderAttention();
    const initialCalls = harness.sync.mock.calls.length;
    harness.unmount();
    vi.advanceTimersByTime(180_000);
    expect(harness.sync).toHaveBeenCalledTimes(initialCalls);
    expect(harness.remove).toHaveBeenCalledOnce();
  });
});
