import { describe, expect, it } from "vitest";
import {
  buildWatchSnapshot,
  isWatchCommandCurrent,
  watchCommandSchema,
  watchSnapshotContent,
  watchSnapshotSchema,
  type WatchCommand,
} from "../src/watch.js";
import type { PendingPermissionSummary, SessionSummary, TerminalInfo } from "../src/model.js";

const baseSession: SessionSummary = {
  id: "codex:s-1",
  nativeId: "s-1",
  agent: "codex",
  cwd: "/Users/dev/LinkShell",
  state: "running",
  title: "实现 Apple Watch 支持",
  archived: false,
  createdAt: 1000,
  updatedAt: 2000,
  lastSeq: 10,
  pendingPermissions: 0,
};

const permission: PendingPermissionSummary = {
  requestId: "req-1",
  title: "允许运行测试命令？",
  tool: { title: "`export CI=1 && pnpm test`", kind: "execute" },
  options: [
    { optionId: "decline", name: "Deny", kind: "reject_once" },
    { optionId: "accept", name: "Allow", kind: "allow_once" },
    { optionId: "acceptForSession", name: "Allow for session", kind: "allow_always" },
  ],
};

describe("Watch snapshot builder & command contract", () => {
  it("prioritizes waiting sessions ahead of failed, running, and idle sessions", () => {
    const idle: SessionSummary = { ...baseSession, id: "codex:idle", state: "idle", updatedAt: 9000, preview: "已完成构建" };
    const running: SessionSummary = { ...baseSession, id: "codex:run", state: "running", updatedAt: 8000, activity: { kind: "tool", title: "pnpm test", toolKind: "execute" } };
    const failed: SessionSummary = { ...baseSession, id: "claude:err", agent: "claude", state: "error", updatedAt: 7000, preview: "Type error in watch.ts" };
    const waiting: SessionSummary = { ...baseSession, id: "claude:wait", agent: "claude", state: "waiting", updatedAt: 1000, pendingPermissions: 1, permission };
    const terminal: TerminalInfo = { id: "term-1", title: "vitest", command: "pnpm test", cwd: "/Users/dev/LinkShell", cols: 80, rows: 24, createdAt: 1, activeAt: 5000 };
    const exitedTerminal: TerminalInfo = { id: "term-2", title: "build", command: "pnpm build", cwd: "/Users/dev/LinkShell", cols: 80, rows: 24, createdAt: 1, activeAt: 4000, exitCode: 0 };

    const snapshot = buildWatchSnapshot("MacBook Pro", [idle, running, failed, waiting], [terminal, exitedTerminal], true, {
      computerKey: "relay:mac-1",
      pinnedSessionIds: ["codex:idle"],
      goals: { "codex:run": { status: "active", objective: "保持所有测试通过" } },
      plans: { "codex:run": { completed: 3, total: 4, currentStep: "运行集成测试与真机校验" } },
    });

    expect(watchSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.waitingCount).toBe(1);
    expect(snapshot.runningCount).toBe(2);
    expect(snapshot.failedCount).toBe(1);
    expect(snapshot.completedCount).toBe(1);
    expect(snapshot.statusLabel).toBe("1 项等待你的确认");
    expect(snapshot.sessions.map((s) => s.id)).toEqual(["claude:wait", "claude:err", "codex:run", "codex:idle"]);

    const waitItem = snapshot.sessions[0]!;
    expect(waitItem.phase).toBe("waiting_for_approval");
    expect(waitItem.promptTitle).toBe("允许运行测试命令？");
    expect(waitItem.commandPreview).toBe("pnpm test");
    expect(waitItem.actions?.map((a) => a.optionId)).toEqual(["decline", "accept", "acceptForSession"]);

    const runItem = snapshot.sessions[2]!;
    expect(runItem.goal).toBe("保持所有测试通过");
    expect(runItem.planProgress).toEqual({
      completed: 3,
      total: 4,
      currentStep: "运行集成测试与真机校验",
    });
    expect(runItem.canCancel).toBe(true);
    expect(runItem.canSend).toBe(true);
    expect(snapshot.terminals[0]?.phase).toBe("running");
    expect(snapshot.terminals[1]?.exitCode).toBe(0);
  });

  it("Reflects desktop handoff state andwithholds direct approval buttons until takeover", () => {
    const desktopWaiting: SessionSummary = {
      ...baseSession,
      id: "claude:desktop-1",
      agent: "claude",
      driver: "desktop",
      state: "waiting",
      pendingPermissions: 1,
      permission,
    };
    const remoteSession: SessionSummary = {
      ...baseSession,
      id: "claude:remote-1",
      agent: "claude",
      driver: "remote",
      state: "running",
    };

    const snapshot = buildWatchSnapshot("Mac", [desktopWaiting, remoteSession], [], true, {
      computerKey: "computer-1",
      agentTiers: { claude: "handoff" },
    });

    const first = snapshot.sessions.find((s) => s.id === "claude:desktop-1")!;
    expect(first.handoff).toBe("can_takeover");
    expect(first.canSend).toBe(false);
    expect(first.actions).toBeUndefined();
    expect(first.hasMoreActions).toBe(true);

    const second = snapshot.sessions.find((s) => s.id === "claude:remote-1")!;
    expect(second.handoff).toBe("can_release");
    expect(second.canSend).toBe(true);
  });

  it("validates Watch commands against live computer and session state", () => {
    const waiting: SessionSummary = {
      ...baseSession,
      state: "waiting",
      pendingPermissions: 1,
      permission,
    };
    const snapshot = buildWatchSnapshot("Mac", [waiting], [], true, { computerKey: "computer-1" });
    const allowAction = snapshot.sessions[0]!.actions!.find((a) => a.optionId === "accept")!;

    const actionCmd: WatchCommand = { id: "cmd-1", kind: "action", action: allowAction };
    expect(watchCommandSchema.safeParse(actionCmd).success).toBe(true);
    expect(isWatchCommandCurrent(actionCmd, "computer-1", waiting)).toBe(true);
    expect(isWatchCommandCurrent(actionCmd, "computer-2", waiting)).toBe(false);
    expect(isWatchCommandCurrent(actionCmd, "computer-1", { ...waiting, driver: "desktop" })).toBe(false);
    expect(isWatchCommandCurrent(actionCmd, "computer-1", { ...waiting, permission: undefined })).toBe(false);

    const promptCmd: WatchCommand = {
      id: "cmd-2",
      kind: "prompt",
      computerKey: "computer-1",
      sessionId: waiting.id,
      text: "请继续执行并运行测试",
      now: true,
    };
    expect(isWatchCommandCurrent(promptCmd, "computer-1", waiting)).toBe(true);
    expect(isWatchCommandCurrent({ ...promptCmd, text: "   " }, "computer-1", waiting)).toBe(false);
    expect(isWatchCommandCurrent(promptCmd, "computer-1", { ...waiting, driver: "desktop" })).toBe(false);

    const cancelCmd: WatchCommand = {
      id: "cmd-3",
      kind: "cancel",
      computerKey: "computer-1",
      sessionId: waiting.id,
    };
    expect(isWatchCommandCurrent(cancelCmd, "computer-1", waiting)).toBe(true);
    expect(isWatchCommandCurrent(cancelCmd, "computer-1", { ...waiting, state: "idle" })).toBe(false);

    const takeoverCmd: WatchCommand = {
      id: "cmd-4",
      kind: "takeover",
      computerKey: "computer-1",
      sessionId: waiting.id,
    };
    expect(isWatchCommandCurrent(takeoverCmd, "computer-1", { ...waiting, driver: "desktop" })).toBe(true);
    expect(isWatchCommandCurrent(takeoverCmd, "computer-1", { ...waiting, driver: "remote" })).toBe(false);

    const releaseCmd: WatchCommand = {
      id: "cmd-5",
      kind: "release",
      computerKey: "computer-1",
      sessionId: waiting.id,
    };
    expect(isWatchCommandCurrent(releaseCmd, "computer-1", { ...waiting, driver: "remote" })).toBe(true);
    expect(isWatchCommandCurrent(releaseCmd, "computer-1", { ...waiting, driver: "desktop" })).toBe(false);
  });

  it("bounds oversized snapshots within WatchConnectivity's payload budget while keeping action IDs intact", () => {
    const manySessions: SessionSummary[] = Array.from({ length: 14 }, (_, index) => ({
      ...baseSession,
      id: `codex:session-${index}`,
      title: `超长任务标题-${"测试🧪".repeat(40)}`,
      preview: `这是一段很长的输出预览-${"内容".repeat(120)}`,
      state: index === 0 ? "waiting" : "running",
      pendingPermissions: index === 0 ? 1 : 0,
      permission: index === 0 ? permission : undefined,
      updatedAt: 5000 - index,
    }));
    const manyTerminals: TerminalInfo[] = Array.from({ length: 10 }, (_, index) => ({
      id: `term-${index}`,
      title: "node",
      command: `node scripts/long-command-${"x".repeat(100)}.mjs`,
      cwd: "/Users/dev/LinkShell",
      cols: 80,
      rows: 24,
      createdAt: 1,
      activeAt: 3000 - index,
    }));

    const snapshot = watchSnapshotContent(
      buildWatchSnapshot("MacBook Pro", manySessions, manyTerminals, true, { computerKey: "computer-1" }),
    );
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
    expect(bytes).toBeLessThanOrEqual(24_000);
    expect(snapshot.sessions[0]!.actions?.map((a) => a.optionId)).toEqual(["decline", "accept", "acceptForSession"]);
  });

  it("includes session timeline items, terminal output previews, available agents, workspaces, and validates new WatchCommand variants", () => {
    const terminal: TerminalInfo = {
      id: "term-live",
      title: "zsh",
      command: "pnpm test",
      cwd: "/Users/dev/LinkShell",
      cols: 80,
      rows: 24,
      createdAt: 1,
      activeAt: 5000,
    };
    const snapshot = buildWatchSnapshot("Mac Studio", [baseSession], [terminal], true, {
      computerKey: "computer-1",
      timelines: {
        [baseSession.id]: [
          { id: "u-1", kind: "user", title: "你", text: "请检查项目状态并运行测试" },
          { id: "t-1", kind: "tool", title: "执行命令", text: "pnpm test", detail: "53 passed", status: "completed" },
          { id: "a-1", kind: "assistant", title: "Agent", text: "全部测试已通过。" },
        ],
      },
      terminalOutputs: {
        "term-live": "$ pnpm test\n✓ test/watch.test.ts (5 tests)",
      },
      availableAgents: ["codex", "claude", "gemini"],
      workspaces: [{ path: "/Users/dev/LinkShell", name: "LinkShell" }],
    });

    expect(watchSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.availableAgents).toEqual(["codex", "claude", "gemini"]);
    expect(snapshot.workspaces).toEqual([{ path: "/Users/dev/LinkShell", name: "LinkShell" }]);
    expect(snapshot.sessions[0]?.project).toBe("LinkShell");
    expect(snapshot.sessions[0]?.cwd).toBe("/Users/dev/LinkShell");
    expect(snapshot.sessions[0]?.items).toHaveLength(3);
    expect(snapshot.sessions[0]?.items?.[1]?.text).toBe("pnpm test");
    expect(snapshot.terminals[0]?.outputPreview).toContain("✓ test/watch.test.ts");

    const createSessionCmd: WatchCommand = {
      id: "cmd-create-s",
      kind: "create-session",
      computerKey: "computer-1",
      agent: "codex",
      cwd: "/Users/dev/LinkShell",
      prompt: "检查 git status",
    };
    expect(watchCommandSchema.safeParse(createSessionCmd).success).toBe(true);
    expect(isWatchCommandCurrent(createSessionCmd, "computer-1")).toBe(true);
    expect(isWatchCommandCurrent(createSessionCmd, "computer-2")).toBe(false);

    const termInputCmd: WatchCommand = {
      id: "cmd-term-in",
      kind: "terminal-input",
      computerKey: "computer-1",
      terminalId: "term-live",
      data: "git status\n",
    };
    expect(watchCommandSchema.safeParse(termInputCmd).success).toBe(true);
    expect(isWatchCommandCurrent(termInputCmd, "computer-1")).toBe(true);

    const loadEarlierCmd: WatchCommand = {
      id: "cmd-load-earlier",
      kind: "load-earlier",
      computerKey: "computer-1",
      sessionId: baseSession.id,
    };
    expect(watchCommandSchema.safeParse(loadEarlierCmd).success).toBe(true);
    expect(isWatchCommandCurrent(loadEarlierCmd, "computer-1")).toBe(true);
    expect(isWatchCommandCurrent(loadEarlierCmd, "computer-2")).toBe(false);

    const longTimeline = Array.from({ length: 24 }, (_, idx) => ({
      id: `item-${idx}`,
      kind: (idx % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      title: idx % 2 === 0 ? "你" : "Agent",
      text: `消息 #${idx}`,
    }));
    const defaultSnap = buildWatchSnapshot("Mac Studio", [baseSession], [], true, {
      computerKey: "computer-1",
      timelines: { [baseSession.id]: longTimeline },
    });
    expect(defaultSnap.sessions[0]?.items).toHaveLength(14);
    expect(defaultSnap.sessions[0]?.hasEarlier).toBe(true);

    const expandedSnap = buildWatchSnapshot("Mac Studio", [baseSession], [], true, {
      computerKey: "computer-1",
      timelines: { [baseSession.id]: longTimeline },
      itemLimits: { [baseSession.id]: 30 },
    });
    expect(expandedSnap.sessions[0]?.items).toHaveLength(24);
    expect(expandedSnap.sessions[0]?.hasEarlier).toBeUndefined();
  });
});


