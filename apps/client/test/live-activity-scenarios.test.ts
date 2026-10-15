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
const permission = { requestId: "consent", title: "允许 Computer Use 访问 Device Hub？", options: [] };
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
  { id: "failed", label: "执行出错", sessions: [failed], phase: "failed" },
  { id: "disconnected", label: "连接断开", sessions: [running], online: false, phase: "stale" },
  { id: "multiple", label: "多任务优先级", sessions: [waiting, failed, { ...running, id: "running-2" }], terminals: [terminal], phase: "waiting_for_approval" },
  { id: "terminal", label: "终端命令", sessions: [], terminals: [terminal], phase: "running" },
  { id: "claude", label: "Claude 图标", sessions: [session({ agent: "claude", activity: { kind: "thinking" } })], phase: "running" },
  { id: "antigravity", label: "Antigravity 图标", sessions: [session({ agent: "antigravity", activity: { kind: "thinking" } })], phase: "running" },
  { id: "completed", label: "全部完成后收起", sessions: [session({ state: "idle" })], phase: undefined },
  { id: "starting", label: "启动状态不会单独展示", sessions: [session({ state: "unknown" })], phase: undefined },
  { id: "offline-only", label: "仅离线会话时收起", sessions: [session({ state: "offline" })], online: false, phase: undefined },
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
});

// The simulator harness consumes the production aggregator's exact payloads.
afterAll(() => {
  if (process.env.LINKSHELL_ACTIVITY_SCENARIOS) writeFileSync(process.env.LINKSHELL_ACTIVITY_SCENARIOS, JSON.stringify(payloads, null, 2));
});
