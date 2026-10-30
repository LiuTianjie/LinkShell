import { beforeEach, expect, it, vi } from "vitest";

interface TestRelay {
  status: string;
  account?: { userId: string };
  lastError?: { code: string; message: string };
  request: ReturnType<typeof vi.fn>;
  emit(status: string, error?: { code: string; message: string }): void;
  event(name: string, payload: { id: string; online: boolean }): void;
}
const fake = vi.hoisted(() => ({ relays: [] as TestRelay[] }));
vi.mock("expo-sqlite/kv-store", () => ({ default: { getItemSync: () => null, setItemSync: vi.fn() } }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-device", () => ({ deviceName: "Test phone" }));
vi.mock("../src/lib/identity", () => ({ deviceIdentity: () => ({ id: "test-phone" }) }));
vi.mock("../src/lib/socket", () => ({ createSocket: vi.fn() }));
vi.mock("@linkshell/wire", () => ({
  RELAY_PATH: "/v2/connect",
  RelayClient: class {
    status = "stopped";
    account = { userId: "account-a" };
    lastError?: { code: string; message: string };
    private listeners: ((status: string, error?: { code: string; message: string }) => void)[] = [];
    private events = new Map<string, (payload: { id: string; online: boolean }) => void>();
    request = vi.fn(async () => ({ machines: [] }));
    constructor() { fake.relays.push(this); }
    onStatus(listener: (status: string, error?: { code: string; message: string }) => void) { this.listeners.push(listener); }
    on(name: string, listener: (payload: { id: string; online: boolean }) => void) { this.events.set(name, listener); }
    event(name: string, payload: { id: string; online: boolean }) { this.events.get(name)?.(payload); }
    start() { this.emit("connecting"); }
    stop() { this.emit("stopped"); }
    reconnectNow() { if (this.status !== "online" && this.status !== "connecting") this.emit("connecting"); }
    emit(status: string, error?: { code: string; message: string }) {
      this.status = status;
      this.lastError = status === "online" ? undefined : error;
      for (const listener of this.listeners) listener(status, error);
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const machine = { id: "computer-a", name: "Computer A", signKey: "sign-a", boxKey: "box-a", online: true, via: "account" as const };

beforeEach(() => {
  vi.resetModules();
  vi.doMock("../src/lib/account", async () => {
    const { create } = await import("zustand");
    return { useAccount: create(() => ({ session: { userId: "account-a", accessToken: "a", refreshToken: "a", expiresAt: 0 }, token: async () => "token" })) };
  });
  vi.stubGlobal("__DEV__", false);
  fake.relays.length = 0;
});

it("retries a failed computer query even while its gateway stays online", async () => {
  const computers = await import("../src/lib/computers");
  computers.startRelays();
  const relay = fake.relays[0]!;
  relay.request.mockRejectedValueOnce(Object.assign(new Error("list timed out"), { code: "timeout" }));
  relay.emit("online");
  await settle();
  expect(computers.useComputers.getState().discovery[computers.DEFAULT_GATEWAY]).toBe("failed");

  relay.request.mockResolvedValueOnce({ machines: [machine] });
  computers.retryComputerDiscovery();
  await settle();
  expect(relay.request).toHaveBeenCalledTimes(2);
  expect(computers.listComputers(computers.useComputers.getState())).toMatchObject([{ machine: { id: machine.id } }]);
});

it("preserves an explicit gateway refusal when its pending RPC fails as offline", async () => {
  const computers = await import("../src/lib/computers");
  computers.startRelays();
  const relay = fake.relays[0]!;
  const pending = deferred<{ machines: typeof machine[] }>();
  relay.request.mockReturnValueOnce(pending.promise);
  relay.emit("online");
  pending.reject(Object.assign(new Error("connection closed"), { code: "offline" }));
  relay.emit("offline", { code: "bad_identity", message: "identity rejected" });
  await settle();
  expect(computers.useComputers.getState().discovery[computers.DEFAULT_GATEWAY]).toBe("refused");
});

it("ignores an older failed discovery after a newer query has succeeded", async () => {
  const computers = await import("../src/lib/computers");
  computers.startRelays();
  const relay = fake.relays[0]!;
  const earlier = deferred<{ machines: typeof machine[] }>();
  relay.request.mockReturnValueOnce(earlier.promise);
  relay.emit("online");
  relay.request.mockResolvedValueOnce({ machines: [machine] });
  await computers.useComputers.getState().refresh(computers.DEFAULT_GATEWAY);
  earlier.reject(Object.assign(new Error("timeout"), { code: "timeout" }));
  await settle();
  expect(computers.useComputers.getState().discovery[computers.DEFAULT_GATEWAY]).toBe("ready");
  expect(computers.listComputers(computers.useComputers.getState())).toHaveLength(1);
});

it("hides account computers immediately on sign-out and rejects the old relay's late list", async () => {
  const computers = await import("../src/lib/computers");
  const { useAccount } = await import("../src/lib/account");
  computers.startRelays();
  const relay = fake.relays[0]!;
  relay.request.mockResolvedValueOnce({ machines: [machine] });
  relay.emit("online");
  await settle();
  const pending = deferred<{ machines: typeof machine[] }>();
  relay.request.mockReturnValueOnce(pending.promise);
  const refresh = computers.useComputers.getState().refresh(computers.DEFAULT_GATEWAY);
  const leave = deferred<undefined>();
  relay.request.mockReturnValueOnce(leave.promise);
  useAccount.setState({ session: undefined });
  expect(computers.listComputers(computers.useComputers.getState())).toEqual([]);
  pending.resolve({ machines: [machine] });
  await refresh;
  expect(computers.listComputers(computers.useComputers.getState())).toEqual([]);
  leave.resolve(undefined);
  await settle();
});

it("ignores presence and list-change notifications from the previous account's relay", async () => {
  const computers = await import("../src/lib/computers");
  const { useAccount } = await import("../src/lib/account");
  computers.startRelays();
  const previousRelay = fake.relays[0]!;
  previousRelay.emit("online");
  await settle();
  useAccount.setState({ session: { ...useAccount.getState().session!, userId: "account-b" } });
  await settle();
  const relay = fake.relays[1]!;
  relay.account = { userId: "account-b" };
  relay.request.mockResolvedValueOnce({ machines: [machine] });
  relay.emit("online");
  await settle();
  previousRelay.event("presence", { id: machine.id, online: false });
  previousRelay.event("machines.changed", { id: machine.id, online: false });
  await settle();
  expect(computers.listComputers(computers.useComputers.getState())).toMatchObject([{ machine: { id: machine.id, online: true } }]);
  expect(relay.request).toHaveBeenCalledTimes(1);
});

it("keeps pairings but rejects old account computers when an offline sign-out could not leave the gateway account", async () => {
  const computers = await import("../src/lib/computers");
  const { useAccount } = await import("../src/lib/account");
  const paired = { ...machine, id: "paired-computer", via: "paired" as const };
  computers.useComputers.getState().addPaired(computers.DEFAULT_GATEWAY, paired);
  computers.startRelays();
  const previousRelay = fake.relays[0]!;
  previousRelay.request.mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "offline" }));
  useAccount.setState({ session: undefined });
  await settle();
  const relay = fake.relays[1]!;
  relay.request.mockResolvedValueOnce({ machines: [machine, paired] });
  relay.emit("online");
  await settle();
  expect(computers.listComputers(computers.useComputers.getState())).toMatchObject([{ machine: { id: paired.id, online: true } }]);
  expect(computers.listComputers(computers.useComputers.getState())).toHaveLength(1);
  expect(computers.useComputers.getState().discovery[computers.DEFAULT_GATEWAY]).toBe("ready");
});
