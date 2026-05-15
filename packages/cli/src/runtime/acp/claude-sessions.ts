import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const SAMPLE_BYTES = 64 * 1024;
const MAX_SESSIONS = 200;

export interface ClaudeStoredSession {
  id: string;
  cwd: string;
  title?: string;
  createdAt?: number;
  lastModified: number;
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
