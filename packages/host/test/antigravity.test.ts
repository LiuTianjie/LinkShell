import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ANTIGRAVITY_ACP_VERSION,
  AntigravityDriver,
  antigravityAuthStatus,
  cleanAntigravityUserInput,
  extractAntigravityAuthUrl,
  newTranscriptParseState,
  parseAntigravityTranscript,
  resolveAntigravityLaunch,
  TranscriptTail,
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

  it("reads model names that carry dots, as Antigravity writes them", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-agy-model-"));
    try {
      const change = (from: string, to: string) =>
        `<USER_REQUEST>\nhi\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from ${from} to ${to}. No need to comment on this change if the user doesn't ask about it. If reporting what model you are, please use a human readable name.\n</USER_SETTINGS_CHANGE>`;
      const write = (name: string, contents: string[]) => {
        const path = join(root, name);
        writeFileSync(path, `${contents.map((content, index) => JSON.stringify({ step_index: index, type: "USER_INPUT", content })).join("\n")}\n`);
        return path;
      };
      expect(parseAntigravityTranscript(write("a.jsonl", [change("None", "Claude Opus 5.5 (High)")]), 0).lastModelLabel).toBe("Claude Opus 5.5 (High)");
      expect(parseAntigravityTranscript(write("b.jsonl", [change("None", "Claude Opus 5.5 (High)"), change("Claude Opus 5.5 (High)", "Gemini 3.8 Flash (Low)")]), 0).lastModelLabel).toBe("Gemini 3.8 Flash (Low)");
      expect(parseAntigravityTranscript(write("c.jsonl", [change("Claude Sonnet 5.5 (Medium)", "Gemini 4 Argon (High)")]), 0).lastModelLabel).toBe("Gemini 4 Argon (High)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses Goal Mode lifecycle, strips HTML/system tags, extracts model selection, and loads uploaded images", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-agy-goal-"));
    try {
      const imgPath = join(root, "upload.png");
      const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
      writeFileSync(imgPath, pngBytes);

      const transcriptPath = join(root, "transcript_full.jsonl");
      const lines = [
        JSON.stringify({
          step_index: 10,
          type: "USER_INPUT",
          content:
            "<USER_REQUEST>\n/goal Optimize pipeline under 15 minutes\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Argon (Medium) to Gemini 4 Argon (High). No need to comment on this change if the user doesn't ask about it.\n</USER_SETTINGS_CHANGE>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Argon (High) to None.\n</USER_SETTINGS_CHANGE>\n<ADDITIONAL_METADATA>\n/goal is a [Slash Command]:\nOnce complete, include <!-- GOAL_COMPLETE --> in your response.\n</ADDITIONAL_METADATA>",
          media: [{ mime_type: "image/png", uri: imgPath }],
        }),
        JSON.stringify({
          step_index: 11,
          type: "SYSTEM_MESSAGE",
          content:
            "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\nStop hook blocked termination: You are still working toward the user's goal. Do not stop until the task is fully complete.\n\nTime spent so far: 1h 8m\nContinuation: #2\n\nOriginal request: Optimize pipeline under 15 minutes\n</SYSTEM_MESSAGE>",
        }),
        JSON.stringify({
          step_index: 12,
          type: "PLANNER_RESPONSE",
          content: "All deliverables verified and complete.\n\n<!-- GOAL_COMPLETE -->",
        }),
      ];
      writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

      const parsed = parseAntigravityTranscript(transcriptPath, 0);
      expect(parsed.lastModelLabel).toBe("Gemini 4 Argon (High)");
      expect(parsed.goal).toEqual({
        objective: "Optimize pipeline under 15 minutes",
        status: "complete",
        iterations: 2,
        timeUsedSeconds: 4080,
      });
      expect(parsed.items).toHaveLength(3);

      // Step 10: user message with image + stripped /goal text + active ls_goal update
      expect(parsed.items[0]?.updates).toEqual([
        {
          sessionUpdate: "user_message_chunk",
          messageId: "agy:user:10",
          content: { type: "image", mimeType: "image/png", data: pngBytes.toString("base64") },
        },
        {
          sessionUpdate: "user_message_chunk",
          messageId: "agy:user:10",
          content: { type: "text", text: "Optimize pipeline under 15 minutes" },
        },
        {
          sessionUpdate: "ls_goal",
          goal: { objective: "Optimize pipeline under 15 minutes", status: "active" },
        },
      ]);

      // Step 11: SYSTEM_MESSAGE goal continuation progress
      expect(parsed.items[1]?.updates).toEqual([
        {
          sessionUpdate: "ls_goal",
          goal: {
            objective: "Optimize pipeline under 15 minutes",
            status: "active",
            iterations: 2,
            timeUsedSeconds: 4080,
          },
        },
      ]);

      // Step 12: PLANNER_RESPONSE strips <!-- GOAL_COMPLETE --> and emits ls_goal complete
      expect(parsed.items[2]?.updates).toEqual([
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "agy:msg:12",
          content: { type: "text", text: "All deliverables verified and complete." },
        },
        {
          sessionUpdate: "ls_message_done",
          messageId: "agy:msg:12",
          role: "agent",
        },
        {
          sessionUpdate: "ls_goal",
          goal: {
            objective: "Optimize pipeline under 15 minutes",
            status: "complete",
            iterations: 2,
            timeUsedSeconds: 4080,
          },
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts pending ask_question, incremental GENERIC tool outputs, and ERROR_MESSAGE steps", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-agy-ask-"));
    try {
      const transcriptPath = join(root, "transcript_full.jsonl");
      const initialLines = [
        JSON.stringify({
          step_index: 20,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            {
              id: "call_ask_1",
              name: "ask_question",
              args: {
                toolSummary: "Ask user about background sync",
                questions: [
                  {
                    question: "Should Live Activity stay active in background?",
                    is_multi_select: false,
                    options: ["(Recommended) Keep alive while running", "Allow stale after 2m"],
                  },
                ],
              },
            },
          ],
        }),
      ];
      writeFileSync(transcriptPath, `${initialLines.join("\n")}\n`);

      const pass1 = parseAntigravityTranscript(transcriptPath, 0);
      expect(pass1.nextLine).toBe(1);
      expect(pass1.lastStepIndex).toBe(20);
      expect(pass1.pendingAskQuestion).toEqual({
        stepIndex: 21,
        toolCallId: "call_ask_1",
        title: "Ask user about background sync",
        questions: [
          {
            question: "Should Live Activity stay active in background?",
            options: [
              { id: "1", text: "(Recommended) Keep alive while running" },
              { id: "2", text: "Allow stale after 2m" },
            ],
          },
        ],
      });
      expect(pass1.items[0]?.updates[0]).toMatchObject({
        sessionUpdate: "tool_call",
        toolCallId: "call_ask_1",
        detail: {
          type: "question",
          text: "Should Live Activity stay active in background?",
        },
      });

      // Append GENERIC answer output and an ERROR_MESSAGE, then parse incrementally from pass1.nextLine
      const nextLines = [
        ...initialLines,
        JSON.stringify({
          step_index: 21,
          type: "GENERIC",
          content: '[{"Question":"Should Live Activity stay active in background?","SelectedOptions":["(Recommended) Keep alive while running"]}]',
        }),
        JSON.stringify({
          step_index: 22,
          type: "ERROR_MESSAGE",
          content: "Rate limit exceeded on upstream model",
        }),
      ];
      writeFileSync(transcriptPath, `${nextLines.join("\n")}\n`);

      const pass2 = parseAntigravityTranscript(transcriptPath, pass1.nextLine);
      expect(pass2.nextLine).toBe(3);
      expect(pass2.lastStepIndex).toBe(22);
      expect(pass2.pendingAskQuestion).toBeUndefined();
      expect(pass2.items).toHaveLength(2);
      expect(pass2.items[0]?.updates[0]).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_ask_1",
        status: "completed",
        detail: {
          type: "question",
          text: "Should Live Activity stay active in background?",
        },
      });
      expect(pass2.items[1]?.updates[0]).toEqual({
        sessionUpdate: "ls_error",
        code: "agent_error",
        message: "Rate limit exceeded on upstream model",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Antigravity transcript tail and tool mapping", () => {
  const line = (step: Record<string, unknown>) => `${JSON.stringify(step)}\n`;

  it("follows a transcript by offset, holding back a half-written line, and settles tool calls when outputs arrive", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-agy-tail-"));
    try {
      const path = join(root, "transcript_full.jsonl");
      const reply = line({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ id: "call_run", name: "run_command", args: { CommandLine: "pnpm test", Cwd: "/repo", toolSummary: "Run tests" } }],
        created_at: "2026-10-17T02:00:00.000Z",
        input_tokens: 100,
        cache_read_tokens: 900,
        output_tokens: 20,
      });
      const output = line({ step_index: 2, type: "GENERIC", status: "DONE", content: "Created At: x\nCompleted At: y\nPASS" });
      writeFileSync(path, line({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\nrun tests\n</USER_REQUEST>" }));
      const tail = new TranscriptTail(path, newTranscriptParseState(), 0);
      expect(tail.read(path).items.map((item) => item.itemId)).toEqual(["agy:user:0"]);

      // Half of the reply line: nothing yet.
      appendFileSync(path, reply.slice(0, 40));
      expect(tail.read(path).items).toEqual([]);
      appendFileSync(path, reply.slice(40));
      const pass2 = tail.read(path);
      expect(pass2.items[0]?.updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "call_run", kind: "execute", status: "in_progress" }),
          expect.objectContaining({ sessionUpdate: "usage_update", usedTokens: 1000, accounting: expect.objectContaining({ id: "agy:step:1", scope: "turn", timestamp: Date.parse("2026-10-17T02:00:00.000Z") }) }),
        ]),
      );

      appendFileSync(path, output);
      expect(tail.read(path).items[0]?.updates[0]).toEqual({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_run",
        status: "completed",
        rawOutput: { output: "PASS" },
      });
      expect(tail.state.lastStepIndex).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps edits to diffs, failed steps to failed calls, sub-agents, MCP calls and compactions", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-agy-tools-"));
    try {
      const path = join(root, "transcript_full.jsonl");
      writeFileSync(
        path,
        [
          line({
            step_index: 1,
            type: "PLANNER_RESPONSE",
            tool_calls: [
              { id: "w", name: "write_to_file", args: { TargetFile: "/repo/a.ts", CodeContent: "export {};\n" } },
              { id: "r", name: "replace_file_content", args: { TargetFile: "/repo/b.ts", TargetContent: "old", ReplacementContent: "new" } },
              { id: "s", name: "invoke_subagent", args: { Subagents: [{ TypeName: "research", Role: "Researcher", Prompt: "Look around" }] } },
              { id: "m", name: "call_mcp_tool", args: { ServerName: "supabase", ToolName: "execute_sql", Arguments: { query: "select 1" } } },
            ],
          }),
          line({ step_index: 2, type: "GENERIC", status: "DONE", content: "Created file" }),
          line({ step_index: 3, type: "GENERIC", status: "ERROR", error: "target content not found" }),
          line({ step_index: 4, type: "GENERIC", status: "DONE", content: 'Created the following subagents:\n{ "conversationId":  "1387c386-51c1-4a2c-b02a-a266794155bd" }' }),
          line({ step_index: 5, type: "GENERIC", status: "DONE", content: "[]" }),
          line({ step_index: 6, type: "CHECKPOINT", content: "# Resuming from a compaction" }),
        ].join(""),
      );
      const { items } = parseAntigravityTranscript(path, 0);
      const calls = items.flatMap((item) => item.updates).filter((u) => u.sessionUpdate === "tool_call");
      expect(calls[0]).toMatchObject({ toolCallId: "w", kind: "edit", status: "completed", content: [{ type: "diff", path: "/repo/a.ts", oldText: null, newText: "export {};\n" }] });
      expect(calls[1]).toMatchObject({ toolCallId: "r", status: "failed", content: [{ type: "diff", oldText: "old", newText: "new" }], rawOutput: { output: "target content not found" } });
      expect(calls[2]).toMatchObject({
        toolCallId: "s",
        detail: { type: "subagent", action: "spawn", agentType: "research", name: "Researcher", task: "Look around", nativeSessionId: "1387c386-51c1-4a2c-b02a-a266794155bd" },
      });
      expect(calls[3]).toMatchObject({ toolCallId: "m", detail: { type: "mcp", server: "supabase", tool: "execute_sql" }, rawInput: { query: "select 1" } });
      expect(calls[4]).toMatchObject({ toolCallId: "agy:checkpoint:6", detail: { type: "compaction" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives each sub-agent of a multi-agent invoke_subagent its own spawning call", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-agy-spawn-"));
    try {
      const path = join(root, "transcript_full.jsonl");
      writeFileSync(
        path,
        line({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          tool_calls: [{ id: "spawn", name: "invoke_subagent", args: { Subagents: [{ Role: "A", Prompt: "a" }, { Role: "B", Prompt: "b", TypeName: "research" }] } }],
        }) +
          line({
            step_index: 2,
            type: "GENERIC",
            content: '{ "conversationId": "11111111-1111-1111-1111-111111111111" }\n{ "conversationId": "22222222-2222-2222-2222-222222222222" }',
          }),
      );
      const calls = parseAntigravityTranscript(path, 0).items.flatMap((item) => item.updates).filter((u) => u.sessionUpdate === "tool_call");
      expect(calls.map((call) => [call.toolCallId, call.detail?.type === "subagent" ? call.detail.nativeSessionId : undefined])).toEqual([
        ["spawn", "11111111-1111-1111-1111-111111111111"],
        ["spawn#1", "22222222-2222-2222-2222-222222222222"],
      ]);
      expect(calls[1]).toMatchObject({ title: "B", detail: { name: "B", agentType: "research", task: "b" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});





describe("Antigravity desktop question reconciliation", () => {
  it.each(["DONE", "CANCELED", "ERROR"])("clears a %s native question even when its transcript still contains the tool call", async (status) => {
    const driver = new AntigravityDriver({ hostVersion: "test", env: { PATH: "" } });
    const harness = driver as unknown as {
      languageServer: () => Promise<unknown>;
      isConversationRunningInDesktop: () => boolean;
      pollDesktopInteractions: (id: string, watcher: unknown) => Promise<void>;
    };
    harness.languageServer = async () => ({ httpPort: 12345, csrfToken: "test" });
    harness.isConversationRunningInDesktop = () => false;
    const question = { stepIndex: 4, toolCallId: "call-ask", title: "Choose database", questions: [{ question: "Database?", options: [{ id: "1", text: "SQLite" }] }] };
    const watcher = {
      pollingInteractions: false, lastStepIndex: 3, resolvedStepIndices: new Set<number>(),
      transcriptPending: question,
      pendingAction: { ...question, kind: "question", requestId: "agy-ask:test:4", trajectoryId: "trajectory" },
    };
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ steps: [{
      type: "CORTEX_STEP_TYPE_ASK_QUESTION", status: `CORTEX_STEP_STATUS_${status}`,
      metadata: { sourceTrajectoryStepInfo: { trajectoryId: "trajectory", stepIndex: 4 } },
      askQuestion: { questions: question.questions },
    }] }), { status: 200 }));
    try {
      await harness.pollDesktopInteractions("test", watcher);
      expect(watcher.pendingAction).toBeUndefined();
      expect(watcher.resolvedStepIndices.has(4)).toBe(true);
      await harness.pollDesktopInteractions("test", watcher);
      expect(watcher.pendingAction).toBeUndefined();
    } finally {
      request.mockRestore();
    }
  });
});
