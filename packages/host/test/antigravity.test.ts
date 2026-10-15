import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_ACP_VERSION,
  antigravityAuthStatus,
  cleanAntigravityUserInput,
  extractAntigravityAuthUrl,
  parseAntigravityTranscript,
  resolveAntigravityLaunch,
} from "../src/drivers/acp/antigravity.js";
import { mapPermissionRequest, normalizeAcpUpdate } from "../src/drivers/acp/mapper.js";
import { mapAcpQuestions, questionMethod } from "../src/drivers/acp/questions.js";

describe("Antigravity ACP binary & environment resolution", () => {
  it("resolves agy_acp_server.par and sibling localharness_external from managed tool roots", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-agy-test-"));
    try {
      const targetKey = `${process.platform}-${process.arch}`;
      const binDir = join(root, "tools", "antigravity-acp", ANTIGRAVITY_ACP_VERSION, targetKey);
      mkdirSync(binDir, { recursive: true });
      const binaryName = process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
      const harnessName = process.platform === "win32" ? "localharness_external.exe" : "localharness_external";
      const binaryPath = join(binDir, binaryName);
      const harnessPath = join(binDir, harnessName);
      writeFileSync(binaryPath, "#!/bin/sh\n");
      writeFileSync(harnessPath, "#!/bin/sh\n");
      chmodSync(binaryPath, 0o755);
      chmodSync(harnessPath, 0o755);

      const resolved = resolveAntigravityLaunch({
        LINKSHELL_HOME: root,
        PATH: "",
      });
      expect(resolved).toBeDefined();
      expect(resolved!.command).toBe(binaryPath);
      expect(resolved!.version).toBe(ANTIGRAVITY_ACP_VERSION);
      expect(resolved!.env.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
      expect(resolved!.env.PYTHONUNBUFFERED).toBe("1");
      expect(resolved!.env.ANTIGRAVITY_HARNESS_PATH).toBe(harnessPath);
      expect(resolved!.env.TMPDIR).toContain("linkshell-antigravity-tmp");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts Google OAuth URLs from plain-text stdout lines", () => {
    const line =
      "Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?client_id=123";
    expect(extractAntigravityAuthUrl(line)).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=123",
    );
    expect(extractAntigravityAuthUrl('{"jsonrpc":"2.0","id":1}')).toBeUndefined();
  });

  it("reports auth status from GEMINI_API_KEY or Google Cloud env vars", async () => {
    expect(await antigravityAuthStatus({ GEMINI_API_KEY: "test-key" })).toEqual({
      state: "ok",
      method: "gemini-api-key",
    });
    expect(await antigravityAuthStatus({ GOOGLE_API_KEY: "test-key" })).toEqual({
      state: "ok",
      method: "agent-platform",
    });
    expect(await antigravityAuthStatus({})).toEqual({ state: "unknown" });
  });
});

describe("Antigravity ACP protocol mapping", () => {
  it("normalizes PascalCase tool rawInput/rawOutput and subagent calls", () => {
    const execUpdate = normalizeAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Run command",
      kind: "execute",
      status: "completed",
      rawInput: {
        CommandLine: "pnpm test",
        Cwd: "/Users/test/repo",
      },
      rawOutput: {
        combinedOutput: "PASS all tests",
        exit_code: 0,
      },
    });
    expect(execUpdate).toMatchObject({
      sessionUpdate: "tool_call",
      rawInput: {
        command: "pnpm test",
        cwd: "/Users/test/repo",
      },
      rawOutput: {
        output: "PASS all tests",
        exitCode: 0,
      },
    });

    const subagentCall = normalizeAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "sub_1",
      title: "Running start_subagent",
      kind: "other",
      status: "in_progress",
      rawInput: {
        agent_name: "researcher",
        task_description: "Inspect ACP protocol",
      },
    });
    expect(subagentCall).toMatchObject({
      sessionUpdate: "tool_call",
      detail: {
        type: "subagent",
        action: "spawn",
        agentType: "researcher",
        name: "researcher",
        task: "Inspect ACP protocol",
      },
    });
  });

  it("maps interaction_* permission requests into interactive user Question cards", () => {
    const params = {
      sessionId: "sess-1",
      toolCall: {
        toolCallId: "interaction_0",
        title: "Which approach should we take?",
      },
      options: [
        { optionId: "opt_a", name: "Use hybrid ACP v2", kind: "allow_once" },
        { optionId: "opt_b", name: "Use legacy wrapper", kind: "reject_once" },
      ],
    };
    expect(questionMethod("antigravity", "session/request_permission", params)).toBe("antigravity-interaction");
    const mapped = mapAcpQuestions("antigravity", "session/request_permission", params, "req-42");
    expect(mapped.update.questions).toEqual([
      {
        id: "interaction_0",
        header: "提问",
        text: "Which approach should we take?",
        kind: "choice",
        options: [
          { value: "opt_a", label: "Use hybrid ACP v2" },
          { value: "opt_b", label: "Use legacy wrapper" },
        ],
      },
    ]);
    expect(mapped.answer([{ id: "interaction_0", values: ["opt_a"] }])).toEqual({
      outcome: { outcome: "selected", optionId: "opt_a" },
    });
    expect(mapped.respond("cancel")).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("surfaces _meta['agy.security.warning'] in permission requests", () => {
    const perm = mapPermissionRequest(
      {
        sessionId: "sess-1",
        _meta: {
          "agy.security.warning": "This command modifies files outside the workspace.",
        },
        toolCall: {
          toolCallId: "cmd_1",
          title: "Run rm -rf /tmp/test",
          kind: "execute",
          rawInput: {
            CommandLine: "rm -rf /tmp/test",
          },
        },
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "reject_once", name: "Deny", kind: "reject_once" },
        ],
      },
      "req-99",
    );
    expect(perm).toBeDefined();
    expect(perm!.update.detail).toContain("rm -rf /tmp/test");
    expect(perm!.update.detail).toContain("This command modifies files outside the workspace.");
  });

  it("parses Antigravity Desktop transcript.jsonl into HistoryItems", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-agy-transcript-"));
    try {
      const transcriptPath = join(root, "transcript.jsonl");
      const lines = [
        JSON.stringify({
          step_index: 1,
          type: "USER_INPUT",
          created_at: "2026-10-15T10:00:00Z",
          content: "<USER_REQUEST>\nFix the desktop transcript parser\n</USER_REQUEST>",
        }),
        JSON.stringify({
          step_index: 2,
          type: "PLANNER_RESPONSE",
          created_at: "2026-10-15T10:00:02Z",
          thinking: "Let me check the transcript format.",
          content: "I will inspect the logs and implement the parser.",
          tool_calls: [
            {
              id: "call_view_1",
              name: "view_file",
              args: { AbsolutePath: "/Users/test/file.ts", toolSummary: "View file.ts" },
            },
          ],
        }),
        JSON.stringify({
          step_index: 3,
          type: "GENERIC",
          created_at: "2026-10-15T10:00:03Z",
          content: "1: export const ok = true;",
        }),
      ];
      writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

      expect(cleanAntigravityUserInput("<USER_REQUEST>\nhello world\n</USER_REQUEST>")).toBe("hello world");
      const parsed = parseAntigravityTranscript(transcriptPath);
      expect(parsed.nextLine).toBe(3);
      expect(parsed.items).toHaveLength(2);
      expect(parsed.items[0]).toMatchObject({
        itemId: "agy:user:1",
        updates: [
          {
            sessionUpdate: "user_message_chunk",
            messageId: "agy:user:1",
            content: { type: "text", text: "Fix the desktop transcript parser" },
          },
        ],
      });
      expect(parsed.items[1]?.itemId).toBe("agy:step:2");
      expect(parsed.items[1]?.updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Let me check the transcript format." },
          }),
          expect.objectContaining({
            sessionUpdate: "tool_call",
            toolCallId: "call_view_1",
            kind: "read",
            status: "completed",
            rawInput: { file_path: "/Users/test/file.ts" },
            rawOutput: { output: "1: export const ok = true;" },
          }),
          expect.objectContaining({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "I will inspect the logs and implement the parser." },
          }),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

