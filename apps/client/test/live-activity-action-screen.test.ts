import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveActivityAction, SessionSummary } from "@linkshell/wire";

interface EffectSlot {
  deps?: readonly unknown[];
  cleanup?: () => void;
}

const harness = vi.hoisted(() => {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const effects: EffectSlot[] = [];
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;
  const pendingEffects: Array<() => void> = [];

  return {
    params: {} as Record<string, string | undefined>,
    focused: true,
    routes: [{ name: "(tabs)" }, { name: "activity", params: { action: "act-a" } }] as Array<{
      name: string;
      key?: string;
      params?: Record<string, unknown>;
    }>,
    computerKey: "computer-1",
    saved: { relay: [], direct: [] as Array<{ url: string; name: string }> },
    live: {} as Record<string, unknown[]>,
    lanHosts: [] as Array<{ name: string; host: string; port: number; machineId?: string; displayName?: string }>,
    status: "online",
    sessionsLoaded: false,
    sessions: {} as Record<string, SessionSummary>,
    ready: {} as Record<string, true>,
    views: {} as Record<string, { permissions?: SessionSummary["permission"][] }>,
    dispatch: vi.fn(),
    routerReplace: vi.fn(),
    selectComputer: vi.fn(),
    discoverLanHost: vi.fn((host: { url: string }) => `direct:${host.url}`),
    consumeAction: vi.fn<(id: string) => Promise<LiveActivityAction | null>>(),
    pendingActionId: vi.fn<() => Promise<string | null>>(),
    respond: vi.fn(),
    answer: vi.fn(),
    answerAsync: vi.fn(),
    reconnectNow: vi.fn(),
    lastEmptyMessage: "" as string,
    lastLoadingLabel: "" as string,
    beginRender() {
      stateCursor = 0;
      refCursor = 0;
      effectCursor = 0;
      pendingEffects.length = 0;
      this.lastEmptyMessage = "";
      this.lastLoadingLabel = "";
    },
    useState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void] {
      const idx = stateCursor++;
      if (!(idx in states)) states[idx] = initial;
      const setState = (next: T | ((prev: T) => T)) => {
        states[idx] = typeof next === "function" ? (next as (prev: T) => T)(states[idx] as T) : next;
      };
      return [states[idx] as T, setState];
    },
    useRef<T>(initial: T) {
      const idx = refCursor++;
      if (!refs[idx]) refs[idx] = { current: initial };
      return refs[idx] as { current: T };
    },
    useCallback<T extends Function>(fn: T): T {
      return fn;
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
    resetHooks() {
      for (const slot of effects) slot?.cleanup?.();
      states.length = 0;
      refs.length = 0;
      effects.length = 0;
      pendingEffects.length = 0;
    },
  };
});

vi.mock("react", () => ({
  useState: <T>(initial: T) => harness.useState(initial),
  useRef: <T>(initial: T) => harness.useRef(initial),
  useCallback: <T extends Function>(fn: T) => harness.useCallback(fn),
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => harness.useEffect(effect, deps),
}));
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("expo-router", () => ({
  router: { replace: harness.routerReplace },
  useIsFocused: () => harness.focused,
  useLocalSearchParams: () => harness.params,
  useNavigation: () => ({
    dispatch: harness.dispatch,
    getState: () => ({ routes: harness.routes }),
  }),
}));
vi.mock("expo-router/react-navigation", () => ({
  CommonActions: { reset: (state: unknown) => ({ type: "RESET", payload: state }) },
}));
vi.mock("../modules/link-layout", () => ({
  consumeNativeLiveActivityAction: harness.consumeAction,
  pendingNativeLiveActivityActionId: harness.pendingActionId,
}));
vi.mock("@/components/state-views", () => ({
  EmptyState: (props: { message: string }) => {
    harness.lastEmptyMessage = props.message;
    return props;
  },
  LoadingState: (props: { label: string }) => {
    harness.lastLoadingLabel = props.label;
    return props;
  },
}));
vi.mock("@/components/fixed-text", () => ({ Text: "Text" }));
vi.mock("@/components/session-row", () => ({ SessionRow: "SessionRow", positionOf: () => "only" }));
vi.mock("@/components/terminal-row", () => ({ TerminalRow: "TerminalRow" }));
vi.mock("@/theme/colors", () => ({ colors: { background: "#000", accentSoft: "#111", card: "#222", accent: "#5263e8", secondaryLabel: "#999" } }));
vi.mock("@/lib/terminals", () => ({ useTerminals: () => ({ terminals: [], loaded: true, retry: vi.fn() }) }));
vi.mock("@/lib/use-now", () => ({ useNow: () => Date.now() }));
vi.mock("@/lib/computers", async () => {
  const lan = await import("../src/lib/lan-discovery");
  const state = () => ({
    saved: harness.saved,
    live: harness.live,
    lanHosts: harness.lanHosts,
    select: harness.selectComputer,
    discoverLanHost: harness.discoverLanHost,
  });
  return {
    lanHostUrl: lan.lanHostUrl,
    lanHostDisplayName: lan.lanHostDisplayName,
    listComputers: (input: { saved: typeof harness.saved; live: typeof harness.live; lanHosts?: typeof harness.lanHosts }) => {
      const out = input.saved.direct.map((entry) => ({
        key: `direct:${entry.url}`,
        kind: "direct" as const,
        url: entry.url,
        name: entry.name,
      }));
      return input.lanHosts?.length ? lan.annotateComputersWithLan(out, input.lanHosts) : out;
    },
    useComputers: Object.assign((select: (s: ReturnType<typeof state>) => unknown) => select(state()), { getState: state }),
  };
});
vi.mock("@/lib/client", () => ({
  useConnection: () => ({
    computer: { key: harness.computerKey },
    link: { reconnectNow: harness.reconnectNow },
  }),
  useClient: (select: (state: {
    status: string;
    sessionsLoaded: boolean;
    ready: Record<string, true>;
    sessions: Record<string, SessionSummary>;
    views: Record<string, { permissions?: SessionSummary["permission"][] }>;
  }) => unknown) => select({
    status: harness.status,
    sessionsLoaded: harness.sessionsLoaded,
    ready: harness.ready,
    sessions: harness.sessions,
    views: harness.views,
  }),
  useActions: () => ({
    respond: harness.respond,
    answer: harness.answer,
    answerAsync: harness.answerAsync,
    refresh: vi.fn(),
  }),
  useSessionSubscription: vi.fn(),
}));

const {
  ActivityActionScreen,
  findNewerQueuedActivityAction,
  shouldDeferActionCompletionReset,
} = await import("../src/screens/activity-action-screen");

function renderScreen() {
  harness.beginRender();
  const root = ActivityActionScreen();
  const Selection = root.type as (props: Record<string, unknown>) => { props: { children: { type: (p: unknown) => unknown; props: unknown } } };
  const tree = Selection(root.props);
  const child = tree.props.children;
  if (typeof child?.type === "function") child.type(child.props);
  harness.commitRender();
}

const sampleAction: LiveActivityAction = {
  id: "perm-1:accept",
  label: "允许",
  role: "allow",
  kind: "permission",
  computerKey: "computer-1",
  sessionId: "sess-1",
  requestId: "perm-1",
  optionId: "accept",
};

const sampleSession: SessionSummary = {
  id: "sess-1",
  nativeId: "native-1",
  agent: "codex",
  cwd: "/repo",
  state: "waiting",
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  lastSeq: 1,
  pendingPermissions: 1,
  permission: {
    requestId: "perm-1",
    title: "Run tests?",
    options: [{ optionId: "accept", name: "Allow", kind: "allow_once" }],
  },
};

describe("ActivityActionScreen fixes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    harness.resetHooks();
    harness.params = { action: "act-a" };
    harness.focused = true;
    harness.routes = [{ name: "(tabs)" }, { name: "activity", params: { action: "act-a" } }];
    harness.computerKey = "computer-1";
    harness.saved = { relay: [], direct: [] };
    harness.live = {};
    harness.lanHosts = [];
    harness.status = "online";
    harness.sessionsLoaded = false;
    harness.sessions = {};
    harness.ready = {};
    harness.views = {};
    harness.consumeAction.mockResolvedValue(sampleAction);
    harness.pendingActionId.mockResolvedValue(null);
    harness.respond.mockResolvedValue(undefined);
  });

  afterEach(() => {
    harness.resetHooks();
    vi.useRealTimers();
  });

  it("defers stack reset when a newer Lock Screen action is stacked above or the route was replaced", () => {
    const stacked = [
      { name: "(tabs)" },
      { name: "activity", params: { action: "act-a" } },
      { name: "activity", params: { action: "act-b" } },
    ];
    expect(findNewerQueuedActivityAction(stacked, "act-a")).toBe("act-b");
    expect(shouldDeferActionCompletionReset(stacked, "act-a")).toBe(true);
    // Once act-b at the top finishes, act-a underneath does NOT block resetting to detail.
    expect(findNewerQueuedActivityAction(stacked, "act-b")).toBeUndefined();
    expect(shouldDeferActionCompletionReset(stacked, "act-b")).toBe(false);
    // If act-a is no longer on the stack at all, defer reset.
    expect(shouldDeferActionCompletionReset([{ name: "(tabs)" }], "act-a")).toBe(true);
  });

  it("selects LAN-only computers discovered via lanHosts for Lock Screen actions", async () => {
    harness.computerKey = "other-computer";
    harness.lanHosts = [{ name: "StudioMac", host: "192.168.1.42", port: 7878, displayName: "Studio Mac" }];
    harness.consumeAction.mockResolvedValue({
      ...sampleAction,
      computerKey: "direct:ws://192.168.1.42:7878",
    });

    renderScreen();
    await vi.advanceTimersByTimeAsync(0);
    renderScreen();

    expect(harness.discoverLanHost).toHaveBeenCalledWith(expect.objectContaining({
      url: "ws://192.168.1.42:7878",
      name: "Studio Mac",
    }));
    expect(harness.selectComputer).toHaveBeenCalledWith("direct:ws://192.168.1.42:7878");
  });

  it("fails fast with Chinese error when sessionsLoaded is true and the session no longer exists", async () => {
    harness.sessionsLoaded = true;
    harness.sessions = {};
    harness.ready = {};

    renderScreen();
    await vi.advanceTimersByTimeAsync(0);
    // Second render applies setSelection(sampleAction) and evaluates missing session immediately.
    renderScreen();
    renderScreen();

    expect(harness.lastEmptyMessage).toBe("该会话已不存在，无法提交操作。");
    expect(harness.respond).not.toHaveBeenCalled();
  });

  it("preserves a queued Lock Screen action B in the native queue instead of wiping it with CommonActions.reset", async () => {
    harness.sessionsLoaded = true;
    harness.sessions = { "sess-1": sampleSession };
    harness.ready = { "sess-1": true };
    harness.pendingActionId.mockResolvedValue("act-b");

    renderScreen();
    await vi.advanceTimersByTimeAsync(0);
    renderScreen();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.respond).toHaveBeenCalledWith("sess-1", "perm-1", "accept");
    expect(harness.routerReplace).toHaveBeenCalledWith({ pathname: "/activity", params: { action: "act-b" } });
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("does not wipe a stacked action B via CommonActions.reset when action A completes in the background", async () => {
    harness.sessionsLoaded = true;
    harness.sessions = { "sess-1": sampleSession };
    harness.ready = { "sess-1": true };
    let finishRespond!: () => void;
    harness.respond.mockReturnValueOnce(new Promise<void>((resolve) => { finishRespond = resolve; }));

    renderScreen();
    await vi.advanceTimersByTimeAsync(0);
    renderScreen();

    // While action A is awaiting respond(), user taps action B which pushes onto the stack.
    harness.routes = [
      { name: "(tabs)" },
      { name: "activity", params: { action: "act-a" } },
      { name: "activity", params: { action: "act-b" } },
    ];
    finishRespond();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.routerReplace).not.toHaveBeenCalled();
  });
});
