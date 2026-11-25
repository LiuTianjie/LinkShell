import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionUpdate } from "@linkshell/wire";

// Content-addressed external blob store for base64 media payloads larger than 16 KB.
// Keeping screenshots/audio/attachments on disk under `<home>/blobs/<sha256>` prevents
// SQLite WAL amplification and multi-GB `state.db` growth while preserving exact retrieval.

export const BLOB_URI_PREFIX = "linkshell-blob:";
/** Payloads larger than this (base64 characters) are externalized out of SQLite. */
export const INLINE_BLOB_THRESHOLD = 16 * 1024;
const DEFAULT_MAX_BLOB_MB = 256;
const BLOB_URI_RE = /^linkshell-blob:([a-f0-9]{64})$/;
const DATA_URL_RE = /^data:((?:image|audio)\/[^;,]+);base64,/i;

const updateBlobStores = new WeakMap<object, BlobStore>();

/** Associates an event update object with the BlobStore that owns its externalized URIs. */
export function attachBlobStore(update: SessionUpdate, store: BlobStore): SessionUpdate {
  if (update && typeof update === "object") updateBlobStores.set(update, store);
  return update;
}

/** Returns the BlobStore attached to an event update, if any. */
export function blobStoreOf(update: unknown): BlobStore | undefined {
  return update && typeof update === "object" ? updateBlobStores.get(update) : undefined;
}

/** Extracts the 64-hex SHA-256 digest from a `linkshell-blob:<sha256>` URI. */
export function parseBlobUri(uri: string): string | undefined {
  const match = BLOB_URI_RE.exec(uri);
  return match?.[1];
}

function defaultMaxBytes(): number {
  const raw = process.env.LINKSHELL_BLOBS_MAX_MB;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed * 1024 * 1024);
  }
  return DEFAULT_MAX_BLOB_MB * 1024 * 1024;
}

export interface BlobStoreOptions {
  maxBytes?: number;
}

export interface BlobPutResult {
  uri: string;
  sha256: string;
  bytes: number;
}

export class BlobStore {
  private readonly dir?: string;
  private readonly maxBytes: number;
  private readonly memory = new Map<string, { data: string; bytes: number; mtimeMs: number }>();
  private dirReady = false;

  /** Passing `undefined` creates an in-memory store (used for `:memory:` SQLite databases). */
  constructor(blobsDir?: string, options: BlobStoreOptions = {}) {
    this.dir = blobsDir;
    this.maxBytes = options.maxBytes ?? defaultMaxBytes();
  }

  get directory(): string | undefined {
    return this.dir;
  }

  putBase64(data: string): BlobPutResult {
    const sha256 = createHash("sha256").update(data, "utf8").digest("hex");
    const uri = `${BLOB_URI_PREFIX}${sha256}`;
    const bytes = Buffer.byteLength(data, "utf8");
    const now = Date.now();
    if (!this.dir) {
      this.memory.set(sha256, { data, bytes, mtimeMs: now });
      return { uri, sha256, bytes };
    }
    this.ensureDir();
    const target = join(this.dir, sha256);
    try {
      const existing = statSync(target);
      if (existing.isFile()) {
        const at = new Date(now);
        try {
          utimesSync(target, at, at);
        } catch {
          // Best-effort LRU touch.
        }
        return { uri, sha256, bytes: existing.size };
      }
    } catch {
      // Not written yet.
    }
    const tmp = join(this.dir, `.${sha256}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, target);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // Ignore cleanup error.
      }
      throw error;
    }
    return { uri, sha256, bytes };
  }

  getBase64(uriOrSha: string): string | undefined {
    const sha256 = uriOrSha.startsWith(BLOB_URI_PREFIX) ? parseBlobUri(uriOrSha) : /^[a-f0-9]{64}$/.test(uriOrSha) ? uriOrSha : undefined;
    if (!sha256) return undefined;
    if (!this.dir) {
      const entry = this.memory.get(sha256);
      if (!entry) return undefined;
      entry.mtimeMs = Date.now();
      return entry.data;
    }
    const target = join(this.dir, sha256);
    try {
      const data = readFileSync(target, "utf8");
      const now = new Date();
      try {
        utimesSync(target, now, now);
      } catch {
        // Best-effort LRU touch on read.
      }
      return data;
    } catch {
      return undefined;
    }
  }

  has(uriOrSha: string): boolean {
    const sha256 = uriOrSha.startsWith(BLOB_URI_PREFIX) ? parseBlobUri(uriOrSha) : /^[a-f0-9]{64}$/.test(uriOrSha) ? uriOrSha : undefined;
    if (!sha256) return false;
    if (!this.dir) return this.memory.has(sha256);
    try {
      return statSync(join(this.dir, sha256)).isFile();
    } catch {
      return false;
    }
  }

  /** Evicts least-recently-used blobs until total size is at or below `budgetBytes`. */
  prune(budgetBytes = this.maxBytes): { removedFiles: number; reclaimedBytes: number; remainingBytes: number } {
    const cap = Math.max(0, Math.trunc(budgetBytes));
    if (!this.dir) {
      const entries = [...this.memory.entries()].sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
      let total = entries.reduce((sum, [, entry]) => sum + entry.bytes, 0);
      let removedFiles = 0;
      let reclaimedBytes = 0;
      for (const [sha, entry] of entries) {
        if (total <= cap) break;
        this.memory.delete(sha);
        total -= entry.bytes;
        removedFiles++;
        reclaimedBytes += entry.bytes;
      }
      return { removedFiles, reclaimedBytes, remainingBytes: total };
    }

    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return { removedFiles: 0, reclaimedBytes: 0, remainingBytes: 0 };
    }
    const entries: { path: string; size: number; mtimeMs: number }[] = [];
    let total = 0;
    const now = Date.now();
    for (const name of names) {
      const full = join(this.dir, name);
      if (name.endsWith(".tmp")) {
        // Reap orphaned atomic-write temp files older than 5 minutes.
        try {
          const st = statSync(full);
          if (now - st.mtimeMs > 5 * 60_000) unlinkSync(full);
        } catch {
          // Ignore concurrent unlink.
        }
        continue;
      }
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        entries.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
        total += st.size;
      } catch {
        // Ignore files removed concurrently.
      }
    }
    if (total <= cap) return { removedFiles: 0, reclaimedBytes: 0, remainingBytes: total };
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let removedFiles = 0;
    let reclaimedBytes = 0;
    for (const entry of entries) {
      if (total <= cap) break;
      try {
        unlinkSync(entry.path);
        total -= entry.size;
        removedFiles++;
        reclaimedBytes += entry.size;
      } catch {
        // Ignore concurrent deletion.
      }
    }
    return { removedFiles, reclaimedBytes, remainingBytes: total };
  }

  /**
   * Replaces inline base64 images/audio/resource blobs > 16 KB with `linkshell-blob:<sha256>`
   * references while keeping small metadata (mimeType, dimensions, annotations) intact.
   */
  externalizeUpdate(update: SessionUpdate): SessionUpdate {
    const next = this.walkExternalize(update) as SessionUpdate;
    return attachBlobStore(next, this);
  }

  private walkExternalize(value: unknown): unknown {
    if (Array.isArray(value)) {
      let out: unknown[] | undefined;
      for (let i = 0; i < value.length; i++) {
        const entry = value[i];
        const next = this.walkExternalize(entry);
        if (next !== entry) (out ??= value.slice())[i] = next;
      }
      return out ?? value;
    }
    if (!value || typeof value !== "object") return value;

    const record = value as Record<string, unknown>;
    if ((record.type === "image" || record.type === "audio") && typeof record.mimeType === "string") {
      if (typeof record.data === "string" && record.data.length > INLINE_BLOB_THRESHOLD) {
        const { uri } = this.putBase64(record.data);
        const { data: _data, ...rest } = record;
        return { ...rest, uri };
      }
      if (typeof record.uri === "string" && record.uri.length > INLINE_BLOB_THRESHOLD) {
        const match = DATA_URL_RE.exec(record.uri);
        if (match) {
          const payload = record.uri.slice(match[0].length);
          if (payload.length > INLINE_BLOB_THRESHOLD) {
            const { uri } = this.putBase64(payload);
            return { ...record, mimeType: match[1]!, uri };
          }
        }
      }
    }

    if (record.type === "resource" && record.resource && typeof record.resource === "object") {
      const resource = record.resource as Record<string, unknown>;
      if (typeof resource.blob === "string" && resource.blob.length > INLINE_BLOB_THRESHOLD) {
        const { uri } = this.putBase64(resource.blob);
        const { blob: _blob, ...rest } = resource;
        return { ...record, resource: { ...rest, assetUri: uri } };
      }
    }

    let out: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(record)) {
      const next = this.walkExternalize(entry);
      if (next !== entry) (out ??= { ...record })[key] = next;
    }
    return out ?? value;
  }

  private ensureDir(): void {
    if (this.dirReady || !this.dir) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.dirReady = true;
  }
}
