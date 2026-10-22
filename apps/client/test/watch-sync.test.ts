import type { PendingPermissionSummary, SessionSummary, TerminalInfo, WatchCommand } from "@linkshell/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  appState: "active",
  onChange: undefined as undefined | ((state: string) => void),
  removeAppState: vi.fn(),
  syncWatch: vi.fn(() => Promise.resolve()),
  pendingId: vi.fn<() => Promise<string | null>>(() => Promise.resolve(null)),
  consumeCmd: vi.fn<(id: string) => Promise<WatchCommand | null>>(() => Promise.resolve(null)),
  completeCmd: vi.fn(() => Promise.resolve()),
  onWatchCmd: undefined as undefined | ((event: { id: string }) => void),
  removeWatchCmd: vi.fn(),
}));

vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useState: <T>(initial: T) => [initial, vi.fn()],
  useMemo: <T>(fn: () => T) => fn(),
  useRef: <T>(initial: T) => ({ current: initial }),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("expo-sqlite/kv-store", () => ({ default: { getItemSync: () => null, setItemSync: vi.fn() } }));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    get currentState() {
      return harness.appState;
    },
    addEventListener: (_name: string, callback: (state: string) => void) => {
      harness.onChange = callback;
      return { remove: harness.removeAppState };
    },
  },
}));

vi.mock("../src/lib/client", () => ({
  useConnection: vi.fn(() => ({
    link: { call: vi.fn(() => Promise.resolve({})) },
  })),
}));

vi.mock("../modules/link-layout", () => ({
  WatchCommandRejected: class WatchCommandRejected extends Error {},
  syncNativeWatchSnapshot: harness.syncWatch,
  pendingNativeWatchCommandId: harness.pendingId,
  consumeNativeWatchCommand: harness.consumeCmd,
  completeNativeWatchCommand: harness.completeCmd,
  subscribeNativeWatchCommands: (listener: (event: { id: string }) => void) => {
    harness.onWatchCmd = listener;
    return () => harness.removeWatchCmd();
  },
  getNativeWatchStatus: () =>
    Promise.resolve({ supported: true, paired: true, installed: true, reachable: true }),
  subscribeNativeWatchStatus: () => () => {},
}));

const {
  buildClientWatchSnapshot,
  createWatchSnapshotScheduler,
  executeWatchCommand,
  extractWatchTimelineItems,
  stripTerminalAnsi,
  useIOSWatchSync,
  waitForLinkOnline,
} = await import("../src/lib/watch-sync");
const { WatchCommandRejected } = await import("../modules/link-layout");
const { holdTerminal } = await import("../src/lib/terminal-attach");

const permission: PendingPermissionSummary = {
  requestId: "req-42",
  title: "允许执行 bash `pnpm test`？",
  options: [
    { optionId: "allow_once", name: "Allow", kind: "allow_once" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ],
};

const waitingSession: SessionSummary = {
  id: "s-wait",
  nativeId: "n-wait",
  agent: "claude",
  title: "重构 Apple Watch 桥接层",
  cwd: "/Users/test/claude-remote",
  state: "waiting",
  archived: false,
  createdAt: 1000,
  updatedAt: 3000,
  lastSeq: 5,
  pendingPermissions: 1,
  permission,
};

const runningSession: SessionSummary = {
  id: "s-run",
  nativeId: "n-run",
  agent: "codex",
  title: "验证编译与单测",
  cwd: "/Users/test/claude-remote",
  state: "running",
  archived: false,
  createdAt: 1000,
  updatedAt: 2000,
  lastSeq: 3,
  pendingPermissions: 0,
  activity: { kind: "tool", title: "pnpm test" },
};

const terminal: TerminalInfo = {
  id: "term-1",
  title: "pnpm",
  command: "pnpm test",
  cwd: "/Users/test/claude-remote",
  cols: 80,
  rows: 24,
  createdAt: 100,
  activeAt: 2500,
};

function makeActions() {
  return {
    respond: vi.fn(() => Promise.resolve()),
    answer: vi.fn(() => Promise.resolve()),
    answerAsync: vi.fn(() => Promise.resolve()),
    send: vi.fn(() => Promise.resolve("started" as const)),
    cancel: vi.fn(() => Promise.resolve()),
    takeover: vi.fn(() => Promise.resolve()),
    release: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
    openSession: vi.fn(),
    createSession: vi.fn(() => Promise.resolve({ ...runningSession, id: "s-new" })),
  };
}

describe("Apple Watch client synchronization & command execution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    harness.effects = [];
    harness.appState = "active";
    harness.pendingId.mockResolvedValue(null);
    harness.consumeCmd.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a complete WatchSnapshot with priority ordering, plan progress, and actions", () => {
    const snapshot = buildClientWatchSnapshot({
      computerKey: "mac-1",
      computerName: "Studio Mac",
      online: true,
      sessions: [runningSession, waitingSession],
      terminals: [terminal],
      views: {
        "s-run": {
          sessionId: "s-run",
          lastSeq: 3,
          startSeq: 0,
          items: [
            {
              kind: "plan",
              id: "plan-1",
              ts: 2000,
              entries: [
                { content: "实现协议", priority: "high", status: "completed" },
                { content: "编写测试", priority: "high", status: "completed" },
                { content: "模拟器验证", priority: "high", status: "in_progress" },
              ],
            },
          ],
          index: { "plan-1": 0 },
          planId: "plan-1",
          permissions: [],
          config: [],
          commands: [],
          state: "running",
          turnActive: true,
        },
      },
      computers: [{ key: "mac-1", name: "Studio Mac", online: true, selected: true }],
    });

    expect(snapshot.statusLabel).toBe("1 项等待你的确认");
    expect(snapshot.waitingCount).toBe(1);
    expect(snapshot.runningCount).toBe(2);
    expect(snapshot.terminals).toHaveLength(1);
    expect(snapshot.sessions[0]?.id).toBe("s-wait");
    expect(snapshot.sessions[0]?.phase).toBe("waiting_for_approval");
    expect(snapshot.sessions[0]?.actions?.map((a) => a.optionId)).toEqual(["reject_once", "allow_once"]);
    expect(snapshot.sessions[1]?.id).toBe("s-run");
    expect(snapshot.sessions[1]?.planProgress).toEqual({
      completed: 2,
      total: 3,
      currentStep: "模拟器验证",
    });
  });

  it("offers only the settings the agent reported, never guessed models or modes", () => {
    const view = (config: NonNullable<Parameters<typeof buildClientWatchSnapshot>[0]["views"]>[string]["config"]) => ({
      sessionId: "s-run", lastSeq: 0, startSeq: 0, items: [], index: {}, permissions: [], config, commands: [],
      state: "running" as const, turnActive: true,
    });
    const reported = [{ id: "model", name: "模型", category: "model" as const, current: "m-2", values: [{ value: "m-1", name: "M1" }, { value: "m-2", name: "M2" }] }];
    const snapshot = buildClientWatchSnapshot({
      computerKey: "mac-1", computerName: "Studio Mac", online: true,
      sessions: [runningSession, waitingSession], terminals: [],
      // s-wait has no view at all, s-run an empty list: neither may get invented options.
      views: { "s-run": view([]) },
      computers: [],
    });
    for (const session of snapshot.sessions) {
      expect(session.configOptions ?? []).toEqual([]);
      expect(session.mode).toBeUndefined();
    }
    const withConfig = buildClientWatchSnapshot({
      computerKey: "mac-1", computerName: "Studio Mac", online: true,
      sessions: [runningSession], terminals: [], views: { "s-run": view(reported) }, computers: [],
    });
    expect(withConfig.sessions[0]?.configOptions).toEqual([
      { id: "model", name: "模型", category: "model", current: "m-2", currentLabel: "M2", values: [{ value: "m-1", name: "M1" }, { value: "m-2", name: "M2" }] },
    ]);
  });

  it("executes permission, prompt, takeover, cancel, and computer switch commands with live validation", async () => {
    const actions = makeActions();
    const selectComputer = vi.fn();
    const snapshot = buildClientWatchSnapshot({
      computerKey: "mac-1",
      computerName: "Studio Mac",
      online: true,
      sessions: [waitingSession, runningSession],
      terminals: [],
    });

    const allowAction = snapshot.sessions[0]!.actions!.find((a) => a.optionId === "allow_once")!;
    const desktopSession: SessionSummary = { ...runningSession, id: "s-desk", driver: "desktop" };
    const ctx = {
      computerKey: "mac-1",
      online: true,
      sessions: {
        "s-wait": waitingSession,
        "s-run": runningSession,
        "s-desk": desktopSession,
      },
      computers: [
        { key: "mac-1", name: "Studio Mac", online: true, selected: true },
        { key: "mac-2", name: "MacBook Air", online: true, selected: false },
      ],
      selectComputer,
      actions,
    };

    const resPerm = await executeWatchCommand(
      { id: "c1", kind: "action", action: allowAction },
      ctx,
    );
    expect(resPerm.ok).toBe(true);
    expect(actions.respond).toHaveBeenCalledWith("s-wait", "req-42", "allow_once");

    const resPrompt = await executeWatchCommand(
      { id: "c2", kind: "prompt", computerKey: "mac-1", sessionId: "s-run", text: "  继续推进  " },
      ctx,
    );
    expect(resPrompt.ok).toBe(true);
    expect(actions.send).toHaveBeenCalledWith("s-run", [{ type: "text", text: "继续推进" }], { now: undefined, clientMessageId: "c2" });

    const blockedPrompt = await executeWatchCommand(
      { id: "c3", kind: "prompt", computerKey: "mac-1", sessionId: "s-desk", text: "继续" },
      ctx,
    );
    expect(blockedPrompt.ok).toBe(false);

    const resTakeover = await executeWatchCommand(
      { id: "c4", kind: "takeover", computerKey: "mac-1", sessionId: "s-desk" },
      ctx,
    );
    expect(resTakeover.ok).toBe(true);
    expect(actions.takeover).toHaveBeenCalledWith("s-desk");

    const resCancel = await executeWatchCommand(
      { id: "c5", kind: "cancel", computerKey: "mac-1", sessionId: "s-run" },
      ctx,
    );
    expect(resCancel.ok).toBe(true);
    expect(actions.cancel).toHaveBeenCalledWith("s-run");

    const resSwitch = await executeWatchCommand(
      { id: "c6", kind: "select-computer", computerKey: "mac-2" },
      ctx,
    );
    expect(resSwitch.ok).toBe(true);
    expect(selectComputer).toHaveBeenCalledWith("mac-2");

    const offlineRes = await executeWatchCommand(
      { id: "c7", kind: "cancel", computerKey: "mac-1", sessionId: "s-run" },
      { ...ctx, online: false },
    );
    expect(offlineRes.ok).toBe(false);
  });

  it("syncs snapshots and drains multiple queued native watch commands in FIFO order in useIOSWatchSync", async () => {
    const actions = makeActions();
    const queue: WatchCommand[] = [
      {
        id: "cmd-queued-1",
        kind: "prompt",
        computerKey: "mac-1",
        sessionId: "s-run",
        text: "第一步：运行测试",
      },
      {
        id: "cmd-queued-2",
        kind: "prompt",
        computerKey: "mac-1",
        sessionId: "s-run",
        text: "第二步：汇报结果",
      },
    ];
    harness.pendingId.mockImplementation(() => Promise.resolve(queue[0]?.id ?? null));
    harness.consumeCmd.mockImplementation((id: string) => {
      const idx = queue.findIndex((item) => item.id === id);
      if (idx === -1) return Promise.resolve(null);
      const [cmd] = queue.splice(idx, 1);
      return Promise.resolve(cmd ?? null);
    });

    useIOSWatchSync(
      {
        computerKey: "mac-1",
        computerName: "Studio Mac",
        sessions: [runningSession],
        terminals: [terminal],
        online: true,
      },
      {
        computerKey: "mac-1",
        online: true,
        sessions: { "s-run": runningSession },
        computers: [{ key: "mac-1", name: "Studio Mac", online: true, selected: true }],
        selectComputer: vi.fn(),
        actions,
      },
      true,
      undefined,
      true,
    );

    const cleanups = harness.effects
      .map((effect) => effect())
      .filter((cleanup): cleanup is () => void => typeof cleanup === "function");

    // Each reply waits briefly for the state the command produced before it goes out.
    await vi.advanceTimersByTimeAsync(1_200);

    expect(harness.syncWatch).toHaveBeenCalledTimes(1);
    expect(actions.send).toHaveBeenCalledTimes(2);
    expect(actions.send).toHaveBeenNthCalledWith(1, "s-run", [{ type: "text", text: "第一步：运行测试" }], { now: undefined, clientMessageId: "cmd-queued-1" });
    expect(actions.send).toHaveBeenNthCalledWith(2, "s-run", [{ type: "text", text: "第二步：汇报结果" }], { now: undefined, clientMessageId: "cmd-queued-2" });
    expect(harness.completeCmd).toHaveBeenNthCalledWith(1, "cmd-queued-1", true, "已发送给 Agent");
    expect(harness.completeCmd).toHaveBeenNthCalledWith(2, "cmd-queued-2", true, "已发送给 Agent");

    // The heartbeat doesn't resend unchanged content, until the watch would call it stale.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.syncWatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(harness.syncWatch).toHaveBeenCalledTimes(2);

    cleanups.forEach((cleanup) => cleanup());
    expect(harness.removeAppState).toHaveBeenCalledTimes(3);
    expect(harness.removeWatchCmd).toHaveBeenCalledOnce();
  });

  it("strips ANSI escapes, zsh backspace spinners, and private-use glyphs while extracting session timelines and executing new session/terminal commands", async () => {
    const rawTerm = "\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m\r\x1b[0m\x1b[27m\x1b[24m\x1b[J\uE0B0 ~/claude-remote $ g\x08git status -sb\r\n## main...origin/main\r\n10.28.2";
    expect(stripTerminalAnsi(rawTerm)).toBe("~/claude-remote $ git status -sb\n## main...origin/main\n10.28.2");

    const items = extractWatchTimelineItems({
      sessionId: "s-run",
      lastSeq: 5,
      startSeq: 0,
      items: [
        { kind: "user", id: "u-1", ts: 1000, blocks: [{ type: "text", text: "运行测试并检查状态" }] },
        { kind: "tool", id: "t-1", ts: 1100, name: "bash", title: "`pnpm test`", toolKind: "execute", status: "completed", output: "\x1b[32m✓ 54 passed\x1b[0m", locations: [], rawInput: {}, content: [] },
        { kind: "agent", id: "a-1", ts: 1200, text: "**测试已全部通过**，状态正常。", streaming: false },
      ],
      index: { "u-1": 0, "t-1": 1, "a-1": 2 },
      permissions: [],
      config: [],
      commands: [],
      state: "idle",
      turnActive: false,
    });
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: "user", title: "你", text: "运行测试并检查状态" });
    expect(items[1]).toMatchObject({ kind: "tool", title: "执行命令", text: "pnpm test", detail: "✓ 54 passed" });
    expect(items[2]).toMatchObject({ kind: "assistant", title: "Agent" });

    const actions = makeActions();
    const createTerminal = vi.fn(() => Promise.resolve({ ...terminal, id: "term-new" }));
    const openTerminal = vi.fn(() => Promise.resolve());
    const terminalInput = vi.fn(() => Promise.resolve());
    const closeTerminal = vi.fn(() => Promise.resolve());
    const ctx = {
      computerKey: "mac-1",
      online: true,
      sessions: { "s-run": runningSession },
      computers: [{ key: "mac-1", name: "Studio Mac", online: true, selected: true }],
      selectComputer: vi.fn(),
      actions,
      createTerminal,
      openTerminal,
      terminalInput,
      closeTerminal,
    };

    const createSessionRes = await executeWatchCommand(
      {
        id: "cs-1",
        kind: "create-session",
        computerKey: "mac-1",
        agent: "codex",
        cwd: "/Users/test/claude-remote",
        prompt: "检查项目状态",
      },
      ctx,
    );
    expect(createSessionRes.ok).toBe(true);
    expect(actions.createSession).toHaveBeenCalledWith({
      agent: "codex",
      cwd: "/Users/test/claude-remote",
      prompt: [{ type: "text", text: "检查项目状态" }],
    });
    expect(actions.openSession).toHaveBeenCalledWith("s-new");

    const createTermRes = await executeWatchCommand(
      {
        id: "ct-1",
        kind: "create-terminal",
        computerKey: "mac-1",
        cwd: "/Users/test/claude-remote",
        command: "git status -sb",
      },
      ctx,
    );
    expect(createTermRes.ok).toBe(true);
    expect(createTerminal).toHaveBeenCalledWith({
      cwd: "/Users/test/claude-remote",
      command: "git status -sb",
    });
    expect(openTerminal).toHaveBeenCalledWith("term-new");

    const termInputRes = await executeWatchCommand(
      {
        id: "ti-1",
        kind: "terminal-input",
        computerKey: "mac-1",
        terminalId: "term-new",
        data: "\u0003",
      },
      ctx,
    );
    expect(termInputRes.ok).toBe(true);
    expect(termInputRes.message).toBe("已发送中断 (Ctrl+C)");
    expect(terminalInput).toHaveBeenCalledWith("term-new", "\u0003");

    const closeTermRes = await executeWatchCommand(
      {
        id: "cl-1",
        kind: "close-terminal",
        computerKey: "mac-1",
        terminalId: "term-new",
      },
      ctx,
    );
    expect(closeTermRes.ok).toBe(true);
    expect(closeTerminal).toHaveBeenCalledWith("term-new");

    // Verify user messages are always preserved even when >14 tool items follow
    const manyTools = Array.from({ length: 16 }, (_, idx) => ({
      kind: "tool" as const,
      id: `t-many-${idx}`,
      ts: 2000 + idx,
      name: "bash",
      title: `echo step-${idx}`,
      toolKind: "execute" as const,
      status: "completed" as const,
      output: "",
      locations: [],
      rawInput: {},
      content: [],
    }));
    const preservedItems = extractWatchTimelineItems({
      sessionId: "s-run",
      lastSeq: 25,
      startSeq: 0,
      items: [
        {
          kind: "user",
          id: "u-wrapped",
          ts: 1000,
          blocks: [
            {
              type: "text",
              text: "<CONTEXT_SUMMARY>old context</CONTEXT_SUMMARY>\n<USER_REQUEST>\n用聊天气泡展示用户输入\n</USER_REQUEST>",
            },
          ],
        },
        ...manyTools,
      ],
      index: {},
      permissions: [],
      config: [],
      commands: [],
      state: "running",
      turnActive: true,
    });
    expect(preservedItems).toHaveLength(14);
    expect(preservedItems[0]).toMatchObject({
      id: "u-wrapped",
      kind: "user",
      text: "用聊天气泡展示用户输入",
    });

    const setConfig = vi.fn(() => Promise.resolve());
    const loadEarlier = vi.fn(() => Promise.resolve(true));
    const cfgRes = await executeWatchCommand(
      {
        id: "cfg-1",
        kind: "set-config",
        computerKey: "mac-1",
        sessionId: "s-run",
        optionId: "mode",
        value: "read-only",
      },
      {
        ...ctx,
        actions: { ...actions, setConfig },
      },
    );
    expect(cfgRes.ok).toBe(true);
    expect(setConfig).toHaveBeenCalledWith("s-run", "mode", "read-only");

    const onExpandTimeline = vi.fn(() => 28);
    const loadRes = await executeWatchCommand(
      {
        id: "le-1",
        kind: "load-earlier",
        computerKey: "mac-1",
        sessionId: "s-run",
      },
      {
        ...ctx,
        views: {
          "s-run": {
            sessionId: "s-run",
            lastSeq: 30,
            startSeq: 12,
            items: manyTools,
            index: {},
            permissions: [],
            config: [],
            commands: [],
            state: "running",
            turnActive: true,
          },
        },
        onExpandTimeline,
        actions: { ...actions, loadEarlier },
      },
    );
    expect(loadRes.ok).toBe(true);
    expect(onExpandTimeline).toHaveBeenCalledWith("s-run");
    expect(loadEarlier).toHaveBeenCalledWith("s-run");

    const pagedSnap = buildClientWatchSnapshot({
      computerKey: "mac-1",
      computerName: "Studio Mac",
      online: true,
      sessions: [runningSession],
      terminals: [],
      views: {
        "s-run": {
          sessionId: "s-run",
          lastSeq: 30,
          startSeq: 10,
          items: manyTools,
          index: {},
          permissions: [],
          config: [],
          commands: [],
          state: "running",
          turnActive: true,
        },
      },
      itemLimits: { "s-run": 29 },
    });
    expect(pagedSnap.sessions[0]?.items).toHaveLength(16);
    expect(pagedSnap.sessions[0]?.hasEarlier).toBe(true);
  });

  it("answers invalid and expired commands instead of leaving the watch waiting", async () => {
    harness.pendingId.mockResolvedValueOnce("cmd-long").mockResolvedValueOnce("cmd-gone").mockResolvedValue(null);
    harness.consumeCmd.mockImplementation((id: string) =>
      id === "cmd-long" ? Promise.reject(new WatchCommandRejected("内容过长，请缩短后重试")) : Promise.resolve(null),
    );
    useIOSWatchSync(
      { computerKey: "mac-1", computerName: "Mac", sessions: [], terminals: [], online: true },
      {
        computerKey: "mac-1",
        online: true,
        sessions: {},
        computers: [],
        selectComputer: vi.fn(),
        actions: makeActions(),
      },
    );
    harness.effects.forEach((effect) => effect());
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.completeCmd).toHaveBeenCalledWith("cmd-long", false, "内容过长，请缩短后重试");
    expect(harness.completeCmd).toHaveBeenCalledWith("cmd-gone", false, "操作已过期，请在手表上重试");
  });

  it("debounces snapshots, caps the wait while output streams, and skips unchanged content", async () => {
    const send = vi.fn(() => Promise.resolve(true));
    const scheduler = createWatchSnapshotScheduler(send);
    let text = "a";
    const build = () =>
      buildClientWatchSnapshot({
        computerKey: "mac-1",
        computerName: "Mac",
        sessions: [{ ...runningSession, preview: text }],
        terminals: [],
        online: true,
        now: Date.now(),
      });

    // The first snapshot after install goes at once.
    scheduler.schedule(build);
    expect(send).toHaveBeenCalledTimes(1);

    // A delta every 100 ms: the trailing debounce alone would never fire.
    for (let i = 0; i < 20; i += 1) {
      text = `streaming ${i}`;
      scheduler.schedule(build);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(send.mock.calls.length).toBeLessThanOrEqual(3);

    await vi.advanceTimersByTimeAsync(400);
    const settled = send.mock.calls.length;
    // Rebuilt with a new timestamp only: nothing to send.
    scheduler.schedule(build);
    await vi.advanceTimersByTimeAsync(400);
    expect(await scheduler.flush()).toBe(false);
    expect(send).toHaveBeenCalledTimes(settled);
    scheduler.dispose();
  });

  it("reconnects for a watch command that finds the computer offline", async () => {
    const actions = makeActions();
    const base = {
      computerKey: "mac-1",
      online: false,
      sessions: { "s-run": runningSession },
      computers: [],
      selectComputer: vi.fn(),
      actions,
    };
    const back = vi.fn(() => Promise.resolve(true));
    expect(await executeWatchCommand({ id: "r", kind: "refresh" }, { ...base, ensureOnline: back })).toEqual({
      ok: true,
      message: "已同步最新状态",
    });
    expect(back).toHaveBeenCalledOnce();
    expect(actions.refresh).toHaveBeenCalledOnce();

    const stillDown = await executeWatchCommand(
      { id: "r2", kind: "refresh" },
      { ...base, ensureOnline: () => Promise.resolve(false) },
    );
    expect(stillDown.ok).toBe(false);
    expect(stillDown.message).toContain("连不上电脑");

    const focusSession = vi.fn();
    await executeWatchCommand(
      { id: "o", kind: "open-session", computerKey: "mac-1", sessionId: "s-run" },
      { ...base, online: true, focusSession },
    );
    expect(focusSession).toHaveBeenCalledWith("s-run");
    expect(actions.openSession).not.toHaveBeenCalled();

    let listener: ((status: string) => void) | undefined;
    const link = { status: "reconnecting" as const, onStatus: (l: (status: string) => void) => ((listener = l), () => {}) };
    const waiting = waitForLinkOnline(link as never, 5_000);
    listener?.("online");
    expect(await waiting).toBe(true);
    const timedOut = waitForLinkOnline(link as never, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await timedOut).toBe(false);
  });

  it("follows sessions through the refcounted subscription, not by opening them directly", () => {
    const actions = makeActions();
    const releases = new Map<string, ReturnType<typeof vi.fn>>();
    const subscribeSession = vi.fn((id: string) => {
      const release = vi.fn();
      releases.set(id, release);
      return release;
    });
    const many = Array.from({ length: 6 }, (_, i) => ({ ...runningSession, id: `s-${i}`, updatedAt: 100 - i }));
    useIOSWatchSync(
      { computerKey: "mac-1", computerName: "Mac", sessions: many, terminals: [], online: true },
      {
        computerKey: "mac-1",
        online: true,
        sessions: Object.fromEntries(many.map((s) => [s.id, s])),
        computers: [],
        selectComputer: vi.fn(),
        actions,
        subscribeSession,
      },
      true,
      undefined,
      true,
    );
    const cleanups = harness.effects
      .map((effect) => effect())
      .filter((cleanup): cleanup is () => void => typeof cleanup === "function");
    expect(subscribeSession.mock.calls.map(([id]) => id)).toEqual(["s-0", "s-1", "s-2", "s-3"]);
    expect(actions.openSession).not.toHaveBeenCalled();
    cleanups.forEach((cleanup) => cleanup());
    for (const id of ["s-0", "s-1", "s-2", "s-3"]) expect(releases.get(id)).toHaveBeenCalledOnce();
  });

  it("keeps a terminal attached while the watch still follows it", () => {
    const call = vi.fn(() => Promise.resolve({}));
    const link = { status: "online", call };
    const releaseScreen = holdTerminal(link as never, "t-1");
    const releaseWatch = holdTerminal(link as never, "t-1");
    releaseScreen();
    expect(call).not.toHaveBeenCalled();
    releaseWatch();
    releaseWatch();
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith("terminals.detach", { terminalId: "t-1" });

    const offline = { status: "reconnecting", call: vi.fn(() => Promise.resolve({})) };
    holdTerminal(offline as never, "t-2")();
    expect(offline.call).not.toHaveBeenCalled();
  });

  it("keeps line breaks and code blocks in conversation items", () => {
    const answer = "修改如下：\n\n```ts\nconst a = 1;\n```\n\n- 第一点\n- 第二点";
    const items = extractWatchTimelineItems({
      sessionId: "s-run",
      lastSeq: 2,
      startSeq: 0,
      items: [
        { kind: "user", id: "u-1", ts: 1, blocks: [{ type: "text", text: `第一行\n第二行${"很长".repeat(400)}` }] },
        { kind: "agent", id: "a-1", ts: 2, text: answer, streaming: false },
      ],
      index: { "u-1": 0, "a-1": 1 },
      permissions: [],
      config: [],
      commands: [],
      state: "idle",
      turnActive: false,
    });
    expect(items[0]!.text.startsWith("第一行\n第二行")).toBe(true);
    // No longer cut to 360 characters here; the snapshot's byte budget decides.
    expect(items[0]!.text.length).toBeGreaterThan(800);
    expect(items[1]!.text).toBe(answer);
  });

  it("answers a late retry with the earlier result instead of sending the prompt twice", async () => {
    const actions = makeActions();
    const prompt: WatchCommand = { id: "cmd-retry-1", kind: "prompt", computerKey: "mac-1", sessionId: "s-run", text: "继续" };
    harness.consumeCmd.mockImplementation(() => Promise.resolve(prompt));
    useIOSWatchSync(
      { computerKey: "mac-1", computerName: "Mac", sessions: [runningSession], terminals: [], online: true },
      {
        computerKey: "mac-1",
        online: true,
        sessions: { "s-run": runningSession },
        computers: [],
        selectComputer: vi.fn(),
        actions,
      },
    );
    harness.effects.forEach((effect) => effect());
    harness.onWatchCmd?.({ id: "cmd-retry-1" });
    await vi.advanceTimersByTimeAsync(1_000);
    // The reply was lost; the watch sends the same command again.
    harness.onWatchCmd?.({ id: "cmd-retry-1" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(actions.send).toHaveBeenCalledOnce();
    expect(actions.send).toHaveBeenCalledWith("s-run", [{ type: "text", text: "继续" }], { now: undefined, clientMessageId: "cmd-retry-1" });
    expect(harness.completeCmd).toHaveBeenCalledTimes(2);
    expect(harness.completeCmd).toHaveBeenNthCalledWith(2, "cmd-retry-1", true, "已发送给 Agent");
  });
});
