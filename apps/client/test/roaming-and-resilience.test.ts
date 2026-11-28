/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SessionSummary } from "@linkshell/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeSocketHarness = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const connect = vi.fn();
  const send = vi.fn();
  const close = vi.fn();
  return {
    connect,
    send,
    close,
    emit(name: string, event: any) {
      for (const listener of listeners.get(name) ?? []) listener(event);
    },
    reset() {
      connect.mockReset();
      send.mockReset();
      close.mockReset();
    },
    module: {
      connect,
      send,
      close,
      addListener(name: string, listener: (event: any) => void) {
        let set = listeners.get(name);
        if (!set) {
          set = new Set();
          listeners.set(name, set);
        }
        set.add(listener);
        return {
          remove: () => set!.delete(listener),
        };
      },
    },
  };
});

vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync: vi.fn() },
}));
vi.mock("../modules/link-socket/src", () => ({ LinkSocket: nativeSocketHarness.module }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock("expo-router", () => ({
  router: { push: vi.fn(), replace: vi.fn() },
  usePathname: () => "/",
  useRootNavigationState: () => ({ key: "root" }),
}));
vi.mock("@/lib/client", () => ({
  useActions: vi.fn(),
  useClient: vi.fn(),
  useConnection: vi.fn(),
  useConnectionStatus: vi.fn(),
}));
vi.mock("@/lib/computers", () => ({
  listComputers: vi.fn(() => []),
  reconnectRelays: vi.fn(),
  useComputers: Object.assign(vi.fn(), { getState: () => ({ select: vi.fn() }) }),
}));
vi.mock("../modules/link-layout", () => ({
  cancelNativeLocalApprovalNotification: vi.fn(() => Promise.resolve()),
  consumeNativeNotificationAction: vi.fn(() => Promise.resolve(null)),
  pendingNativeNotificationActionId: vi.fn(() => Promise.resolve(null)),
  restartNativeLanDiscovery: vi.fn(),
  setNativeShortcutItems: vi.fn(() => Promise.resolve()),
  subscribeNativeNetworkPathChange: vi.fn(() => () => {}),
  subscribeNativeNotificationActions: vi.fn(() => () => {}),
  syncNativeLiveActivity: vi.fn(() => Promise.resolve(true)),
}));

const {
  bindNetworkPathSupport,
  createSocket,
  restartLanDiscovery,
  subscribeNetworkPathChange,
} = await import("../src/lib/socket");
const { dispatchNotificationAction } = await import("../src/components/notification-action-sync");

describe("NativeSocket close race guard & OS network-path roaming hooks", () => {
  beforeEach(() => {
    nativeSocketHarness.reset();
  });

  it("ignores a late native onOpen event after close() was already called on a connecting socket", () => {
    const socket = createSocket("ws://192.168.1.50:7878");
    expect(nativeSocketHarness.connect).toHaveBeenCalledTimes(1);
    const [socketId] = nativeSocketHarness.connect.mock.calls[0]!;

    const onOpen = vi.fn();
    const onMessage = vi.fn();
    socket.onopen = onOpen;
    socket.onmessage = onMessage;

    expect(socket.readyState).toBe(0); // CONNECTING
    socket.close();
    expect(socket.readyState).toBe(2); // CLOSING
    expect(nativeSocketHarness.close).toHaveBeenCalledWith(socketId, 1000, "");

    // Simulate a late native onOpen racing with close().
    nativeSocketHarness.emit("onOpen", { id: socketId });
    expect(socket.readyState).toBe(2);
    expect(onOpen).not.toHaveBeenCalled();

    // Late message after close() is also dropped.
    nativeSocketHarness.emit("onMessage", { id: socketId, data: "late" });
    expect(onMessage).not.toHaveBeenCalled();

    // Native close completes transition to CLOSED.
    nativeSocketHarness.emit("onClose", { id: socketId, code: 1000, reason: "" });
    expect(socket.readyState).toBe(3);
  });

  it("subscribes to iOS NWPathMonitor events and delegates Android fallback + LAN restart bindings cleanly", () => {
    const received: Array<{ status: string; interface: string }> = [];
    const unsub = subscribeNetworkPathChange((ev) => {
      received.push({ status: ev.status, interface: ev.interface });
    });

    nativeSocketHarness.emit("onNetworkPathChange", {
      status: "satisfied",
      interface: "cellular",
      isExpensive: true,
      isConstrained: false,
    });
    expect(received).toEqual([{ status: "satisfied", interface: "cellular" }]);
    unsub();

    // Verify restartLanDiscovery delegates to bound native hook.
    const restartMock = vi.fn();
    bindNetworkPathSupport({ restartLanDiscovery: restartMock });
    restartLanDiscovery();
    expect(restartMock).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchNotificationAction live state validation", () => {
  const waitingSession: SessionSummary = {
    id: "s-1",
    nativeId: "n-1",
    agent: "codex",
    title: "修复编译",
    cwd: "/repo",
    state: "waiting",
    archived: false,
    createdAt: 100,
    updatedAt: 200,
    lastSeq: 5,
    pendingPermissions: 1,
    permission: {
      requestId: "req-live",
      title: "允许运行 pnpm test？",
      options: [
        { optionId: "allow_once", name: "允许", kind: "allow_once" },
        { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
      ],
    },
  };

  it("dispatches approve/deny only when requestId and optionId still match live session state", async () => {
    const respond = vi.fn(() => Promise.resolve());
    const cancel = vi.fn(() => Promise.resolve());
    const navigate = vi.fn();
    const ctx = {
      computerKey: "comp-1",
      actions: { respond, cancel },
      sessions: { "s-1": waitingSession },
      views: {},
    };

    // Current permission request -> executes respond cleanly.
    const ok = await dispatchNotificationAction(
      {
        id: "a-1",
        actionId: "approve:s-1:req-live",
        kind: "approve",
        computerKey: "comp-1",
        sessionId: "s-1",
        requestId: "req-live",
        optionId: "allow_once",
        createdAt: Date.now(),
      },
      ctx,
      navigate,
    );
    expect(ok).toBe(true);
    expect(respond).toHaveBeenCalledWith("s-1", "req-live", "allow_once");
    expect(navigate).not.toHaveBeenCalled();

    // Stale requestId -> refuses to call respond and navigates to session instead.
    respond.mockClear();
    const stale = await dispatchNotificationAction(
      {
        id: "a-2",
        actionId: "approve:s-1:req-old",
        kind: "approve",
        computerKey: "comp-1",
        sessionId: "s-1",
        requestId: "req-old",
        optionId: "allow_once",
        createdAt: Date.now(),
      },
      ctx,
      navigate,
    );
    expect(stale).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);

    // Mismatched optionId -> also refused cleanly.
    navigate.mockClear();
    const wrongOption = await dispatchNotificationAction(
      {
        id: "a-3",
        actionId: "approve:s-1:req-live",
        kind: "approve",
        computerKey: "comp-1",
        sessionId: "s-1",
        requestId: "req-live",
        optionId: "nonexistent_option",
        createdAt: Date.now(),
      },
      ctx,
      navigate,
    );
    expect(wrongOption).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("skips cancel when session is already idle and cancels when running", async () => {
    const respond = vi.fn(() => Promise.resolve());
    const cancel = vi.fn(() => Promise.resolve());
    const navigate = vi.fn();

    const idleRes = await dispatchNotificationAction(
      {
        id: "c-1",
        actionId: "cancel:s-1",
        kind: "cancel",
        computerKey: "comp-1",
        sessionId: "s-1",
        createdAt: Date.now(),
      },
      {
        computerKey: "comp-1",
        actions: { respond, cancel },
        sessions: { "s-1": { ...waitingSession, state: "idle", pendingPermissions: 0, permission: undefined } },
        views: {},
      },
      navigate,
    );
    expect(idleRes).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);

    navigate.mockClear();
    const runningRes = await dispatchNotificationAction(
      {
        id: "c-2",
        actionId: "cancel:s-1",
        kind: "cancel",
        computerKey: "comp-1",
        sessionId: "s-1",
        createdAt: Date.now(),
      },
      {
        computerKey: "comp-1",
        actions: { respond, cancel },
        sessions: { "s-1": { ...waitingSession, state: "running", pendingPermissions: 0, permission: undefined } },
        views: {},
      },
      navigate,
    );
    expect(runningRes).toBe(true);
    expect(cancel).toHaveBeenCalledWith("s-1");
    expect(navigate).not.toHaveBeenCalled();
  });
});
