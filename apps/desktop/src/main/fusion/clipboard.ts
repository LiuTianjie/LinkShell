import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  FUSION_FILE_CLIPBOARD_CHUNK_BYTES,
  FUSION_MAX_FILE_CLIPBOARD,
  FUSION_MAX_FILE_CLIPBOARD_FILES,
  type FusionMessage,
} from "./wire.js";

/** Control frames top out at 16 MB; leave room for the base64 expansion (~4/3) and headers. */
export const MAX_CLIPBOARD_BYTES = 8 << 20;
const MAX_CONCURRENT_FILE_TRANSFERS = 4;

export interface ClipboardSnapshot {
  text: string;
  /** Which pasteboard types are present, so an updated picture with a new digest can still be polled on focus. */
  types: string;
  concealed: boolean;
  png: () => Promise<Buffer | undefined>;
  files?: string[];
}

export interface ClipboardPort {
  read(): Promise<ClipboardSnapshot>;
  write(clip: { text?: string; png?: Buffer }): Promise<void> | void;
  writeFiles?(paths: string[]): Promise<void> | void;
}

export interface FusionClipboardOptions {
  /** Override temporary staging directory root (defaults to `os.tmpdir()`). */
  stageRoot?: string;
  /** Maximum total bytes across one file-clipboard transfer (default 50 MiB). */
  maxFileBytes?: number;
  /** Chunk size per `clip.file.chunk` frame (default 512 KiB). */
  chunkBytes?: number;
  /** Guard evaluated before sending file-clipboard messages (e.g. `remoteFeatures.has("file-clipboard")`). */
  canSendFiles?: () => boolean;
}

const digest = (data: Buffer | string) => createHash("sha1").update(data).digest("hex");

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_m, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return "\"";
      case "apos":
        return "'";
      default: {
        const code = entity.startsWith("#x")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
      }
    }
  });
}

/** Encodes absolute file paths into macOS `NSFilenamesPboardType` UTF-8 XML plist format. */
export function buildMacNsFilenamesPlist(paths: readonly string[]): Buffer {
  const items = paths.map((p) => `\t<string>${xmlEscape(p)}</string>`).join("\n");
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<array>",
    items,
    "</array>",
    "</plist>",
    "",
  ].join("\n");
  return Buffer.from(xml, "utf8");
}

/** Parses macOS `NSFilenamesPboardType` XML plist buffer into file paths. */
export function parseMacNsFilenamesPlist(buffer: Buffer): string[] {
  if (!buffer || buffer.length === 0) return [];
  const text = buffer.toString("utf8");
  if (!text.includes("<plist") && !text.includes("<string")) return [];
  const out: string[] = [];
  const pattern = /<string>([\s\S]*?)<\/string>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const decoded = xmlUnescape(match[1] ?? "").trim();
    if (decoded) out.push(decoded);
  }
  return out;
}

/** Encodes absolute file paths into Windows `CF_HDROP` (`DROPFILES` struct + UTF-16LE double-NUL) format. */
export function buildWindowsDropFiles(paths: readonly string[]): Buffer {
  const header = Buffer.alloc(20, 0);
  header.writeUInt32LE(20, 0); // pFiles offset
  header.writeUInt32LE(1, 16); // fWide = TRUE (UTF-16LE)
  const bodyParts = paths.map((p) => Buffer.from(`${p}\0`, "utf16le"));
  bodyParts.push(Buffer.from("\0", "utf16le"));
  return Buffer.concat([header, ...bodyParts]);
}

/** Parses Windows `CF_HDROP` (`DROPFILES`) buffer into file paths (supports UTF-16LE and ANSI). */
export function parseWindowsDropFiles(buffer: Buffer): string[] {
  if (!buffer || buffer.length < 20) return [];
  const pFiles = buffer.readUInt32LE(0);
  const fWide = buffer.readUInt32LE(16) !== 0;
  if (pFiles < 20 || pFiles >= buffer.length) return [];
  const raw = buffer.subarray(pFiles);
  const text = fWide
    ? raw.subarray(0, raw.length - (raw.length % 2)).toString("utf16le")
    : raw.toString("utf8");
  const out: string[] = [];
  for (const part of text.split("\0")) {
    if (!part) break;
    out.push(part);
  }
  return out;
}

/** Parses Windows `FileNameW` single UTF-16LE path clipboard format. */
export function parseWindowsFileNameW(buffer: Buffer): string[] {
  if (!buffer || buffer.length < 2) return [];
  const clean = buffer
    .subarray(0, buffer.length - (buffer.length % 2))
    .toString("utf16le")
    .replace(/\0+$/, "");
  return clean ? [clean] : [];
}

/** Resolves a staged incoming filename strictly inside `stageDir/<index>/`, preventing traversal/control chars. */
export function resolveSafeClipFilePath(
  stageDir: string,
  index: number,
  rawName: string,
): string | null {
  if (!rawName || rawName.length > 255) return null;
  if (rawName === "." || rawName === "..") return null;
  if (/[/\\\0]/.test(rawName) || /[\x00-\x1f]/.test(rawName)) return null;
  const subDir = resolve(stageDir, String(index));
  const resolved = resolve(subDir, rawName);
  if (!resolved.startsWith(`${subDir}${sep}`) || basename(resolved) !== rawName) return null;
  return resolved;
}

function makeSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best-effort on filesystems without POSIX permissions.
    }
  }
}

interface IncomingClipFile {
  index: number;
  name: string;
  expectedSize: number;
  path: string;
  receivedBytes: number;
  nextSeq: number;
}

interface IncomingFileTransfer {
  transferId: string;
  stageDir: string;
  files: Map<number, IncomingClipFile>;
  orderedFiles: IncomingClipFile[];
  totalExpectedBytes: number;
  totalReceivedBytes: number;
  failed: boolean;
  queue: Promise<void>;
}

/**
 * Bidirectional Fusion clipboard sync (`clip` text/PNG + `clip.file.*` chunked files).
 * Only activates after the user enters a fused window (`focused()`), tracks outgoing/incoming
 * digests to prevent echo loops, stages incoming files in a `0700` temp directory with traversal
 * sanitization, and removes all staged temp files on abort/reset/dispose.
 */
export class FusionClipboard {
  private armed = false;
  /** The cheap digest (`types` + text), so polling skips PNG encoding when nothing changed. */
  private seenCheap = "";
  private seenImage = "";
  private seenFiles = "";
  private suppressedImage = "";
  private suppressedFiles = "";
  private busy = false;
  private outgoingFileEpoch = 0;
  private outgoingFileQueue: Promise<void> = Promise.resolve();
  private readonly incomingTransfers = new Map<string, IncomingFileTransfer>();
  private readonly stagingDirs = new Set<string>();
  private readonly maxFileBytes: number;
  private readonly chunkBytes: number;

  constructor(
    private readonly port: ClipboardPort,
    private readonly send: (message: FusionMessage) => void,
    private readonly options: FusionClipboardOptions = {},
  ) {
    this.maxFileBytes = options.maxFileBytes ?? FUSION_MAX_FILE_CLIPBOARD;
    this.chunkBytes = options.chunkBytes ?? FUSION_FILE_CLIPBOARD_CHUNK_BYTES;
  }

  /** A fused window took focus: learn what is already on this pasteboard, and check for a new picture. */
  async focused(): Promise<void> {
    this.armed = true;
    await this.push(true);
  }

  /** Cheap check while a fused window has focus: catches text/file copies, and picture copies whose types changed. */
  async tick(): Promise<void> {
    if (!this.armed) return;
    await this.push(false);
  }

  private async push(checkImage: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const snap = await this.port.read();
      if (snap.concealed) return;

      const files = snap.files?.filter((f) => typeof f === "string" && f.length > 0) ?? [];
      if (files.length > 0 && (this.options.canSendFiles?.() ?? true)) {
        const filesKey = digest(files.join("\0"));
        if (filesKey === this.suppressedFiles || filesKey === this.seenFiles) {
          return;
        }
        this.seenFiles = filesKey;
        this.seenCheap = "";
        this.suppressedFiles = "";
        const epoch = this.outgoingFileEpoch;
        const snapshotFiles = [...files];
        this.outgoingFileQueue = this.outgoingFileQueue
          .then(() => this.sendFiles(snapshotFiles, epoch))
          .catch(() => undefined);
        return;
      }

      const cheap = digest(`${snap.types}\0${snap.text}`);
      const cheapChanged = cheap !== this.seenCheap;
      this.seenCheap = cheap;
      this.seenFiles = "";
      if (!cheapChanged && !checkImage) return;

      const png = await snap.png();
      const imageKey = png ? digest(png) : "";
      const imageNew = !!png && png.length <= MAX_CLIPBOARD_BYTES && imageKey !== this.suppressedImage && imageKey !== this.seenImage;
      this.seenImage = imageKey;
      this.suppressedImage = "";
      if (!cheapChanged && !imageNew) return;
      if (!snap.text && !imageNew) return;
      this.send({ t: "clip", ...(snap.text ? { text: snap.text } : {}), ...(imageNew && png ? { png: png.toString("base64") } : {}) });
    } catch {
      // Clipboard can be momentarily busy on Windows while another app holds it open.
    } finally {
      this.busy = false;
    }
  }

  private async sendFiles(paths: string[], epoch: number): Promise<void> {
    if (!this.armed || epoch !== this.outgoingFileEpoch) return;
    if (this.options.canSendFiles && !this.options.canSendFiles()) return;

    const entries: Array<{ path: string; index: number; name: string; size: number }> = [];
    let totalBytes = 0;
    for (const filePath of paths.slice(0, FUSION_MAX_FILE_CLIPBOARD_FILES)) {
      const info = await stat(filePath).catch(() => null);
      if (!info || !info.isFile()) continue;
      if (totalBytes + info.size > this.maxFileBytes) return;
      const name = basename(filePath);
      if (!name || name.length > 255 || /[/\\\0]/.test(name)) continue;
      entries.push({ path: filePath, index: entries.length, name, size: info.size });
      totalBytes += info.size;
    }
    if (entries.length === 0 || !this.armed || epoch !== this.outgoingFileEpoch) return;

    const transferId = randomUUID();
    this.send({
      t: "clip.file.start",
      transferId,
      files: entries.map(({ index, name, size }) => ({ index, name, size })),
      totalBytes,
    });

    const chunkBuf = Buffer.allocUnsafe(this.chunkBytes);
    for (const entry of entries) {
      if (!this.armed || epoch !== this.outgoingFileEpoch) {
        this.send({ t: "clip.file.end", transferId, ok: false, error: "aborted" });
        return;
      }
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(entry.path, "r");
        let seq = 0;
        let offset = 0;
        while (offset < entry.size) {
          if (!this.armed || epoch !== this.outgoingFileEpoch) {
            this.send({ t: "clip.file.end", transferId, ok: false, error: "aborted" });
            return;
          }
          const toRead = Math.min(this.chunkBytes, entry.size - offset);
          const { bytesRead } = await handle.read(chunkBuf, 0, toRead, offset);
          if (bytesRead <= 0) break;
          this.send({
            t: "clip.file.chunk",
            transferId,
            index: entry.index,
            seq: seq++,
            data: chunkBuf.subarray(0, bytesRead).toString("base64"),
          });
          offset += bytesRead;
        }
        if (offset !== entry.size) {
          this.send({ t: "clip.file.end", transferId, ok: false, error: "file size changed during read" });
          return;
        }
      } catch (error) {
        this.send({
          t: "clip.file.end",
          transferId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      } finally {
        await handle?.close().catch(() => {});
      }
    }

    this.send({ t: "clip.file.end", transferId, ok: true });
  }

  async received(m: FusionMessage): Promise<void> {
    if (!this.armed) return;
    const text = typeof m.text === "string" ? m.text : undefined;
    const raw = typeof m.png === "string" ? Buffer.from(m.png, "base64") : undefined;
    const png = raw && raw.length <= MAX_CLIPBOARD_BYTES ? raw : undefined;
    if (!text && !png) return;
    await this.port.write({ ...(text ? { text } : {}), ...(png ? { png } : {}) });
    const after = await this.port.read().catch(() => undefined);
    if (after) this.seenCheap = digest(`${after.types}\0${after.text}`);
    this.suppressedImage = png ? digest(png) : "";
    this.seenFiles = "";
  }

  /** Handles incoming `clip.file.start`, `clip.file.chunk`, and `clip.file.end` messages. */
  async receivedFileMessage(m: FusionMessage): Promise<void> {
    switch (m.t) {
      case "clip.file.start":
        this.handleFileStart(m);
        return;
      case "clip.file.chunk":
        this.handleFileChunk(m);
        return;
      case "clip.file.end":
        await this.handleFileEnd(m);
        return;
      default:
        return;
    }
  }

  private handleFileStart(m: FusionMessage): void {
    if (!this.armed || !this.port.writeFiles) return;
    const transferId = typeof m.transferId === "string" ? m.transferId : "";
    const rawFiles = Array.isArray(m.files)
      ? (m.files as Array<{ index?: unknown; name?: unknown; size?: unknown }>)
      : null;
    const totalBytes = typeof m.totalBytes === "number" ? m.totalBytes : -1;
    if (
      !transferId ||
      transferId.length > 128 ||
      !rawFiles ||
      rawFiles.length === 0 ||
      rawFiles.length > FUSION_MAX_FILE_CLIPBOARD_FILES
    ) {
      return;
    }
    if (!Number.isInteger(totalBytes) || totalBytes < 0 || totalBytes > this.maxFileBytes) {
      this.send({ t: "clip.file.end", transferId, ok: false, error: "totalBytes exceeds limit" });
      return;
    }
    if (
      this.incomingTransfers.has(transferId) ||
      this.incomingTransfers.size >= MAX_CONCURRENT_FILE_TRANSFERS
    ) {
      this.send({ t: "clip.file.end", transferId, ok: false, error: "transfer busy or duplicate" });
      return;
    }

    const root = this.options.stageRoot ?? tmpdir();
    makeSecureDir(root);
    const stageDir = mkdtempSync(join(root, "linkshell-fusion-clip-"));
    if (process.platform !== "win32") {
      try {
        chmodSync(stageDir, 0o700);
      } catch {
        // Best effort.
      }
    }
    this.stagingDirs.add(stageDir);

    const files = new Map<number, IncomingClipFile>();
    const orderedFiles: IncomingClipFile[] = [];
    let declaredSum = 0;

    for (const raw of rawFiles) {
      const index = typeof raw?.index === "number" ? raw.index : -1;
      const name = typeof raw?.name === "string" ? raw.name : "";
      const size = typeof raw?.size === "number" ? raw.size : -1;
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= FUSION_MAX_FILE_CLIPBOARD_FILES ||
        files.has(index)
      ) {
        this.cleanupStageDir(stageDir);
        this.send({ t: "clip.file.end", transferId, ok: false, error: "invalid file index" });
        return;
      }
      if (!Number.isInteger(size) || size < 0 || size > this.maxFileBytes) {
        this.cleanupStageDir(stageDir);
        this.send({ t: "clip.file.end", transferId, ok: false, error: "invalid file size" });
        return;
      }
      declaredSum += size;
      if (declaredSum > this.maxFileBytes) {
        this.cleanupStageDir(stageDir);
        this.send({ t: "clip.file.end", transferId, ok: false, error: "totalBytes exceeds limit" });
        return;
      }
      const safePath = resolveSafeClipFilePath(stageDir, index, name);
      if (!safePath) {
        this.cleanupStageDir(stageDir);
        this.send({ t: "clip.file.end", transferId, ok: false, error: "invalid file name" });
        return;
      }
      makeSecureDir(join(stageDir, String(index)));
      const entry: IncomingClipFile = {
        index,
        name,
        expectedSize: size,
        path: safePath,
        receivedBytes: 0,
        nextSeq: 0,
      };
      files.set(index, entry);
      orderedFiles.push(entry);
    }

    if (declaredSum !== totalBytes) {
      this.cleanupStageDir(stageDir);
      this.send({ t: "clip.file.end", transferId, ok: false, error: "totalBytes mismatch" });
      return;
    }

    const transfer: IncomingFileTransfer = {
      transferId,
      stageDir,
      files,
      orderedFiles,
      totalExpectedBytes: totalBytes,
      totalReceivedBytes: 0,
      failed: false,
      queue: Promise.resolve(),
    };
    transfer.queue = transfer.queue
      .then(async () => {
        for (const entry of orderedFiles) {
          const fh = await open(entry.path, "w", 0o600);
          await fh.close();
        }
      })
      .catch(() => {
        transfer.failed = true;
      });
    this.incomingTransfers.set(transferId, transfer);
  }

  private handleFileChunk(m: FusionMessage): void {
    const transferId = typeof m.transferId === "string" ? m.transferId : "";
    const transfer = this.incomingTransfers.get(transferId);
    if (!transfer || transfer.failed) return;

    const index = typeof m.index === "number" ? m.index : -1;
    const seq = typeof m.seq === "number" ? m.seq : -1;
    const data = typeof m.data === "string" ? m.data : "";
    const entry = transfer.files.get(index);
    if (!entry || seq !== entry.nextSeq) {
      this.failIncomingTransfer(transfer, "invalid chunk sequence");
      return;
    }

    const chunk = Buffer.from(data, "base64");
    if (
      chunk.length > this.chunkBytes ||
      entry.receivedBytes + chunk.length > entry.expectedSize ||
      transfer.totalReceivedBytes + chunk.length > this.maxFileBytes
    ) {
      this.failIncomingTransfer(transfer, "chunk exceeds size limit");
      return;
    }

    entry.nextSeq += 1;
    entry.receivedBytes += chunk.length;
    transfer.totalReceivedBytes += chunk.length;
    transfer.queue = transfer.queue
      .then(async () => {
        if (transfer.failed || !this.armed) return;
        const fh = await open(entry.path, "a", 0o600);
        try {
          await fh.write(chunk, 0, chunk.length);
        } finally {
          await fh.close();
        }
      })
      .catch(() => {
        transfer.failed = true;
      });
  }

  private async handleFileEnd(m: FusionMessage): Promise<void> {
    const transferId = typeof m.transferId === "string" ? m.transferId : "";
    const transfer = this.incomingTransfers.get(transferId);
    if (!transfer) return;
    this.incomingTransfers.delete(transferId);
    await transfer.queue.catch(() => {});

    const allMatched =
      transfer.orderedFiles.every((entry) => entry.receivedBytes === entry.expectedSize) &&
      transfer.totalReceivedBytes === transfer.totalExpectedBytes;

    if (m.ok !== true || transfer.failed || !allMatched || !this.armed || !this.port.writeFiles) {
      this.cleanupStageDir(transfer.stageDir);
      return;
    }

    // Keep only the newest completed batch alive for OS paste.
    const activeDirs = new Set([...this.incomingTransfers.values()].map((t) => t.stageDir));
    for (const dir of [...this.stagingDirs]) {
      if (dir !== transfer.stageDir && !activeDirs.has(dir)) {
        this.cleanupStageDir(dir);
      }
    }

    const paths = transfer.orderedFiles.map((entry) => entry.path);
    this.suppressedFiles = digest(paths.join("\0"));
    this.seenFiles = this.suppressedFiles;
    await this.port.writeFiles(paths);
  }

  private failIncomingTransfer(transfer: IncomingFileTransfer, reason: string): void {
    transfer.failed = true;
    this.incomingTransfers.delete(transfer.transferId);
    void transfer.queue.finally(() => this.cleanupStageDir(transfer.stageDir));
    this.send({ t: "clip.file.end", transferId: transfer.transferId, ok: false, error: reason });
  }

  private cleanupStageDir(dir: string): void {
    this.stagingDirs.delete(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore concurrent cleanup failures.
    }
  }

  /** Cancels in-flight outgoing and incoming transfers while retaining completed staged files if still needed. */
  abortTransfers(): void {
    this.outgoingFileEpoch += 1;
    for (const transfer of [...this.incomingTransfers.values()]) {
      transfer.failed = true;
      this.incomingTransfers.delete(transfer.transferId);
      void transfer.queue.finally(() => this.cleanupStageDir(transfer.stageDir));
    }
  }

  /** Disarms clipboard sync, cancels transfers, and removes all staged temporary directories. */
  dispose(): void {
    this.armed = false;
    this.abortTransfers();
    for (const dir of [...this.stagingDirs]) {
      this.cleanupStageDir(dir);
    }
  }
}
