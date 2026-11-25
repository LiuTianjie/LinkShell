import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const effects: Array<() => void | (() => void)> = [];
  let appStateListener: ((state: string) => void) | undefined;
  let networkPathListener: ((event: { status: string; interface: string; isExpensive: boolean; isConstrained: boolean }) => void) | undefined;
  let linkStatus = "online";
  let selectedComputerValue: Record<string, unknown> | undefined = {
    key: "direct:ws://192.168.1.10:7878",
    kind: "direct",
    url: "ws://192.168.1.10:7878",
    name: "Studio Mac",
  };
  let recoveringHistory: boolean[] = [];
  let initialRecoveryRef = { current: true };
  const linkProbe = vi.fn<(ms?: number) => Promise<boolean>>(() => Promise.resolve(true));
  const linkReconnectNow = vi.fn<(force?: boolean) => void>();
  const linkResumeLatest = vi.fn();
  const reconnectRelays = vi.fn();
  const probeRelays = vi.fn();
  const startRelays = vi.fn();
  const restartLanDiscovery = vi.fn();
  const storeConnect = vi.fn();
  const storeDisconnect = vi.fn();
  const streamsStart = vi.fn();
  const streamsStop = vi.fn();
  const streamsConnect = vi.fn();
  let capturedStoreOptions: Record<string, unknown> | undefined;

  return {
    effects,
    get appStateListener() {
      return appStateListener;
    },
    set appStateListener(cb: ((state: string) => void) | undefined) {
      appStateListener = cb;
    },
    get networkPathListener() {
      return networkPathListener;
    },
    set networkPathListener(cb: ((event: { status: string; interface: string; isExpensive: boolean; isConstrained: boolean }) => void) | undefined) {
      networkPathListener = cb;
    },
    get linkStatus() {
      return linkStatus;
    },
    set linkStatus(value: string) {
      linkStatus = value;
    },
    get selectedComputerValue() {
      return selectedComputerValue;
    },
    set selectedComputerValue(value: Record<string, unknown> | undefined) {
      selectedComputerValue = value;
    },
    get recoveringHistory() {
      return recoveringHistory;
    },
    resetRecovering() {
      recoveringHistory = [];
      initialRecoveryRef = { current: true };
    },
    get initialRecoveryRef() {
      return initialRecoveryRef;
    },
    linkProbe,
    linkReconnectNow,
    linkResumeLatest,
    reconnectRelays,
    probeRelays,
    startRelays,
    restartLanDiscovery,
    storeConnect,
    storeDisconnect,
    streamsStart,
    streamsStop,
    streamsConnect,
    get capturedStoreOptions() {
      return capturedStoreOptions;
    },
    set capturedStoreOptions(opts: Record<string, unknown> | undefined) {
      capturedStoreOptions = opts;
    },
  };
});

vi.mock("react", () => ({
  createContext: () => ({}),
  use: () => null,
  useEffect: (fn: () => void | (() => void)) => harness.effects.push(fn),
  useLayoutEffect: (fn: () => void | (() => void)) => harness.effects.push(fn),
  useMemo: <T>(fn: () => T) => fn(),
  useRef: <T>(initial: T) => (typeof initial === "boolean" ? (harness.initialRecoveryRef as { current: T }) : { current: initial }),
  useState: <T>(initial: T | (() => T)) => {
    const val = typeof initial === "function" ? (initial as () => T)() : initial;
    const setter = vi.fn((next: unknown) => {
      if (typeof next === "boolean") harness.recoveringHistory.push(next);
    });
    return [val, setter];
  },
  useSyncExternalStore: (_sub: unknown, snap: () => unknown) => snap(),
}));
vi.mock("react/jsx-runtime", () => ({
  jsx: (_type: unknown, props: unknown) => props,
  jsxs: (_type: unknown, props: unknown) => props,
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      harness.appStateListener = listener;
      return { remove: vi.fn() };
    },
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "uuid-1" }));
vi.mock("zustand", () => ({ useStore: vi.fn() }));
vi.mock("zustand/react/shallow", () => ({ useShallow: <T>(fn: T) => fn }));
vi.mock("@/lib/format", () => ({ setHostHome: vi.fn() }));
vi.mock("../src/lib/session-preferences", () => ({ sessionPreferences: {} }));
vi.mock("../src/lib/secure", () => ({
  readSecret: () => undefined,
  writeSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));
vi.mock("../src/lib/identity", () => ({ deviceIdentity: () => ({ id: "dev-1", signKey: "s", boxKey: "b" }) }));
vi.mock("../src/lib/lan-socket", () => ({ HybridLanGatewaySocket: class {}, LanE2eeSocket: class {} }));
vi.mock("../src/lib/settings", () => ({ DEFAULT_HOST_URL: "ws://127.0.0.1:7878" }));
vi.mock("../src/lib/socket", () => ({
  createSocket: vi.fn(),
  restartLanDiscovery: harness.restartLanDiscovery,
  subscribeNetworkPathChange: (listener: (event: { status: string; interface: string; isExpensive: boolean; isConstrained: boolean }) => void) => {
    harness.networkPathListener = listener;
    return () => {
      if (harness.networkPathListener === listener) harness.networkPathListener = undefined;
    };
  },
}));
vi.mock("../src/lib/direct", () => ({ directConnector: {} }));
vi.mock("../src/lib/session-subscriptions", () => ({ createSessionSubscriptions: () => () => () => {} }));
vi.mock("../src/lib/computer-names", () => ({ syncComputerName: vi.fn() }));
vi.mock("../src/lib/account", () => ({
  setAppBackgrounded: vi.fn(),
  useAccount: { subscribe: () => () => {}, getState: () => ({ session: undefined }) },
}));
vi.mock("../src/lib/computers", () => ({
  startRelays: harness.startRelays,
  reconnectRelays: harness.reconnectRelays,
  probeRelays: harness.probeRelays,
  relayFor: vi.fn(),
  selectedComputer: () => harness.selectedComputerValue,
  useComputers: Object.assign(
    (selector: (state: { saved: unknown; live: unknown; lanHosts: unknown[]; discovery: Record<string, string> }) => unknown) =>
      selector({ saved: {}, live: {}, lanHosts: [], discovery: {} }),
    { getState: () => ({ addDirect: vi.fn(), select: vi.fn(), saved: { lanUrls: {} } }) },
  ),
}));
vi.mock("@linkshell/client-core", () => ({
  HostLink: class {
    get status() {
      return harness.linkStatus;
    }
    probe = harness.linkProbe;
    reconnectNow = harness.linkReconnectNow;
    resumeLatest = harness.linkResumeLatest;
    onStatus = () => () => {};
  },
  HostStreams: class {
    start = harness.streamsStart;
    stop = harness.streamsStop;
    connect = harness.streamsConnect;
    onPath = () => () => {};
    path = "relay";
  },
  TunnelSocket: class {},
  createClientStore: (_link: unknown, options: Record<string, unknown>) => {
    harness.capturedStoreOptions = options;
    return {
      getState: () => ({
        status: harness.linkStatus,
        sessions: {},
        machine: undefined,
        connect: harness.storeConnect,
        disconnect: harness.storeDisconnect,
        openSession: vi.fn(),
        closeSession: vi.fn(),
      }),
      subscribe: () => () => {},
    };
  },
}));

const { outboxStorage } = await import("../src/lib/outbox-db");
const { ClientProvider, connectionSignature } = await import("../src/lib/client");

describe("ClientProvider foreground reconnect & outboxStorage wiring", () => {
  let cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    harness.effects.length = 0;
    harness.appStateListener = undefined;
    harness.networkPathListener = undefined;
    harness.capturedStoreOptions = undefined;
    harness.linkStatus = "online";
    harness.selectedComputerValue = {
      key: "direct:ws://192.168.1.10:7878",
      kind: "direct",
      url: "ws://192.168.1.10:7878",
      name: "Studio Mac",
    };
    harness.resetRecovering();
    harness.linkProbe.mockResolvedValue(true);
  });

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups = [];
    vi.useRealTimers();
  });

  function mountProvider() {
    ClientProvider({ children: null });
    cleanups = harness.effects
      .map((effect) => effect())
      .filter((fn): fn is () => void => typeof fn === "function");
  }

  it("wires durable outboxStorage and per-computer outboxKey into createClientStore", () => {
    mountProvider();
    expect(harness.capturedStoreOptions?.outboxStorage).toBe(outboxStorage);
    expect(harness.capturedStoreOptions?.outboxKey).toBe("direct:ws://192.168.1.10:7878");
  });

  it("keeps connectionSignature strictly keyed by computer.key so mDNS lanUrl flapping never tears down connections", () => {
    const base = {
      key: "wss://gateway.itool.tech#mac-1",
      kind: "relay" as const,
      gateway: "wss://gateway.itool.tech",
      machine: { id: "mac-1", name: "Mac", signKey: "s", boxKey: "b", online: true, via: "account" as const },
    };
    expect(connectionSignature(base)).toBe("wss://gateway.itool.tech#mac-1");
    expect(connectionSignature({ ...base, lanUrl: "ws://192.168.1.42:7878", lanE2ee: true })).toBe(
      "wss://gateway.itool.tech#mac-1",
    );
    expect(connectionSignature({ ...base, lanUrl: "ws://10.0.0.5:7878", lanE2ee: false })).toBe(
      "wss://gateway.itool.tech#mac-1",
    );
  });

  it("probes with 2500ms on foreground active when online without tearing down a healthy socket and clears recovering", async () => {
    harness.linkStatus = "online";
    harness.linkProbe.mockResolvedValue(true);
    mountProvider();
    harness.recoveringHistory.length = 0;

    harness.appStateListener?.("active");
    await Promise.resolve();

    expect(harness.linkProbe).toHaveBeenCalledWith(2500);
    expect(harness.probeRelays).toHaveBeenCalledTimes(1);
    expect(harness.linkReconnectNow).not.toHaveBeenCalled();
    expect(harness.reconnectRelays).not.toHaveBeenCalled();
    expect(harness.streamsConnect).toHaveBeenCalledTimes(1);
    // Probe succeeded -> recovering was set true on resume then cleared immediately to false (not stuck 12s).
    expect(harness.recoveringHistory).toEqual([true, false]);
  });

  it("wakes relays if the 2500ms foreground probe detects a dead suspended socket", async () => {
    harness.linkStatus = "online";
    harness.linkProbe.mockResolvedValue(false);
    mountProvider();

    harness.appStateListener?.("active");
    await Promise.resolve();

    expect(harness.linkProbe).toHaveBeenCalledWith(2500);
    expect(harness.reconnectRelays).toHaveBeenCalledTimes(1);
  });

  it("forces immediate reconnectNow(true) + reconnectRelays() on foreground active when offline", () => {
    harness.linkStatus = "reconnecting";
    mountProvider();

    harness.appStateListener?.("active");

    expect(harness.linkReconnectNow).toHaveBeenCalledWith(true);
    expect(harness.reconnectRelays).toHaveBeenCalledTimes(1);
    expect(harness.linkProbe).not.toHaveBeenCalled();
    expect(harness.streamsConnect).toHaveBeenCalledTimes(1);
  });

  it("does not burn initialRecovery while connection.key is none", () => {
    harness.selectedComputerValue = {
      key: "none",
      kind: "direct",
      url: "",
      name: "LinkShell",
    };
    mountProvider();
    expect(harness.initialRecoveryRef.current).toBe(true);
    expect(harness.recoveringHistory.at(-1)).toBe(false);
  });

  it("reconnects relays, restarts LAN discovery, and forces reconnectNow(true) on Wi-Fi <-> cellular path transitions", () => {
    harness.linkStatus = "online";
    mountProvider();
    vi.clearAllMocks();

    // First satisfied event on wifi -> probes or reconnects cleanly and restarts LAN discovery.
    harness.networkPathListener?.({
      status: "satisfied",
      interface: "wifi",
      isExpensive: false,
      isConstrained: false,
    });
    expect(harness.reconnectRelays).toHaveBeenCalledTimes(1);
    expect(harness.restartLanDiscovery).toHaveBeenCalledTimes(1);
    expect(harness.streamsConnect).toHaveBeenCalledTimes(1);

    // Interface switches from wifi -> cellular: must force reconnectNow(true) immediately.
    vi.clearAllMocks();
    harness.networkPathListener?.({
      status: "satisfied",
      interface: "cellular",
      isExpensive: true,
      isConstrained: false,
    });
    expect(harness.reconnectRelays).toHaveBeenCalledTimes(1);
    expect(harness.restartLanDiscovery).toHaveBeenCalledTimes(1);
    expect(harness.linkReconnectNow).toHaveBeenCalledWith(true);
    expect(harness.streamsConnect).toHaveBeenCalledTimes(1);
  });
});
