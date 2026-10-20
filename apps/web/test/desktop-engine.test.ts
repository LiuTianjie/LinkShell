import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  links: [] as { options: { createSocket(): unknown }; socket?: unknown }[],
  streams: [] as { connector?: unknown }[],
  relays: [] as { options: { name: string; platform: string }; reauthenticate: ReturnType<typeof vi.fn> }[],
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
    constructor(readonly options: { name: string; platform: string }) { mocks.relays.push(this); }
    onStatus() {}
    on() {}
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

async function start(accountFailure = false) {
  vi.stubGlobal("fetch", vi.fn((path: string) => Promise.resolve(
    path === "/desktop/bootstrap" ? json({ identity: { id: "native-device" }, storage: {}, localComputer: local }) :
    path === "/desktop/local" ? json({ computer: local }) :
    path === "/desktop/account" ? json(accountFailure ? { error: "账号服务暂不可用" } : {}, accountFailure ? 503 : 200) :
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
}

describe("desktop client connections", () => {
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

  it("removes account computers on logout while preserving the local session", async () => {
    const desktop = await start();
    const connection = engine!.state.getState().connection;
    window.dispatchEvent(new CustomEvent(desktop.DESKTOP_ACCOUNT_EVENT, { detail: { userId: "user-a", email: "person@example.com", accessToken: "short-token" } }));
    await vi.waitFor(() => expect(mocks.relays).toHaveLength(1));
    engine!.state.setState({ computers: [local, remote] });
    window.dispatchEvent(new CustomEvent(desktop.DESKTOP_ACCOUNT_EVENT, { detail: {} }));
    expect(engine!.state.getState().computers).toEqual([local]);
    expect(engine!.state.getState().connection).toBe(connection);
    expect(mocks.relays[0].options.name).toBe("LinkShell Desktop");
    expect(mocks.relays[0].options.platform).toBe("macOS");
    expect(mocks.supabase).not.toHaveBeenCalled();
  });
});
