import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const SAMPLE_BYTES = 512 * 1024;
const HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 200;
const MAX_HISTORY_ITEMS = 200;

export interface CodexStoredSession {
  id: string;
  cwd: string;
  title?: string;
  createdAt?: number;
  lastModified: number;
  archived?: boolean;
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

interface CodexIndexEntry {
  id: string;
  title?: string;
  updatedAt?: number;
}

type StoredToolStatus = NonNullable<StoredAgentTimelineItem["toolCall"]>["status"];

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

function sessionIdFromRolloutFile(fileName: string): string | undefined {
  const withoutExt = basename(fileName, ".jsonl");
  const match = withoutExt.match(/(019[a-z0-9-]+)$/i);
  return match?.[1] ?? undefined;
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
        // Best-effort local history scan.
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
        // Best-effort local history scan.
      }
    }
  }
}

function loadSessionIndex(root: string): Map<string, CodexIndexEntry> {
  const indexPath = join(root, "session_index.jsonl");
  const entries = new Map<string, CodexIndexEntry>();
  if (!existsSync(indexPath)) return entries;

  let statSize = 0;
  try {
    statSize = statSync(indexPath).size;
  } catch {
    return entries;
  }
  for (const line of readSample(indexPath, statSize).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const entry = asRecord(JSON.parse(trimmed));
      if (!entry) continue;
      const id = typeof entry.id === "string" ? entry.id : undefined;
      if (!id) continue;
      entries.set(id, {
        id,
        title: normalizeTitle(
          typeof entry.thread_name === "string"
            ? entry.thread_name
            : typeof entry.title === "string"
            ? entry.title
            : undefined,
        ),
        updatedAt: parseTimestamp(entry.updated_at ?? entry.updatedAt),
      });
    } catch {
      // Ignore malformed index lines.
    }
  }
  return entries;
}

function readCodexSessionFile(filePath: string, fallbackCwd: string): Omit<CodexStoredSession, "lastModified"> & {
  lastModified?: number;
} | undefined {
  let statSize = 0;
  let statMtime: number | undefined;
  try {
    const stat = statSync(filePath);
    statSize = stat.size;
    statMtime = stat.mtimeMs;
  } catch {
    return undefined;
  }

  let id = sessionIdFromRolloutFile(filePath);
  let cwd: string | undefined;
  let title: string | undefined;
  let createdAt: number | undefined;
  let lastActivityAt: number | undefined;
  for (const line of readSample(filePath, statSize).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const entry = asRecord(JSON.parse(trimmed));
      const payload = asRecord(entry?.payload);
      if (entry?.type === "session_meta" && payload) {
        if (typeof payload.id === "string") id = payload.id;
        if (typeof payload.cwd === "string" && payload.cwd.trim()) cwd = payload.cwd;
        createdAt ??= parseTimestamp(payload.timestamp);
      }
      if (entry?.type === "event_msg" && payload?.type === "user_message") {
        title ??= normalizeTitle(normalizeHistoryText(payload.message));
      }
      const timestamp = parseTimestamp(entry?.timestamp);
      createdAt ??= timestamp;
      if (timestamp) lastActivityAt = timestamp;
    } catch {
      // The sample may contain partial JSONL lines.
    }
  }

  if (!id) return undefined;
  return {
    id,
    cwd: cwd ?? resolve(fallbackCwd),
    title,
    createdAt,
    lastModified: lastActivityAt ?? statMtime,
  };
}

function collectJsonlFiles(dir: string, result: Array<{ path: string; archived: boolean }>, archived: boolean): void {
  if (!existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectJsonlFiles(path, result, archived);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push({ path, archived });
      }
    }
  } catch {
    // Ignore unreadable local history directories.
  }
}

function findCodexSessionFile(sessionId: string, inputCwd: string): { path: string; archived: boolean } | undefined {
  const root = join(homedir(), ".codex");
  if (!existsSync(root)) return undefined;
  const files: Array<{ path: string; archived: boolean }> = [];
  collectJsonlFiles(join(root, "sessions"), files, false);
  collectJsonlFiles(join(root, "archived_sessions"), files, true);

  let best: { path: string; archived: boolean; lastModified: number } | undefined;
  for (const file of files) {
    const fileId = sessionIdFromRolloutFile(file.path);
    let metadata: ReturnType<typeof readCodexSessionFile> | undefined;
    if (fileId !== sessionId) {
      metadata = readCodexSessionFile(file.path, inputCwd);
      if (metadata?.id !== sessionId) continue;
    }
    let lastModified = metadata?.lastModified;
    if (!lastModified) {
      try {
        lastModified = statSync(file.path).mtimeMs;
      } catch {
        lastModified = 0;
      }
    }
    if (!best || file.archived || lastModified > best.lastModified) {
      best = { ...file, lastModified };
    }
  }
  return best;
}

function normalizeHistoryText(value: unknown): string | undefined {
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
  return normalizeHistoryText(record.content ?? record.text ?? record.message);
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

function visibleCodexRole(value: unknown): "user" | "assistant" | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
}

function isInjectedCodexContext(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<app-context>") ||
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<skill>") ||
    trimmed.startsWith("<turn_aborted>") ||
    trimmed.startsWith("<developer") ||
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.startsWith("AGENTS.md instructions for ") ||
    trimmed.includes("\n# AGENTS.md\n") ||
    trimmed.includes("\n<INSTRUCTIONS>")
  );
}

function messageDedupeKey(role: "user" | "assistant" | "system", text: string): string {
  return `${role}:${text.replace(/\s+/g, " ").trim().slice(0, 400)}`;
}

function historyMessage(
  conversationId: string,
  index: number,
  role: "user" | "assistant" | "system",
  text: string,
  createdAt: number,
  source: string,
): StoredAgentTimelineItem {
  const id = `history:${source}:${index}`;
  return {
    id,
    conversationId,
    type: "message",
    role,
    content: [{ type: "text", text }],
    text,
    createdAt,
    metadata: { source: "device-history", provider: "codex" },
  };
}

function historyToolName(name: string | undefined): string {
  if (!name) return "工具";
  if (name.endsWith("exec_command") || name.endsWith("write_stdin")) return "命令";
  if (name === "apply_patch") return "文件修改";
  return name;
}

function historyToolKind(name: string | undefined): "tool_activity" | "command_execution" | "file_change" {
  if (name === "apply_patch") return "file_change";
  return name?.endsWith("exec_command") || name?.endsWith("write_stdin") ? "command_execution" : "tool_activity";
}

function commandFromCodexTool(name: string | undefined, rawInput: unknown, output?: string): StoredAgentTimelineItem["commandExecution"] {
  if (!name?.endsWith("exec_command") && !name?.endsWith("write_stdin")) return undefined;
  let input = asRecord(rawInput);
  if (!input && typeof rawInput === "string" && rawInput.trim().startsWith("{")) {
    try {
      input = asRecord(JSON.parse(rawInput));
    } catch {
      input = undefined;
    }
  }
  const command = typeof input?.cmd === "string"
    ? input.cmd
    : typeof input?.chars === "string"
    ? input.chars
    : undefined;
  const cwd = typeof input?.workdir === "string" ? input.workdir : undefined;
  if (!command && !cwd && !output) return undefined;
  return { command, cwd, output, status: output === undefined ? "running" : "completed" };
}

function patchTextFromCodexTool(name: string | undefined, rawInput: unknown, input: string | undefined): string | undefined {
  if (name !== "apply_patch") return undefined;
  if (typeof rawInput === "string") return rawInput;
  const record = asRecord(rawInput);
  for (const key of ["patch", "input", "text", "content"]) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return input;
}

function fileChangeFromApplyPatch(
  patchText: string | undefined,
  status: StoredToolStatus,
): StoredAgentTimelineItem["fileChange"] | undefined {
  if (!patchText?.trim()) return undefined;
  const entries: NonNullable<StoredAgentTimelineItem["fileChange"]>["entries"] = [];
  let current: NonNullable<StoredAgentTimelineItem["fileChange"]>["entries"][number] | undefined;

  const flush = () => {
    if (!current?.path) return;
    const existing = entries.find((entry) => entry.path === current!.path);
    if (existing) {
      existing.added = (existing.added ?? 0) + (current.added ?? 0);
      existing.removed = (existing.removed ?? 0) + (current.removed ?? 0);
      existing.kind ??= current.kind;
    } else {
      entries.push(current);
    }
  };

  for (const rawLine of patchText.split(/\r?\n/)) {
    const add = rawLine.match(/^\*\*\* Add File:\s+(.+)$/);
    const update = rawLine.match(/^\*\*\* Update File:\s+(.+)$/);
    const del = rawLine.match(/^\*\*\* Delete File:\s+(.+)$/);
    const move = rawLine.match(/^\*\*\* Move to:\s+(.+)$/);
    if (add || update || del) {
      flush();
      current = {
        path: (add?.[1] ?? update?.[1] ?? del?.[1] ?? "").trim(),
        kind: add ? "create" : del ? "delete" : "update",
        added: 0,
        removed: 0,
      };
      continue;
    }
    if (move?.[1] && current) {
      current.path = move[1].trim();
      current.kind = "move";
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      current.added = (current.added ?? 0) + 1;
    } else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      current.removed = (current.removed ?? 0) + 1;
    }
  }
  flush();

  if (entries.length === 0) return undefined;
  return {
    entries,
    diff: patchText,
    summary: entries.map((entry) => [entry.kind, entry.path].filter(Boolean).join(" ")).join("\n"),
    status,
  };
}

function upsertHistoryTool(
  itemsById: Map<string, StoredAgentTimelineItem>,
  conversationId: string,
  callId: string,
  name: string | undefined,
  rawInput: unknown,
  input: string | undefined,
  createdAt: number,
): void {
  const id = `history-tool:${callId}`;
  const existing = itemsById.get(id);
  const commandExecution = commandFromCodexTool(name, rawInput, existing?.commandExecution?.output);
  const status: StoredToolStatus = existing?.toolCall?.status ?? "running";
  const fileChange = fileChangeFromApplyPatch(patchTextFromCodexTool(name, rawInput, input), status);
  itemsById.set(id, {
    id,
    conversationId,
    type: "tool_call",
    kind: fileChange ? "file_change" : historyToolKind(name),
    itemId: callId,
    toolCall: {
      id: callId,
      name: fileChange ? "文件修改" : historyToolName(name),
      input: fileChange?.summary ?? input ?? existing?.toolCall?.input,
      output: existing?.toolCall?.output,
      createdAt: existing?.toolCall?.createdAt ?? createdAt,
      status,
    },
    commandExecution: commandExecution ?? existing?.commandExecution,
    fileChange: fileChange ?? existing?.fileChange,
    text: fileChange
      ? `已编辑 ${fileChange.entries.length} 个文件`
      : existing?.text,
    createdAt: existing?.createdAt ?? createdAt,
    updatedAt: createdAt,
    metadata: { source: "device-history", provider: "codex" },
  });
}

function completeHistoryTool(
  itemsById: Map<string, StoredAgentTimelineItem>,
  conversationId: string,
  callId: string,
  output: string | undefined,
  createdAt: number,
): void {
  const id = `history-tool:${callId}`;
  const existing = itemsById.get(id);
  const commandExecution = existing?.commandExecution
    ? { ...existing.commandExecution, output, status: "completed" as const }
    : undefined;
  const fileChange = existing?.fileChange
    ? { ...existing.fileChange, summary: existing.fileChange.summary ?? output, status: "completed" as const }
    : undefined;
  itemsById.set(id, {
    id,
    conversationId,
    type: "tool_call",
    kind: existing?.kind ?? "tool_activity",
    itemId: callId,
    toolCall: {
      id: callId,
      name: existing?.toolCall?.name ?? "工具",
      input: existing?.toolCall?.input,
      output,
      createdAt: existing?.toolCall?.createdAt ?? createdAt,
      status: "completed",
    },
    commandExecution,
    fileChange,
    text: fileChange ? existing?.text ?? `已编辑 ${fileChange.entries.length} 个文件` : existing?.text,
    createdAt: existing?.createdAt ?? createdAt,
    updatedAt: createdAt,
    metadata: { source: "device-history", provider: "codex" },
  });
}

function relativeHistoryPath(path: string, cwd: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^["']|["']$/g, "");
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.startsWith(`${normalizedCwd}/`)
    ? normalized.slice(normalizedCwd.length + 1)
    : normalized;
}

function countDiffLines(diff: string | undefined): { added: number; removed: number } {
  if (!diff) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function countContentLines(content: unknown): number {
  if (typeof content !== "string") return 0;
  if (!content) return 0;
  return content.split(/\r?\n/).filter((line) => line.length > 0).length;
}

function changeKind(value: string | undefined): string | undefined {
  if (value === "add") return "create";
  if (value === "delete") return "delete";
  if (value === "update" || value === "move") return "update";
  return value;
}

function patchApplyFileChange(
  conversationId: string,
  payload: Record<string, unknown>,
  cwd: string,
  createdAt: number,
): StoredAgentTimelineItem | undefined {
  const changes = asRecord(payload.changes);
  if (!changes) return undefined;
  const entries: NonNullable<StoredAgentTimelineItem["fileChange"]>["entries"] = [];
  const diffParts: string[] = [];
  for (const [absolutePath, rawChange] of Object.entries(changes)) {
    const change = asRecord(rawChange);
    if (!change) continue;
    const path = relativeHistoryPath(absolutePath, cwd);
    const kind = changeKind(typeof change.type === "string" ? change.type : undefined);
    const diff = typeof change.unified_diff === "string" ? change.unified_diff : undefined;
    const stats = countDiffLines(diff);
    const added = stats.added || (kind === "create" ? countContentLines(change.content) : 0);
    const removed = stats.removed;
    const entry: NonNullable<StoredAgentTimelineItem["fileChange"]>["entries"][number] = { path };
    if (kind) entry.kind = kind;
    if (added > 0) entry.added = added;
    if (removed > 0) entry.removed = removed;
    entries.push(entry);
    if (diff) {
      diffParts.push([
        `Path: ${path}`,
        kind ? `Kind: ${kind}` : undefined,
        `Totals: +${added} -${removed}`,
        "",
        "```diff",
        diff.trimEnd(),
        "```",
      ].filter((line): line is string => line !== undefined).join("\n"));
    }
  }
  if (entries.length === 0) return undefined;
  const callId = typeof payload.call_id === "string" ? payload.call_id : `patch-${createdAt}`;
  const status = payload.success === false ? "failed" : "completed";
  const totalAdded = entries.reduce((sum, entry) => sum + (entry.added ?? 0), 0);
  const totalRemoved = entries.reduce((sum, entry) => sum + (entry.removed ?? 0), 0);
  const summary = entries
    .map((entry) => [entry.kind, entry.path].filter(Boolean).join(" "))
    .join("\n");
  const diff = diffParts.length > 0 ? diffParts.join("\n\n---\n\n") : undefined;
  return {
    id: `history-file-change:${callId}`,
    conversationId,
    type: "tool_call",
    kind: "file_change",
    itemId: callId,
    toolCall: {
      id: callId,
      name: "文件修改",
      input: summary,
      output: diff ?? (typeof payload.stdout === "string" ? payload.stdout : undefined),
      createdAt,
      status,
    },
    fileChange: {
      entries,
      diff,
      summary,
      status,
    },
    text: `已编辑 ${entries.length} 个文件 +${totalAdded} -${totalRemoved}`,
    createdAt,
    updatedAt: createdAt,
    metadata: { source: "device-history", provider: "codex" },
  };
}

export function listCodexStoredSessions(inputCwd: string): { sessions: CodexStoredSession[] } {
  const root = join(homedir(), ".codex");
  if (!existsSync(root)) return { sessions: [] };

  const index = loadSessionIndex(root);
  const files: Array<{ path: string; archived: boolean }> = [];
  collectJsonlFiles(join(root, "sessions"), files, false);
  collectJsonlFiles(join(root, "archived_sessions"), files, true);

  const sessionsById = new Map<string, CodexStoredSession>();
  for (const file of files) {
    const metadata = readCodexSessionFile(file.path, inputCwd);
    if (!metadata) continue;
    const indexed = index.get(metadata.id);
    const session: CodexStoredSession = {
      id: metadata.id,
      cwd: metadata.cwd,
      title: indexed?.title ?? metadata.title,
      createdAt: metadata.createdAt,
      lastModified: indexed?.updatedAt ?? metadata.lastModified ?? Date.now(),
      archived: file.archived,
    };
    const existing = sessionsById.get(session.id);
    if (!existing || session.lastModified > existing.lastModified || session.archived) {
      sessionsById.set(session.id, session);
    }
  }

  for (const indexed of index.values()) {
    if (sessionsById.has(indexed.id)) continue;
    sessionsById.set(indexed.id, {
      id: indexed.id,
      cwd: resolve(inputCwd),
      title: indexed.title,
      lastModified: indexed.updatedAt ?? Date.now(),
      archived: false,
    });
  }

  return {
    sessions: [...sessionsById.values()]
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, MAX_SESSIONS),
  };
}

export function loadCodexStoredTimeline(
  sessionId: string,
  conversationId: string,
  inputCwd: string,
): { items: StoredAgentTimelineItem[] } {
  const file = findCodexSessionFile(sessionId, inputCwd);
  if (!file) return { items: [] };
  let statMtime = Date.now();
  let statSize = 0;
  try {
    const stat = statSync(file.path);
    statMtime = stat.mtimeMs;
    statSize = stat.size;
  } catch {
    return { items: [] };
  }

  const itemsById = new Map<string, StoredAgentTimelineItem>();
  const seenMessages = new Set<string>();
  let index = 0;
  for (const line of readHistorySample(file.path, statSize).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const entry = asRecord(JSON.parse(trimmed));
      const payload = asRecord(entry?.payload);
      const createdAt =
        parseTimestamp(entry?.timestamp ?? payload?.created_at ?? payload?.started_at ?? payload?.completed_at) ??
        statMtime + index;
      if (entry?.type === "event_msg" && payload) {
        const eventType = typeof payload.type === "string" ? payload.type : undefined;
        if (eventType === "user_message") {
          const text = normalizeHistoryText(payload.message);
          if (!text || isInjectedCodexContext(text)) continue;
          const dedupeKey = messageDedupeKey("user", text);
          if (seenMessages.has(dedupeKey)) continue;
          seenMessages.add(dedupeKey);
          itemsById.set(`history:${sessionId}:${index}`, historyMessage(conversationId, index, "user", text, createdAt, sessionId));
          index += 1;
        } else if (eventType === "agent_message") {
          const text = normalizeHistoryText(payload.message);
          if (!text || isInjectedCodexContext(text)) continue;
          const dedupeKey = messageDedupeKey("assistant", text);
          if (seenMessages.has(dedupeKey)) continue;
          seenMessages.add(dedupeKey);
          itemsById.set(`history:${sessionId}:${index}`, historyMessage(conversationId, index, "assistant", text, createdAt, sessionId));
          index += 1;
        } else if (eventType === "patch_apply_end") {
          const item = patchApplyFileChange(conversationId, payload, inputCwd, createdAt);
          if (item) itemsById.set(item.id, item);
        }
        continue;
      }

      if (entry?.type !== "response_item" || !payload) continue;
      const responseType = typeof payload.type === "string" ? payload.type : undefined;
      if (responseType === "message") {
        const role = visibleCodexRole(payload.role);
        if (!role) continue;
        const text = normalizeHistoryText(payload.message);
        const contentText = text ?? normalizeHistoryText(payload.content);
        if (!contentText || isInjectedCodexContext(contentText)) continue;
        const dedupeKey = messageDedupeKey(role, contentText);
        if (seenMessages.has(dedupeKey)) continue;
        seenMessages.add(dedupeKey);
        itemsById.set(`history:${sessionId}:${index}`, historyMessage(conversationId, index, role, contentText, createdAt, sessionId));
        index += 1;
        continue;
      }
      if (responseType === "function_call") {
        const callId = typeof payload.call_id === "string"
          ? payload.call_id
          : typeof payload.id === "string"
          ? payload.id
          : undefined;
        if (!callId) continue;
        const name = typeof payload.name === "string" ? payload.name : undefined;
        upsertHistoryTool(
          itemsById,
          conversationId,
          callId,
          name,
          payload.arguments,
          stringifyHistoryValue(payload.arguments),
          createdAt,
        );
        continue;
      }
      if (responseType === "function_call_output") {
        const callId = typeof payload.call_id === "string"
          ? payload.call_id
          : typeof payload.id === "string"
          ? payload.id
          : undefined;
        if (!callId) continue;
        completeHistoryTool(itemsById, conversationId, callId, stringifyHistoryValue(payload.output), createdAt);
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
