import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@linkshell/wire";
import { turnActivity } from "../src/lib/turn-activity";

const session: SessionSummary = { id: "codex:one", nativeId: "one", agent: "codex", cwd: "/work", state: "idle", pendingPermissions: 0, createdAt: 1, updatedAt: 1, lastSeq: 0, archived: false };
const input = { session, online: true, ready: true, hasPermission: false, queued: 0 };

describe("conversation activity feedback", () => {
  it("separates delivery from execution and hides after completion", () => {
    const progress = { clientMessageId: "one", phase: "sending" as const, afterSeq: 0 };
    expect(turnActivity({ ...input, progress })).toMatchObject({ label: "正在发送…", animated: true });
    expect(turnActivity({ ...input, progress: { ...progress, phase: "starting" } })?.label).toContain("等待 Agent 开始");
    expect(turnActivity({ ...input, session: { ...session, state: "running", activity: { kind: "thinking" } } })?.label).toBe("思考中…");
    expect(turnActivity(input)).toBeUndefined();
  });

  it("keeps long-running tools and observed sessions visibly active without text chunks", () => {
    expect(turnActivity({ ...input, session: { ...session, state: "running" } })).toMatchObject({ label: "正在运行…", animated: true });
    expect(turnActivity({ ...input, session: { ...session, state: "running", activity: { kind: "tool", title: "pnpm test", toolKind: "execute" } } })?.label).toContain("pnpm test");
  });

  it("stops the work animation for disconnection, approval, queueing and errors", () => {
    const running = { ...input, session: { ...session, state: "running" as const } };
    expect(turnActivity({ ...running, online: false })).toMatchObject({ tone: "muted", animated: false });
    expect(turnActivity({ ...running, hasPermission: true })).toBeUndefined();
    expect(turnActivity({ ...running, session: { ...running.session, state: "waiting" } })).toMatchObject({ tone: "waiting", animated: false });
    expect(turnActivity({ ...input, queued: 2 })).toMatchObject({ label: "已排队，等待 Agent 接收…", animated: false });
    expect(turnActivity({ ...input, session: { ...session, state: "error" } })).toMatchObject({ tone: "error", animated: false });
  });

  it("does not present cached execution as current while reconnect is restoring history", () => {
    const running = { ...input, session: { ...session, state: "running" as const } };
    expect(turnActivity({ ...running, online: false, connecting: true })).toMatchObject({ label: "正在恢复连接…", animated: true, tone: "muted" });
    expect(turnActivity({ ...running, online: false, connecting: false })).toMatchObject({ label: "连接已断开，等待重连…", animated: false });
    expect(turnActivity({ ...input, ready: false, session: { ...session, state: "running" } })?.label).toBe("正在同步会话…");
  });
});
