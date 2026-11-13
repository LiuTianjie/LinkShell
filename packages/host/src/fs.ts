import { execFile } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { RpcError, type DirectoryEntry } from "@linkshell/wire";

const execFileAsync = promisify(execFile);

// Browsing and searching the host's directories, to pick where a session runs.

const PROJECT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "Package.swift", "pom.xml", "build.gradle", "Gemfile", "composer.json", "deno.json", "CMakeLists.txt"];

/** Directories never worth descending into when searching. */
const SKIP = new Set([
  "node_modules", ".git", "Library", "Pods", "DerivedData", "build", "dist", ".next", ".expo", "target", "vendor",
  ".Trash", "Applications", "Movies", "Music", "Pictures", ".cache", ".npm", ".pnpm-store", "venv", ".venv", "__pycache__",
]);

function isProject(names: Set<string>): boolean {
  return PROJECT_MARKERS.some((marker) => names.has(marker));
}

function expand(path: string | undefined): string {
  if (!path || path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

const SUBDIR_CONCURRENCY = 16;

async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

async function subdirectories(path: string, hidden: boolean): Promise<{ entries: DirectoryEntry[]; names: Set<string> }> {
  const dirents = await readdir(path, { withFileTypes: true });
  const names = new Set(dirents.map((d) => d.name));
  const dirs = dirents.filter((d) => (d.isDirectory() || d.isSymbolicLink()) && (hidden || !d.name.startsWith(".")));
  const entries = await mapLimit(dirs, SUBDIR_CONCURRENCY, async (d): Promise<DirectoryEntry | undefined> => {
    const full = join(path, d.name);
    try {
      if (d.isSymbolicLink() && !(await stat(full)).isDirectory()) return undefined;
      const children = new Set(await readdir(full).catch(() => [] as string[]));
      return { name: d.name, path: full, project: isProject(children) || undefined };
    } catch {
      return undefined;
    }
  });
  return {
    entries: entries
      .filter((e): e is DirectoryEntry => Boolean(e))
      .sort((a, b) => Number(Boolean(b.project)) - Number(Boolean(a.project)) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    names,
  };
}

/** A listing carries at most this many entries. */
const MAX_ENTRIES = 1000;

/** The directory's files, by name. */
async function filesIn(path: string, hidden: boolean, limit: number): Promise<{ entries: DirectoryEntry[]; truncated: boolean }> {
  const dirents = (await readdir(path, { withFileTypes: true }))
    .filter((d) => !d.isDirectory() && (hidden || !d.name.startsWith(".")))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const entries: DirectoryEntry[] = [];
  let truncated = false;
  for (const d of dirents) {
    const full = join(path, d.name);
    // A link is listed as what it points to; one to a directory is already among the subdirectories.
    const info = await stat(full).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
    entries.push({ name: d.name, path: full, file: true, size: info.size });
  }
  return { entries, truncated };
}

export async function listDirectory(input: { path?: string; hidden: boolean; files?: boolean }) {
  const path = expand(input.path);
  if (!existsSync(path) || !(await stat(path)).isDirectory()) throw RpcError.app("not_found", `找不到文件夹：${path}`);
  const { entries } = await subdirectories(path, input.hidden).catch(() => {
    throw RpcError.app("not_found", `无法读取 ${path}`);
  });
  const parent = dirname(path);
  const base = { path, parent: parent === path ? undefined : parent, home: homedir() };
  if (!input.files) {
    return {
      ...base,
      entries: entries.slice(0, MAX_ENTRIES),
      truncated: entries.length > MAX_ENTRIES || undefined,
    };
  }
  // Browsing a project: directories by name (not projects first), then files.
  const dirs = entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).slice(0, MAX_ENTRIES);
  const files = await filesIn(path, input.hidden, MAX_ENTRIES - dirs.length);
  return { ...base, entries: [...dirs, ...files.entries], truncated: files.truncated || entries.length > MAX_ENTRIES || undefined };
}

/**
 * Breadth-first under the home directory, a few levels deep, within a time
 * budget: good enough to find "claude-remote" or "rtranslate" by typing.
 */
export async function searchDirectories(input: { query: string; limit: number }, budgetMs = 1500) {
  const query = input.query.toLowerCase().trim();
  const deadline = Date.now() + budgetMs;
  const found: DirectoryEntry[] = [];
  let queue: { path: string; depth: number }[] = [{ path: homedir(), depth: 0 }];
  let truncated = false;
  while (queue.length > 0) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    const next: typeof queue = [];
    for (const { path, depth } of queue) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      let dirents;
      try {
        dirents = await readdir(path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        if (!d.isDirectory() || d.name.startsWith(".") || SKIP.has(d.name)) continue;
        const full = join(path, d.name);
        if (d.name.toLowerCase().includes(query)) {
          const children = new Set(await readdir(full).catch(() => [] as string[]));
          found.push({ name: d.name, path: full, project: isProject(children) || undefined });
        }
        if (depth < 4) next.push({ path: full, depth: depth + 1 });
      }
    }
    queue = next;
  }
  // Code projects first (that's what a session runs in), then how well the name matches.
  const score = (e: DirectoryEntry) => (e.project ? 0 : 10) + (e.name.toLowerCase() === query ? 0 : e.name.toLowerCase().startsWith(query) ? 1 : 2);
  found.sort((a, b) => score(a) - score(b) || a.path.split("/").length - b.path.split("/").length);
  if (found.length > input.limit) truncated = true;
  return { entries: found.slice(0, input.limit), truncated };
}


const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
};

/** Preview limits keep the viewer bounded; original downloads use a separate chunked reader. */
const MAX_TEXT_FILE = 20 * 1024 * 1024;
const MAX_IMAGE_FILE = 10 * 1024 * 1024;

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** How many bytes at the end of `buffer` belong to a UTF-8 character that continues past it. */
function incompleteTail(buffer: Buffer): number {
  for (let back = 1; back <= Math.min(3, buffer.length); back++) {
    const byte = buffer[buffer.length - back]!;
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte: keep looking for its lead
    const needs = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needs > back ? back : 0;
  }
  return 0;
}

/**
 * Reads a file for the phone's viewer. Text is detected by content, not
 * extension, and comes in parts (`offset`, `maxBytes`); a picture comes whole.
 */
export async function readFile(input: { path: string; offset?: number; maxBytes: number }) {
  const path = expand(input.path);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw RpcError.app("not_found", `找不到文件：${path}`);
  }
  if (!info.isFile()) throw RpcError.app("invalid_params", `这不是文件：${path}`);
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const image = IMAGE_TYPES[extension];
  const base = { path, size: info.size, modifiedAt: info.mtimeMs };
  if (info.size > (image ? MAX_IMAGE_FILE : MAX_TEXT_FILE)) {
    throw RpcError.app("too_large", `${image ? "图片" : "文件"}太大（${megabytes(info.size)}），暂不支持预览`);
  }
  const offset = image ? 0 : Math.min(input.offset ?? 0, info.size);
  const length = image ? info.size : Math.min(info.size - offset, input.maxBytes);
  const handle = await open(path, "r");
  let buffer = Buffer.alloc(length);
  try {
    // Text or not: no NUL bytes in the file's first 8 KB, wherever this part starts.
    const head = offset === 0 ? undefined : Buffer.alloc(Math.min(8192, info.size));
    if (head) await handle.read(head, 0, head.length, 0);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    buffer = buffer.subarray(0, bytesRead);
    if (image) return { ...base, kind: "image" as const, data: buffer.toString("base64"), mimeType: image, truncated: false };
    if ((head ?? buffer.subarray(0, 8192)).includes(0)) return { ...base, kind: "binary" as const, truncated: false };
  } finally {
    await handle.close();
  }
  // Don't end on half a multi-byte character: the next part starts with it.
  const more = offset + buffer.length < info.size;
  if (more) buffer = buffer.subarray(0, buffer.length - incompleteTail(buffer));
  return { ...base, kind: "text" as const, text: buffer.toString("utf8"), truncated: more, nextOffset: more ? offset + buffer.length : undefined };
}

/** Open and stat the same descriptor so replacement or edits cannot mix download chunks. */
export async function downloadFile(input: { path: string; offset: number; maxBytes: number; revision?: string }) {
  const handle = await open(expand(input.path), "r").catch(() => {
    throw RpcError.app("not_found", "无法读取这个文件，请确认文件仍然存在且有读取权限。");
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw RpcError.app("invalid_params", "只能下载文件。");
    const revisionOf = (s: typeof info) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    const revision = revisionOf(info);
    if (input.revision !== undefined && input.revision !== revision) throw RpcError.app("invalid_params", "文件已变化，请重新下载。");
    if (input.offset > info.size) throw RpcError.app("invalid_params", "下载位置已失效，请重新下载。");
    const buffer = Buffer.alloc(Math.min(input.maxBytes, 1_048_576, info.size - input.offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
    if (revisionOf(await handle.stat()) !== revision || (bytesRead === 0 && input.offset < info.size)) {
      throw RpcError.app("invalid_params", "文件已变化，请重新下载。");
    }
    const nextOffset = input.offset + bytesRead;
    return { size: info.size, revision, data: buffer.subarray(0, bytesRead).toString("base64"), nextOffset, done: nextOffset === info.size };
  } finally {
    await handle.close();
  }
}

/** A single path component: no separators, no `.`/`..`, nothing a shell or filesystem would choke on. */
function safeName(name: string): string {
  const cleaned = name.replace(/[/\\\0]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw RpcError.app("invalid_params", "名称无效");
  return cleaned;
}

async function existingDirectory(path: string): Promise<string> {
  const dir = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) throw RpcError.app("not_found", `找不到文件夹：${path}`);
  return dir;
}

const MAX_UPLOAD_FILE_BYTES = 512 * 1024 * 1024;

/** Writes an uploaded file into `dir`, never over an existing one; appends subsequent chunks at `offset`. */
export async function uploadFile(input: {
  dir: string;
  name: string;
  data: string;
  offset?: number;
  appendPath?: string;
}) {
  const dir = await existingDirectory(input.dir);
  const bytes = Buffer.from(input.data, "base64");

  if (input.appendPath !== undefined) {
    const realDir = await realpath(dir);
    const candidate = expand(input.appendPath);
    const base = basename(candidate);
    if (base !== safeName(base) || (dirname(candidate) !== dir && dirname(candidate) !== realDir)) {
      throw RpcError.app("invalid_params", "上传路径超出目标文件夹范围");
    }
    const linkInfo = await lstat(candidate).catch(() => undefined);
    if (!linkInfo) throw RpcError.app("not_found", "上传目标文件不存在，请重新上传");
    if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
      throw RpcError.app("invalid_params", "上传目标文件无效");
    }
    const realParent = await realpath(dirname(candidate)).catch(() => undefined);
    if (realParent !== realDir) {
      throw RpcError.app("invalid_params", "上传路径超出目标文件夹范围");
    }
    const flags = process.platform === "win32" ? fsConstants.O_RDWR : fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;
    const handle = await open(candidate, flags).catch(() => {
      throw RpcError.app("not_found", "无法写入上传目标文件，请重新上传");
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw RpcError.app("invalid_params", "上传目标文件无效");
      const offset = input.offset ?? info.size;
      if (offset !== info.size) {
        throw RpcError.app("invalid_params", `上传分片偏移量不匹配（期望 ${info.size}，收到 ${offset}）`);
      }
      if (offset + bytes.length > MAX_UPLOAD_FILE_BYTES) {
        throw RpcError.app("too_large", `上传文件超过上限（${megabytes(MAX_UPLOAD_FILE_BYTES)}）`);
      }
      let written = 0;
      while (written < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, offset + written);
        if (bytesWritten <= 0) throw RpcError.app("internal", "写入上传分片失败");
        written += bytesWritten;
      }
      return { path: candidate, size: offset + written };
    } finally {
      await handle.close();
    }
  }

  if (input.offset !== undefined && input.offset !== 0) {
    throw RpcError.app("invalid_params", "首块上传偏移量必须为 0");
  }
  if (bytes.length > MAX_UPLOAD_FILE_BYTES) {
    throw RpcError.app("too_large", `上传文件超过上限（${megabytes(MAX_UPLOAD_FILE_BYTES)}）`);
  }
  const name = safeName(input.name);
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let attempt = 1; attempt < 1000; attempt++) {
    const path = join(dir, attempt === 1 ? name : `${stem} ${attempt}${ext}`);
    try {
      // "wx": fails if the file exists, so a race can't overwrite either.
      await writeFile(path, bytes, { flag: "wx" });
      return { path, size: bytes.length };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw RpcError.app("busy", "同名文件太多了，请换个名字");
}

export async function makeDirectory(input: { parent: string; name: string }) {
  const parent = await existingDirectory(input.parent);
  const path = join(parent, safeName(input.name));
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw RpcError.app("invalid_params", "已经有同名的文件或文件夹");
    throw error;
  }
  return { path };
}

export interface ProjectFileEntry {
  path: string;
  relativePath: string;
  isDir?: boolean;
}

const MAX_PROJECT_WALK_ENTRIES = 10_000;
const BOUNDARY_CHARS = new Set(["/", "-", "_", ".", " "]);

/**
 * Fuzzy score for `@file` autocomplete. Returns `null` when `query` is not a
 * subsequence of `relativePath`. Higher scores rank first.
 */
export function scoreProjectPath(relativePath: string, query: string, isDir?: boolean): number | null {
  const q = query.trim().replace(/^@+/, "").replace(/\\/g, "/").toLowerCase();
  if (!q) return 0;
  const rel = relativePath.toLowerCase();
  const slashIndex = rel.lastIndexOf("/");
  const base = slashIndex >= 0 ? rel.slice(slashIndex + 1) : rel;
  const dirPenalty = isDir ? 8 : 0;

  if (rel === q) return 2000 - dirPenalty;
  if (base === q) return 1800 - rel.length * 0.2 - dirPenalty;
  if (base.startsWith(q)) return 1500 - base.length - rel.length * 0.2 - dirPenalty;
  if (rel.startsWith(q)) return 1400 - rel.length * 0.4 - dirPenalty;
  if (rel.endsWith(`/${q}`)) return 1350 - rel.length * 0.2 - dirPenalty;

  const baseIdx = base.indexOf(q);
  if (baseIdx >= 0) return 1200 - baseIdx * 4 - base.length - rel.length * 0.2 - dirPenalty;

  const relIdx = rel.indexOf(q);
  if (relIdx >= 0) return 1000 - relIdx * 2 - rel.length * 0.3 - dirPenalty;

  // Subsequence fuzzy match preferring basename and word/segment boundaries.
  let qi = 0;
  let score = 200 - rel.length * 0.5 - dirPenalty;
  let lastMatch = -2;
  for (let i = 0; i < rel.length && qi < q.length; i++) {
    if (rel[i] !== q[qi]) continue;
    if (i === lastMatch + 1) score += 14;
    if (i === 0 || BOUNDARY_CHARS.has(rel[i - 1]!)) score += 18;
    if (i > slashIndex) score += 20;
    lastMatch = i;
    qi++;
  }
  return qi === q.length ? score : null;
}

async function gitProjectCandidates(cwd: string): Promise<ProjectFileEntry[] | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "ls-files", "-co", "--exclude-standard", "-z"], {
      encoding: "buffer",
      timeout: 3000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const rawPaths = stdout.toString("utf8").split("\0").filter(Boolean);
    const seenFiles = new Set<string>();
    const seenDirs = new Set<string>();
    const entries: ProjectFileEntry[] = [];
    for (const raw of rawPaths) {
      const rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
      if (!rel || rel.split("/").includes("..") || seenFiles.has(rel)) continue;
      seenFiles.add(rel);
      entries.push({ path: join(cwd, ...rel.split("/")), relativePath: rel });
      const parts = rel.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        const dirRel = parts.slice(0, depth).join("/");
        if (!seenDirs.has(dirRel)) {
          seenDirs.add(dirRel);
          entries.push({ path: join(cwd, ...dirRel.split("/")), relativePath: dirRel, isDir: true });
        }
      }
    }
    return entries;
  } catch {
    return undefined;
  }
}

async function walkProjectCandidates(cwd: string, budgetMs = 1500): Promise<{ entries: ProjectFileEntry[]; truncated: boolean }> {
  const deadline = Date.now() + budgetMs;
  const entries: ProjectFileEntry[] = [];
  let queue: { full: string; rel: string; depth: number }[] = [{ full: cwd, rel: "", depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    if (Date.now() > deadline || entries.length >= MAX_PROJECT_WALK_ENTRIES) {
      truncated = true;
      break;
    }
    const next: typeof queue = [];
    for (const current of queue) {
      if (Date.now() > deadline || entries.length >= MAX_PROJECT_WALK_ENTRIES) {
        truncated = true;
        break;
      }
      let dirents;
      try {
        dirents = await readdir(current.full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        if (d.name === ".git" || SKIP.has(d.name)) continue;
        if (d.isDirectory() && d.name.startsWith(".")) continue;
        const rel = current.rel ? `${current.rel}/${d.name}` : d.name;
        const full = join(current.full, d.name);
        if (d.isDirectory()) {
          entries.push({ path: full, relativePath: rel, isDir: true });
          if (current.depth < 8) next.push({ full, rel, depth: current.depth + 1 });
        } else if (d.isFile()) {
          entries.push({ path: full, relativePath: rel });
        }
        if (entries.length >= MAX_PROJECT_WALK_ENTRIES) {
          truncated = true;
          break;
        }
      }
    }
    queue = next;
  }

  return { entries, truncated };
}

export async function listProjectFiles(input: {
  cwd: string;
  query?: string;
  limit?: number;
}): Promise<{ files: ProjectFileEntry[]; truncated: boolean }> {
  const cwd = await existingDirectory(input.cwd);
  const limit = Math.min(Math.max(1, input.limit ?? 100), 1000);
  const gitEntries = await gitProjectCandidates(cwd);
  let candidates: ProjectFileEntry[];
  let sourceTruncated = false;
  if (gitEntries !== undefined) {
    candidates = gitEntries;
  } else {
    const walked = await walkProjectCandidates(cwd);
    candidates = walked.entries;
    sourceTruncated = walked.truncated;
  }

  const query = (input.query ?? "").trim().replace(/^@+/, "");
  if (!query) {
    candidates.sort(
      (a, b) =>
        Number(Boolean(a.isDir)) - Number(Boolean(b.isDir)) ||
        a.relativePath.split("/").length - b.relativePath.split("/").length ||
        a.relativePath.localeCompare(b.relativePath),
    );
    return {
      files: candidates.slice(0, limit),
      truncated: sourceTruncated || candidates.length > limit,
    };
  }

  const scored: { entry: ProjectFileEntry; score: number }[] = [];
  for (const entry of candidates) {
    const score = scoreProjectPath(entry.relativePath, query, entry.isDir);
    if (score !== null) scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.relativePath.length - b.entry.relativePath.length ||
      a.entry.relativePath.localeCompare(b.entry.relativePath),
  );
  return {
    files: scored.slice(0, limit).map((item) => item.entry),
    truncated: sourceTruncated || scored.length > limit,
  };
}
