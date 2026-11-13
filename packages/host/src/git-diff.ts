import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { RpcError } from "@linkshell/wire";
import { gitBranch } from "./worktrees.js";

const execFileAsync = promisify(execFile);

export type GitDiffFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface GitDiffFile {
  path: string;
  oldPath?: string;
  status: GitDiffFileStatus;
  oldText: string;
  newText: string;
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface GitDiffParams {
  cwd: string;
  base?: string;
  includeUntracked?: boolean;
  maxBytes?: number;
}

export interface GitDiffResult {
  files: GitDiffFile[];
  truncated: boolean;
  branch?: string;
}

export interface GitCommitParams {
  cwd: string;
  message: string;
  stageAll?: boolean;
  paths?: string[];
}

export interface GitCommitResult {
  sha: string;
  branch?: string;
  summary: string;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_ALLOWED_BYTES = 8 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const BATCH_BLOB_MAX_BYTES = 2 * 1024 * 1024;
const DIFF_READ_CONCURRENCY = 8;

function expandPath(input: string): string {
  if (!input || input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

async function gitBuffer(cwd: string, args: string[], timeout = 15_000): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "buffer",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function gitText(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  return (await gitBuffer(cwd, args, timeout)).toString("utf8").trim();
}

async function resolveRepoRoot(cwdInput: string): Promise<string> {
  const cwd = expandPath(cwdInput);
  if (!existsSync(cwd)) throw RpcError.app("not_found", `找不到目录：${cwdInput}`);
  let statInfo;
  try {
    statInfo = lstatSync(cwd);
  } catch {
    throw RpcError.app("not_found", `找不到目录：${cwdInput}`);
  }
  const dir = statInfo.isDirectory() ? cwd : dirname(cwd);
  try {
    const top = await gitText(dir, ["rev-parse", "--show-toplevel"], 5000);
    return realpathSync(top);
  } catch {
    throw RpcError.app("not_a_repo", "这个目录不在 git 仓库里");
  }
}

function isInsideRoot(realRoot: string, candidate: string): boolean {
  const rel = relative(realRoot, candidate);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Validates and resolves a path strictly inside `realRoot`, verifying existing
 * parent directories via `realpathSync` so symlinked subdirectories cannot
 * escape the repository root.
 */
export function resolveRepoPath(realRoot: string, rawPath: string): { fullPath: string; repoPath: string } {
  if (!rawPath || rawPath.includes("\0")) {
    throw RpcError.app("invalid_params", "文件路径无效");
  }
  const normalizedInput = rawPath.replace(/\\/g, "/");
  if (normalizedInput.startsWith("/") || /^[a-zA-Z]:/.test(normalizedInput)) {
    // Allow absolute paths only when they resolve strictly inside realRoot.
    const candidate = resolve(rawPath);
    if (!isInsideRoot(realRoot, candidate)) {
      throw RpcError.app("invalid_params", "文件路径超出仓库范围");
    }
    return resolveRepoPath(realRoot, relative(realRoot, candidate));
  }
  const segments = normalizedInput.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((part) => part === "." || part === ".." || part.toLowerCase() === ".git")
  ) {
    throw RpcError.app("invalid_params", "文件路径超出仓库范围");
  }
  const fullPath = resolve(realRoot, ...segments);
  if (!isInsideRoot(realRoot, fullPath)) {
    throw RpcError.app("invalid_params", "文件路径超出仓库范围");
  }
  // Verify the deepest existing ancestor resolves inside realRoot (symlink escape protection).
  let ancestor = dirname(fullPath);
  while (!existsSync(ancestor) && ancestor !== realRoot) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (existsSync(ancestor)) {
    const realAncestor = realpathSync(ancestor);
    if (realAncestor !== realRoot && !realAncestor.startsWith(`${realRoot}${sep}`)) {
      throw RpcError.app("invalid_params", "文件路径超出仓库范围");
    }
  }
  return { fullPath, repoPath: segments.join("/") };
}

function incompleteUtf8Tail(buffer: Buffer): number {
  for (let back = 1; back <= Math.min(3, buffer.length); back++) {
    const byte = buffer[buffer.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const needs = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needs > back ? back : 0;
  }
  return 0;
}

function bufferToSafeUtf8(buffer: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString("utf8"), truncated: false };
  }
  const sliced = buffer.subarray(0, maxBytes);
  const clean = sliced.subarray(0, sliced.length - incompleteUtf8Tail(sliced));
  return { text: clean.toString("utf8"), truncated: true };
}

async function readWorkingFileBounded(
  realRoot: string,
  fullPath: string,
  maxBytes: number,
): Promise<{ exists: boolean; binary: boolean; text: string; bytes: number; truncated: boolean }> {
  const info = await lstat(fullPath).catch(() => undefined);
  if (!info) return { exists: false, binary: false, text: "", bytes: 0, truncated: false };
  if (info.isSymbolicLink()) {
    const target = await readlink(fullPath).catch(() => "");
    // Never dereference a symlink pointing outside the repository.
    const resolvedTarget = resolve(dirname(fullPath), target);
    if (!isInsideRoot(realRoot, resolvedTarget)) {
      const text = `${target}\n`;
      return { exists: true, binary: false, text, bytes: Buffer.byteLength(text), truncated: false };
    }
    const text = `${target}\n`;
    return { exists: true, binary: false, text, bytes: Buffer.byteLength(text), truncated: false };
  }
  if (!info.isFile()) {
    return { exists: true, binary: false, text: "", bytes: 0, truncated: false };
  }
  const toRead = Math.min(info.size, Math.max(maxBytes + 4, BINARY_SNIFF_BYTES));
  const handle = await open(fullPath, "r");
  try {
    const buffer = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
    const view = buffer.subarray(0, bytesRead);
    if (view.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { exists: true, binary: true, text: "", bytes: 0, truncated: false };
    }
    const decoded = bufferToSafeUtf8(view, maxBytes);
    const truncated = decoded.truncated || info.size > maxBytes;
    return {
      exists: true,
      binary: false,
      text: decoded.text,
      bytes: Buffer.byteLength(decoded.text),
      truncated,
    };
  } finally {
    await handle.close();
  }
}

async function readGitBlobBounded(
  realRoot: string,
  ref: string,
  repoPath: string,
  maxBytes: number,
): Promise<{ exists: boolean; binary: boolean; text: string; bytes: number; truncated: boolean }> {
  const spec = `${ref}:${repoPath}`;
  let blobSize: number;
  try {
    const sizeOut = await gitText(realRoot, ["cat-file", "-s", spec], 5000);
    blobSize = Number(sizeOut);
    if (!Number.isFinite(blobSize) || blobSize < 0) {
      return { exists: false, binary: false, text: "", bytes: 0, truncated: false };
    }
  } catch {
    return { exists: false, binary: false, text: "", bytes: 0, truncated: false };
  }
  if (blobSize === 0) {
    return { exists: true, binary: false, text: "", bytes: 0, truncated: false };
  }
  const cap = Math.min(blobSize, Math.max(maxBytes + 4, BINARY_SNIFF_BYTES));
  const buffer = await new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-C", realRoot, "cat-file", "blob", spec], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        rejectPromise(new Error("git cat-file timed out"));
      }
    }, 10_000);
    timer.unref();
    const finish = (result: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = cap - total;
      if (remaining > 0) {
        const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(piece);
        total += piece.length;
      }
      if (total >= cap) {
        child.kill("SIGTERM");
        finish(Buffer.concat(chunks, total));
      }
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      }
    });
    child.once("close", () => finish(Buffer.concat(chunks, total)));
  });

  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { exists: true, binary: true, text: "", bytes: 0, truncated: false };
  }
  const decoded = bufferToSafeUtf8(buffer, maxBytes);
  return {
    exists: true,
    binary: false,
    text: decoded.text,
    bytes: Buffer.byteLength(decoded.text),
    truncated: decoded.truncated || blobSize > maxBytes,
  };
}

type DiffSide = { exists: boolean; binary: boolean; text: string; bytes: number; truncated: boolean };

const EMPTY_SIDE: DiffSide = { exists: false, binary: false, text: "", bytes: 0, truncated: false };

function trimSideToBudget(side: DiffSide, maxBytes: number): DiffSide {
  if (!side.exists || side.binary || side.bytes <= maxBytes) return side;
  const raw = Buffer.from(side.text, "utf8");
  const decoded = bufferToSafeUtf8(raw, maxBytes);
  return {
    exists: true,
    binary: false,
    text: decoded.text,
    bytes: Buffer.byteLength(decoded.text),
    truncated: true,
  };
}

interface BlobCheckEntry {
  exists: boolean;
  oid?: string;
  size: number;
}

async function batchCheckBlobs(realRoot: string, specs: string[]): Promise<Map<string, BlobCheckEntry>> {
  const result = new Map<string, BlobCheckEntry>();
  if (specs.length === 0) return result;
  const output = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-C", realRoot, "cat-file", "--batch-check"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        rejectPromise(new Error("git cat-file --batch-check timed out"));
      }
    }, 10_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) rejectPromise(new Error(`git cat-file --batch-check exited with ${code}`));
      else resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`${specs.join("\n")}\n`);
  });

  const lines = output.split("\n");
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const line = lines[i] ?? "";
    const match = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(line);
    if (!match || match[2] !== "blob") {
      result.set(spec, { exists: false, size: 0 });
      continue;
    }
    const size = Number(match[3]);
    if (!Number.isFinite(size) || size < 0) {
      result.set(spec, { exists: false, size: 0 });
      continue;
    }
    result.set(spec, { exists: true, oid: match[1]!, size });
  }
  return result;
}

/**
 * Persistent `git cat-file --batch` reader scoped to a single `gitDiff` call so
 * tracked old-side blobs stream over one pipe instead of spawning two git
 * processes per changed file.
 */
class GitCatFileBatch {
  private child?: ReturnType<typeof spawn>;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private closed = false;
  private failed?: Error;
  private waiter?: () => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly realRoot: string) {}

  private ensureStarted(): void {
    if (this.child || this.closed) return;
    const child = spawn("git", ["-C", this.realRoot, "cat-file", "--batch"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      const wake = this.waiter;
      this.waiter = undefined;
      wake?.();
    });
    const fail = (error: Error) => {
      this.failed ??= error;
      this.closed = true;
      const wake = this.waiter;
      this.waiter = undefined;
      wake?.();
    };
    child.once("error", fail);
    child.once("close", () => fail(new Error("git cat-file --batch closed")));
    child.stdin?.on("error", () => {});
  }

  private waitForData(timeoutMs = 10_000): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        this.close();
        rejectPromise(new Error("git cat-file --batch timed out"));
      }, timeoutMs);
      timer.unref();
      this.waiter = () => {
        clearTimeout(timer);
        if (this.failed && this.buffered === 0) rejectPromise(this.failed);
        else resolvePromise();
      };
    });
  }

  private consume(length: number, retainLength: number): Buffer {
    const out = Buffer.allocUnsafe(Math.min(length, retainLength));
    let written = 0;
    let remaining = length;
    while (remaining > 0 && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const take = Math.min(remaining, head.length);
      if (written < out.length) {
        const copyLen = Math.min(take, out.length - written);
        head.copy(out, written, 0, copyLen);
        written += copyLen;
      }
      if (take === head.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(take);
      }
      this.buffered -= take;
      remaining -= take;
    }
    return written === out.length ? out : out.subarray(0, written);
  }

  private async readLine(): Promise<string> {
    for (;;) {
      let scanned = 0;
      for (const chunk of this.chunks) {
        const nl = chunk.indexOf(0x0a);
        if (nl >= 0) {
          const total = scanned + nl;
          const lineBuf = this.consume(total + 1, total);
          return lineBuf.toString("utf8");
        }
        scanned += chunk.length;
      }
      await this.waitForData();
    }
  }

  private async readExact(length: number, retainLength: number): Promise<Buffer> {
    while (this.buffered < length) {
      await this.waitForData();
    }
    return this.consume(length, retainLength);
  }

  readBlob(oid: string, maxBytes: number): Promise<DiffSide> {
    const run = async (): Promise<DiffSide> => {
      this.ensureStarted();
      if (!this.child?.stdin || this.failed) throw this.failed ?? new Error("git cat-file --batch unavailable");
      this.child.stdin.write(`${oid}\n`);
      const header = await this.readLine();
      const match = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(header);
      if (!match || match[2] !== "blob") {
        return EMPTY_SIDE;
      }
      const blobSize = Number(match[3]);
      if (blobSize === 0) {
        await this.readExact(1, 0);
        return { exists: true, binary: false, text: "", bytes: 0, truncated: false };
      }
      const cap = Math.min(blobSize, Math.max(maxBytes + 4, BINARY_SNIFF_BYTES));
      const buffer = await this.readExact(blobSize + 1, cap);
      if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        return { exists: true, binary: true, text: "", bytes: 0, truncated: false };
      }
      const decoded = bufferToSafeUtf8(buffer, maxBytes);
      return {
        exists: true,
        binary: false,
        text: decoded.text,
        bytes: Buffer.byteLength(decoded.text),
        truncated: decoded.truncated || blobSize > maxBytes,
      };
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  close(): void {
    if (this.closed && !this.child) return;
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      // Ignore broken pipe on teardown.
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  }
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function countLineChanges(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const m = oldEnd - start;
  const n = newEnd - start;
  if (m === 0) return { additions: n, deletions: 0 };
  if (n === 0) return { additions: 0, deletions: m };

  // Rolling two-row LCS when product fits comfortably in memory and CPU.
  if (m * n <= 2_500_000) {
    let prev = new Int32Array(n + 1);
    let curr = new Int32Array(n + 1);
    for (let i = 0; i < m; i++) {
      const a = oldLines[start + i]!;
      for (let j = 0; j < n; j++) {
        curr[j + 1] = a === newLines[start + j] ? prev[j]! + 1 : Math.max(prev[j + 1]!, curr[j]!);
      }
      const swap = prev;
      prev = curr;
      curr = swap;
      curr.fill(0);
    }
    const lcs = prev[n]!;
    return { additions: n - lcs, deletions: m - lcs };
  }

  // Bounded multiset fallback for very large files.
  const counts = new Map<string, number>();
  for (let i = start; i < oldEnd; i++) {
    const line = oldLines[i]!;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let shared = 0;
  for (let j = start; j < newEnd; j++) {
    const line = newLines[j]!;
    const left = counts.get(line) ?? 0;
    if (left > 0) {
      counts.set(line, left - 1);
      shared++;
    }
  }
  return { additions: n - shared, deletions: m - shared };
}

interface RawChange {
  path: string;
  oldPath?: string;
  status: GitDiffFileStatus;
}

export function parsePorcelainZ(buffer: Buffer, includeUntracked: boolean, hasHead: boolean): RawChange[] {
  const tokens = buffer.toString("utf8").split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const changes: RawChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!;
    if (entry.length < 4 || entry[2] !== " ") continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry.slice(3);
    if (x === "!" && y === "!") continue;
    if (x === "?" && y === "?") {
      if (includeUntracked) changes.push({ path, status: "untracked" });
      continue;
    }
    // In `git status --porcelain=v1 -z`, R/C entries emit `XY new_path\0old_path\0`.
    let oldPath: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      oldPath = tokens[++i];
    }
    if (!hasHead) {
      if (y !== "D") changes.push({ path, status: "added" });
      continue;
    }
    if (x === "A" && y === "D") continue;
    if (x === "R" || y === "R") {
      if (y === "D" && oldPath) {
        changes.push({ path: oldPath, status: "deleted" });
      } else {
        changes.push({ path, oldPath, status: "renamed" });
      }
    } else if (x === "A" || x === "C") {
      changes.push({ path, status: "added" });
    } else if (x === "D" || y === "D") {
      changes.push({ path, status: "deleted" });
    } else {
      changes.push({ path, status: "modified" });
    }
  }
  return changes;
}

export function parseNameStatusZ(buffer: Buffer): RawChange[] {
  const tokens = buffer.toString("utf8").split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const changes: RawChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]!;
    if (!code) continue;
    const kind = code[0]!;
    if (kind === "R" || kind === "C") {
      // In `git diff --name-status -z`, R/C entries emit `R100\0old_path\0new_path\0`.
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      if (!oldPath || !newPath) continue;
      if (kind === "R") changes.push({ path: newPath, oldPath, status: "renamed" });
      else changes.push({ path: newPath, status: "added" });
    } else {
      const path = tokens[++i];
      if (!path) continue;
      if (kind === "A") changes.push({ path, status: "added" });
      else if (kind === "D") changes.push({ path, status: "deleted" });
      else changes.push({ path, status: "modified" });
    }
  }
  return changes;
}

async function verifyCommitRef(realRoot: string, ref: string): Promise<boolean> {
  if (!ref || ref.startsWith("-") || /[\0\r\n]/.test(ref)) return false;
  try {
    await gitText(realRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 5000);
    return true;
  } catch {
    return false;
  }
}

export async function gitDiff(params: GitDiffParams): Promise<GitDiffResult> {
  const realRoot = await resolveRepoRoot(params.cwd);
  const includeUntracked = params.includeUntracked !== false;
  const maxBytes = Math.min(Math.max(1024, params.maxBytes ?? DEFAULT_MAX_BYTES), MAX_ALLOWED_BYTES);
  const baseRef = params.base?.trim() ? params.base.trim() : undefined;

  if (baseRef) {
    if (!(await verifyCommitRef(realRoot, baseRef))) {
      throw RpcError.app("invalid_params", `无效的 git 基线：${baseRef}`);
    }
  }

  const [hasHead, branch] = await Promise.all([verifyCommitRef(realRoot, "HEAD"), gitBranch(realRoot)]);

  let rawChanges: RawChange[];
  let compareRef: string | undefined;

  if (baseRef) {
    compareRef = baseRef;
    const diffBuf = await gitBuffer(realRoot, ["diff", "--name-status", "-z", baseRef, "--"]);
    rawChanges = parseNameStatusZ(diffBuf);
    if (includeUntracked) {
      const seen = new Set(rawChanges.map((item) => item.path));
      const untrackedBuf = await gitBuffer(realRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
      const untrackedPaths = untrackedBuf.toString("utf8").split("\0").filter(Boolean);
      for (const rel of untrackedPaths) {
        if (!seen.has(rel)) {
          seen.add(rel);
          rawChanges.push({ path: rel, status: "untracked" });
        }
      }
    }
  } else {
    compareRef = hasHead ? "HEAD" : undefined;
    const statusBuf = await gitBuffer(realRoot, ["status", "--porcelain=v1", "-z", "-uall"]);
    rawChanges = parsePorcelainZ(statusBuf, includeUntracked, hasHead);
  }

  const files: GitDiffFile[] = [];
  let usedBytes = 0;
  let truncated = false;

  interface PreparedChange {
    change: RawChange;
    resolvedNew: { fullPath: string; repoPath: string };
    resolvedOldPath?: string;
    needOld: boolean;
    needNew: boolean;
    oldSpec?: string;
  }

  const prepared: PreparedChange[] = [];
  const checkSpecs = new Set<string>();
  for (const change of rawChanges) {
    let resolvedNew: { fullPath: string; repoPath: string };
    let resolvedOldPath: string | undefined;
    try {
      resolvedNew = resolveRepoPath(realRoot, change.path);
      if (change.oldPath) {
        resolvedOldPath = resolveRepoPath(realRoot, change.oldPath).repoPath;
      }
    } catch {
      // Skip malformed paths rather than aborting the entire diff view.
      continue;
    }
    const needOld = compareRef !== undefined && (change.status === "modified" || change.status === "deleted" || change.status === "renamed");
    const needNew = change.status !== "deleted";
    const oldRepoPath = resolvedOldPath ?? resolvedNew.repoPath;
    const oldSpec = needOld ? `${compareRef!}:${oldRepoPath}` : undefined;
    if (oldSpec && !/[\r\n\0]/.test(oldSpec)) {
      checkSpecs.add(oldSpec);
    }
    prepared.push({ change, resolvedNew, resolvedOldPath, needOld, needNew, oldSpec });
  }

  const checkedBlobs = await batchCheckBlobs(realRoot, [...checkSpecs]).catch(() => new Map<string, BlobCheckEntry>());
  const batch = new GitCatFileBatch(realRoot);

  const loadOldSide = async (item: PreparedChange, budget: number): Promise<DiffSide> => {
    if (!item.needOld || !item.oldSpec) return EMPTY_SIDE;
    const oldRepoPath = item.resolvedOldPath ?? item.resolvedNew.repoPath;
    const checked = checkedBlobs.get(item.oldSpec);
    if (checked) {
      if (!checked.exists) return EMPTY_SIDE;
      if (checked.size === 0) return { exists: true, binary: false, text: "", bytes: 0, truncated: false };
      if (checked.oid && checked.size <= BATCH_BLOB_MAX_BYTES) {
        return batch.readBlob(checked.oid, budget).catch(() =>
          readGitBlobBounded(realRoot, compareRef!, oldRepoPath, budget),
        );
      }
    }
    return readGitBlobBounded(realRoot, compareRef!, oldRepoPath, budget);
  };

  try {
    for (let offset = 0; offset < prepared.length; offset += DIFF_READ_CONCURRENCY) {
      const windowRemaining = maxBytes - usedBytes;
      if (windowRemaining <= 0) {
        truncated = true;
        break;
      }
      const windowBudget = Math.max(512, Math.min(MAX_SINGLE_FILE_BYTES, windowRemaining));
      const slice = prepared.slice(offset, offset + DIFF_READ_CONCURRENCY);
      const loaded = await Promise.all(
        slice.map(async (item) => {
          const [oldSide, newSide] = await Promise.all([
            loadOldSide(item, windowBudget),
            item.needNew ? readWorkingFileBounded(realRoot, item.resolvedNew.fullPath, windowBudget) : Promise.resolve(EMPTY_SIDE),
          ]);
          return { item, oldSide, newSide };
        }),
      );

      for (const entry of loaded) {
        const remaining = maxBytes - usedBytes;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const perSideBudget = Math.max(512, Math.min(MAX_SINGLE_FILE_BYTES, remaining));
        const oldSide = trimSideToBudget(entry.oldSide, perSideBudget);
        const newSide = trimSideToBudget(entry.newSide, perSideBudget);
        const { change, resolvedNew, resolvedOldPath } = entry.item;

        if (oldSide.truncated || newSide.truncated) truncated = true;

        // A file marked modified in index but restored on disk back to exact HEAD content: skip no-op.
        if (
          change.status === "modified" &&
          !oldSide.binary &&
          !newSide.binary &&
          oldSide.exists &&
          newSide.exists &&
          oldSide.text === newSide.text &&
          !oldSide.truncated &&
          !newSide.truncated
        ) {
          continue;
        }

        if (oldSide.binary || newSide.binary) {
          files.push({
            path: resolvedNew.repoPath,
            ...(resolvedOldPath ? { oldPath: resolvedOldPath } : {}),
            status: change.status,
            oldText: "",
            newText: "",
            additions: 0,
            deletions: 0,
            binary: true,
          });
          usedBytes += 64;
          continue;
        }

        // Refine status if file was deleted from disk after staging or vice versa.
        let status = change.status;
        if (status === "modified" && oldSide.exists && !newSide.exists) status = "deleted";
        else if (status === "deleted" && newSide.exists && oldSide.exists) status = "modified";

        const { additions, deletions } = countLineChanges(oldSide.text, newSide.text);
        files.push({
          path: resolvedNew.repoPath,
          ...(resolvedOldPath ? { oldPath: resolvedOldPath } : {}),
          status,
          oldText: oldSide.text,
          newText: newSide.text,
          additions,
          deletions,
        });
        usedBytes += oldSide.bytes + newSide.bytes + 64;
      }

      if (maxBytes - usedBytes <= 0 && offset + DIFF_READ_CONCURRENCY < prepared.length) {
        truncated = true;
        break;
      }
    }
  } finally {
    batch.close();
  }

  return {
    files,
    truncated,
    ...(branch ? { branch } : {}),
  };
}

export async function gitRevertFile(params: { cwd: string; path: string }): Promise<{ ok: boolean }> {
  const realRoot = await resolveRepoRoot(params.cwd);
  const { fullPath, repoPath } = resolveRepoPath(realRoot, params.path);
  const hasHead = await verifyCommitRef(realRoot, "HEAD");

  let inHead = false;
  if (hasHead) {
    try {
      await gitBuffer(realRoot, ["cat-file", "-e", `HEAD:${repoPath}`], 5000);
      inHead = true;
    } catch {
      inHead = false;
    }
  }

  let inIndex: boolean;
  try {
    await gitBuffer(realRoot, ["ls-files", "--error-unmatch", "--", repoPath], 5000);
    inIndex = true;
  } catch {
    inIndex = false;
  }

  if (inHead) {
    await gitBuffer(realRoot, ["checkout", "HEAD", "--", repoPath], 10_000);
    return { ok: true };
  }

  if (inIndex) {
    // Staged new file not in HEAD: unstage and remove from working tree.
    await gitBuffer(realRoot, ["rm", "-f", "--", repoPath], 10_000);
    return { ok: true };
  }

  // Untracked file: verify it exists as a file or symlink inside realRoot and remove it.
  let info;
  try {
    info = lstatSync(fullPath);
  } catch {
    throw RpcError.app("not_found", `找不到文件：${repoPath}`);
  }
  if (info.isDirectory()) {
    throw RpcError.app("invalid_params", "只能还原单个文件，不能删除目录");
  }
  unlinkSync(fullPath);
  return { ok: true };
}

function formatGitError(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (Buffer.isBuffer(stderr) && stderr.length > 0) {
      return stderr.toString("utf8").trim().split("\n").slice(-2).join(" ").trim();
    }
    if (typeof stderr === "string" && stderr.trim()) {
      return stderr.trim().split("\n").slice(-2).join(" ").trim();
    }
  }
  return error instanceof Error ? error.message.split("\n").slice(-2).join(" ").trim() : String(error);
}

export async function gitCommit(params: GitCommitParams): Promise<GitCommitResult> {
  const message = params.message.trim();
  if (!message) {
    throw RpcError.app("invalid_params", "提交说明不能为空");
  }
  const realRoot = await resolveRepoRoot(params.cwd);
  const repoPaths =
    params.paths !== undefined
      ? [...new Set(params.paths.map((rawPath) => resolveRepoPath(realRoot, rawPath).repoPath))]
      : undefined;

  if (repoPaths !== undefined && repoPaths.length === 0 && !params.stageAll) {
    throw RpcError.app("invalid_params", "未指定要提交的文件");
  }

  try {
    if (params.stageAll) {
      await gitBuffer(realRoot, ["add", "-A"], 30_000);
    } else if (repoPaths && repoPaths.length > 0) {
      await gitBuffer(realRoot, ["add", "-A", "--", ...repoPaths], 30_000);
    }
  } catch (error) {
    throw RpcError.app("git_failed", `暂存文件失败：${formatGitError(error)}`);
  }

  const scopedPaths = !params.stageAll && repoPaths && repoPaths.length > 0 ? repoPaths : undefined;
  const stagedOut = await gitText(
    realRoot,
    scopedPaths ? ["diff", "--cached", "--name-only", "--", ...scopedPaths] : ["diff", "--cached", "--name-only"],
    10_000,
  ).catch(() => "");
  if (!stagedOut) {
    throw RpcError.app("invalid_params", scopedPaths ? "所选文件没有可提交的改动" : "暂存区没有可提交的改动");
  }

  try {
    await gitBuffer(
      realRoot,
      scopedPaths ? ["commit", "-m", message, "--", ...scopedPaths] : ["commit", "-m", message],
      30_000,
    );
  } catch (error) {
    throw RpcError.app("git_failed", `提交失败：${formatGitError(error)}`);
  }

  const [sha, summary, branch] = await Promise.all([
    gitText(realRoot, ["rev-parse", "HEAD"], 5000),
    gitText(realRoot, ["log", "-1", "--pretty=%s", "HEAD"], 5000),
    gitBranch(realRoot),
  ]);
  return {
    sha,
    ...(branch ? { branch } : {}),
    summary,
  };
}
