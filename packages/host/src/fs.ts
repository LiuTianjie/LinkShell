import { existsSync } from "node:fs";
import { mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { RpcError, type DirectoryEntry } from "@linkshell/wire";

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

async function subdirectories(path: string, hidden: boolean): Promise<{ entries: DirectoryEntry[]; names: Set<string> }> {
  const dirents = await readdir(path, { withFileTypes: true });
  const names = new Set(dirents.map((d) => d.name));
  const dirs = dirents.filter((d) => (d.isDirectory() || d.isSymbolicLink()) && (hidden || !d.name.startsWith(".")));
  const entries = await Promise.all(
    dirs.map(async (d): Promise<DirectoryEntry | undefined> => {
      const full = join(path, d.name);
      try {
        if (d.isSymbolicLink() && !(await stat(full)).isDirectory()) return undefined;
        const children = new Set(await readdir(full).catch(() => [] as string[]));
        return { name: d.name, path: full, project: isProject(children) || undefined };
      } catch {
        return undefined;
      }
    }),
  );
  return {
    entries: entries
      .filter((e): e is DirectoryEntry => Boolean(e))
      .sort((a, b) => Number(Boolean(b.project)) - Number(Boolean(a.project)) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    names,
  };
}

export async function listDirectory(input: { path?: string; hidden: boolean }) {
  const path = expand(input.path);
  if (!existsSync(path) || !(await stat(path)).isDirectory()) throw RpcError.app("not_found", `no such directory: ${path}`);
  const { entries } = await subdirectories(path, input.hidden).catch(() => {
    throw RpcError.app("not_found", `can't read ${path}`);
  });
  const parent = dirname(path);
  return { path, parent: parent === path ? undefined : parent, home: homedir(), entries };
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

/** Reads a file for the phone's viewer. Text is detected by content, not extension. */
export async function readFile(input: { path: string; maxBytes: number }) {
  const path = expand(input.path);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw RpcError.app("not_found", `no such file: ${path}`);
  }
  if (!info.isFile()) throw RpcError.app("invalid_params", `not a file: ${path}`);
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const image = IMAGE_TYPES[extension];
  const limit = image ? Math.min(input.maxBytes * 3, 8_000_000) : input.maxBytes;
  const length = Math.min(info.size, limit);
  const handle = await open(path, "r");
  const buffer = Buffer.alloc(length);
  try {
    await handle.read(buffer, 0, length, 0);
  } finally {
    await handle.close();
  }
  const base = { path, size: info.size, modifiedAt: info.mtimeMs, truncated: info.size > length };
  if (image && !base.truncated) return { ...base, kind: "image" as const, data: buffer.toString("base64"), mimeType: image };
  // Text: no NUL bytes in the first 8KB.
  if (buffer.subarray(0, 8192).includes(0)) return { ...base, kind: "binary" as const };
  let text = buffer.toString("utf8");
  // Don't end on half a multi-byte character.
  if (base.truncated) text = text.replace(/\uFFFD+$/, "");
  return { ...base, kind: "text" as const, text };
}

/** A single path component: no separators, no `.`/`..`, nothing a shell or filesystem would choke on. */
function safeName(name: string): string {
  const cleaned = name.replace(/[/\\\0]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw RpcError.app("invalid_params", "invalid name");
  return cleaned;
}

async function existingDirectory(path: string): Promise<string> {
  const dir = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) throw RpcError.app("not_found", `no such directory: ${path}`);
  return dir;
}

/** Writes an uploaded file into `dir`, never over an existing one. */
export async function uploadFile(input: { dir: string; name: string; data: string }) {
  const dir = await existingDirectory(input.dir);
  const name = safeName(input.name);
  const bytes = Buffer.from(input.data, "base64");
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
  throw RpcError.app("busy", "too many files with this name");
}

export async function makeDirectory(input: { parent: string; name: string }) {
  const parent = await existingDirectory(input.parent);
  const path = join(parent, safeName(input.name));
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw RpcError.app("invalid_params", "a file or folder with this name already exists");
    throw error;
  }
  return { path };
}
