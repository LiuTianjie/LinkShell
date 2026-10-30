import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Computer } from "../src/live/engine";

const mocks = vi.hoisted(() => ({
  saved: new Map<string, unknown>(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  accountToken: vi.fn(),
  disconnected: [] as ReturnType<typeof vi.fn>[],
  relays: [] as { options: { token?: () => Promise<string | undefined> }; account?: { userId: string }; request: ReturnType<typeof vi.fn>; reauthenticate: ReturnType<typeof vi.fn> }[],
}));
vi.mock("../src/live/storage", () => ({
  browserIdentity: async () => ({ id: "browser-device" }),
  readLocal: (key: string, fallback: unknown) => mocks.saved.get(key) ?? fallback,
  saveLocal: (key: string, value: unknown) => mocks.saved.set(key, value),
}));
vi.mock("../src/live/account", () => ({
  accountClient: () => ({ auth: { getSession: mocks.getSession, onAuthStateChange: mocks.onAuthStateChange } }),
  accountToken: mocks.accountToken,
}));
vi.mock("@linkshell/client-core", () => ({
  HostLink: class { reconnectNow() {} },
  HostStreams: class { start() {} stop() {} connect() {} },
  createClientStore: () => {
    const disconnect = vi.fn();
    mocks.disconnected.push(disconnect);
    return { subscribe: () => () => {}, getState: () => ({ connect() {}, disconnect }) };
  },
  TunnelSocket: class {}, pairByCode: vi.fn(), pairByLink: vi.fn(),
}));
vi.mock("@linkshell/wire", () => ({
  RELAY_PATH: "/v2/connect",
  decodePairingLink: vi.fn(),
  RelayClient: class {
    request = vi.fn(async () => ({ machines: [] }));
    reauthenticate = vi.fn();
    status = "online";
    account = { userId: "a" };
    constructor(readonly options: { token?: () => Promise<string | undefined> }) { mocks.relays.push(this); }
    onStatus() {} on() {} start() {} stop() {} reconnectNow() {}
  },
}));

const gateway = "wss://gateway.itool.tech";
const computer = (id: string, via: "account" | "paired"): Computer => ({
  key: `${gateway}#${id}`, gateway,
  machine: { id, name: id, signKey: "sign", boxKey: "box", online: true, via },
});
const accountComputer = computer("account-computer", "account");
const hiddenComputer = computer("background-account-computer", "account");
const pairedComputer = computer("paired-computer", "paired");
const session = (id: string) => ({ user: { id, email: `${id}@example.test` } });
let engine: import("../src/live/engine").BrowserEngine;
let authChanged: (event: string, value: ReturnType<typeof session> | null) => void;

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  mocks.saved.clear(); mocks.disconnected.length = 0; mocks.relays.length = 0;
  mocks.saved.set("paired", [pairedComputer]);
  mocks.getSession.mockResolvedValue({ data: { session: session("a") }, error: null });
  mocks.onAuthStateChange.mockImplementation((callback) => { authChanged = callback; });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { __LINKSHELL_CONFIG__: { desktop: false } }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false, documentElement: { dataset: {} } }));
  vi.stubGlobal("location", { origin: "https://workspace.example.test", protocol: "https:", hash: "", pathname: "/", search: "" });
  Object.assign(window, { location });
  vi.stubGlobal("navigator", { locks: { request: (_name: string, _options: unknown, use: (lock: object) => Promise<void>) => use({}) } });
  vi.stubGlobal("BroadcastChannel", undefined);
  engine = (await import("../src/live/engine")).engine;
  await engine.start();
  await vi.advanceTimersByTimeAsync(0);
  mocks.relays[0].reauthenticate.mockClear();
});
afterEach(() => { engine.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("drops selected and hidden account connections on sign out while keeping paired access", () => {
  engine.state.setState({ computers: [accountComputer, pairedComputer] });
  engine.select(accountComputer);
  const selectedClosed = mocks.disconnected.at(-1)!;
  const overview = engine.retainComputer(hiddenComputer, { metadataOnly: true });
  const overviewClosed = mocks.disconnected.at(-1)!;
  const paired = engine.retainComputer(pairedComputer, { metadataOnly: true });
  const pairedClosed = mocks.disconnected.at(-1)!;
  authChanged("SIGNED_OUT", null);
  expect(engine.state.getState().accountUserId).toBeUndefined();
  expect(engine.state.getState().connection).toBeUndefined();
  expect(engine.state.getState().computers).toEqual([pairedComputer]);
  expect(selectedClosed).toHaveBeenCalledTimes(1);
  expect(overviewClosed).toHaveBeenCalledTimes(1);
  expect(pairedClosed).not.toHaveBeenCalled();
  expect(mocks.saved.get("paired")).toEqual([pairedComputer]);
  overview.release(); paired.release();
  expect(pairedClosed).toHaveBeenCalledTimes(1);
});

it("cleans up an explicit account switch and does not cancel its reauthentication on duplicate events", async () => {
  engine.state.setState({ computers: [accountComputer, pairedComputer] });
  engine.select(accountComputer);
  mocks.getSession.mockResolvedValue({ data: { session: session("b") }, error: null });
  await engine.connectAccount();
  authChanged("INITIAL_SESSION", session("b"));
  authChanged("TOKEN_REFRESHED", session("b"));
  expect(engine.state.getState().connection).toBeUndefined();
  expect(engine.state.getState().computers).toEqual([pairedComputer]);
  expect(engine.state.getState().accountUserId).toBe("b");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.relays[0].reauthenticate).toHaveBeenCalledTimes(1);
  engine.select(pairedComputer);
  const selected = engine.state.getState().connection;
  authChanged("TOKEN_REFRESHED", session("b"));
  await vi.advanceTimersByTimeAsync(0);
  expect(engine.state.getState().connection).toBe(selected);
  expect(mocks.relays[0].reauthenticate).toHaveBeenCalledTimes(1);
});

it("ignores late session and machine-list responses from before an account transition", async () => {
  let finishSession!: (value: unknown) => void;
  let finishList!: (value: unknown) => void;
  mocks.getSession.mockImplementationOnce(() => new Promise((resolve) => { finishSession = resolve; }));
  mocks.relays[0].request.mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve; }));
  const pendingSession = engine.connectAccount();
  const pendingList = engine.refresh(gateway);
  authChanged("SIGNED_OUT", null);
  finishSession({ data: { session: session("a") }, error: null });
  await pendingSession;
  expect(engine.state.getState().accountUserId).toBeUndefined();
  authChanged("SIGNED_IN", session("a"));
  finishList({ machines: [accountComputer.machine] });
  await pendingList;
  expect(engine.state.getState().computers.some((item) => item.key === accountComputer.key)).toBe(false);
});

it("rejects a gateway token fetched for the previous account without surfacing its stale error", async () => {
  let finish!: (token: string) => void;
  mocks.accountToken.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = mocks.relays[0].options.token!();
  expect(mocks.accountToken).toHaveBeenCalledWith("a");
  authChanged("SIGNED_IN", session("b"));
  finish("previous-account-token");
  await expect(pending).rejects.toThrow("账号已更新");
  expect(engine.state.getState().error).toBeUndefined();
});

it.each([undefined, "b"])("filters a stale gateway account binding after switching to %s while keeping pairings", async (userId) => {
  const relay = mocks.relays[0];
  relay.request.mockResolvedValue({ machines: [accountComputer.machine, pairedComputer.machine] });
  await engine.refresh(gateway);
  expect(engine.state.getState().computers).toEqual([accountComputer, pairedComputer]);
  engine.select(accountComputer);
  const selectedClosed = mocks.disconnected.at(-1)!;
  authChanged(userId ? "SIGNED_IN" : "SIGNED_OUT", userId ? session(userId) : null);
  await vi.advanceTimersByTimeAsync(0);
  // A newly completed list can still carry the old binding when account.leave failed offline.
  await engine.refresh(gateway);
  expect(engine.state.getState().computers).toEqual([pairedComputer]);
  expect(engine.state.getState().connection?.computer.key).toBe(pairedComputer.key);
  expect(selectedClosed).toHaveBeenCalledTimes(1);
  expect(engine.state.getState().error).toBe(userId ? "网关未确认当前账号，请退出账号后重新登录。" : undefined);
  const nextUser = userId ?? "a";
  if (!userId) authChanged("SIGNED_IN", session(nextUser));
  relay.account = { userId: nextUser };
  await engine.refresh(gateway);
  expect(engine.state.getState().computers).toEqual([accountComputer, pairedComputer]);
  expect(engine.state.getState().error).toBeUndefined();
});
