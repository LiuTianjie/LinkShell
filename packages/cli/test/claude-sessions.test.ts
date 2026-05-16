import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listClaudeStoredSessions, loadClaudeStoredTimeline } from "../src/runtime/acp/claude-sessions.js";

let homeDir: string | undefined;
const originalHome = process.env.HOME;

function useTempHome(): string {
  homeDir = mkdtempSync(join(tmpdir(), "linkshell-claude-sessions-"));
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

describe("Claude local session discovery", () => {
  it("lists sessions across Claude project directories with cwd, title, and activity time", () => {
    const home = useTempHome();
    const projectsRoot = join(home, ".claude", "projects");
    const alphaProject = join(projectsRoot, "-Users-tifenxia-Alpha");
    const betaProject = join(projectsRoot, "-Users-tifenxia-Beta");
    mkdirSync(alphaProject, { recursive: true });
    mkdirSync(betaProject, { recursive: true });

    writeJsonl(join(alphaProject, "alpha-session.jsonl"), [
      {
        type: "user",
        cwd: "/Users/tifenxia/Alpha",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Build the Alpha workspace" },
      },
      {
        type: "assistant",
        cwd: "/Users/tifenxia/Alpha",
        timestamp: "2026-01-01T00:05:00.000Z",
        message: { role: "assistant", content: "Done" },
      },
    ]);
    writeJsonl(join(betaProject, "beta-session.jsonl"), [
      {
        type: "user",
        timestamp: "2026-01-02T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Inspect Beta" }] },
      },
    ]);

    const result = listClaudeStoredSessions("/fallback");

    expect(result.sessions.map((session) => session.id)).toEqual(["beta-session", "alpha-session"]);
    expect(result.sessions[0]).toMatchObject({
      cwd: "/Users/tifenxia/Beta",
      title: "Inspect Beta",
      createdAt: Date.parse("2026-01-02T00:00:00.000Z"),
      lastModified: Date.parse("2026-01-02T00:00:00.000Z"),
    });
    expect(result.sessions[1]).toMatchObject({
      cwd: "/Users/tifenxia/Alpha",
      title: "Build the Alpha workspace",
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      lastModified: Date.parse("2026-01-01T00:05:00.000Z"),
    });
  });

  it("loads Claude user and assistant messages from device history", () => {
    const home = useTempHome();
    const projectDir = join(home, ".claude", "projects", "-Users-tifenxia-Alpha");
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, "alpha-session.jsonl"), [
      {
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Build Alpha" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-01-01T00:05:00.000Z",
        message: { role: "assistant", content: "Alpha is ready" },
      },
    ]);

    const result = loadClaudeStoredTimeline("alpha-session", "agent:alpha-session");

    expect(result.items).toEqual([
      expect.objectContaining({
        conversationId: "agent:alpha-session",
        role: "user",
        text: "Build Alpha",
      }),
      expect.objectContaining({
        conversationId: "agent:alpha-session",
        role: "assistant",
        text: "Alpha is ready",
      }),
    ]);
  });

  it("loads Claude tool use and tool result blocks as first-class timeline items", () => {
    const home = useTempHome();
    const projectDir = join(home, ".claude", "projects", "-Users-tifenxia-Alpha");
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, "alpha-session.jsonl"), [
      {
        type: "assistant",
        timestamp: "2026-01-01T00:05:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll update the file and run tests." },
            {
              type: "tool_use",
              id: "toolu-edit",
              name: "Edit",
              input: {
                file_path: "/Users/tifenxia/Alpha/src/app.ts",
                old_string: "old",
                new_string: "new\nagain",
              },
            },
            {
              type: "tool_use",
              id: "toolu-bash",
              name: "Bash",
              input: {
                command: "pnpm test",
                cwd: "/Users/tifenxia/Alpha",
              },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-01-01T00:06:00.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu-edit", content: "The file has been updated." },
            { type: "tool_result", tool_use_id: "toolu-bash", content: "Tests passed" },
          ],
        },
      },
    ]);

    const result = loadClaudeStoredTimeline("alpha-session", "agent:alpha-session");

    expect(result.items).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "I'll update the file and run tests.",
      }),
      expect.objectContaining({
        type: "tool_call",
        kind: "file_change",
        itemId: "toolu-edit",
        toolCall: expect.objectContaining({ name: "文件修改", status: "completed", output: "The file has been updated." }),
        fileChange: expect.objectContaining({
          status: "completed",
          entries: [expect.objectContaining({ path: "/Users/tifenxia/Alpha/src/app.ts", kind: "update", added: 2, removed: 1 })],
        }),
      }),
      expect.objectContaining({
        type: "tool_call",
        kind: "command_execution",
        itemId: "toolu-bash",
        toolCall: expect.objectContaining({ name: "命令", status: "completed", output: "Tests passed" }),
        commandExecution: expect.objectContaining({
          command: "pnpm test",
          cwd: "/Users/tifenxia/Alpha",
          output: "Tests passed",
          status: "completed",
        }),
      }),
    ]);
  });

  it("extracts titles from visible user prompts instead of tool-result noise", () => {
    const home = useTempHome();
    const projectDir = join(home, ".claude", "projects", "-Users-tifenxia-Alpha");
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, "alpha-session.jsonl"), [
      {
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "Tool output should not be the title" }],
        },
      },
      {
        type: "user",
        timestamp: "2026-01-01T00:01:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Use this prompt as the title" }] },
      },
    ]);

    const result = listClaudeStoredSessions("/fallback");

    expect(result.sessions[0]).toMatchObject({
      title: "Use this prompt as the title",
    });
  });

  it("normalizes Claude MultiEdit, Write, and NotebookEdit file changes", () => {
    const home = useTempHome();
    const projectDir = join(home, ".claude", "projects", "-Users-tifenxia-Alpha");
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, "alpha-session.jsonl"), [
      {
        type: "assistant",
        timestamp: "2026-01-01T00:05:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-multiedit",
              name: "MultiEdit",
              input: {
                file_path: "/Users/tifenxia/Alpha/src/app.ts",
                edits: [
                  { old_string: "old", new_string: "new\nagain" },
                  { old_string: "before\nalso", new_string: "after" },
                ],
              },
            },
            {
              type: "tool_use",
              id: "toolu-write",
              name: "Write",
              input: {
                file_path: "/Users/tifenxia/Alpha/src/new.ts",
                content: "one\ntwo\n",
              },
            },
            {
              type: "tool_use",
              id: "toolu-notebook",
              name: "NotebookEdit",
              input: {
                notebook_path: "/Users/tifenxia/Alpha/analysis.ipynb",
                new_string: "print('hi')",
              },
            },
          ],
        },
      },
    ]);

    const result = loadClaudeStoredTimeline("alpha-session", "agent:alpha-session");

    expect(result.items).toEqual([
      expect.objectContaining({
        itemId: "toolu-multiedit",
        kind: "file_change",
        fileChange: expect.objectContaining({
          entries: [expect.objectContaining({ kind: "update", added: 3, removed: 3 })],
        }),
      }),
      expect.objectContaining({
        itemId: "toolu-write",
        kind: "file_change",
        fileChange: expect.objectContaining({
          entries: [expect.objectContaining({ kind: "create", added: 2 })],
        }),
      }),
      expect.objectContaining({
        itemId: "toolu-notebook",
        kind: "file_change",
        fileChange: expect.objectContaining({
          entries: [expect.objectContaining({ path: "/Users/tifenxia/Alpha/analysis.ipynb", kind: "update", added: 1 })],
        }),
      }),
    ]);
  });
});
