import { homedir } from "node:os";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentFraming, AgentProtocol } from "./provider-resolver.js";

type AgentPermissionMode = "read_only" | "workspace_write" | "full_access";

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeSdkMessage {
  type?: string;
  subtype?: string;
  message?: Record<string, unknown>;
  session_id?: string;
  uuid?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: unknown;
  [key: string]: unknown;
}

type ClaudeQuery = (input: Record<string, unknown>) => AsyncIterable<ClaudeSdkMessage>;

type AgentInputContentBlock = {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function projectHash(cwd: string): string {
  return (
    "-" +
    resolve(cwd)
      .replace(/\/$/, "")
      .replace(/\//g, "-")
  );
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
          return (part as { text: string }).text;
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

function toClaudeMessageContent(blocks: AgentInputContentBlock[]): Record<string, unknown>[] {
  return blocks
    .map((block) => {
      if (block.type === "image" && block.data) {
        const image = splitImageDataUrl(block.data, block.mimeType);
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: image.data,
          },
        };
      }
      return { type: "text", text: block.text ?? "" };
    })
    .filter((block) =>
      block.type === "image" ||
      (typeof block.text === "string" && block.text.trim().length > 0),
    );
}

async function* singleUserMessage(content: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  yield {
    type: "user",
    message: {
      role: "user",
      content,
    },
    parent_tool_use_id: null,
  };
}

function isRealClaudeSessionId(value: string | undefined): value is string {
  return Boolean(value && !value.startsWith("agent-session-"));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown, keys: string[]): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function isInsideCwd(cwd: string, candidate: string): boolean {
  const root = resolve(cwd);
  const target = resolve(root, candidate);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function outcomeFromPermissionResponse(value: unknown): "allow" | "deny" {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (raw.behavior === "allow") return "allow";
  if (raw.behavior === "deny") return "deny";
  const outcome = raw.outcome && typeof raw.outcome === "object"
    ? (raw.outcome as Record<string, unknown>).outcome
    : raw.outcome;
  if (outcome === "selected") {
    const optionId = raw.outcome && typeof raw.outcome === "object"
      ? String((raw.outcome as Record<string, unknown>).optionId ?? "")
      : "";
    return optionId.toLowerCase().includes("allow") ? "allow" : "deny";
  }
  return outcome === "allow" ? "allow" : "deny";
}

export class ClaudeSdkClient {
  private query: ClaudeQuery | undefined;
  private claudeSessionId: string | undefined;
  private abortController: AbortController | undefined;
  private permissionWaiters = new Map<string, (outcome: "allow" | "deny") => void>();

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
    try {
      const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
      const mod = await dynamicImport("@anthropic-ai/claude-agent-sdk");
      const query = (mod as { query?: unknown }).query;
      if (typeof query !== "function") {
        throw new Error("Claude Agent SDK does not export query()");
      }
      this.query = query as ClaudeQuery;
      return { status: "ok", protocol: "claude-agent-sdk" };
    } catch (error) {
      throw new Error(
        `Claude Agent SDK is not available: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async newSession(input: { cwd: string; mcpServers?: unknown }): Promise<unknown> {
    this.claudeSessionId = undefined;
    return { sessionId: undefined, status: "ready", cwd: input.cwd };
  }

  async loadSession(input: { sessionId: string; cwd: string; mcpServers?: unknown }): Promise<unknown> {
    this.claudeSessionId = input.sessionId;
    return { sessionId: input.sessionId, status: "loaded", cwd: input.cwd };
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
    if (!this.query) await this.initialize();
    if (!this.query) throw new Error("Claude Agent SDK is not initialized");

    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;

    const inputBlocks = input.content as AgentInputContentBlock[];
    const hasImages = inputBlocks.some((block) => block.type === "image" && block.data);
    const prompt = inputBlocks
      .map((block) => {
        if (block.type === "image") return `[${block.mimeType ?? "image"} attachment]`;
        return block.text ?? "";
      })
      .filter(Boolean)
      .join("\n");

    const sdkOptions: Record<string, unknown> = {
      cwd: input.cwd ?? this.input.cwd,
      abortController,
      canUseTool: async (toolName: string, toolInput: unknown) => {
        if (input.permissionMode === "full_access") return { behavior: "allow" };
        if (["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoRead"].includes(toolName)) {
          return { behavior: "allow" };
        }
        if (input.permissionMode === "read_only" && ["Write", "Edit", "MultiEdit", "Bash"].includes(toolName)) {
          return { behavior: "deny", message: "Read-only mode is active." };
        }
        if (input.permissionMode === "workspace_write" && ["Write", "Edit", "MultiEdit"].includes(toolName)) {
          const filePath = stringField(toolInput, ["file_path", "path", "notebook_path"]);
          if (filePath && isInsideCwd(input.cwd ?? this.input.cwd, filePath)) {
            return { behavior: "allow" };
          }
        }
        const requestId = id("claude-perm");
        const response = await this.input.onRequest("claude/requestApproval", {
          requestId,
          sessionId: this.claudeSessionId,
          toolCall: {
            toolName,
            input: toolInput,
          },
          context: `Claude wants to use ${toolName}`,
          options: [
            { id: "deny", label: "拒绝", kind: "deny" },
            { id: "allow_once", label: "允许一次", kind: "allow" },
          ],
        });
        return { behavior: outcomeFromPermissionResponse(response) === "allow" ? "allow" : "deny" };
      },
    };
    if (input.model) sdkOptions.model = input.model;
    if (isRealClaudeSessionId(input.sessionId ?? this.claudeSessionId)) {
      sdkOptions.resume = input.sessionId ?? this.claudeSessionId;
    }

    const toolNames = new Map<string, string>();
    let currentToolId: string | undefined;
    let currentToolName: string | undefined;
    let currentMessageId: string | undefined;
    const progressItemId = `claude-progress:${input.clientMessageId}`;

    try {
      this.input.onNotification("item/started", {
        sessionId: input.sessionId ?? this.claudeSessionId,
        item: {
          id: progressItemId,
          type: "thinking",
          text: "Claude 正在处理请求",
          status: "running",
        },
      });
      const queryPrompt = hasImages ? singleUserMessage(toClaudeMessageContent(inputBlocks)) : prompt;
      for await (const message of this.query({ prompt: queryPrompt, options: sdkOptions })) {
        if (abortController.signal.aborted) break;
        this.handleSdkMessage(message, {
          cwd: input.cwd ?? this.input.cwd,
          toolNames,
      currentToolId: (value?: string | null) => {
        if (value !== undefined) currentToolId = value ?? undefined;
        return currentToolId;
      },
      currentToolName: (value?: string | null) => {
        if (value !== undefined) currentToolName = value ?? undefined;
        return currentToolName;
      },
      currentMessageId: (value?: string | null) => {
        if (value !== undefined) currentMessageId = value ?? undefined;
        return currentMessageId;
      },
        });
      }
      return { sessionId: this.claudeSessionId, status: abortController.signal.aborted ? "cancelled" : "completed" };
    } finally {
      this.input.onNotification("item/completed", {
        sessionId: this.claudeSessionId ?? input.sessionId,
        item: {
          id: progressItemId,
          type: "thinking",
          text: abortController.signal.aborted ? "Claude 已停止" : "Claude 已完成",
          status: abortController.signal.aborted ? "failed" : "completed",
        },
      });
      if (this.abortController === abortController) this.abortController = undefined;
    }
  }

  cancel(input: { sessionId?: string; turnId?: string }): void {
    this.abortController?.abort();
    this.abortController = undefined;
    for (const [, resolve] of this.permissionWaiters) resolve("deny");
    this.permissionWaiters.clear();
  }

  respondPermission(input: { sessionId?: string; requestId: string; outcome: "allow" | "deny"; optionId?: string }): void {
    const waiter = this.permissionWaiters.get(input.requestId);
    if (!waiter) return;
    this.permissionWaiters.delete(input.requestId);
    waiter(input.outcome);
  }

  async listSessions(): Promise<unknown> {
    const projectDir = join(homedir(), ".claude", "projects", projectHash(this.input.cwd));
    if (!existsSync(projectDir)) return { sessions: [] };
    const sessions: Array<{ id: string; cwd: string; lastModified: number }> = [];
    try {
      for (const entry of readdirSync(projectDir)) {
        if (entry.endsWith(".jsonl")) {
          sessions.push({
            id: entry.replace(".jsonl", ""),
            cwd: this.input.cwd,
            lastModified: 0,
          });
        }
      }
    } catch {
      // Ignore unreadable Claude project storage.
    }
    return { sessions };
  }

  async listModels(): Promise<unknown> {
    let defaultModel: string = "default";
    try {
      const settingsPath = join(homedir(), ".claude", "settings.json");
      if (existsSync(settingsPath)) {
        const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { model?: unknown };
        if (typeof raw.model === "string" && raw.model.trim().length > 0) {
          defaultModel = raw.model.trim();
        }
      }
    } catch {
      // Fallback to "default" if settings file is unreadable.
    }
    return {
      defaultModel,
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
    this.cancel({});
  }

  private handleSdkMessage(
    event: ClaudeSdkMessage,
    state: {
      cwd: string;
      toolNames: Map<string, string>;
      currentToolId: (value?: string | null) => string | undefined;
      currentToolName: (value?: string | null) => string | undefined;
      currentMessageId: (value?: string | null) => string | undefined;
    },
  ): void {
    switch (event.type) {
      case "system": {
        if (event.subtype === "init" && typeof event.session_id === "string") {
          this.claudeSessionId = event.session_id;
          this.input.onNotification("thread/started", {
            sessionId: event.session_id,
            threadId: event.session_id,
          });
          this.input.onNotification("initialized", {
            sessionId: event.session_id,
            threadId: event.session_id,
            cwd: event.cwd ?? state.cwd,
            model: event.model,
          });
        }
        break;
      }
      case "assistant": {
        const rawMessage = event.message;
        const content = (Array.isArray(rawMessage?.content) ? rawMessage.content : []) as ClaudeContentBlock[];
        state.currentMessageId(null);
        for (const block of content) {
          if (block.type === "thinking") {
            this.input.onNotification("item/completed", {
              sessionId: this.claudeSessionId,
              item: {
                id: event.uuid ?? id("thinking"),
                type: "thinking",
                text: block.thinking,
                status: "completed",
              },
            });
          } else if (block.type === "text") {
            const messageId = (typeof rawMessage?.id === "string" ? rawMessage.id : undefined) ?? event.uuid ?? id("msg");
            state.currentMessageId(messageId);
            this.input.onNotification("item/agentMessage/delta", {
              sessionId: this.claudeSessionId,
              itemId: messageId,
              delta: block.text,
            });
          } else if (block.type === "tool_use") {
            const toolId = block.id ?? id("tool");
            const toolName = block.name ?? "tool";
            state.currentToolId(toolId);
            state.currentToolName(toolName);
            state.toolNames.set(toolId, toolName);
            this.input.onNotification("item/started", {
              sessionId: this.claudeSessionId,
              item: {
                id: toolId,
                type: toolName === "Bash" ? "commandExecution" : toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" ? "fileChange" : "toolCall",
                toolName,
                tool: toolName,
                input: block.input,
                command: block.input?.command as string | undefined,
                cwd: block.input?.cwd as string | undefined ?? state.cwd,
                status: "running",
              },
            });
          }
        }
        const messageId = state.currentMessageId();
        if (messageId) {
          this.input.onNotification("item/completed", {
            sessionId: this.claudeSessionId,
            item: { id: messageId, type: "agentMessage", status: "completed" },
          });
        }
        break;
      }
      case "user": {
        const rawMessage = event.message;
        const content = (Array.isArray(rawMessage?.content) ? rawMessage.content : []) as ClaudeContentBlock[];
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const toolId = block.tool_use_id ?? state.currentToolId();
          const toolName = (toolId ? state.toolNames.get(toolId) : undefined) ?? state.currentToolName();
          const output = extractToolResultText(block.content);
          this.input.onNotification("item/completed", {
            sessionId: this.claudeSessionId,
            item: {
              id: toolId ?? id("tool"),
              type: "toolCall",
              toolName,
              tool: toolName,
              status: block.is_error ? "failed" : "completed",
              output,
              aggregatedOutput: output,
              isError: block.is_error === true,
            },
          });
        }
        break;
      }
      case "result": {
        if (typeof event.session_id === "string") this.claudeSessionId = event.session_id;
        this.input.onNotification("turn/completed", {
          sessionId: this.claudeSessionId,
          durationMs: event.duration_ms,
          totalCostUsd: event.total_cost_usd,
          usage: event.usage,
          isError: event.subtype === "error",
        });
        break;
      }
    }
  }
}
