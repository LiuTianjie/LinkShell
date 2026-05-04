import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { readdirSync, existsSync } from "node:fs";
import { join, basename, relative, resolve } from "node:path";
import type { AgentFraming, AgentProtocol } from "./provider-resolver.js";

type AgentPermissionMode = "read_only" | "workspace_write" | "full_access";

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  message?: Record<string, unknown>;
  session_id?: string;
  parent_tool_use_id?: string | null;
  uuid?: string;
  [key: string]: unknown;
}

interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  signature?: string;
}

// Hash a directory path the same way Claude Code does for project storage
function projectHash(cwd: string): string {
  return (
    "-" +
    resolve(cwd)
      .replace(/\/$/, "")
      .replace(/\//g, "-")
  );
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class ClaudeStreamJsonClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private claudeSessionId: string | undefined;
  private pendingCancel = false;
  private messageBuffer = "";

  constructor(
    private readonly input: {
      command: string;
      protocol: AgentProtocol;
      framing: AgentFraming;
      cwd: string;
      onNotification: (method: string, params: unknown) => void;
      onRequest: (method: string, params: unknown) => Promise<unknown> | unknown;
      onExit: (message: string) => void;
    },
  ) {}

  async initialize(): Promise<unknown> {
    // No persistent process to start — we'll capture session on first prompt.
    // But we can verify the binary exists by running a quick --help.
    try {
      const { execSync } = await import("node:child_process");
      execSync("claude --version", { stdio: "ignore", timeout: 5000 });
    } catch {
      throw new Error("Claude Code CLI not found or not executable");
    }
    return { status: "ok" };
  }

  async newSession(input: { cwd: string; mcpServers?: unknown }): Promise<unknown> {
    // Start a dry-run prompt to get a session_id, then cancel.
    // Actually, we just store that there's no session yet — the real session
    // will be created on the first prompt() call.
    this.claudeSessionId = undefined;
    return { sessionId: undefined, status: "ready" };
  }

  async loadSession(input: { sessionId: string; cwd: string; mcpServers?: unknown }): Promise<unknown> {
    this.claudeSessionId = input.sessionId;
    return { sessionId: input.sessionId, status: "loaded" };
  }

  async prompt(input: {
    sessionId?: string;
    content: unknown[];
    clientMessageId: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: AgentPermissionMode;
    cwd: string;
  }): Promise<unknown> {
    if (this.child) {
      this.stop();
    }

    this.pendingCancel = false;

    // Build Claude args
    const args: string[] = [
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
    ];

    // Use stored session for --continue or --resume
    if (input.sessionId || this.claudeSessionId) {
      const sid = input.sessionId ?? this.claudeSessionId;
      if (sid) {
        args.push("--resume", sid);
      }
    }

    if (input.model) {
      args.push("--model", input.model);
    }

    // Build the user message
    const contentBlocks = (input.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>).map(
      (block) => {
        if (block.type === "image" && block.data) {
          return { type: "image", source: { type: "base64", media_type: block.mimeType ?? "image/png", data: block.data } };
        }
        return { type: "text", text: block.text ?? "" };
      },
    );

    const userMessage = {
      type: "user",
      message: {
        role: "user",
        content: contentBlocks,
      },
    };

    return new Promise((resolve, reject) => {
      const cwd = input.cwd ?? this.input.cwd;
      const child = spawn("claude", args, {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.child = child;
      let settled = false;

      const finish = (err: Error | null, result: unknown) => {
        if (settled) return;
        settled = true;
        this.child = undefined;
        if (err) {
          this.input.onExit(err.message);
          reject(err);
        } else {
          resolve(result);
        }
      };

      // Send the prompt
      child.stdin.write(JSON.stringify(userMessage) + "\n");
      child.stdin.end();

      // Read stdout line by line (stream-json is newline-delimited)
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let currentToolId: string | undefined;

      rl.on("line", (line: string) => {
        if (this.pendingCancel) {
          child.kill("SIGTERM");
          return;
        }

        let event: ClaudeStreamEvent;
        try {
          event = JSON.parse(line);
        } catch {
          return; // skip unparseable lines
        }

        switch (event.type) {
          case "system": {
            if (event.subtype === "init") {
              // Capture session ID
              if (event.session_id) {
                this.claudeSessionId = event.session_id;
              }
              // Send as initialized notification — workspace needs this
              const initParams: Record<string, unknown> = {
                sessionId: event.session_id,
                cwd: event.cwd ?? cwd,
                model: event.model,
              };
              if (event.tools) initParams.tools = event.tools;
              if (event.mcp_servers) initParams.mcpServers = event.mcp_servers;
              this.input.onNotification("initialized", initParams);
            }
            // Hook events and other system messages are informational, skip
            break;
          }

          case "assistant": {
            const message = event.message;
            if (!message) break;
            const content = (message.content ?? []) as ClaudeContentBlock[];

            for (const block of content) {
              switch (block.type) {
                case "thinking":
                  this.input.onNotification("item/started", {
                    sessionId: this.claudeSessionId,
                    item: {
                      id: event.uuid ?? id("thinking"),
                      type: "thinking",
                      text: block.thinking,
                      status: "completed",
                    },
                  });
                  break;

                case "text":
                  this.input.onNotification("item/agentMessage/delta", {
                    sessionId: this.claudeSessionId,
                    itemId: message.id ?? event.uuid ?? id("msg"),
                    delta: block.text,
                  });
                  break;

                case "tool_use": {
                  currentToolId = block.id;
                  const toolName = block.name ?? "tool";
                  this.input.onNotification("item/started", {
                    sessionId: this.claudeSessionId,
                    item: {
                      id: block.id ?? id("tool"),
                      type: toolName === "Bash" ? "commandExecution" : toolName === "Write" || toolName === "Edit" ? "fileChange" : "toolCall",
                      toolName: block.name,
                      tool: block.name,
                      input: block.input,
                      command: block.input?.command as string | undefined,
                      cwd: block.input?.cwd as string | undefined ?? cwd,
                      status: "running",
                    },
                  });
                  break;
                }

                case "tool_result":
                  // tool_result comes in user messages, not assistant
                  break;
              }
            }
            break;
          }

          case "user": {
            // User messages in stream-json contain tool results
            const message = event.message;
            if (!message) break;
            const content = (message.content ?? []) as ClaudeContentBlock[];

            for (const block of content) {
              if (block.type === "tool_result") {
                const toolId = block.tool_use_id ?? currentToolId;
                const isError = block.is_error === true;
                this.input.onNotification("item/completed", {
                  sessionId: this.claudeSessionId,
                  item: {
                    id: toolId ?? id("tool"),
                    type: "toolCall",
                    status: isError ? "failed" : "completed",
                    output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
                    aggregatedOutput: typeof block.content === "string" ? block.content : undefined,
                    isError,
                  },
                });
              }
            }
            break;
          }

          case "result": {
            // Turn complete
            const isError = event.subtype === "error" || event.is_error === true;
            this.input.onNotification("turn/completed", {
              sessionId: this.claudeSessionId,
              stopReason: event.stop_reason ?? (isError ? "error" : "end_turn"),
              durationMs: event.duration_ms,
              totalCostUsd: event.total_cost_usd,
              usage: event.usage,
              isError,
            });
            finish(null, { sessionId: this.claudeSessionId, status: isError ? "error" : "completed" });
            break;
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const trimmed = chunk.toString().trim();
        if (trimmed) process.stderr.write(`[claude:stderr] ${trimmed}\n`);
      });

      child.on("error", (err) => {
        finish(err, undefined);
      });

      child.on("exit", (code, signal) => {
        if (!settled) {
          finish(
            new Error(`Claude exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`),
            undefined,
          );
        }
      });
    });
  }

  cancel(input: { sessionId?: string; turnId?: string }): void {
    this.pendingCancel = true;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = undefined;
  }

  respondPermission(input: { sessionId?: string; requestId: string; outcome: "allow" | "deny"; optionId?: string }): void {
    // In bypassPermissions mode, permission requests don't occur.
    // If we later switch to hook-based permissions, we'd send the response via a hook.
  }

  async listSessions(): Promise<unknown> {
    const home = homedir();
    const projectDir = join(home, ".claude", "projects", projectHash(this.input.cwd));

    if (!existsSync(projectDir)) {
      return { sessions: [] };
    }

    const sessions: Array<{ id: string; cwd: string; lastModified: number }> = [];
    try {
      for (const entry of readdirSync(projectDir)) {
        if (entry.endsWith(".jsonl")) {
          const sessionId = entry.replace(".jsonl", "");
          sessions.push({
            id: sessionId,
            cwd: this.input.cwd,
            lastModified: 0, // would need fs.statSync for accurate time
          });
        }
      }
    } catch {
      // directory read failed
    }

    return { sessions };
  }

  stop(): void {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = undefined;
  }
}
