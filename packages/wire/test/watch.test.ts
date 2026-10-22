import { describe, expect, it } from "vitest";
import {
  buildWatchSnapshot,
  cutWatchBytes,
  cutWatchBytesMiddle,
  isWatchCommandCurrent,
  WATCH_SNAPSHOT_BYTE_LIMIT,
  watchCommandSchema,
  watchSnapshotContent,
  watchSnapshotSchema,
  watchPlainText,
  watchTimelineText,
  type WatchCommand,
  type WatchTimelineItem,
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
    expect(bytes).toBeLessThanOrEqual(WATCH_SNAPSHOT_BYTE_LIMIT);
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

  const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const cjkTimeline = (prefix: string, count: number, chars: number): WatchTimelineItem[] =>
    Array.from({ length: count }, (_, idx) => ({
      id: `${prefix}-${idx}`,
      kind: idx % 3 === 0 ? "user" : "assistant",
      text: `第${idx}条：${"中文内容".repeat(Math.ceil(chars / 4))}`.slice(0, chars),
    }));

  it("trims CJK text by bytes and gives the session the watch has open the largest share", () => {
    const sessions: SessionSummary[] = Array.from({ length: 13 }, (_, idx) => ({
      ...baseSession,
      id: `codex:s-${idx}`,
      title: `任务 ${idx}`,
      preview: "进展".repeat(80),
      updatedAt: 10_000 - idx,
    }));
    const timelines = Object.fromEntries(sessions.map((s) => [s.id, cjkTimeline(s.id, 40, 400)]));
    // The oldest session: outside the top ten, but the one on the watch's screen.
    const focusedId = "codex:s-12";
    const snapshot = watchSnapshotContent(
      buildWatchSnapshot("Mac", sessions, [], true, { computerKey: "c", timelines, focusedSessionId: focusedId }),
    );

    expect(bytesOf(snapshot)).toBeLessThanOrEqual(WATCH_SNAPSHOT_BYTE_LIMIT);
    expect(watchSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.focusedSessionId).toBe(focusedId);
    const focused = snapshot.sessions.find((s) => s.id === focusedId)!;
    expect(focused).toBeDefined();
    // 400 CJK characters are 1.2 KB: a character-counted 24 KB budget fitted a handful.
    expect(focused.items!.length).toBeGreaterThanOrEqual(25);
    expect(focused.items!.at(-1)!.id).toBe(`${focusedId}-39`);
    expect(focused.items!.at(-1)!.text).toBe(timelines[focusedId]!.at(-1)!.text);
    expect(focused.hasEarlier).toBe(true);
    for (const other of snapshot.sessions.filter((s) => s.id !== focusedId)) {
      expect(other.items?.length ?? 0).toBeLessThan(focused.items!.length);
    }
    // Idempotent: the phone bounds the snapshot again before handing it to WatchConnectivity.
    expect(watchSnapshotContent(snapshot)).toEqual(snapshot);
  });

  it("drops pictures before text", () => {
    const image = "A".repeat(11_000);
    const items: WatchTimelineItem[] = Array.from({ length: 12 }, (_, idx) => ({
      id: `img-${idx}`,
      kind: "image",
      text: `截图 ${idx}：${"界面说明".repeat(60)}`,
      imageBase64: image,
      imageMimeType: "image/png",
    }));
    const other: SessionSummary = { ...baseSession, id: "codex:other", updatedAt: 9000 };
    const snapshot = watchSnapshotContent(
      buildWatchSnapshot("Mac", [baseSession, other], [], true, {
        computerKey: "c",
        timelines: { [baseSession.id]: items, [other.id]: items.map((i) => ({ ...i, id: `o-${i.id}` })) },
        focusedSessionId: baseSession.id,
      }),
    );
    expect(bytesOf(snapshot)).toBeLessThanOrEqual(WATCH_SNAPSHOT_BYTE_LIMIT);
    const focused = snapshot.sessions.find((s) => s.id === baseSession.id)!;
    expect(focused.items).toHaveLength(12);
    expect(focused.items!.filter((i) => i.imageBase64)).toHaveLength(1);
    expect(focused.items!.at(-1)!.imageBase64).toBe(image);
    const otherOut = snapshot.sessions.find((s) => s.id === other.id)!;
    expect(otherOut.items!.every((i) => !i.imageBase64)).toBe(true);
  });

  it("keeps line breaks and code blocks in timeline text and marks cuts", () => {
    const raw = "## 修改如下：\r\n\r\n\r\n\r\n```ts\r\nconst a = 1;\r\n\tif (a) {\r\n\t\treturn;\r\n\t}\r\n```\r\n- **第一点**   \r\n- 见 [文档](https://x.y) 与 `pnpm test`";
    // The watch renders answers as markdown: only whitespace is tidied.
    expect(watchTimelineText(raw)).toBe(
      "## 修改如下：\n\n```ts\nconst a = 1;\n  if (a) {\n    return;\n  }\n```\n- **第一点**\n- 见 [文档](https://x.y) 与 `pnpm test`",
    );
    // Thoughts are plain Text there: markup is unwrapped, code kept.
    expect(watchPlainText("## 想法\n- **先**看 `a`\n```\n**x**\n```")).toBe("想法\n• 先看 a\n```\n**x**\n```");
    const long = `开头${"甲".repeat(3000)}结论在这里`;
    const middle = cutWatchBytesMiddle(long, 3000);
    expect(new TextEncoder().encode(middle).length).toBeLessThanOrEqual(3000);
    expect(middle.startsWith("开头")).toBe(true);
    expect(middle.endsWith("结论在这里")).toBe(true);
    expect(middle).toMatch(/中间略去 \d+ 字/);
    const snapshot = buildWatchSnapshot("Mac", [baseSession], [], true, {
      computerKey: "c",
      timelines: { [baseSession.id]: [{ id: "a", kind: "assistant", text: watchTimelineText(raw) }] },
    });
    expect(snapshot.sessions[0]!.items![0]!.text).toContain("```ts\nconst a = 1;");

    const cutText = cutWatchBytes("汉".repeat(1000), 300);
    expect(cutText.endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(cutText).length).toBeLessThanOrEqual(300);
    expect(cutWatchBytes("short", 300)).toBe("short");
  });

  it("offers no agents the computer did not report, and accepts long dictation", () => {
    const snapshot = buildWatchSnapshot("Mac", [baseSession], [], true, { computerKey: "c" });
    expect(snapshot.availableAgents).toEqual([]);
    const prompt = (text: string) =>
      watchCommandSchema.safeParse({ id: "p", kind: "prompt", computerKey: "c", sessionId: "s", text }).success;
    expect(prompt("说".repeat(5000))).toBe(true);
    expect(prompt("说".repeat(9000))).toBe(false);
  });
});
