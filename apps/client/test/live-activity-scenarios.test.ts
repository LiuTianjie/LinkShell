import { writeFileSync } from "node:fs";
import type { SessionSummary, TerminalInfo } from "@linkshell/wire";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("expo-sqlite/kv-store", () => ({ default: { getItemSync: () => null, setItemSync: vi.fn() } }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: vi.fn() } }));
vi.mock("../src/lib/client", () => ({ useConnection: vi.fn() }));
vi.mock("../modules/link-layout", () => ({ setNativeShortcutItems: vi.fn(), syncNativeLiveActivity: vi.fn() }));
const { buildLiveActivityPayload } = await import("../src/lib/session-attention");

const session = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "activity-test", nativeId: "activity-test", agent: "codex", title: "验证实时活动展示",
  cwd: "/Users/test/LinkShell", state: "running", archived: false,
  createdAt: 1000, updatedAt: 2000, lastSeq: 1, pendingPermissions: 0, ...overrides,
});
const permission = { requestId: "consent", title: "允许 Computer Use 访问 Device Hub？", options: [
  { optionId: "decline", name: "Deny", kind: "reject_once" as const },
  { optionId: "accept", name: "Allow", kind: "allow_once" as const },
  { optionId: "acceptForSession", name: "Allow for session", kind: "allow_always" as const },
] };
const running = session({ activity: { kind: "thinking" } });
const waiting = session({ state: "waiting", pendingPermissions: 1, permission });
const question = session({ asyncQuestions: [{ id: "q1", title: "你希望先测试哪种展示？", options: ["锁屏", "灵动岛"] }] });
const failed = session({ id: "failed", state: "error", preview: "构建失败：请检查编译日志" });
const terminal: TerminalInfo = { id: "terminal-test", title: "pnpm", command: "pnpm test", cwd: "/Users/test/LinkShell", cols: 80, rows: 24, createdAt: 1, activeAt: 2 };
const scenarios = [
  { id: "thinking", label: "思考中", sessions: [running], phase: "running" },
  { id: "tool", label: "执行工具", sessions: [session({ activity: { kind: "tool", title: "pnpm test", toolKind: "execute" } })], phase: "running" },
  { id: "responding", label: "正在回复", sessions: [session({ activity: { kind: "responding" } })], phase: "running" },
  { id: "approval", label: "等待确认", sessions: [waiting], phase: "waiting_for_approval" },
  { id: "question", label: "等待回答", sessions: [question], phase: "waiting_for_input" },
  { id: "many-options", label: "更多选项 · 点标题进入详情", sessions: [session({ asyncQuestions: [{ id: "q2", title: "接下来优先处理什么？", options: ["实时活动", "审批交互", "连接恢复", "其他任务"] }] })], phase: "waiting_for_input" },
  { id: "long-options", label: "长选项 · 进入详情完整选择", sessions: [session({ asyncQuestions: [{ id: "q3", title: "选择实时活动的更新方案", options: ["保留所有选项并进入会话详情后选择", "在后台接收并展示服务端的最新进展"] }] })], phase: "waiting_for_input" },
  { id: "failed", label: "执行出错", sessions: [failed], phase: "failed" },
  { id: "disconnected", label: "连接断开", sessions: [running], online: false, phase: "stale" },
  { id: "multiple", label: "等待确认 · 可直接选择", sessions: [waiting, failed, { ...running, id: "running-2" }], terminals: [terminal], phase: "waiting_for_approval" },
  { id: "agent-stack", label: "Codex 与 Claude 并行", sessions: [running, session({ id: "claude-running", agent: "claude", updatedAt: 1500, activity: { kind: "tool", title: "验证实时活动布局", toolKind: "execute" } })], phase: "running" },
  { id: "agent-overflow", label: "多个 Agent 的图标溢出", sessions: [running, ...["claude", "gemini", "cursor", "antigravity"].map((agent, index) => session({ id: agent, agent, updatedAt: 1500 - index }))], phase: "running" },
  { id: "terminal", label: "终端命令", sessions: [], terminals: [terminal], phase: "running" },
  { id: "claude", label: "Claude 图标", sessions: [session({ agent: "claude", activity: { kind: "thinking" } })], phase: "running" },
  { id: "antigravity", label: "Antigravity 图标", sessions: [session({ agent: "antigravity", activity: { kind: "thinking" } })], phase: "running" },
  { id: "completed", label: "全部完成后收起", sessions: [session({ state: "idle" })], phase: undefined },
  { id: "starting", label: "启动状态不会单独展示", sessions: [session({ state: "unknown" })], phase: undefined },
  { id: "offline-only", label: "仅离线会话时收起", sessions: [session({ state: "offline" })], online: false, phase: undefined },
  { id: "latest-codex", label: "Codex 有新进展", sessions: [session({ id: "recency-codex", title: "优化实时活动", updatedAt: 4000, activity: { kind: "tool", title: "正在验证锁屏布局" } }), session({ id: "recency-claude", agent: "claude", title: "接入实时活动更新", updatedAt: 3000, activity: { kind: "thinking" } })], phase: "running" },
  { id: "latest-claude", label: "Claude 更新 · 头像与内容一起切换", sessions: [session({ id: "recency-codex", title: "优化实时活动", updatedAt: 4000, activity: { kind: "tool", title: "正在验证锁屏布局" } }), session({ id: "recency-claude", agent: "claude", title: "接入实时活动更新", updatedAt: 5000, activity: { kind: "responding" }, preview: "已整理好 ActivityKit 的接入方案" })], phase: "running" },
];
const payloads = scenarios.map((scenario) => ({
  id: scenario.id, label: scenario.label,
  payload: buildLiveActivityPayload("测试 Mac", scenario.sessions, scenario.terminals ?? [], scenario.online ?? true),
}));

describe("Live Activity simulator scenarios", () => {
  for (const [index, scenario] of scenarios.entries()) it(scenario.label, () => {
    const payload = payloads[index]!.payload;
    expect(payload.phase).toBe(scenario.phase);
    expect(payload.active).toBe(scenario.phase !== undefined);
    if (scenario.id === "multiple") expect(payload).toMatchObject({ waitingCount: 1, runningCount: 2, failedCount: 1, subtitle: permission.title });
    if (scenario.id === "question") expect(payload.subtitle).toBe(question.asyncQuestions![0]!.title);
    if (scenario.id === "terminal") expect(payload).toMatchObject({ agent: "terminal", deepLink: "linkshell:///terminal/terminal-test" });
  });

  it("shows each participating agent once, keeping the featured task first and excluding inactive sessions", () => {
    const payload = buildLiveActivityPayload("Mac", [
      running,
      session({ id: "codex-2" }),
      session({ id: "claude-waiting", agent: "claude", state: "waiting", pendingPermissions: 1, permission }),
      session({ id: "gemini-idle", agent: "gemini", state: "idle" }),
      session({ id: "cursor-offline", agent: "cursor", state: "offline" }),
      session({ id: "archived", agent: "antigravity", archived: true }),
    ], [terminal, { ...terminal, id: "terminal-2" }], true);
    expect(payload).toMatchObject({
      agent: "claude",
      agents: ["claude", "codex", "terminal"],
      phase: "waiting_for_approval",
      runningCount: 4,
      waitingCount: 1,
    });
  });

  it("retains the last participating agents when the connection goes stale", () => {
    const payload = buildLiveActivityPayload("Mac", [running, session({ id: "claude", agent: "claude" })], [], false);
    expect(payload).toMatchObject({ phase: "stale", agents: ["codex", "claude"] });
  });

  it("moves the agent with new progress first, updating title, content and link as one snapshot", () => {
    const before = payloads.find((item) => item.id === "latest-codex")!.payload;
    const after = payloads.find((item) => item.id === "latest-claude")!.payload;
    expect(before).toMatchObject({ agent: "codex", agents: ["codex", "claude"], title: "优化实时活动", runningCount: 2 });
    expect(after).toMatchObject({ agent: "claude", agents: ["claude", "codex"], title: "接入实时活动更新", subtitle: "已整理好 ActivityKit 的接入方案", runningCount: 2, deepLink: "linkshell:///session/recency-claude" });
  });

  it("lets fresh progress lead while preserving waiting counts and stabilizes timestamp ties", () => {
    const newer = session({ id: "claude-new", agent: "claude", updatedAt: 4000 });
    const payload = buildLiveActivityPayload("Mac", [waiting, newer], [], true);
    expect(payload).toMatchObject({ agent: "claude", agents: ["claude", "codex"], waitingCount: 1, runningCount: 1 });
    expect(buildLiveActivityPayload("Mac", [newer, waiting], [], true)).toEqual(payload);
    const tie = { ...newer, updatedAt: waiting.updatedAt };
    expect(buildLiveActivityPayload("Mac", [tie, waiting], [], true).phase).toBe("waiting_for_approval");
  });

  it("can feature a newly active terminal without dropping other task counts", () => {
    expect(buildLiveActivityPayload("Mac", [waiting, failed], [{ ...terminal, activeAt: 5000 }], true))
      .toMatchObject({ agent: "terminal", agents: ["terminal", "codex"], waitingCount: 1, runningCount: 1, failedCount: 1 });
  });

  it("does not leave actionable choices on stale content", () => {
    const payload = buildLiveActivityPayload("Mac", [waiting], [], false, undefined, undefined, "computer-1");
    expect(payload).toMatchObject({ phase: "stale", actions: [], hasMoreActions: false });
  });
});

// The simulator harness consumes the production aggregator's exact payloads.
afterAll(() => {
  if (process.env.LINKSHELL_ACTIVITY_SCENARIOS) writeFileSync(process.env.LINKSHELL_ACTIVITY_SCENARIOS, JSON.stringify(scenarios.map((scenario) => ({
    id: scenario.id, label: scenario.label,
    payload: buildLiveActivityPayload("测试 Mac", scenario.sessions, scenario.terminals ?? [], scenario.online ?? true, undefined, undefined, "preview-computer"),
  })), null, 2));
});
