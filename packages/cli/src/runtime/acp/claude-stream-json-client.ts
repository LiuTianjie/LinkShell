import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentFraming, AgentProtocol } from "./provider-resolver.js";
import { parseClaudeJsonlSession } from "./claude-sdk-client.js";

type AgentPermissionMode = "read_only" | "workspace_write" | "full_access";

type AgentInputContentBlock = {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

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

function claudeProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

function claudeProjectDir(cwd: string): string {
  return join(claudeProjectsRoot(), projectHash(cwd));
}

function claudeProjectDirs(preferredCwd: string): string[] {
  const root = claudeProjectsRoot();
  const preferred = claudeProjectDir(preferredCwd);
  const dirs: string[] = [];
  if (existsSync(preferred)) dirs.push(preferred);
  if (!existsSync(root)) return dirs;
  try {
    for (const entry of readdirSync(root)) {
      const fullPath = join(root, entry);
      if (fullPath !== preferred && statSync(fullPath).isDirectory()) {
        dirs.push(fullPath);
      }
    }
  } catch {
    // Ignore unreadable Claude storage.
  }
  return dirs;
}

function stringField(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Claude stream-json returns tool_result content as either a plain string or
// an array of content-block objects. Extract the text regardless of shape.
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object" && "text" in content && typeof (content as { text: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  return String(content ?? "");
}

function splitImageDataUrl(value: string, fallbackMimeType = "image/png"): { data: string; mimeType: string } {
  const match = value.match(/^data:([^;,]+)?;base64,(.*)$/is);
  if (!match) return { data: value, mimeType: fallbackMimeType };
  return {
    data: match[2] ?? "",
    mimeType: match[1] || fallbackMimeType,
  };
}

export class ClaudeStreamJsonClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private claudeSessionId: string | undefined;
  private pendingCancel = false;

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
    collaborationMode?: "default" | "plan";
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

    // Use stored session for --resume (only when we have a real session ID from system.init)
    if (this.claudeSessionId) {
      args.push("--resume", this.claudeSessionId);
    }
    // Allow up to 10 turns so Claude can execute tools and continue responding.
    // With bypassPermissions, tools auto-execute — a generous limit prevents
    // infinite loops while still allowing complex multi-step workflows.
    args.push("--max-turns", "10");

    if (input.model) {
      args.push("--model", input.model);
    }

    // Build the user message
    const contentBlocks = (input.content as AgentInputContentBlock[]).map(
      (block) => {
        if (block.type === "image" && block.data) {
          const image = splitImageDataUrl(block.data, block.mimeType);
          return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
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
        // Only clear reference if this child is still the active one
        if (this.child === child) {
          this.child = undefined;
        }
        if (err) {
          // Don't call onExit for per-prompt failures — the client can still accept new prompts.
          // onExit is reserved for fatal errors (e.g. binary not found in initialize()).
          reject(err);
        } else {
          resolve(result);
        }
      };

      // Send the prompt
      try {
        child.stdin.write(JSON.stringify(userMessage) + "\n");
        child.stdin.end();
      } catch (err) {
        child.kill("SIGTERM");
        finish(err instanceof Error ? err : new Error(String(err)), undefined);
        return child;
      }

      // Read stdout line by line (stream-json is newline-delimited)
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let currentToolId: string | undefined;
      let currentToolName: string | undefined;
      let currentMessageId: string | undefined;
      const progressItemId = `claude-progress:${input.clientMessageId}`;
      // Map tool_use_id → tool_name so tool_result can look up the correct name
      // even when multiple tools are in flight
      const toolNames = new Map<string, string>();

      this.input.onNotification("item/started", {
        sessionId: input.sessionId ?? this.claudeSessionId,
        item: {
          id: progressItemId,
          type: "thinking",
          text: "Claude 正在处理请求",
          status: "running",
        },
      });

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
              // Emit thread/started so workspace/session proxies update their agentSessionId
              this.input.onNotification("thread/started", {
                sessionId: event.session_id,
                threadId: event.session_id,
              });
              // Also send initialized with full metadata
              const initParams: Record<string, unknown> = {
                sessionId: event.session_id,
                threadId: event.session_id,
                cwd: event.cwd ?? cwd,
                model: event.model,
              };
              if (event.tools) initParams.tools = event.tools;
              if (event.slash_commands) initParams.slashCommands = event.slash_commands;
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
            // Reset per-message tracking — each assistant message starts fresh
            currentMessageId = undefined;

            for (const block of content) {
              switch (block.type) {
                case "thinking":
                  // Use item/completed since thinking blocks arrive complete (not streaming deltas)
                  // item/started would leave isStreaming=true forever with no matching item/completed
                  this.input.onNotification("item/completed", {
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
                  currentMessageId = (typeof message.id === "string" ? message.id : undefined) ?? event.uuid ?? id("msg");
                  this.input.onNotification("item/agentMessage/delta", {
                    sessionId: this.claudeSessionId,
                    itemId: currentMessageId,
                    delta: block.text,
                  });
                  break;

                case "tool_use": {
                  currentToolId = block.id;
                  currentToolName = block.name ?? "tool";
                  if (block.id) toolNames.set(block.id, block.name ?? "tool");
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

            // Mark this assistant message as complete — the full message has arrived.
            // Each text block was streamed via item/agentMessage/delta; now we signal
            // that streaming is done so the UI stops showing "正在生成".
            if (currentMessageId) {
              this.input.onNotification("item/completed", {
                sessionId: this.claudeSessionId,
                item: {
                  id: currentMessageId,
                  type: "agentMessage",
                  status: "completed",
                },
              });
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
                const toolName = (toolId ? toolNames.get(toolId) : undefined) ?? currentToolName;
                const isError = block.is_error === true;
                // Claude stream-json may return content as a plain string or as
                // an array of content-block objects (e.g. [{type:"text", text:"..."}]).
                const output = extractToolResultText(block.content);
                this.input.onNotification("item/completed", {
                  sessionId: this.claudeSessionId,
                  item: {
                    id: toolId ?? id("tool"),
                    type: "toolCall",
                    toolName,
                    tool: toolName,
                    status: isError ? "failed" : "completed",
                    output,
                    aggregatedOutput: output,
                    isError,
                  },
                });
              }
            }
            break;
          }

          case "result": {
            const isError = event.subtype === "error" || event.is_error === true;
            this.input.onNotification("item/completed", {
              sessionId: this.claudeSessionId ?? input.sessionId,
              item: {
                id: progressItemId,
                type: "thinking",
                text: isError ? "Claude 运行出错" : "Claude 已完成",
                status: isError ? "failed" : "completed",
              },
            });
            // Mark the last agent message as complete so isStreaming flips to false
            if (currentMessageId) {
              this.input.onNotification("item/completed", {
                sessionId: this.claudeSessionId,
                item: {
                  id: currentMessageId,
                  type: "agentMessage",
                  status: "completed",
                },
              });
            }
            // Turn complete
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
        this.input.onNotification("item/completed", {
          sessionId: this.claudeSessionId ?? input.sessionId,
          item: {
            id: progressItemId,
            type: "thinking",
            text: "Claude 运行出错",
            status: "failed",
          },
        });
        finish(err, undefined);
      });

      child.on("exit", (code, signal) => {
        if (!settled) {
          this.input.onNotification("item/completed", {
            sessionId: this.claudeSessionId ?? input.sessionId,
            item: {
              id: progressItemId,
              type: "thinking",
              text: this.pendingCancel ? "Claude 已停止" : "Claude 意外退出",
              status: "failed",
            },
          });
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
    const sessions: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const projectDir of claudeProjectDirs(this.input.cwd)) {
      try {
        for (const entry of readdirSync(projectDir)) {
          if (!entry.endsWith(".jsonl")) continue;
          const sessionId = entry.replace(".jsonl", "");
          if (seen.has(sessionId)) continue;
          seen.add(sessionId);
          const filePath = join(projectDir, entry);
          const stat = statSync(filePath);
          const parsed = parseClaudeJsonlSession({
            text: readFileSync(filePath, "utf8"),
            cwd: this.input.cwd,
            sessionId,
            fallbackUpdatedAt: stat.mtimeMs,
          });
          const thread = parsed.thread && typeof parsed.thread === "object"
            ? parsed.thread as Record<string, unknown>
            : {};
          sessions.push({
            id: sessionId,
            cwd: stringField(thread, ["cwd", "workingDirectory", "workspacePath"]) ?? this.input.cwd,
            title: stringField(thread, ["title", "preview"]),
            model: stringField(thread, ["model"]),
            createdAt: thread.createdAt,
            lastActivityAt: thread.updatedAt ?? stat.mtimeMs,
            lastModified: stat.mtimeMs,
          });
        }
      } catch {
        // directory read failed
      }
    }

    return { sessions };
  }

  async listModels(): Promise<unknown> {
    return {
      defaultModel: "default",
      models: [
        { id: "default", label: "默认模型" },
        { id: "sonnet", label: "Sonnet" },
        { id: "opus", label: "Opus" },
        { id: "haiku", label: "Haiku" },
        { id: "sonnet[1m]", label: "Sonnet 1M" },
        { id: "opusplan", label: "Opus Plan" },
      ],
    };
  }

  stop(): void {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = undefined;
  }
}
