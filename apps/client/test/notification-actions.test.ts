import type { SessionSummary } from "@linkshell/wire";
import { describe, expect, it, vi } from "vitest";
import type { LocalApprovalNotificationPayload, NativeNotificationAction } from "../modules/link-layout";

vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync: vi.fn() },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock("../modules/link-layout", () => ({
  setNativeShortcutItems: vi.fn(() => Promise.resolve()),
  syncNativeLiveActivity: vi.fn(() => Promise.resolve(true)),
}));

const attention = await import("../src/lib/session-attention");

const baseSession: SessionSummary = {
  id: "s1",
  nativeId: "n1",
  agent: "codex",
  title: "修复登录问题",
  cwd: "/repo/app",
  state: "idle",
  archived: false,
  createdAt: 1000,
  updatedAt: 2000,
  lastSeq: 1,
  pendingPermissions: 0,
};

const approvalSession: SessionSummary = {
  ...baseSession,
  state: "waiting",
  pendingPermissions: 1,
  permission: {
    requestId: "req-1",
    title: "允许执行 rm -rf build？",
    options: [
      { optionId: "decline", name: "Deny", kind: "reject_once" },
      { optionId: "accept", name: "Allow", kind: "allow_once" },
    ],
  },
};

describe("notification actions, Android foreground guard, & iOS local approval fallback", () => {
  it("builds Android notification payload with Approve/Deny and foregroundService=true for waiting approval", () => {
    const payload = attention.buildAndroidStatusPayload({
      computerName: "Studio Mac",
      computerKey: "comp-1",
      sessions: [approvalSession],
      terminals: [],
      online: true,
    });

    expect(payload.active).toBe(true);
    expect(payload.urgent).toBe(true);
    expect(payload.ongoing).toBe(false);
    expect(payload.foregroundService).toBe(true);
    expect(payload.actions).toEqual([
      expect.objectContaining({
        kind: "approve",
        label: "允许",
        computerKey: "comp-1",
        sessionId: "s1",
        requestId: "req-1",
        optionId: "accept",
      }),
      expect.objectContaining({
        kind: "deny",
        label: "拒绝",
        computerKey: "comp-1",
        sessionId: "s1",
        requestId: "req-1",
        optionId: "decline",
      }),
    ]);
  });

  it("builds Android notification payload with Cancel/Open while running and turns foregroundService off when idle", () => {
    const runningPayload = attention.buildAndroidStatusPayload({
      computerName: "Studio Mac",
      computerKey: "comp-1",
      sessions: [{ ...baseSession, state: "running", activity: { kind: "thinking" } }],
      terminals: [],
      online: true,
    });

    expect(runningPayload.active).toBe(true);
    expect(runningPayload.ongoing).toBe(true);
    expect(runningPayload.foregroundService).toBe(true);
    expect(runningPayload.actions?.map((a) => a.kind)).toEqual(["cancel", "open"]);

    const idlePayload = attention.buildAndroidStatusPayload({
      computerName: "Studio Mac",
      computerKey: "comp-1",
      sessions: [baseSession],
      terminals: [],
      online: true,
    });
    expect(idlePayload).toEqual({
      active: false,
      foregroundService: false,
      actions: [],
    });
  });

  it("triggers iOS local approval fallback when Live Activity is unavailable or disabled/rejected, and cancels on resolve", async () => {
    let available = false;
    let syncOk = false;
    const syncLocal = vi.fn(async (_payload: LocalApprovalNotificationPayload) => true);
    const cancelLocal = vi.fn(async (_id: string) => {});

    const scheduler = attention.createAttentionSyncScheduler({
      throttleMs: 0,
      setShortcuts: vi.fn(async () => {}),
      syncActivity: vi.fn(async () => syncOk),
      isLiveActivityAvailable: vi.fn(async () => available),
      syncLocalApproval: syncLocal,
      cancelLocalApproval: cancelLocal,
    });

    let currentSessions: SessionSummary[] = [approvalSession];
    scheduler.schedule(
      () => ({
        computerName: "Studio Mac",
        computerKey: "comp-1",
        sessions: currentSessions,
        terminals: [],
        online: true,
        pinned: [],
        enabled: true,
      }),
      { immediate: true },
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(syncLocal).toHaveBeenCalledTimes(1);
    expect(syncLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "approval:comp-1:s1:req-1",
        computerKey: "comp-1",
        sessionId: "s1",
        requestId: "req-1",
        approveOptionId: "accept",
        denyOptionId: "decline",
      }),
    );

    // Resolving the approval online cancels the local approval notification.
    currentSessions = [{ ...baseSession, state: "idle", updatedAt: 3000 }];
    scheduler.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelLocal).toHaveBeenCalledWith("approval:comp-1:s1:req-1");

    // Even if available=true, Live Activity rejection/disabled (syncActivity=false) still falls back locally,
    // and cancels if Live Activity later succeeds.
    syncLocal.mockClear();
    cancelLocal.mockClear();
    available = true;
    syncOk = false;
    currentSessions = [approvalSession];
    scheduler.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(syncLocal).toHaveBeenCalledTimes(1);

    syncOk = true;
    scheduler.flush({ foregroundReturn: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelLocal).toHaveBeenCalledWith("approval:comp-1:s1:req-1");
    scheduler.dispose();
  });

  it("drains and deduplicates native notification actions and resolves deepLink routes", async () => {
    const queue = ["act-1", "act-2"];
    let listener: ((event: { id: string }) => void) | undefined;
    const actionsMap = new Map<string, NativeNotificationAction>([
      [
        "act-1",
        {
          id: "act-1",
          actionId: "approve:s1:req-1",
          kind: "approve",
          computerKey: "comp-1",
          sessionId: "s1",
          requestId: "req-1",
          optionId: "accept",
          createdAt: 1000,
        },
      ],
      [
        "act-2",
        {
          id: "act-2",
          actionId: "open:s2",
          kind: "open",
          computerKey: "comp-1",
          sessionId: "s2",
          deepLink: "linkshell:///activity?computer=comp-1&session=s2",
          createdAt: 1001,
        },
      ],
    ]);

    const executed: NativeNotificationAction[] = [];
    const coordinator = attention.createNotificationActionCoordinator({
      pendingId: async () => queue[0] ?? null,
      consume: async (id) => {
        const idx = queue.indexOf(id);
        if (idx >= 0) queue.splice(idx, 1);
        return actionsMap.get(id) ?? null;
      },
      subscribe: (cb) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      onExecute: (action) => {
        executed.push(action);
      },
    });

    await coordinator.drain();
    // Duplicate emission for already-consumed id must be ignored.
    listener?.({ id: "act-1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(executed.map((item) => item.id)).toEqual(["act-1", "act-2"]);
    expect(attention.resolveNotificationRoute(executed[1]!)).toEqual({
      pathname: "/activity",
      params: { computer: "comp-1", session: "s2" },
    });
    expect(
      attention.resolveNotificationRoute({
        sessionId: "s9",
        deepLink: "linkshell:///session/s9",
      }),
    ).toEqual({
      pathname: "/session/[id]",
      params: { id: "s9" },
    });

    coordinator.dispose();
  });
});
