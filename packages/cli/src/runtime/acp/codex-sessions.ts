import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const SAMPLE_BYTES = 64 * 1024;
const MAX_SESSIONS = 200;

export interface CodexStoredSession {
  id: string;
  cwd: string;
  title?: string;
  createdAt?: number;
  lastModified: number;
}

interface CodexIndexEntry {
  id: string;
  title?: string;
  updatedAt?: number;
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
    createdAt,
    lastModified: lastActivityAt ?? statMtime,
  };
}

function collectJsonlFiles(dir: string, result: string[]): void {
  if (!existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectJsonlFiles(path, result);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(path);
      }
    }
  } catch {
    // Ignore unreadable local history directories.
  }
}

export function listCodexStoredSessions(inputCwd: string): { sessions: CodexStoredSession[] } {
  const root = join(homedir(), ".codex");
  if (!existsSync(root)) return { sessions: [] };

  const index = loadSessionIndex(root);
  const files: string[] = [];
  collectJsonlFiles(join(root, "sessions"), files);
  collectJsonlFiles(join(root, "archived_sessions"), files);

  const sessionsById = new Map<string, CodexStoredSession>();
  for (const file of files) {
    const metadata = readCodexSessionFile(file, inputCwd);
    if (!metadata) continue;
    const indexed = index.get(metadata.id);
    const session: CodexStoredSession = {
      id: metadata.id,
      cwd: metadata.cwd,
      title: indexed?.title,
      createdAt: metadata.createdAt,
      lastModified: indexed?.updatedAt ?? metadata.lastModified ?? Date.now(),
    };
    const existing = sessionsById.get(session.id);
    if (!existing || session.lastModified > existing.lastModified) {
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
    });
  }

  return {
    sessions: [...sessionsById.values()]
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, MAX_SESSIONS),
  };
}
