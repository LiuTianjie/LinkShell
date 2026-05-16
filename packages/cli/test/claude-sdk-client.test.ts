import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSdkClient } from "../src/runtime/acp/claude-sdk-client.js";

let homeDir: string | undefined;
const originalHome = process.env.HOME;

function useTempHome(): string {
  homeDir = mkdtempSync(join(tmpdir(), "linkshell-claude-sdk-"));
  process.env.HOME = homeDir;
  return homeDir;
}

function writeClaudeHistory(sessionId: string, cwd: string): void {
  const home = homeDir ?? useTempHome();
  const projectDir = join(home, ".claude", "projects", cwd.replaceAll("/", "-"));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: "user",
      cwd,
      timestamp: "2026-05-16T00:00:00.000Z",
      message: { role: "user", content: "hello" },
    }),
  ].join("\n") + "\n", "utf8");
}

function makeClient(cwd: string): {
  client: ClaudeSdkClient;
  notifications: Array<{ method: string; params: unknown }>;
  requests: Array<{ method: string; params: unknown }>;
} {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = new ClaudeSdkClient({
    command: "claude-agent-sdk",
    protocol: "claude-agent-sdk",
    framing: "newline",
    cwd,
    onNotification: (method, params) => notifications.push({ method, params }),
    onRequest: (method, params) => {
      requests.push({ method, params });
      return { behavior: "allow" };
    },
    onExit: () => {},
  });
  return { client, notifications, requests };
}

afterEach(() => {
  process.env.HOME = originalHome;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

describe("ClaudeSdkClient", () => {
  it("does not pass placeholder session IDs to SDK resume and adopts system init session IDs", async () => {
    useTempHome();
    const { client, notifications } = makeClient("/workspace");
    let capturedInput: Record<string, any> | undefined;
    (client as any).query = async function* (input: Record<string, any>) {
      capturedInput = input;
      yield { type: "system", subtype: "init", session_id: "claude-real-1", cwd: "/workspace", model: "sonnet" };
      yield { type: "result", session_id: "claude-real-1", subtype: "success" };
    };

    await client.loadSession({ sessionId: "agent-session-placeholder", cwd: "/workspace" });
    const result = await client.prompt({
      sessionId: "agent-session-placeholder",
      content: [{ type: "text", text: "hello" }],
      clientMessageId: "msg-1",
      cwd: "/workspace",
    });

    expect(capturedInput?.options).not.toHaveProperty("resume");
    expect(result).toMatchObject({ sessionId: "claude-real-1" });
    expect(notifications).toContainEqual(expect.objectContaining({
      method: "thread/started",
      params: expect.objectContaining({ sessionId: "claude-real-1", threadId: "claude-real-1" }),
    }));
    expect(notifications).toContainEqual(expect.objectContaining({
      method: "initialized",
      params: expect.objectContaining({ sessionId: "claude-real-1", cwd: "/workspace", model: "sonnet" }),
    }));
  });

  it("rejects resume when the stored Claude session belongs to another cwd", async () => {
    useTempHome();
    writeClaudeHistory("claude-real-2", "/workspace/a");
    const { client } = makeClient("/workspace/b");

    await expect(client.loadSession({ sessionId: "claude-real-2", cwd: "/workspace/b" }))
      .rejects.toThrow("belongs to /workspace/a");
  });

  it("builds SDK options and permission policy from LinkShell settings", async () => {
    useTempHome();
    const { client, requests } = makeClient("/workspace");
    let capturedOptions: Record<string, any> | undefined;
    (client as any).query = async function* (input: Record<string, any>) {
      capturedOptions = input.options;
      yield { type: "result", session_id: "claude-real-3", subtype: "success" };
    };

    await client.prompt({
      content: [{ type: "text", text: "hello" }],
      clientMessageId: "msg-2",
      model: "sonnet",
      reasoningEffort: "minimal",
      permissionMode: "read_only",
      cwd: "/workspace",
    });

    expect(capturedOptions).toMatchObject({
      cwd: "/workspace",
      model: "sonnet",
      effort: "low",
      permissionMode: "dontAsk",
    });
    await expect(capturedOptions?.canUseTool("Read", { file_path: "/workspace/a.ts" })).resolves.toEqual({ behavior: "allow" });
    await expect(capturedOptions?.canUseTool("Write", { file_path: "/workspace/a.ts" })).resolves.toMatchObject({ behavior: "deny" });
    await expect(capturedOptions?.canUseTool("NotebookEdit", { notebook_path: "/workspace/a.ipynb" })).resolves.toMatchObject({ behavior: "deny" });
    await expect(capturedOptions?.canUseTool("CustomTool", {})).resolves.toEqual({ behavior: "allow" });
    expect(requests).toHaveLength(1);
  });

  it("allows workspace file edits and routes risky workspace_write tools to approval", async () => {
    useTempHome();
    const { client, requests } = makeClient("/workspace");
    let capturedOptions: Record<string, any> | undefined;
    (client as any).query = async function* (input: Record<string, any>) {
      capturedOptions = input.options;
      yield { type: "result", session_id: "claude-real-4", subtype: "success" };
    };

    await client.prompt({
      content: [{ type: "text", text: "edit" }],
      clientMessageId: "msg-3",
      permissionMode: "workspace_write",
      cwd: "/workspace",
    });

    await expect(capturedOptions?.canUseTool("Edit", { file_path: "/workspace/src/app.ts" })).resolves.toEqual({ behavior: "allow" });
    await expect(capturedOptions?.canUseTool("NotebookEdit", { notebook_path: "/workspace/analysis.ipynb" })).resolves.toEqual({ behavior: "allow" });
    await expect(capturedOptions?.canUseTool("Edit", { file_path: "/outside/app.ts" })).resolves.toEqual({ behavior: "allow" });
    await expect(capturedOptions?.canUseTool("Bash", { command: "pnpm test" })).resolves.toEqual({ behavior: "allow" });
    expect(requests.map((request) => (request.params as any).toolCall.toolName)).toEqual(["Edit", "Bash"]);
  });

  it("uses bypass permissions for full access and plan mode takes priority", async () => {
    useTempHome();
    const { client } = makeClient("/workspace");
    const optionSnapshots: Record<string, any>[] = [];
    (client as any).query = async function* (input: Record<string, any>) {
      optionSnapshots.push(input.options);
      yield { type: "result", session_id: "claude-real-5", subtype: "success" };
    };

    await client.prompt({
      content: [{ type: "text", text: "full" }],
      clientMessageId: "msg-4",
      permissionMode: "full_access",
      cwd: "/workspace",
    });
    await client.prompt({
      content: [{ type: "text", text: "plan" }],
      clientMessageId: "msg-5",
      permissionMode: "full_access",
      collaborationMode: "plan",
      cwd: "/workspace",
    });

    expect(optionSnapshots[0]).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    await expect(optionSnapshots[0]?.canUseTool("Bash", { command: "rm -rf tmp" })).resolves.toEqual({ behavior: "allow" });
    expect(optionSnapshots[1]).toMatchObject({ permissionMode: "plan" });
    expect(optionSnapshots[1]).not.toHaveProperty("allowDangerouslySkipPermissions");
  });

  it("maps SDK Bash, file edit, and ordinary tool blocks to Agent v2 items", async () => {
    useTempHome();
    const { client, notifications } = makeClient("/workspace");
    (client as any).query = async function* () {
      yield {
        type: "assistant",
        uuid: "assistant-1",
        message: {
          id: "assistant-msg",
          content: [
            { type: "text", text: "Working" },
            { type: "tool_use", id: "tool-bash", name: "Bash", input: { command: "pnpm test", cwd: "/workspace" } },
            { type: "tool_use", id: "tool-notebook", name: "NotebookEdit", input: { notebook_path: "/workspace/a.ipynb", new_string: "print(1)" } },
            { type: "tool_use", id: "tool-web", name: "WebFetch", input: { url: "https://example.com" } },
          ],
        },
      };
      yield {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-bash", content: "tests passed" },
            { type: "tool_result", tool_use_id: "tool-notebook", content: "notebook updated" },
            { type: "tool_result", tool_use_id: "tool-web", content: "fetched" },
          ],
        },
      };
      yield { type: "result", session_id: "claude-real-6", subtype: "success" };
    };

    await client.prompt({
      content: [{ type: "text", text: "run" }],
      clientMessageId: "msg-6",
      cwd: "/workspace",
    });

    const startedItems = notifications
      .filter((notification) => notification.method === "item/started")
      .map((notification) => (notification.params as any).item);
    expect(startedItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "tool-bash", type: "commandExecution", command: "pnpm test" }),
      expect.objectContaining({
        id: "tool-notebook",
        type: "fileChange",
        path: "/workspace/a.ipynb",
        changes: [expect.objectContaining({ path: "/workspace/a.ipynb", kind: "update" })],
      }),
      expect.objectContaining({ id: "tool-web", type: "toolCall", toolName: "WebFetch" }),
    ]));
    const completedItems = notifications
      .filter((notification) => notification.method === "item/completed")
      .map((notification) => (notification.params as any).item);
    expect(completedItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "tool-bash", type: "commandExecution", output: "tests passed" }),
      expect.objectContaining({ id: "tool-notebook", type: "fileChange", output: "notebook updated" }),
      expect.objectContaining({ id: "tool-web", type: "toolCall", output: "fetched" }),
    ]));
  });
});
