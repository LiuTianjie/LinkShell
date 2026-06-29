import { homedir } from "node:os";
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentFraming, AgentProtocol } from "./provider-resolver.js";

type AgentPermissionMode = "read_only" | "workspace_write" | "full_access";
type AgentCollaborationMode = "default" | "plan";
type ClaudePermissionMode = "default" | "dontAsk" | "acceptEdits" | "bypassPermissions" | "plan";

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

function claudeProjectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", projectHash(cwd));
}

function claudeProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
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

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
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

function previewText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const raw = asRecord(entry);
      if (!raw) return "";
      if (typeof raw.text === "string") return raw.text;
      if (raw.type === "image") return `[${stringField(raw.source, ["media_type", "mimeType"]) ?? "image"} attachment]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function claudeToolItemType(toolName: string | undefined): "commandExecution" | "fileChange" | "toolCall" {
  if (toolName === "Bash") return "commandExecution";
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") return "fileChange";
  return "toolCall";
}

function claudeToolHistoryItem(
  toolId: string,
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  cwd: string,
): Record<string, unknown> {
  const filePath = stringField(toolInput, ["file_path", "path", "notebook_path"]);
  return {
    id: toolId,
    type: claudeToolItemType(toolName),
    toolName: toolName ?? "tool",
    tool: toolName ?? "tool",
    input: toolInput,
    toolInput,
    command: stringField(toolInput, ["command"]),
    cwd: stringField(toolInput, ["cwd"]) ?? cwd,
    path: filePath,
    status: "running",
  };
}

export function parseClaudeJsonlSession(input: {
  text: string;
  cwd: string;
  sessionId?: string;
  fallbackUpdatedAt?: number;
}): Record<string, unknown> {
  const turns: Array<Record<string, unknown>> = [];
  const toolItems = new Map<string, Record<string, unknown>>();
  let sessionId = input.sessionId;
  let model: string | undefined;
  let title: string | undefined;
  let preview: string | undefined;
  let createdAt: number | undefined;
  let updatedAt = input.fallbackUpdatedAt;
  let cwd = input.cwd;
  // Last assistant line's token usage. input_tokens at the latest turn is the
  // current context-window occupancy (NOT a running sum), so we keep the last
  // one we see rather than accumulating. Decoupled from any live LinkShell turn
  // — this is read straight from the on-disk transcript.
  let usage: Record<string, unknown> | undefined;
  let index = 0;

  for (const line of input.text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    index += 1;
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      const record = asRecord(parsed);
      if (!record) continue;
      raw = record;
    } catch {
      continue;
    }

    const timestamp = parseTimestamp(raw.timestamp ?? raw.createdAt ?? raw.created_at);
    cwd = stringField(raw, ["cwd", "workingDirectory", "workspacePath"]) ?? cwd;
    if (timestamp !== undefined) {
      createdAt = createdAt === undefined ? timestamp : Math.min(createdAt, timestamp);
      updatedAt = updatedAt === undefined ? timestamp : Math.max(updatedAt, timestamp);
    }

    sessionId = sessionId ?? stringField(raw, ["sessionId", "session_id"]);
    model = model ?? stringField(raw, ["model"]);
    const message = asRecord(raw.message);
    model = model ?? stringField(message, ["model"]);
    const type = stringField(raw, ["type"]);
    const role = stringField(message, ["role"]) ?? type;
    const content = message && "content" in message ? message.content : raw.content;
    const turnId = stringField(raw, ["uuid", "id"]) ?? `claude-history-${index}`;
    const items: Record<string, unknown>[] = [];

    if (type === "summary" || typeof raw.summary === "string") {
      const summary = typeof raw.summary === "string" ? raw.summary : undefined;
      if (summary) {
        items.push({
          id: turnId,
          type: "contextCompaction",
          summary,
          status: "completed",
        });
        preview = previewText(summary) || preview;
      }
    } else if (role === "user") {
      const contentBlocks = Array.isArray(content) ? content : [];
      const toolResults = contentBlocks
        .map(asRecord)
        .filter((block): block is Record<string, unknown> => Boolean(block && block.type === "tool_result"));
      const ordinaryText = Array.isArray(content)
        ? contentText(contentBlocks.filter((block) => asRecord(block)?.type !== "tool_result"))
        : contentText(content);
      if (ordinaryText.trim()) {
        items.push({
          id: stringField(message, ["id"]) ?? turnId,
          type: "userMessage",
          content: [{ type: "text", text: ordinaryText }],
        });
        title = title ?? previewText(ordinaryText);
        preview = previewText(ordinaryText) || preview;
      }
      for (const block of toolResults) {
        const toolId = stringField(block, ["tool_use_id"]) ?? `tool-result-${index}`;
        const previous = toolItems.get(toolId);
        const output = extractToolResultText(block.content);
        items.push({
          ...previous,
          id: toolId,
          type: stringField(previous, ["type"]) ?? "toolCall",
          toolName: stringField(previous, ["toolName", "tool", "name"]),
          tool: stringField(previous, ["toolName", "tool", "name"]),
          status: block.is_error === true ? "failed" : "completed",
          output,
          aggregatedOutput: output,
          isError: block.is_error === true,
        });
      }
    } else if (role === "assistant") {
      const assistantMessageId = stringField(message, ["id"]) ?? turnId;
      const lineUsage = asRecord(message?.usage);
      if (lineUsage) usage = lineUsage;
      if (typeof content === "string") {
        if (content.trim()) {
          items.push({
            id: assistantMessageId,
            type: "agentMessage",
            content: [{ type: "text", text: content }],
            status: "completed",
          });
          preview = previewText(content) || preview;
        }
      } else {
        const blocks = Array.isArray(content) ? content.map(asRecord).filter((block): block is Record<string, unknown> => Boolean(block)) : [];
        const text = contentText(blocks.filter((block) => block.type === "text"));
        if (text.trim()) {
          items.push({
            id: assistantMessageId,
            type: "agentMessage",
            content: [{ type: "text", text }],
            status: "completed",
          });
          preview = previewText(text) || preview;
        }
        blocks.forEach((block, blockIndex) => {
          if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
            items.push({
              id: `${turnId}:thinking:${blockIndex}`,
              type: "thinking",
              text: block.thinking,
              status: "completed",
            });
          } else if (block.type === "tool_use") {
            const toolId = stringField(block, ["id"]) ?? `${turnId}:tool:${blockIndex}`;
            const toolName = stringField(block, ["name"]);
            const toolInput = asRecord(block.input);
            const item = claudeToolHistoryItem(toolId, toolName, toolInput, cwd);
            toolItems.set(toolId, item);
            items.push(item);
          }
        });
      }
    } else if (type === "system") {
      model = model ?? stringField(raw, ["model"]);
    }

    if (items.length > 0) {
      turns.push({
        id: turnId,
        createdAt: timestamp,
        items,
      });
    }
  }

  return {
    thread: {
      id: sessionId ?? input.sessionId,
      sessionId: sessionId ?? input.sessionId,
      cwd,
      model,
      title,
      preview,
      createdAt,
      updatedAt,
      usage,
      turns,
    },
  };
}

/** Derive whether an on-disk Claude transcript is being actively driven RIGHT
 *  NOW by some process (LinkShell or an external `claude` terminal), purely from
 *  the file. Combines a structural signal (the last record) with a freshness
 *  signal (mtime), so it neither misses a live external turn nor sticks at
 *  "running" forever if that process dies mid-turn.
 *
 *  - last record is a completed assistant turn (stop_reason "end_turn") → idle,
 *    regardless of mtime (the turn is definitively done).
 *  - otherwise the structure is mid-turn (awaiting an assistant response, an
 *    assistant still calling tools, or a half-written trailing line). If the
 *    file changed within FRESH_MS, a process is appending → running; if it's
 *    stale, the driver is gone → idle.
 *  Verified against real transcripts: mid-turn+fresh→running, mid-turn+stale→
 *  idle, end_turn+fresh→idle, half-written-line+fresh→running. */
function deriveTranscriptStatus(text: string, mtimeMs: number, nowMs: number): "running" | "idle" {
  const FRESH_MS = 10_000;
  const fresh = nowMs - mtimeMs < FRESH_MS;
  const lines = text.split(/\r?\n/);
  let last: Record<string, unknown> | undefined;
  let sawUnparseableTail = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
    try {
      last = asRecord(JSON.parse(ln));
      break;
    } catch {
      // A trailing half-written line means a writer is mid-append.
      sawUnparseableTail = true;
    }
  }
  if (!last) return "idle";
  const message = asRecord(last.message);
  const role = stringField(message, ["role"]) ?? stringField(last, ["type"]);
  const stop = message ? message.stop_reason ?? null : null;
  if (role === "assistant" && stop === "end_turn") return "idle";
  const midTurn =
    role === "user" ||
    last.type === "user" ||
    (role === "assistant" && (stop === "tool_use" || stop === null)) ||
    sawUnparseableTail;
  return midTurn && fresh ? "running" : "idle";
}

function claudeSessionMetadataFromFile(filePath: string, cwd: string, sessionId: string): Record<string, unknown> {
  const stat = statSync(filePath);
  const text = readFileSync(filePath, "utf8");
  const parsed = parseClaudeJsonlSession({
    text,
    cwd,
    sessionId,
    fallbackUpdatedAt: stat.mtimeMs,
  });
  const thread = asRecord(parsed.thread) ?? {};
  return {
    id: sessionId,
    cwd: stringField(thread, ["cwd", "workingDirectory", "workspacePath"]) ?? cwd,
    title: stringField(thread, ["title", "preview"]),
    model: stringField(thread, ["model"]),
    createdAt: parseTimestamp(thread.createdAt),
    lastActivityAt: parseTimestamp(thread.updatedAt) ?? stat.mtimeMs,
    lastModified: stat.mtimeMs,
    usage: asRecord(thread.usage),
    // Live status read straight from the transcript, so a session another
    // `claude` process is actively driving shows as "running" in the list
    // rather than the hardcoded "idle" the workspace would otherwise assign.
    status: deriveTranscriptStatus(text, stat.mtimeMs, Date.now()),
  };
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

export function claudePermissionModeFor(input: {
  permissionMode?: AgentPermissionMode;
  collaborationMode?: AgentCollaborationMode;
}): ClaudePermissionMode {
  if (input.collaborationMode === "plan" || input.permissionMode === "read_only") return "plan";
  if (input.permissionMode === "workspace_write") return "acceptEdits";
  if (input.permissionMode === "full_access") return "bypassPermissions";
  return "default";
}

const FALLBACK_MODEL_LABELS: Record<string, string> = {
  default: "默认模型",
  sonnet: "Sonnet",
  opus: "Opus",
  opusplan: "Opus Plan",
  haiku: "Haiku",
  "sonnet[1m]": "Sonnet 1M",
  "opus[1m]": "Opus 1M",
};

// Canonical Claude Code model aliases, used whenever live model discovery
// (supportedModels()) returns nothing. Hoisted so the two listModels() fallback
// branches stay in sync — a new alias added here reaches both.
const DEFAULT_FALLBACK_MODELS = ["default", "sonnet", "opus", "opusplan", "haiku", "sonnet[1m]", "opus[1m]"];
const toModelEntries = (ids: string[]): { id: string; label: string }[] =>
  ids.map((id) => ({ id, label: FALLBACK_MODEL_LABELS[id] ?? id }));

export class ClaudeSdkClient {
  private query: ClaudeQuery | undefined;
  private startup: ((params?: { options?: Record<string, unknown>; initializeTimeoutMs?: number }) => Promise<{ query(prompt: string): AsyncGenerator<unknown> & { supportedModels(): Promise<{ value: string; displayName: string }[]>; interrupt(): Promise<void> }; close(): void }>) | undefined;
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
      // startup() pre-warms the CLI subprocess so we can discover available models
      // without starting a full conversation (via supportedModels() on the Query).
      const startup = (mod as { startup?: unknown }).startup;
      if (typeof startup === "function") {
        this.startup = startup as typeof this.startup;
      }
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

  async readSession(input: { sessionId: string; includeTurns?: boolean }): Promise<unknown> {
    const filePath = this.resolveSessionFile(input.sessionId);
    if (!filePath) {
      return {
        thread: {
          id: input.sessionId,
          sessionId: input.sessionId,
          cwd: this.input.cwd,
          turns: [],
        },
      };
    }
    const stat = statSync(filePath);
    return parseClaudeJsonlSession({
      text: readFileSync(filePath, "utf8"),
      cwd: this.input.cwd,
      sessionId: input.sessionId,
      fallbackUpdatedAt: stat.mtimeMs,
    });
  }

  /** Resolve the on-disk JSONL transcript for a session, preferring the cwd's
   *  project dir and falling back to a scan of sibling project dirs. */
  private resolveSessionFile(sessionId: string): string | undefined {
    const preferred = join(claudeProjectDir(this.input.cwd), `${sessionId}.jsonl`);
    if (existsSync(preferred)) return preferred;
    return claudeProjectDirs(this.input.cwd)
      .map((dir) => join(dir, `${sessionId}.jsonl`))
      .find((candidate) => existsSync(candidate));
  }

  /** Page OLDER transcript turns for scroll-back, mirroring Codex's
   *  thread/turns/list. The whole transcript lives on disk and is already
   *  parsed by parseClaudeJsonlSession, so we slice a window of chronological
   *  turns by an integer end-exclusive cursor.
   *
   *  Cursor = the exclusive upper-bound turn index for the page. No cursor =
   *  start at the end (total turn count). A page returns turns [lo, hi) where
   *  lo = max(0, hi - limit); nextCursor = String(lo) while lo > 0, else absent
   *  (start of history reached). The web client's mergeTimeline dedupes by id
   *  and re-sorts by createdAt, so any overlap between this page and what the
   *  client already shows is harmless. */
  async listTurns(input: {
    sessionId: string;
    limit?: number;
    cursor?: string;
    sortDirection?: "asc" | "desc";
    itemsView?: "summary" | "full";
  }): Promise<unknown> {
    const empty = { sessionId: input.sessionId, turns: [], sortDirection: "asc" as const };
    const filePath = this.resolveSessionFile(input.sessionId);
    if (!filePath) return empty;

    const stat = statSync(filePath);
    const parsed = parseClaudeJsonlSession({
      text: readFileSync(filePath, "utf8"),
      cwd: this.input.cwd,
      sessionId: input.sessionId,
      fallbackUpdatedAt: stat.mtimeMs,
    });
    const thread = asRecord(parsed.thread);
    const allTurns = Array.isArray(thread?.turns) ? thread.turns : [];
    const total = allTurns.length;
    if (total === 0) return empty;

    const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : 50;
    // Parse the end-exclusive cursor; default to the end of history. Clamp into
    // [0, total] so a stale/garbage cursor can't slice out of bounds.
    const parsedCursor = input.cursor !== undefined ? Number.parseInt(input.cursor, 10) : total;
    const hi = Number.isFinite(parsedCursor) ? Math.max(0, Math.min(total, parsedCursor)) : total;
    const lo = Math.max(0, hi - limit);
    const page = allTurns.slice(lo, hi);
    return {
      sessionId: input.sessionId,
      turns: page, // already chronological (ascending)
      sortDirection: "asc" as const,
      ...(lo > 0 ? { nextCursor: String(lo) } : {}),
    };
  }

  async prompt(input: {
    sessionId?: string;
    content: unknown[];
    clientMessageId: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: AgentPermissionMode;
    collaborationMode?: AgentCollaborationMode;
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
      permissionMode: claudePermissionModeFor({
        permissionMode: input.permissionMode,
        collaborationMode: input.collaborationMode,
      }),
      toolConfig: {
        askUserQuestion: { previewFormat: "markdown" },
      },
      canUseTool: async (toolName: string, toolInput: unknown) => {
        if (toolName === "AskUserQuestion") {
          const response = await this.input.onRequest("claude/askUserQuestion", {
            ...(asRecord(toolInput) ?? {}),
            requestId: id("claude-input"),
            sessionId: this.claudeSessionId,
          });
          return response;
        }
        if (input.permissionMode === "full_access") return { behavior: "allow", updatedInput: toolInput };
        if (["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoRead"].includes(toolName)) {
          return { behavior: "allow", updatedInput: toolInput };
        }
        if (input.permissionMode === "read_only" && ["Write", "Edit", "MultiEdit", "Bash"].includes(toolName)) {
          return { behavior: "deny", message: "Read-only mode is active." };
        }
        if (input.permissionMode === "workspace_write" && ["Write", "Edit", "MultiEdit"].includes(toolName)) {
          const filePath = stringField(toolInput, ["file_path", "path", "notebook_path"]);
          if (filePath && isInsideCwd(input.cwd ?? this.input.cwd, filePath)) {
            return { behavior: "allow", updatedInput: toolInput };
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
        return outcomeFromPermissionResponse(response) === "allow"
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: "User denied this action from LinkShell." };
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
    const sessions: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const projectDir of claudeProjectDirs(this.input.cwd)) {
      try {
        for (const entry of readdirSync(projectDir)) {
          if (!entry.endsWith(".jsonl")) continue;
          const sessionId = entry.replace(".jsonl", "");
          if (seen.has(sessionId)) continue;
          seen.add(sessionId);
          sessions.push(claudeSessionMetadataFromFile(join(projectDir, entry), this.input.cwd, sessionId));
        }
      } catch {
        // Ignore unreadable Claude project storage.
      }
    }
    return { sessions };
  }

  async listModels(): Promise<unknown> {
    let defaultModel: string = "default";
    // Read the user's configured default model from settings.json. This is always
    // consulted (both for live discovery and for the fallback path).
    let availableModels: string[] | undefined;
    try {
      const settingsPath = join(homedir(), ".claude", "settings.json");
      if (existsSync(settingsPath)) {
        const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { model?: unknown; availableModels?: unknown };
        if (typeof raw.model === "string" && raw.model.trim().length > 0) {
          defaultModel = raw.model.trim();
        }
        if (Array.isArray(raw.availableModels)) {
          availableModels = raw.availableModels.filter((m): m is string => typeof m === "string");
        }
      }
    } catch {
      // Fallback to "default" if settings file is unreadable.
    }

    // Dynamic model discovery: use the Claude Agent SDK's startup() to get the
    // REAL model list for THIS API key (different keys/tiers see different models).
    // Falls back to settings.json availableModels → hardcoded list on any failure.
    if (this.startup) {
      let warm: Awaited<ReturnType<NonNullable<typeof this.startup>>> | undefined;
      try {
        warm = await this.startup({ initializeTimeoutMs: 10_000 });
        const q = warm.query("");
        try {
          const sdkModels: { value: string; displayName: string }[] = await (q as unknown as { supportedModels(): Promise<{ value: string; displayName: string }[]> }).supportedModels();
          // Discover the REAL slash-command set for the installed Claude Code
          // (built-ins like /goal + project/user custom commands), instead of a
          // hardcoded list that drifts out of sync. Best-effort: an older SDK
          // without supportedCommands() just leaves commands undefined and the
          // static defaults still apply.
          let commands: { name: string; description?: string; argumentHint?: string }[] | undefined;
          try {
            const sdkCommands = await (q as unknown as { supportedCommands?: () => Promise<{ name: string; description?: string; argumentHint?: string }[]> }).supportedCommands?.();
            if (Array.isArray(sdkCommands) && sdkCommands.length > 0) commands = sdkCommands;
          } catch {
            // supportedCommands() unavailable or failed — fall back to static defaults.
          }
          if (sdkModels.length > 0) {
            // Filter to admin-configured allowlist if present, then map to our format.
            const allow = availableModels;
            const filtered = allow
              ? sdkModels.filter((m) => allow.includes(m.value) || m.value === "default")
              : sdkModels;
            return {
              defaultModel,
              models: filtered.map((m) => ({ id: m.value, label: m.displayName || m.value })),
              ...(commands ? { commands } : {}),
            };
          }
          // No models surfaced, but commands may still be present — return them
          // so the command palette stays in sync even when the model list is empty.
          if (commands) {
            const fallbackModels = availableModels ?? DEFAULT_FALLBACK_MODELS;
            return {
              defaultModel,
              models: toModelEntries(fallbackModels),
              commands,
            };
          }
        } catch {
          // supportedModels() failed — the subprocess may be in a bad state. Close it.
        } finally {
          try { warm.close(); } catch { /* ignore */ }
        }
      } catch {
        // startup() failed — clean up if it partially succeeded.
        try { warm?.close(); } catch { /* ignore */ }
      }
    }

    // Fallback: admin-configured allowlist, or the full Claude Code alias set.
    const fallbackModels = availableModels ?? DEFAULT_FALLBACK_MODELS;
    return {
      defaultModel,
      models: toModelEntries(fallbackModels),
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
