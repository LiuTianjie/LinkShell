import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  links: [] as { options: { createSocket(): unknown }; socket?: unknown }[],
  streams: [] as { connector?: unknown }[],
  relays: [] as { options: { name: string; platform: string }; account?: { userId: string }; reauthenticate: ReturnType<typeof vi.fn>; handlers: Map<string, (data: unknown) => void>; request: ReturnType<typeof vi.fn>; status: string }[],
  supabase: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.supabase }));
vi.mock("@linkshell/client-core", () => ({
  HostLink: class {
    constructor(readonly options: { createSocket(): unknown }) { mocks.links.push(this); }
    reconnectNow() {}
  },
  HostStreams: class {
    constructor(_link: unknown, options: { connector?: unknown }) { mocks.streams.push(options); }
    start() {}
    stop() {}
    connect() {}
  },
  createClientStore: (link: typeof mocks.links[number]) => ({
    subscribe: () => () => {},
    getState: () => ({
      connect: () => { link.socket = link.options.createSocket(); },
      disconnect() {},
    }),
  }),
  TunnelSocket: class {},
  pairByCode: vi.fn(),
  pairByLink: vi.fn(),
  fetchProMembership: vi.fn(),
  redeemProCode: vi.fn(),
}));
vi.mock("@linkshell/wire", () => ({
  RELAY_PATH: "/v2/connect",
  decodePairingLink: vi.fn(),
  createIdentity: vi.fn(),
  RelayClient: class {
    reauthenticate = vi.fn();
    handlers = new Map<string, (data: unknown) => void>();
    request = vi.fn(async () => ({ machines: [] as unknown[] }));
    status = "online";
    account = { userId: "user-a" };
    constructor(readonly options: { name: string; platform: string }) { mocks.relays.push(this); }
    onStatus() {}
    on(name: string, handler: (data: unknown) => void) { this.handlers.set(name, handler); }
    start() {}
    stop() {}
    reconnectNow() {}
  },
}));

const local = {
  key: "desktop:local", gateway: "desktop:local",
  machine: { id: "this-mac", name: "My Mac", signKey: "sign", boxKey: "box", platform: "darwin", online: true, via: "paired" as const },
};
const remote = {
  key: "wss://gateway.itool.tech#other", gateway: "wss://gateway.itool.tech",
  machine: { ...local.machine, id: "other", name: "Other Mac", via: "account" as const },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let engine: import("../src/live/engine").BrowserEngine | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.links.length = 0; mocks.streams.length = 0; mocks.relays.length = 0;
  vi.stubGlobal("window", Object.assign(new EventTarget(), { __LINKSHELL_CONFIG__: { desktop: true } }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { documentElement: { dataset: {} }, hidden: false }));
  vi.stubGlobal("location", { hash: "#desktop=capability", origin: "http://127.0.0.1:41414", protocol: "http:", pathname: "/", search: "" });
  Object.assign(window, { location });
  vi.stubGlobal("history", { replaceState: vi.fn() });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", vi.fn());
});
afterEach(() => { engine?.stop(); engine = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

async function start(accountFailure = false, computer: import("../src/live/engine").Computer = local, userId?: string) {
  vi.stubGlobal("fetch", vi.fn((path: string) => Promise.resolve(
    path === "/desktop/bootstrap" ? json({ identity: { id: "native-device" }, storage: {}, localComputer: computer }) :
    path === "/desktop/local" ? json({ computer }) :
    path === "/desktop/account" ? json(accountFailure ? { error: "账号服务暂不可用" } : { userId }, accountFailure ? 503 : 200) :
    json({ ok: true }),
  )));
  const desktop = await import("../src/live/desktop");
  await desktop.bootstrapDesktop();
  const module = await import("../src/live/engine");
  engine = module.engine;
  await engine.start();
  return desktop;
}

async function startBeforeLocalHost(lookup: (options?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((path: string, options?: RequestInit) => {
    if (path === "/desktop/bootstrap") return Promise.resolve(json({ identity: { id: "native-device" }, storage: {} }));
    if (path === "/desktop/local") return lookup(options);
    if (path === "/desktop/account") return Promise.resolve(json({ userId: "account-a", accessToken: "access-a" }));
    return Promise.resolve(json({ ok: true }));
  }));
  const desktop = await import("../src/live/desktop");
  await desktop.bootstrapDesktop();
  engine = (await import("../src/live/engine")).engine;
  await engine.start();
  await vi.advanceTimersByTimeAsync(0);
  mocks.relays[0].account = { userId: "account-a" };
}

describe("desktop client connections", () => {
  it("merges the local relay alias by identity, preserves same-name computers and resolves saved remote routes", async () => {
    const localIdentity = { ...local, relayId: "local-signing-id" };
    await start(false, localIdentity, "user-a");
    const connection = engine!.state.getState().connection;
    const duplicate = { ...remote, key: `${remote.gateway}#local-signing-id`, machine: { ...remote.machine, id: "local-signing-id" } };
    const other = { ...remote, machine: { ...remote.machine, name: local.machine.name } };
    const relay = engine!.relay(remote.gateway);
    vi.mocked(relay.request).mockResolvedValue({ machines: [duplicate.machine, other.machine] });
    await engine!.refresh(remote.gateway);
    expect(engine!.state.getState().computers.map((computer) => computer.key)).toEqual([local.key, other.key]);
    expect(engine!.computerForKey(duplicate.key)?.key).toBe(local.key);
    engine!.select(duplicate);
    expect(engine!.state.getState().connection).toBe(connection);
    expect(mocks.links).toHaveLength(1);
  });

  it("merges a relay alias when local discovery finishes later, without interrupting an active remote connection", async () => {
    vi.useFakeTimers();
    let discovered = false;
    await startBeforeLocalHost(() => Promise.resolve(json(discovered ? { computer: { ...local, relayId: remote.machine.id } } : {})));
    const relay = mocks.relays[0];
    relay.request.mockResolvedValue({ machines: [remote.machine] });
    await engine!.refresh(remote.gateway);
    const connection = engine!.state.getState().connection;
    expect(connection?.computer.key).toBe(remote.key);
    discovered = true;
    await engine!.refreshLocal();
    expect(engine!.state.getState().computers.map((computer) => computer.key)).toEqual([local.key]);
    expect(engine!.state.getState().connection).toBe(connection);
    expect(engine!.computerForKey(remote.key)?.key).toBe(local.key);
    const desktop = await import("../src/live/desktop");
    window.dispatchEvent(new CustomEvent(desktop.DESKTOP_ACCOUNT_EVENT, { detail: {} }));
    expect(engine!.state.getState().connection).toBeUndefined();
  });

  it.each(["stopped", "unreachable"])("keeps one reachable relay row when local IPC is %s, and restores the local row when it returns", async (failure) => {
    const localIdentity = { ...local, relayId: remote.machine.id };
    await start(false, localIdentity, "user-a");
    engine!.relay(remote.gateway);
    const relay = mocks.relays.at(-1)!;
    relay.request.mockResolvedValue({ machines: [remote.machine] });
    await engine!.refresh(remote.gateway);
    const nativeFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((path, init) => path === "/desktop/local"
      ? failure === "unreachable" ? Promise.reject(new Error("本机桌面服务暂时不可用")) : Promise.resolve(json({}))
      : nativeFetch(path, init));
    await engine!.refreshLocal();
    expect(engine!.state.getState().computers.map((computer) => computer.key)).toEqual([remote.key]);
    expect(engine!.computerForKey(local.key)?.key).toBe(remote.key);
    expect(engine!.state.getState().connection?.computer.key).toBe(local.key);
    engine!.select(local);
    expect(engine!.state.getState().connection?.computer.key).toBe(remote.key);
    relay.handlers.get("presence")!({ id: remote.machine.id, online: false });
    expect(engine!.state.getState().computers.map((computer) => computer.key)).toEqual([local.key]);
    relay.handlers.get("presence")!({ id: remote.machine.id, online: true });
    expect(engine!.state.getState().computers.map((computer) => computer.key)).toEqual([remote.key]);
    vi.mocked(fetch).mockImplementation(nativeFetch);
    await engine!.refreshLocal();
    expect(engine!.state.getState().computers.map((computer) => computer.key)).toEqual([local.key]);
    expect(engine!.computerForKey(remote.key)?.key).toBe(local.key);
    engine!.select(remote);
    expect(engine!.state.getState().connection?.computer.key).toBe(local.key);
  });

  it("does not restore a forgotten hidden relay alias when the local socket later stops", async () => {
    await start(false, { ...local, relayId: remote.machine.id }, "user-a");
    engine!.relay(remote.gateway);
    const relay = mocks.relays.at(-1)!;
    relay.request.mockResolvedValue({ machines: [remote.machine] });
    await engine!.refresh(remote.gateway);
    await engine!.forget(remote);
    const nativeFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((path, init) => path === "/desktop/local" ? Promise.resolve(json({})) : nativeFetch(path, init));
    await engine!.refreshLocal();
    expect(engine!.state.getState().computers).toHaveLength(1);
    expect(engine!.state.getState().computers[0]).toMatchObject({ key: local.key, machine: { online: false } });
  });

  it("discovers a Host that opens shortly after bootstrap while keeping remote account access ready", async () => {
    vi.useFakeTimers();
    let lookups = 0;
    await startBeforeLocalHost(() => Promise.resolve(json(++lookups < 3 ? {} : { computer: local })));
    expect(engine!.state.getState().ready).toBe(true);
    expect(engine!.state.getState().accountUserId).toBe("account-a");
    expect(mocks.relays).toHaveLength(1);
    expect(engine!.state.getState().connection).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(lookups).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine!.state.getState().connection?.computer.key).toBe("desktop:local");
    expect(engine!.state.getState().localError).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lookups).toBe(3);
  });

  it("bounds initial retries when the Host stays stopped and cancels later polling on stop", async () => {
    vi.useFakeTimers();
    let lookups = 0;
    await startBeforeLocalHost(() => { lookups++; return Promise.resolve(json({})); });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lookups).toBe(6);
    expect(engine!.state.getState().ready).toBe(true);
    expect(engine!.state.getState().accountUserId).toBe("account-a");
    engine!.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lookups).toBe(6);
  });

  it("aborts an in-flight discovery and ignores a late Host response after stop", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    let lookups = 0;
    await startBeforeLocalHost((options) => {
      lookups++; signal = options?.signal ?? undefined;
      return new Promise((resolve) => { finish = resolve; });
    });
    engine!.stop();
    expect(signal?.aborted).toBe(true);
    finish(json({ computer: local }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine!.state.getState().connection).toBeUndefined();
    expect(engine!.state.getState().computers).toEqual([]);
    expect(lookups).toBe(1);
  });

  it("opens this Mac without an account, a relay or a bulk WebRTC connection", async () => {
    await start();
    expect(engine!.state.getState().connection?.computer.key).toBe("desktop:local");
    expect(engine!.state.getState().ready).toBe(true);
    expect(mocks.links).toHaveLength(1);
    expect(mocks.streams[0].connector).toBeUndefined();
    expect(mocks.relays).toHaveLength(0);
    expect(mocks.supabase).not.toHaveBeenCalled();
  });

  it("keeps this Mac usable if the native account refresh fails", async () => {
    await start(true);
    expect(engine!.state.getState().connection?.computer.key).toBe("desktop:local");
    expect(engine!.state.getState().error).toContain("账号服务暂不可用");
    await expect(engine!.forget(local)).rejects.toThrow("本机无需配对");
  });

  it.each([["darwin", "macOS"], ["win32", "Windows"]])("registers %s correctly and removes account computers on logout while preserving the local session", async (platform, label) => {
    window.__LINKSHELL_CONFIG__!.desktopPlatform = platform;
    const desktop = await start();
    const connection = engine!.state.getState().connection;
    window.dispatchEvent(new CustomEvent(desktop.DESKTOP_ACCOUNT_EVENT, { detail: { userId: "user-a", email: "person@example.com", accessToken: "short-token" } }));
    await vi.waitFor(() => expect(mocks.relays).toHaveLength(1));
    engine!.state.setState({ computers: [local, remote] });
    window.dispatchEvent(new CustomEvent(desktop.DESKTOP_ACCOUNT_EVENT, { detail: {} }));
    expect(engine!.state.getState().computers).toEqual([local]);
    expect(engine!.state.getState().connection).toBe(connection);
    expect(mocks.relays[0].options.name).toBe("LinkShell Desktop");
    expect(mocks.relays[0].options.platform).toBe(label);
    expect(mocks.supabase).not.toHaveBeenCalled();
  });

  it("keeps the gateway connection when only the account's token is refreshed", async () => {
    const desktop = await start();
    const account = (accessToken: string) => window.dispatchEvent(new CustomEvent(desktop.DESKTOP_ACCOUNT_EVENT, { detail: { userId: "user-a", email: "person@example.com", accessToken } }));
    account("token-1");
    await vi.waitFor(() => expect(mocks.relays).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const signIns = mocks.relays[0].reauthenticate.mock.calls.length;
    // The hourly refresh: reconnecting here would drop every open tunnel.
    account("token-2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.relays).toHaveLength(1);
    expect(mocks.relays[0].reauthenticate.mock.calls.length).toBe(signIns);
  });

  it("lists a computer that joins the account while the workspace is open, and refreshes on request", async () => {
    const desktop = await start();
    window.dispatchEvent(new CustomEvent(desktop.DESKTOP_ACCOUNT_EVENT, { detail: { userId: "user-a", email: "person@example.com", accessToken: "token-1" } }));
    await vi.waitFor(() => expect(mocks.relays).toHaveLength(1));
    const relay = mocks.relays[0];
    relay.request.mockResolvedValue({ machines: [remote.machine] });
    relay.handlers.get("presence")!({ id: "other", online: true });
    await vi.waitFor(() => expect(engine!.state.getState().computers.map((item) => item.key)).toContain(remote.key));
    const asked = relay.request.mock.calls.length;
    await engine!.refreshComputers();
    expect(relay.request.mock.calls.length).toBe(asked + 1);
  });
});
