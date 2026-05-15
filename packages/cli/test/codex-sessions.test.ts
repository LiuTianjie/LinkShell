import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCodexStoredSessions, loadCodexStoredTimeline } from "../src/runtime/acp/codex-sessions.js";

let homeDir: string | undefined;
const originalHome = process.env.HOME;

function useTempHome(): string {
  homeDir = mkdtempSync(join(tmpdir(), "linkshell-codex-sessions-"));
  process.env.HOME = homeDir;
  return homeDir;
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

afterEach(() => {
  process.env.HOME = originalHome;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

describe("Codex local session discovery", () => {
  it("uses device-side Codex index and rollout metadata for session list", () => {
    const home = useTempHome();
    const codexRoot = join(home, ".codex");
    const activeDir = join(codexRoot, "sessions", "2026", "05", "16");
    const archivedDir = join(codexRoot, "archived_sessions");
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(archivedDir, { recursive: true });

    writeJsonl(join(codexRoot, "session_index.jsonl"), [
      {
        id: "019e-active",
        thread_name: "Active Codex Work",
        updated_at: "2026-05-16T01:00:00.000Z",
      },
      {
        id: "019e-archived",
        thread_name: "Archived Codex Work",
        updated_at: "2026-05-15T01:00:00.000Z",
      },
    ]);
    writeJsonl(join(activeDir, "rollout-2026-05-16T01-00-00-019e-active.jsonl"), [
      {
        timestamp: "2026-05-16T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019e-active",
          cwd: "/Users/tifenxia/ActiveProject",
          timestamp: "2026-05-16T00:59:00.000Z",
        },
      },
      {
        timestamp: "2026-05-16T01:01:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Fallback active title" },
      },
    ]);
    writeJsonl(join(archivedDir, "rollout-2026-05-15T01-00-00-019e-archived.jsonl"), [
      {
        timestamp: "2026-05-15T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019e-archived",
          cwd: "/Users/tifenxia/ArchivedProject",
          timestamp: "2026-05-15T00:59:00.000Z",
        },
      },
    ]);

    const result = listCodexStoredSessions("/fallback");

    expect(result.sessions.map((session) => session.id)).toEqual(["019e-active", "019e-archived"]);
    expect(result.sessions[0]).toMatchObject({
      cwd: "/Users/tifenxia/ActiveProject",
      title: "Active Codex Work",
      lastModified: Date.parse("2026-05-16T01:00:00.000Z"),
      archived: false,
    });
    expect(result.sessions[1]).toMatchObject({
      cwd: "/Users/tifenxia/ArchivedProject",
      title: "Archived Codex Work",
      lastModified: Date.parse("2026-05-15T01:00:00.000Z"),
      archived: true,
    });
  });

  it("loads visible Codex user and assistant messages from device history", () => {
    const home = useTempHome();
    const codexRoot = join(home, ".codex");
    const activeDir = join(codexRoot, "sessions", "2026", "05", "16");
    mkdirSync(activeDir, { recursive: true });
    writeJsonl(join(activeDir, "rollout-2026-05-16T01-00-00-019e-active.jsonl"), [
      {
        timestamp: "2026-05-16T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "019e-active", cwd: "/Users/tifenxia/ActiveProject" },
      },
      {
        timestamp: "2026-05-16T01:01:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Show me the device sessions" },
      },
      {
        timestamp: "2026-05-16T01:02:00.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Here are the sessions." },
      },
      {
        timestamp: "2026-05-16T01:03:00.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: {} },
      },
    ]);

    const result = loadCodexStoredTimeline("019e-active", "agent:019e-active", "/fallback");

    expect(result.items).toEqual([
      expect.objectContaining({
        conversationId: "agent:019e-active",
        role: "user",
        text: "Show me the device sessions",
        createdAt: Date.parse("2026-05-16T01:01:00.000Z"),
      }),
      expect.objectContaining({
        conversationId: "agent:019e-active",
        role: "assistant",
        text: "Here are the sessions.",
        createdAt: Date.parse("2026-05-16T01:02:00.000Z"),
      }),
    ]);
  });

  it("falls back to the first Codex user message when the session index has no title", () => {
    const home = useTempHome();
    const codexRoot = join(home, ".codex");
    const activeDir = join(codexRoot, "sessions", "2026", "05", "16");
    mkdirSync(activeDir, { recursive: true });
    writeJsonl(join(activeDir, "rollout-2026-05-16T01-00-00-019e-active.jsonl"), [
      {
        timestamp: "2026-05-16T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "019e-active", cwd: "/Users/tifenxia/ActiveProject" },
      },
      {
        timestamp: "2026-05-16T01:01:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Use this as the active title" },
      },
    ]);

    const result = listCodexStoredSessions("/fallback");

    expect(result.sessions[0]).toMatchObject({
      id: "019e-active",
      title: "Use this as the active title",
    });
  });

  it("loads Codex patch and command history as first-class timeline items", () => {
    const home = useTempHome();
    const codexRoot = join(home, ".codex");
    const activeDir = join(codexRoot, "sessions", "2026", "05", "16");
    mkdirSync(activeDir, { recursive: true });
    writeJsonl(join(activeDir, "rollout-2026-05-16T01-00-00-019e-active.jsonl"), [
      {
        timestamp: "2026-05-16T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "019e-active", cwd: "/Users/tifenxia/ActiveProject" },
      },
      {
        timestamp: "2026-05-16T01:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "patch-1",
          success: true,
          changes: {
            "/Users/tifenxia/ActiveProject/src/app.ts": {
              type: "update",
              unified_diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-old\n+new\n+again",
            },
            "/Users/tifenxia/ActiveProject/src/new.ts": {
              type: "add",
              content: "export const value = 1;\nexport const next = 2;\n",
            },
          },
        },
      },
      {
        timestamp: "2026-05-16T01:02:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call-1",
          name: "exec_command",
          arguments: { cmd: "pnpm test", workdir: "/Users/tifenxia/ActiveProject" },
        },
      },
      {
        timestamp: "2026-05-16T01:03:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "Tests passed",
        },
      },
    ]);

    const result = loadCodexStoredTimeline("019e-active", "agent:019e-active", "/Users/tifenxia/ActiveProject");

    expect(result.items).toEqual([
      expect.objectContaining({
        type: "tool_call",
        kind: "file_change",
        text: "已编辑 2 个文件 +4 -1",
        fileChange: expect.objectContaining({
          entries: [
            expect.objectContaining({ path: "src/app.ts", kind: "update", added: 2, removed: 1 }),
            expect.objectContaining({ path: "src/new.ts", kind: "create", added: 2 }),
          ],
        }),
      }),
      expect.objectContaining({
        type: "tool_call",
        kind: "command_execution",
        toolCall: expect.objectContaining({ name: "命令", output: "Tests passed", status: "completed" }),
        commandExecution: expect.objectContaining({
          command: "pnpm test",
          cwd: "/Users/tifenxia/ActiveProject",
          output: "Tests passed",
          status: "completed",
        }),
      }),
    ]);
  });

  it("promotes Codex apply_patch calls into a single file change item", () => {
    const home = useTempHome();
    const codexRoot = join(home, ".codex");
    const activeDir = join(codexRoot, "sessions", "2026", "05", "16");
    mkdirSync(activeDir, { recursive: true });
    writeJsonl(join(activeDir, "rollout-2026-05-16T01-00-00-019e-active.jsonl"), [
      {
        timestamp: "2026-05-16T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "019e-active", cwd: "/Users/tifenxia/ActiveProject" },
      },
      {
        timestamp: "2026-05-16T01:01:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "patch-call-1",
          name: "apply_patch",
          arguments: [
            "*** Begin Patch",
            "*** Update File: src/app.ts",
            "@@",
            "-old",
            "+new",
            "*** Add File: src/new.ts",
            "+export const value = 1;",
            "*** End Patch",
          ].join("\n"),
        },
      },
      {
        timestamp: "2026-05-16T01:02:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "patch-call-1",
          output: "Done!",
        },
      },
    ]);

    const result = loadCodexStoredTimeline("019e-active", "agent:019e-active", "/Users/tifenxia/ActiveProject");

    expect(result.items).toEqual([
      expect.objectContaining({
        type: "tool_call",
        kind: "file_change",
        text: "已编辑 2 个文件",
        toolCall: expect.objectContaining({ name: "文件修改", status: "completed" }),
        fileChange: expect.objectContaining({
          entries: [
            expect.objectContaining({ path: "src/app.ts", kind: "update", added: 1, removed: 1 }),
            expect.objectContaining({ path: "src/new.ts", kind: "create", added: 1, removed: 0 }),
          ],
          status: "completed",
        }),
      }),
    ]);
  });
});
