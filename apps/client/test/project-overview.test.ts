import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@linkshell/wire";
import type { Computer } from "../src/lib/computers";
import type { ProjectOverview } from "../src/lib/project-overview";

interface FakeLink {
  call: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  online?: () => void;
  status?: (status: string) => void;
  summary?: (session: SessionSummary) => void;
}
const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  snapshot: undefined as { identity: string; overview: ProjectOverview } | undefined,
  owner: "account-a" as string | undefined,
  appState: "active",
  onAppState: undefined as undefined | ((state: string) => void),
  links: [] as FakeLink[],
  reply: vi.fn<(method: string) => Promise<unknown>>(),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useState: (initial: () => NonNullable<typeof harness.snapshot>) => {
    harness.snapshot ??= initial();
    return [harness.snapshot, (change: (current: NonNullable<typeof harness.snapshot>) => NonNullable<typeof harness.snapshot>) => { harness.snapshot = change(harness.snapshot!); }];
  },
}));
vi.mock("react-native", () => ({ AppState: {
  get currentState() { return harness.appState; },
  addEventListener: (_event: string, callback: (state: string) => void) => {
    harness.onAppState = callback;
    return { remove: () => { harness.onAppState = undefined; } };
  },
} }));
vi.mock("@linkshell/client-core", () => ({
  HostLink: class {
    call = vi.fn((method: string) => harness.reply(method));
    start = vi.fn();
    stop = vi.fn();
    online?: () => void;
    status?: (status: string) => void;
    summary?: (session: SessionSummary) => void;
    constructor() { harness.links.push(this); }
    onOnline(callback: () => void) { this.online = callback; return () => { this.online = undefined; }; }
    onStatus(callback: (status: string) => void) { this.status = callback; return () => { this.status = undefined; }; }
    onSummary(callback: (session: SessionSummary) => void) { this.summary = callback; return () => { this.summary = undefined; }; }
  },
  TunnelSocket: class {},
}));
vi.mock("../src/lib/client", () => ({ accessToken: () => ({ load: () => "scoped-access-token", save: vi.fn() }) }));
vi.mock("../src/lib/computers", () => ({ relayFor: vi.fn() }));
vi.mock("../src/lib/identity", () => ({ deviceIdentity: vi.fn() }));
vi.mock("../src/lib/socket", () => ({ createSocket: vi.fn() }));
vi.mock("../src/lib/account", () => ({ useAccount: (select: (value: { session?: { userId: string } }) => unknown) => select({ session: harness.owner ? { userId: harness.owner } : undefined }) }));

const { useProjectOverview } = await import("../src/lib/project-overview");
const computer: Computer = { key: "direct:ws://host-a", kind: "direct", url: "ws://host-a", name: "Computer A" };
const session = (state = "running"): SessionSummary => ({ id: "task-a", cwd: "/work/a", agent: "codex", state, updatedAt: 1, pendingPermissions: 0 } as SessionSummary);
const project = { cwd: "/work/a", name: "Project A", lastActiveAt: 1, sessionCount: 1 };
const settle = () => vi.advanceTimersByTimeAsync(0);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("mobile all-computer project overview", () => {
  let cleanup: (() => void) | undefined;
  const render = (target: Computer = computer, enabled = true) => {
    harness.effects = [];
    return useProjectOverview(target, enabled);
  };
  const mount = (target: Computer = computer, enabled = true) => {
    cleanup?.();
    render(target, enabled);
    cleanup = harness.effects[0]() || undefined;
  };
  const foreground = (state: string) => {
    harness.appState = state;
    harness.onAppState?.(state);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    harness.links = [];
    harness.snapshot = undefined;
    harness.owner = "account-a";
    harness.appState = "active";
    harness.onAppState = undefined;
    harness.reply.mockImplementation(async (method) => method === "projects.list" ? { projects: [project] } : { sessions: [session()] });
  });
  afterEach(() => {
    cleanup?.(); cleanup = undefined;
    vi.useRealTimers();
  });

  it("only reads summaries and releases its connection and polling when the page loses focus", async () => {
    mount(); await settle();
    expect(render()).toMatchObject({ loaded: true, projects: [project] });
    const link = harness.links[0];
    expect(link.call.mock.calls.map(([method]) => method)).toEqual(["projects.list", "sessions.list"]);
    mount(computer, false);
    const calls = link.call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.stop).toHaveBeenCalledOnce();
    expect(link.call).toHaveBeenCalledTimes(calls);
    expect(link.online).toBeUndefined();
    expect(link.summary).toBeUndefined();
    expect(harness.onAppState).toBeUndefined();
  });

  it("ignores reads completed after backgrounding and opens a fresh observer on return", async () => {
    const pending = deferred<{ projects: typeof project[] }>();
    harness.reply.mockImplementation((method) => method === "projects.list" ? pending.promise : Promise.resolve({ sessions: [session()] }));
    mount();
    foreground("background");
    pending.resolve({ projects: [project] }); await settle();
    expect(render().loaded).toBe(false);
    expect(harness.links[0].stop).toHaveBeenCalledOnce();
    foreground("active"); await settle();
    expect(harness.links).toHaveLength(2);
    expect(render().loaded).toBe(true);
  });

  it("does not start an observer for an unfocused or background screen", () => {
    mount(computer, false);
    expect(harness.links).toHaveLength(0);
    harness.appState = "background";
    mount();
    expect(harness.links).toHaveLength(0);
    foreground("active");
    expect(harness.links).toHaveLength(1);
  });

  it("hides cached summaries immediately when the account or computer identity changes", async () => {
    mount(); await settle();
    expect(render().loaded).toBe(true);
    harness.owner = "account-b";
    expect(render()).toMatchObject({ loaded: false, projects: [], sessions: [] });
    mount(); await settle();
    expect(harness.links[0].stop).toHaveBeenCalledOnce();
    expect(render().loaded).toBe(true);
    expect(render({ ...computer, url: "ws://host-b" })).toMatchObject({ loaded: false, projects: [], sessions: [] });
  });

  it("does not reopen an account-only computer while sign-out discovery is still clearing its old row", async () => {
    const remote: Computer = { key: "gateway#host-a", kind: "relay", gateway: "wss://gateway", machine: {
      id: "host-a", signKey: "sign-a", boxKey: "box-a", name: "Computer A", online: true, via: "account",
    } };
    mount(remote); await settle();
    expect(render(remote).loaded).toBe(true);
    harness.owner = undefined;
    mount(remote); await settle();
    expect(harness.links).toHaveLength(1);
    expect(harness.links[0].stop).toHaveBeenCalledOnce();
    expect(render(remote)).toMatchObject({ loaded: false, projects: [], sessions: [], error: expect.any(String) });
  });

  it("clears cached projects when access is locked and clears the error after a successful retry", async () => {
    mount(); await settle();
    const link = harness.links[0];
    link.status?.("locked");
    expect(render()).toMatchObject({ loaded: false, projects: [], sessions: [], error: expect.any(String) });
    link.online?.(); await settle();
    expect(render()).toMatchObject({ loaded: true, projects: [project] });
    expect(render().error).toBeUndefined();
  });

  it("keeps a live permission request arriving while an older snapshot is in flight", async () => {
    const pending = deferred<{ sessions: SessionSummary[] }>();
    harness.reply.mockImplementation((method) => method === "sessions.list" ? pending.promise : Promise.resolve({ projects: [project] }));
    mount();
    const waiting = { ...session("waiting"), pendingPermissions: 1 };
    harness.links[0].summary?.(waiting);
    pending.resolve({ sessions: [session()] }); await settle();
    expect(render().sessions).toEqual([waiting]);
  });
});
