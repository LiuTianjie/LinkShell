import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const SAMPLE_BYTES = 64 * 1024;
const HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 200;
const MAX_HISTORY_ITEMS = 200;

export interface ClaudeStoredSession {
  id: string;
  cwd: string;
  title?: string;
  createdAt?: number;
  lastModified: number;
}

export interface StoredAgentTimelineItem {
  id: string;
  conversationId: string;
  type: "message" | "tool_call";
  kind?: "tool_activity" | "command_execution" | "file_change";
  itemId?: string;
  role?: "user" | "assistant" | "system";
  content?: Array<{ type: "text"; text: string }>;
  text?: string;
  toolCall?: {
    id: string;
    name: string;
    input?: string;
    output?: string;
    createdAt?: number;
    status: "pending" | "running" | "completed" | "failed";
  };
  commandExecution?: {
    command?: string;
    cwd?: string;
    output?: string;
    exitCode?: number | null;
    status?: "pending" | "running" | "completed" | "failed";
  };
  fileChange?: {
    entries: Array<{
      path: string;
      kind?: string;
      added?: number;
      removed?: number;
    }>;
    diff?: string;
    summary?: string;
    status?: "pending" | "running" | "completed" | "failed";
  };
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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

function normalizeTitle(value: string | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function findStringDeep(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 4) return undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  for (const candidate of Object.values(record)) {
    if (candidate && typeof candidate === "object") {
      const found = findStringDeep(candidate, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function extractMessageText(value: unknown): string | undefined {
  if (typeof value === "string") return normalizeTitle(value);
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        if (typeof part === "string") return part;
        const record = asRecord(part);
        return typeof record?.text === "string" ? record.text : "";
      })
      .join(" ");
    return normalizeTitle(text);
  }
  const record = asRecord(value);
  if (!record) return undefined;
  return extractMessageText(record.content ?? record.text);
}

function extractHistoryText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.replace(/\r\n/g, "\n").trim();
    return text || undefined;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        if (typeof part === "string") return part;
        const record = asRecord(part);
        return typeof record?.text === "string"
          ? record.text
          : typeof record?.content === "string"
          ? record.content
          : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return text || undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  return extractHistoryText(record.content ?? record.text ?? record.message);
}

function extractVisibleClaudeText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return extractHistoryText(value);
  const text = value
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      if (!record || record.type === "tool_use" || record.type === "tool_result") return "";
      return typeof record.text === "string"
        ? record.text
        : typeof record.content === "string"
        ? record.content
        : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

function stringifyHistoryValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function guessCwdFromProjectDir(projectDirName: string, fallbackCwd: string): string {
  const trimmed = projectDirName.replace(/^-+/, "");
  if (!trimmed) return resolve(fallbackCwd);
  return `/${trimmed.split("-").filter(Boolean).join("/")}`;
}

function readSample(filePath: string, size: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    if (size <= SAMPLE_BYTES * 2) {
      const buffer = Buffer.alloc(size);
      const bytesRead = readSync(fd, buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    }

    const head = Buffer.alloc(SAMPLE_BYTES);
    const tail = Buffer.alloc(SAMPLE_BYTES);
    const headBytes = readSync(fd, head, 0, SAMPLE_BYTES, 0);
    const tailBytes = readSync(fd, tail, 0, SAMPLE_BYTES, Math.max(0, size - SAMPLE_BYTES));
    return `${head.subarray(0, headBytes).toString("utf8")}\n${tail.subarray(0, tailBytes).toString("utf8")}`;
  } catch {
    return "";
  } finally {
    if (typeof fd === "number") {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures while listing best-effort local history.
      }
    }
  }
}

function readHistorySample(filePath: string, size: number): string {
  try {
    if (size <= HISTORY_BYTES) return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }

  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(HISTORY_BYTES);
    const bytesRead = readSync(fd, buffer, 0, HISTORY_BYTES, Math.max(0, size - HISTORY_BYTES));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (typeof fd === "number") {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures while reading best-effort local history.
      }
    }
  }
}

function readClaudeSessionMetadata(filePath: string, fallbackCwd: string): Omit<ClaudeStoredSession, "id" | "lastModified"> & {
  lastModified?: number;
} {
  let statMtime: number | undefined;
  let statSize = 0;
  try {
    const stat = statSync(filePath);
    statMtime = stat.mtimeMs;
    statSize = stat.size;
  } catch {
    // Best effort only.
  }

  const sample = readSample(filePath, statSize);
  let cwd: string | undefined;
  let title: string | undefined;
  let createdAt: number | undefined;
  let lastActivityAt: number | undefined;

  for (const line of sample.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const entry = JSON.parse(trimmed) as unknown;
      const record = asRecord(entry);
      if (!record) continue;
      cwd ??= findStringDeep(record, ["cwd", "workingDirectory", "workspacePath"]);
      const timestamp = parseTimestamp(record.timestamp ?? record.createdAt ?? record.created_at);
      createdAt ??= timestamp;
      if (timestamp) lastActivityAt = timestamp;
      if (!title && record.type === "user") {
        title = extractMessageText(asRecord(record.message)?.content ?? record.content);
      }
    } catch {
      // The sample may start in the middle of a JSONL line; skip partial lines.
    }
  }

  return {
    cwd: cwd ?? resolve(fallbackCwd),
    title,
    createdAt,
    lastModified: lastActivityAt ?? statMtime,
  };
}

export function listClaudeStoredSessions(inputCwd: string): { sessions: ClaudeStoredSession[] } {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return { sessions: [] };

  const sessions: ClaudeStoredSession[] = [];
  try {
    for (const projectEntry of readdirSync(root, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue;
      const projectDir = join(root, projectEntry.name);
      const fallbackCwd = guessCwdFromProjectDir(projectEntry.name, inputCwd);
      for (const sessionEntry of readdirSync(projectDir, { withFileTypes: true })) {
        if (!sessionEntry.isFile() || !sessionEntry.name.endsWith(".jsonl")) continue;
        const filePath = join(projectDir, sessionEntry.name);
        try {
          const stat = statSync(filePath);
          const metadata = readClaudeSessionMetadata(filePath, fallbackCwd);
          sessions.push({
            id: basename(sessionEntry.name, ".jsonl"),
            cwd: metadata.cwd,
            title: metadata.title,
            createdAt: metadata.createdAt,
            lastModified: metadata.lastModified ?? stat.mtimeMs,
          });
        } catch {
          // Skip individual history files that disappear or are unreadable during the scan.
        }
      }
    }
  } catch {
    // Ignore unreadable Claude storage; the caller treats an empty list as no local history.
  }

  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return { sessions: sessions.slice(0, MAX_SESSIONS) };
}

function findClaudeSessionFile(sessionId: string): string | undefined {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return undefined;
  try {
    for (const projectEntry of readdirSync(root, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue;
      const projectDir = join(root, projectEntry.name);
      for (const sessionEntry of readdirSync(projectDir, { withFileTypes: true })) {
        if (!sessionEntry.isFile() || !sessionEntry.name.endsWith(".jsonl")) continue;
        if (basename(sessionEntry.name, ".jsonl") === sessionId) {
          return join(projectDir, sessionEntry.name);
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function historyMessage(
  conversationId: string,
  index: number,
  role: "user" | "assistant" | "system",
  text: string,
  createdAt: number,
  source: string,
): StoredAgentTimelineItem {
  return {
    id: `history:${source}:${index}`,
    conversationId,
    type: "message",
    role,
    content: [{ type: "text", text }],
    text,
    createdAt,
    metadata: { source: "device-history", provider: "claude" },
  };
}

function claudeToolName(name: string | undefined): string {
  if (!name) return "工具";
  if (name === "Bash") return "命令";
  if (isClaudeFileTool(name)) return "文件修改";
  return name;
}

function isClaudeFileTool(name: string | undefined): boolean {
  return name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit";
}

function claudeToolKind(name: string | undefined): "tool_activity" | "command_execution" | "file_change" {
  if (name === "Bash") return "command_execution";
  if (isClaudeFileTool(name)) return "file_change";
  return "tool_activity";
}

function claudeFileEntry(name: string | undefined, input: Record<string, unknown> | undefined): StoredAgentTimelineItem["fileChange"] | undefined {
  if (!isClaudeFileTool(name) || !input) return undefined;
  const rawPath = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
  const path = rawPath.trim();
  const kind = name === "Write" ? "create" : "update";
  const added = typeof input.new_string === "string"
    ? input.new_string.split(/\r?\n/).filter((line) => line.length > 0).length
    : typeof input.content === "string"
    ? input.content.split(/\r?\n/).filter((line) => line.length > 0).length
    : Array.isArray(input.edits)
    ? input.edits.length
    : undefined;
  const removed = typeof input.old_string === "string"
    ? input.old_string.split(/\r?\n/).filter((line) => line.length > 0).length
    : undefined;
  const entry: NonNullable<StoredAgentTimelineItem["fileChange"]>["entries"][number] = { path, kind };
  if (added && added > 0) entry.added = added;
  if (removed && removed > 0) entry.removed = removed;
  return {
    entries: [entry],
    summary: [kind, path].filter(Boolean).join(" "),
    status: "running",
  };
}

function claudeCommandExecution(input: Record<string, unknown> | undefined): StoredAgentTimelineItem["commandExecution"] | undefined {
  if (!input) return undefined;
  const command = typeof input.command === "string" ? input.command : undefined;
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
  if (!command && !cwd) return undefined;
  return { command, cwd, status: "running" };
}

function createClaudeToolItem(
  conversationId: string,
  toolUseId: string,
  name: string | undefined,
  input: Record<string, unknown> | undefined,
  createdAt: number,
): StoredAgentTimelineItem {
  const kind = claudeToolKind(name);
  const inputText = stringifyHistoryValue(input);
  const fileChange = claudeFileEntry(name, input);
  return {
    id: `history-tool:${toolUseId}`,
    conversationId,
    type: "tool_call",
    kind,
    itemId: toolUseId,
    toolCall: {
      id: toolUseId,
      name: claudeToolName(name),
      input: inputText,
      createdAt,
      status: "running",
    },
    commandExecution: name === "Bash" ? claudeCommandExecution(input) : undefined,
    fileChange,
    text: fileChange ? `已编辑 ${fileChange.entries.length} 个文件` : undefined,
    createdAt,
    updatedAt: createdAt,
    metadata: { source: "device-history", provider: "claude", toolName: name },
  };
}

function completeClaudeToolItem(
  itemsById: Map<string, StoredAgentTimelineItem>,
  conversationId: string,
  toolUseId: string,
  output: string | undefined,
  failed: boolean,
  createdAt: number,
): void {
  const id = `history-tool:${toolUseId}`;
  const existing = itemsById.get(id);
  const status = failed ? "failed" : "completed";
  itemsById.set(id, {
    id,
    conversationId,
    type: "tool_call",
    kind: existing?.kind ?? "tool_activity",
    itemId: toolUseId,
    toolCall: {
      id: toolUseId,
      name: existing?.toolCall?.name ?? "工具",
      input: existing?.toolCall?.input,
      output,
      createdAt: existing?.toolCall?.createdAt ?? createdAt,
      status,
    },
    commandExecution: existing?.commandExecution
      ? { ...existing.commandExecution, output, status }
      : undefined,
    fileChange: existing?.fileChange
      ? { ...existing.fileChange, summary: output ?? existing.fileChange.summary, status }
      : undefined,
    text: existing?.text,
    createdAt: existing?.createdAt ?? createdAt,
    updatedAt: createdAt,
    metadata: existing?.metadata ?? { source: "device-history", provider: "claude" },
  });
}

export function loadClaudeStoredTimeline(
  sessionId: string,
  conversationId: string,
): { items: StoredAgentTimelineItem[] } {
  const filePath = findClaudeSessionFile(sessionId);
  if (!filePath) return { items: [] };
  let statMtime = Date.now();
  let statSize = 0;
  try {
    const stat = statSync(filePath);
    statMtime = stat.mtimeMs;
    statSize = stat.size;
  } catch {
    return { items: [] };
  }

  const itemsById = new Map<string, StoredAgentTimelineItem>();
  let index = 0;
  for (const line of readHistorySample(filePath, statSize).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const record = asRecord(JSON.parse(trimmed));
      if (!record) continue;
      const message = asRecord(record.message);
      const rawRole = typeof record.role === "string"
        ? record.role
        : typeof message?.role === "string"
        ? message.role
        : typeof record.type === "string"
        ? record.type
        : undefined;
      const role = rawRole === "assistant" ? "assistant" : rawRole === "user" ? "user" : undefined;
      if (!role) continue;
      const createdAt =
        parseTimestamp(record.timestamp ?? record.createdAt ?? record.created_at) ??
        statMtime + index;
      const content = message?.content ?? record.content ?? record.text;
      const text = extractVisibleClaudeText(content);
      if (text) {
        itemsById.set(
          `history:${sessionId}:${index}`,
          historyMessage(conversationId, index, role, text, createdAt, sessionId),
        );
        index += 1;
      }
      if (Array.isArray(content)) {
        for (const part of content) {
          const block = asRecord(part);
          if (!block) continue;
          if (role === "assistant" && block.type === "tool_use") {
            const toolUseId = typeof block.id === "string" ? block.id : undefined;
            if (!toolUseId) continue;
            const name = typeof block.name === "string" ? block.name : undefined;
            const input = asRecord(block.input);
            const item = createClaudeToolItem(conversationId, toolUseId, name, input, createdAt);
            itemsById.set(item.id, item);
          } else if (role === "user" && block.type === "tool_result") {
            const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
            if (!toolUseId) continue;
            completeClaudeToolItem(
              itemsById,
              conversationId,
              toolUseId,
              extractHistoryText(block.content),
              block.is_error === true,
              createdAt,
            );
          }
        }
      }
    } catch {
      // Ignore malformed or partial JSONL lines in the history window.
    }
  }

  return {
    items: [...itemsById.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-MAX_HISTORY_ITEMS),
  };
}
