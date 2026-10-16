import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface NativeRegistration { activityId: string; computerKey: string; token: string }
interface SavedRegistration extends NativeRegistration { grant: string; owner: string; ended?: boolean }
const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  owner: "owner-1" as string | undefined,
  online: true,
  computerKey: "computer-1",
  serviceUrl: "https://push.itool.tech",
  saved: undefined as { records: SavedRegistration[] } | null | undefined,
  native: { activityId: "activity-1", computerKey: "computer-1", token: "ab".repeat(32) },
  onToken: undefined as undefined | ((event: { activityId?: string; ended?: boolean }) => void),
  onAppState: undefined as undefined | ((state: string) => void),
  onOnline: undefined as undefined | (() => void),
  getNative: vi.fn(), ready: vi.fn(), end: vi.fn(), call: vi.fn(), token: vi.fn(),
}));
vi.mock("react", () => ({ useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect) }));
vi.mock("react-native", () => ({ AppState: {
  currentState: "active",
  addEventListener: (_name: string, callback: (state: string) => void) => {
    harness.onAppState = callback;
    return { remove: () => { harness.onAppState = undefined; } };
  },
} }));
vi.mock("expo-crypto", () => ({ getRandomBytes: (count: number) => new Uint8Array(count).fill(7) }));
vi.mock("../modules/link-layout", () => ({
  get liveActivityPushURL() { return harness.serviceUrl; },
  getNativeLiveActivityRegistrations: harness.getNative,
  setNativeLiveActivityPushReady: harness.ready,
  endNativeLiveActivity: harness.end,
  subscribeNativeLiveActivityTokens: (callback: typeof harness.onToken) => {
    harness.onToken = callback;
    return () => { harness.onToken = undefined; };
  },
}));
vi.mock("../src/lib/secure", () => ({
  readSecret: () => harness.saved,
  writeSecret: (_key: string, record: { records: SavedRegistration[] } | null) => { harness.saved = structuredClone(record); },
  deleteSecret: async () => { harness.saved = undefined; },
}));
vi.mock("../src/lib/account", () => {
  const state = () => ({ session: harness.owner ? { userId: harness.owner } : undefined, token: harness.token });
  return { useAccount: Object.assign((select: (value: ReturnType<typeof state>) => unknown) => select(state()), { getState: state }) };
});
vi.mock("../src/lib/client", () => ({
  useConnection: () => ({ computer: { key: harness.computerKey }, link: {
    call: harness.call, get status() { return harness.online ? "online" : "reconnecting"; },
    onOnline: (callback: () => void) => { harness.onOnline = callback; return () => { harness.onOnline = undefined; }; },
  } }),
  useClient: (select: (state: { status: string }) => unknown) => select({ status: harness.online ? "online" : "offline" }),
}));
const { useLiveActivityPush } = await import("../src/lib/live-activity-push");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const registered = () => Response.json({ activityId: harness.native.activityId, expiresAt: Date.now() + 3_600_000 });
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("ActivityKit registration handoff", () => {
  let cleanup: (() => void) | undefined;
  const request = vi.fn<typeof fetch>();
  const mount = () => {
    cleanup?.();
    harness.effects = [];
    useLiveActivityPush();
    cleanup = harness.effects[0]() || undefined;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    harness.owner = "owner-1"; harness.online = true; harness.computerKey = "computer-1";
    harness.serviceUrl = "https://push.itool.tech"; harness.saved = undefined;
    harness.native = { activityId: "activity-1", computerKey: "computer-1", token: "ab".repeat(32) };
    harness.onToken = undefined; harness.onAppState = undefined;
    harness.getNative.mockImplementation(async () => [{ ...harness.native }]);
    harness.token.mockResolvedValue("account-access-token");
    harness.call.mockResolvedValue({ ok: true });
    harness.ready.mockResolvedValue(true);
    harness.end.mockResolvedValue(undefined);
    request.mockImplementation(async (_url, init) => init?.method === "PUT" ? registered() : new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", request);
  });
  afterEach(() => {
    cleanup?.(); cleanup = undefined;
    vi.unstubAllGlobals(); vi.useRealTimers();
  });

  it("hands only a scoped grant to the host and waits for its acknowledgement", async () => {
    const host = deferred<{ ok: boolean }>();
    harness.call.mockReturnValueOnce(host.promise);
    mount(); await settle();
    expect(request).toHaveBeenCalledWith("https://push.itool.tech/v1/activities/activity-1", expect.objectContaining({
      method: "PUT", headers: { Authorization: "Bearer account-access-token", "content-type": "application/json" },
    }));
    const [method, subscription] = harness.call.mock.calls[0];
    expect(method).toBe("liveActivities.subscribe");
    expect(subscription).toMatchObject({ activityId: "activity-1", computerKey: "computer-1", grant: "07".repeat(32) });
    expect(subscription).not.toHaveProperty("token");
    expect(harness.ready).not.toHaveBeenCalled();
    host.resolve({ ok: true }); await settle();
    expect(harness.ready).toHaveBeenCalledWith("activity-1");
  });

  it("does not register an activity belonging to another computer", async () => {
    harness.native.computerKey = "other-computer";
    mount(); await settle();
    expect(request).not.toHaveBeenCalled();
    expect(harness.call).not.toHaveBeenCalled();
    expect(harness.ready).not.toHaveBeenCalled();
  });

  it("re-registers a rotated ActivityKit token using the same grant", async () => {
    mount(); await settle();
    const grant = harness.saved?.records[0]?.grant;
    harness.native.token = "cd".repeat(32);
    harness.onToken?.({ activityId: "activity-1" }); await settle();
    expect(request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(2);
    expect(JSON.parse(request.mock.calls[1][1]!.body as string)).toEqual({ token: "cd".repeat(32), grant });
    expect(harness.call).toHaveBeenCalledTimes(2);
    expect(harness.ready).toHaveBeenCalledTimes(2);
  });

  it("does not treat a failed token rotation as registered on the next retry", async () => {
    mount(); await settle();
    harness.native.token = "cd".repeat(32);
    request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    harness.onToken?.({ activityId: "activity-1" }); await settle();
    expect(harness.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(3);
    expect(harness.call).toHaveBeenCalledTimes(2);
  });

  it("preserves an in-flight service registration across a socket reconnect", async () => {
    const registration = deferred<Response>();
    request.mockImplementationOnce(() => registration.promise);
    mount(); await settle();
    harness.online = false;
    harness.online = true; harness.onOnline?.();
    registration.resolve(registered()); await settle();
    expect(request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(harness.ready).toHaveBeenCalledWith("activity-1");
  });

  it("revalidates a server registration after returning to the foreground", async () => {
    mount(); await settle();
    harness.onAppState?.("active"); await settle();
    expect(request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(2);
    expect(harness.call).toHaveBeenCalledTimes(2);
  });

  it("retries a failed foreground validation before handing the grant to Host", async () => {
    mount(); await settle();
    request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    harness.onAppState?.("active"); await settle();
    expect(harness.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(3);
    expect(harness.call).toHaveBeenCalledTimes(2);
  });

  it("ignores an ended activity even when its native lookup finishes late", async () => {
    const native = deferred<NativeRegistration[]>();
    harness.getNative.mockReturnValueOnce(native.promise);
    mount();
    harness.onToken?.({ activityId: "activity-1", ended: true });
    native.resolve([harness.native]); await settle();
    expect(request).not.toHaveBeenCalled();
    expect(harness.call).not.toHaveBeenCalled();
    expect(harness.ready).not.toHaveBeenCalled();
  });

  it("revokes an ended activity while registration is in flight", async () => {
    const registration = deferred<Response>();
    request.mockImplementationOnce(() => registration.promise);
    mount(); await settle();
    harness.onToken?.({ activityId: "activity-1", ended: true });
    registration.resolve(registered()); await settle();
    expect(harness.saved?.records[0]?.ended).toBe(true);
    expect(request.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
    expect(harness.call.mock.calls.some(([method]) => method === "liveActivities.subscribe")).toBe(false);
    expect(harness.ready).not.toHaveBeenCalled();
  });

  it("does not mark the activity ready after it ends during host handoff", async () => {
    const host = deferred<{ ok: boolean }>();
    harness.call.mockReturnValueOnce(host.promise);
    mount(); await settle();
    harness.onToken?.({ activityId: "activity-1", ended: true });
    host.resolve({ ok: true }); await settle();
    expect(harness.ready).not.toHaveBeenCalled();
    expect(harness.call).toHaveBeenCalledWith("liveActivities.unsubscribe", { activityId: "activity-1" });
  });

  it("cannot restore a registration after the account signs out", async () => {
    const registration = deferred<Response>();
    request.mockImplementationOnce(() => registration.promise);
    mount(); await settle();
    harness.owner = undefined; mount();
    registration.resolve(registered()); await settle();
    expect(harness.saved).toBeFalsy();
    expect(harness.end).toHaveBeenCalledOnce();
    expect(harness.call.mock.calls.some(([method]) => method === "liveActivities.subscribe")).toBe(false);
    expect(harness.ready).not.toHaveBeenCalled();
  });

  it("leaves public builds independent of the service", async () => {
    harness.serviceUrl = "";
    mount(); await settle();
    expect(harness.getNative).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(harness.onToken).toBeUndefined();
  });

  it("retries a lost Host handoff without repeating account registration", async () => {
    harness.call.mockRejectedValueOnce(new Error("socket disconnected"));
    mount(); await settle();
    expect(harness.ready).not.toHaveBeenCalled();
    harness.onOnline?.(); await settle();
    expect(request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(harness.call).toHaveBeenCalledTimes(2);
    expect(harness.ready).toHaveBeenCalledWith("activity-1");
  });

  it("repairs a missing Host subscription while the same native activity remains open", async () => {
    mount(); await settle();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(harness.call).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("preserves computer A while registering B and hands each grant only to its own host", async () => {
    mount(); await settle();
    const first = { ...harness.native };
    harness.computerKey = "computer-2";
    harness.native = { activityId: "activity-2", computerKey: "computer-2", token: "cd".repeat(32) };
    harness.getNative.mockImplementation(async () => [first, harness.native]);
    mount(); await settle();
    expect(harness.saved?.records.map((record) => record.activityId).sort()).toEqual(["activity-1", "activity-2"]);
    expect(request.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    expect(harness.call.mock.calls.filter(([method]) => method === "liveActivities.subscribe").map(([, data]) => data.computerKey)).toEqual(["computer-1", "computer-2"]);
    expect(harness.end).not.toHaveBeenCalled();
  });

  it("continues registering B when background A's token refresh throws", async () => {
    mount(); await settle();
    const first = { ...harness.native, token: "ef".repeat(32) };
    harness.computerKey = "computer-2";
    harness.native = { activityId: "activity-2", computerKey: "computer-2", token: "cd".repeat(32) };
    harness.getNative.mockImplementation(async () => [first, harness.native]);
    request.mockRejectedValueOnce(new Error("network unavailable"));
    mount(); await settle();
    expect(harness.saved?.records.find((record) => record.activityId === "activity-2")).toBeDefined();
    expect(harness.ready).toHaveBeenCalledWith("activity-2");
  });

  it("rotates a background computer's token without forwarding its grant to the current host", async () => {
    mount(); await settle();
    const grant = harness.saved?.records[0]?.grant;
    harness.computerKey = "computer-2";
    harness.native.token = "cd".repeat(32);
    mount(); await settle();
    expect(request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(2);
    expect(harness.saved?.records[0]?.grant).toBe(grant);
    expect(harness.call).toHaveBeenCalledTimes(1);
  });

  it("ending a background activity cannot revoke the foreground computer's registration", async () => {
    mount(); await settle();
    const first = { ...harness.native };
    harness.computerKey = "computer-2";
    harness.native = { activityId: "activity-2", computerKey: "computer-2", token: "cd".repeat(32) };
    harness.getNative.mockImplementation(async () => [first, harness.native]);
    mount(); await settle();
    harness.onToken?.({ activityId: "activity-1", ended: true }); await settle();
    expect(harness.saved?.records.find((record) => record.activityId === "activity-2")?.ended).not.toBe(true);
    expect(harness.call.mock.calls.filter(([method]) => method === "liveActivities.unsubscribe")).toHaveLength(0);
    expect(request.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => url)).toEqual(["https://push.itool.tech/v1/activities/activity-1"]);
  });

  it("signing out revokes all computers, not only the selected one", async () => {
    mount(); await settle();
    const first = { ...harness.native };
    harness.computerKey = "computer-2";
    harness.native = { activityId: "activity-2", computerKey: "computer-2", token: "cd".repeat(32) };
    harness.getNative.mockImplementation(async () => [first, harness.native]);
    mount(); await settle();
    harness.owner = undefined; mount(); await settle();
    expect(harness.saved).toBeNull();
    expect(request.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
    expect(harness.end).toHaveBeenCalledOnce();
  });
});
