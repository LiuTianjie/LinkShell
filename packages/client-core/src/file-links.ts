// Shared parsing for computer file links and embedded Markdown images across mobile, desktop, and web.

export interface ParsedFileLink {
  path: string;
  line?: number;
  endLine?: number;
}

export interface ParseFileLinkOptions {
  /** Keep relative paths (e.g. `src/a.ts` or `scripts\\build`) even without a base directory. */
  allowRelativeWithoutBase?: boolean;
}

export type MarkdownSegment =
  | { kind: "markdown"; text: string }
  | { kind: "image"; url: string; alt: string };

const EDITOR_URI_RE = /^(?:vscode|vscode-insiders|cursor|zed|windsurf):\/\/file(\/.*)$/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const LEADING_SLASH_WINDOWS_DRIVE_RE = /^\/+([A-Za-z]:[\\/])/;
const LINE_HASH_RE = /^#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i;
const TRAILING_LINE_HASH_RE = /^(.*)#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i;
const TRAILING_COLON_LINE_RE = /^(.*?):(\d+)(?::\d+)?$/;
const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|svg|heic|heif|avif|bmp|ico)$/i;

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Preserve literal `%` characters that are not valid percent-encoding.
    return value;
  }
}

function stripLeadingWindowsSlash(path: string): string {
  return LEADING_SLASH_WINDOWS_DRIVE_RE.test(path) ? path.replace(/^\/+/, "") : path;
}

function parseLineHash(hash: string): { line?: number; endLine?: number } {
  const match = LINE_HASH_RE.exec(hash);
  if (!match) return {};
  const line = Number(match[1]);
  const endLine = match[2] ? Number(match[2]) : undefined;
  return {
    ...(line > 0 ? { line } : {}),
    ...(endLine && endLine > 0 ? { endLine } : {}),
  };
}

function isAbsoluteHostPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path === "~" ||
    path.startsWith("~/") ||
    path.startsWith("~\\") ||
    WINDOWS_DRIVE_RE.test(path) ||
    path.startsWith("\\\\")
  );
}

function joinBasePath(base: string, relPath: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  const cleanBase = base.replace(/[\\/]+$/, "");
  const strippedRel = relPath.replace(/^\.[\\/]/, "");
  const normalizedRel = sep === "\\" ? strippedRel.replace(/\//g, "\\") : strippedRel;
  if (!cleanBase) return `${sep}${normalizedRel}`;
  return `${cleanBase}${sep}${normalizedRel}`;
}

/**
 * Resolves a link or path (including `file://`, editor URIs, Windows drive paths,
 * `#L` line anchors, non-line HTML fragments like `#weapons-001`, and `?query` suffixes)
 * into a concrete host filesystem path.
 */
export function parseFileLink(
  url: string,
  base?: string,
  options?: ParseFileLinkOptions,
): ParsedFileLink | undefined {
  let clean = url.trim();
  if (clean.startsWith("<") && clean.endsWith(">") && clean.length > 2) {
    clean = clean.slice(1, -1).trim();
  }
  if (!clean || clean.startsWith("#")) return undefined;

  let line: number | undefined;
  let endLine: number | undefined;
  let rawPath: string;

  const editorMatch = EDITOR_URI_RE.exec(clean);
  if (editorMatch) {
    let part = editorMatch[1]!;
    const hashIdx = part.indexOf("#");
    if (hashIdx >= 0) {
      const parsedHash = parseLineHash(part.slice(hashIdx));
      line = parsedHash.line;
      endLine = parsedHash.endLine;
      part = part.slice(0, hashIdx);
    }
    const queryIdx = part.indexOf("?");
    if (queryIdx >= 0) part = part.slice(0, queryIdx);
    rawPath = stripLeadingWindowsSlash(safeDecodeURIComponent(part));
  } else if (/^file:\/\//i.test(clean)) {
    let urlPart = clean;
    const hashIdx = urlPart.indexOf("#");
    if (hashIdx >= 0) {
      const parsedHash = parseLineHash(urlPart.slice(hashIdx));
      line = parsedHash.line;
      endLine = parsedHash.endLine;
      urlPart = urlPart.slice(0, hashIdx);
    }
    const queryIdx = urlPart.indexOf("?");
    if (queryIdx >= 0) urlPart = urlPart.slice(0, queryIdx);

    const afterScheme = urlPart.replace(/^file:\/\//i, "");
    let extracted: string;
    if (/^(?:localhost)?\/+[A-Za-z](?::|%3[Aa])[\\/]/i.test(afterScheme)) {
      extracted = afterScheme.replace(/^(?:localhost)?\/+/i, "");
    } else if (/^[A-Za-z](?::|%3[Aa])[\\/]/i.test(afterScheme)) {
      extracted = afterScheme;
    } else if (/^localhost\//i.test(afterScheme)) {
      extracted = afterScheme.slice("localhost".length);
    } else if (afterScheme.startsWith("/")) {
      extracted = afterScheme;
    } else if (/^[A-Za-z0-9._-]+[\\/].+/.test(afterScheme)) {
      // RFC 8089 UNC file URI: file://server/share/file -> \\server\share\file
      extracted = `\\\\${afterScheme.replace(/\//g, "\\")}`;
    } else {
      extracted = afterScheme;
    }
    rawPath = stripLeadingWindowsSlash(safeDecodeURIComponent(extracted));
  } else {
    // Reject web/app URI schemes, but never confuse a Windows drive (`D:\` / `D:/`) with a scheme.
    if (/^[a-z][a-z0-9+.-]*:/i.test(clean) && !WINDOWS_DRIVE_RE.test(clean)) {
      return undefined;
    }
    let part = clean;
    const lineHashMatch = TRAILING_LINE_HASH_RE.exec(part);
    if (lineHashMatch) {
      part = lineHashMatch[1]!;
      const start = Number(lineHashMatch[2]);
      const end = lineHashMatch[3] ? Number(lineHashMatch[3]) : undefined;
      if (start > 0) line = start;
      if (end && end > 0) endLine = end;
    } else {
      // Strip non-line URL fragments (e.g. `attack-effects-v82.html#weapons-001`, `README.md#install`)
      // while preserving `#` inside directory names such as `/repo/c#/app.cs`.
      const hashMatch = /^(.*?)#[^/\\]*$/.exec(part);
      if (hashMatch && hashMatch[1]) {
        part = hashMatch[1];
      }
    }
    // Strip trailing query strings (e.g. `demo.gif?v=2`); `?` is not valid in Windows paths.
    const queryMatch = /^(.*?)\?[^/\\]*$/.exec(part);
    if (queryMatch && queryMatch[1]) {
      part = queryMatch[1];
    }
    rawPath = stripLeadingWindowsSlash(safeDecodeURIComponent(part));
  }

  if (line === undefined) {
    const colonMatch = TRAILING_COLON_LINE_RE.exec(rawPath);
    if (colonMatch && colonMatch[1] && !/^[A-Za-z]$/.test(colonMatch[1])) {
      const parsedLine = Number(colonMatch[2]);
      rawPath = colonMatch[1];
      if (parsedLine > 0) line = parsedLine;
    }
  }

  rawPath = stripLeadingWindowsSlash(rawPath);
  if (!rawPath) return undefined;

  if (!isAbsoluteHostPath(rawPath)) {
    if (base) {
      rawPath = joinBasePath(base, rawPath);
    } else if (options?.allowRelativeWithoutBase) {
      if (
        !/\.[a-z0-9]{1,8}$/i.test(rawPath) &&
        !rawPath.includes("/") &&
        !rawPath.includes("\\")
      ) {
        return undefined;
      }
    } else {
      return undefined;
    }
  }

  return {
    path: rawPath,
    ...(line !== undefined ? { line } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

/** Whether a path or URL points to an image file based on its extension (ignoring query/fragment). */
export function isImagePath(pathOrUrl: string): boolean {
  const cleaned = pathOrUrl.trim().replace(/[?#].*$/, "");
  return IMAGE_EXTENSION_RE.test(cleaned);
}

/** Whether a MIME type or path/URL identifies an image asset. */
export function isImageResource(uri: string, mimeType?: string): boolean {
  if (mimeType && /^image\//i.test(mimeType)) return true;
  return isImagePath(uri);
}

/** Parent directory of a POSIX or Windows path, preserving root `/` or `C:\`. */
export function parentDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed || trimmed === "/") return "/";
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`;
  const sepIdx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (sepIdx < 0) return "";
  if (sepIdx === 0) return trimmed[0]!;
  const parent = trimmed.slice(0, sepIdx);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${trimmed[sepIdx]!}`;
  return parent;
}

interface ParsedImageToken {
  end: number;
  url: string;
  alt: string;
}

function parseLinkDestination(source: string, openParen: number): { url: string; end: number } | null {
  let i = openParen + 1;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  if (i >= source.length) return null;

  let url: string;
  if (source[i] === "<") {
    i++;
    const start = i;
    while (i < source.length && source[i] !== ">" && source[i] !== "\n") {
      if (source[i] === "\\" && i + 1 < source.length && (source[i + 1] === ">" || source[i + 1] === "\\")) {
        i += 2;
        continue;
      }
      i++;
    }
    if (i >= source.length || source[i] !== ">") return null;
    url = source.slice(start, i);
    i++;
  } else {
    const start = i;
    let depth = 0;
    const isWinDrive = /^[A-Za-z]:\\/.test(source.slice(start));
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === "\n" || ch === "\r") return null;
      if (ch === " " || ch === "\t") break;
      if (ch === "\\" && !isWinDrive && i + 1 < source.length) {
        i += 2;
        continue;
      }
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    url = source.slice(start, i);
  }

  // Skip optional whitespace and title (`"..."`, `'...'`, or `(...)`) before closing `)`.
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  if (i < source.length && (source[i] === '"' || source[i] === "'" || source[i] === "(")) {
    const close = source[i] === "(" ? ")" : source[i]!;
    i++;
    while (i < source.length && source[i] !== close) {
      if (source[i] === "\n") return null;
      if (source[i] === "\\" && i + 1 < source.length) i += 2;
      else i++;
    }
    if (i >= source.length || source[i] !== close) return null;
    i++;
    while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  }

  if (i >= source.length || source[i] !== ")") return null;
  if (!url.trim()) return null;
  return { url: url.trim(), end: i + 1 };
}

function parseMarkdownImageAt(source: string, start: number): ParsedImageToken | null {
  if (source[start] !== "!" || source[start + 1] !== "[") return null;
  let i = start + 2;
  let bracketDepth = 1;
  while (i < source.length && bracketDepth > 0) {
    const ch = source[i]!;
    if (ch === "\n") return null;
    if (ch === "\\" && i + 1 < source.length) {
      i += 2;
      continue;
    }
    if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;
    i++;
  }
  if (bracketDepth !== 0 || source[i] !== "(") return null;
  const alt = source.slice(start + 2, i - 1);
  const dest = parseLinkDestination(source, i);
  if (!dest) return null;
  return { end: dest.end, url: dest.url, alt };
}

function parseLinkedImageAt(source: string, start: number): ParsedImageToken | null {
  if (source[start] !== "[" || source[start + 1] !== "!" || source[start + 2] !== "[") return null;
  const inner = parseMarkdownImageAt(source, start + 1);
  if (!inner || source[inner.end] !== "]" || source[inner.end + 1] !== "(") return null;
  const outer = parseLinkDestination(source, inner.end + 1);
  if (!outer) return null;
  return { end: outer.end, url: inner.url, alt: inner.alt };
}

function parseHtmlImgAt(source: string, start: number): ParsedImageToken | null {
  if (source[start] !== "<") return null;
  const rest = source.slice(start);
  const match = /^<img\b([^>]*?)\/?>/i.exec(rest);
  if (!match) return null;
  const attrs = match[1] ?? "";
  const srcMatch = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i.exec(attrs);
  const url = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "").trim();
  if (!url) return null;
  const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attrs);
  const alt = (altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? "").trim();
  return { end: start + match[0].length, url, alt };
}

function isTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length >= 2;
}

/**
 * Normalizes Markdown text before CommonMark parsing so Windows backslash paths inside link/image
 * destinations (e.g. `D:\DEV\xian\_artifacts\attack-effects-v82.html`) never lose `\_` / `\.` to
 * CommonMark backslash-escape rules, and raw HTML `<img src="...">` tags render identically as
 * Markdown images across mobile, desktop, and web without enabling unsafe raw HTML.
 */
export function normalizeMarkdownForDisplay(markdown: string): string {
  if (!markdown.includes("\\") && !/<img\b/i.test(markdown)) {
    return markdown;
  }

  const lines = markdown.split("\n");
  const outLines: string[] = [];
  let fenceChar = "";
  let fenceLen = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!fenceChar) {
      const openFence = /^(`{3,}|~{3,})/.exec(trimmed);
      if (openFence && line.length - trimmed.length <= 3) {
        fenceChar = openFence[1]![0]!;
        fenceLen = openFence[1]!.length;
        outLines.push(line);
        continue;
      }
    } else {
      const closeFence = new RegExp(`^${fenceChar === "`" ? "`" : "~"}{${fenceLen},}\\s*$`);
      outLines.push(line);
      if (line.length - trimmed.length <= 3 && closeFence.test(trimmed)) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }

    if (!line.includes("\\") && !/<img\b/i.test(line)) {
      outLines.push(line);
      continue;
    }

    let cursor = 0;
    let out = "";
    while (cursor < line.length) {
      if (line[cursor] === "`") {
        let ticks = 0;
        while (cursor + ticks < line.length && line[cursor + ticks] === "`") ticks++;
        const closeIdx = line.indexOf("`".repeat(ticks), cursor + ticks);
        if (closeIdx >= 0) {
          out += line.slice(cursor, closeIdx + ticks);
          cursor = closeIdx + ticks;
          continue;
        }
        out += line.slice(cursor, cursor + ticks);
        cursor += ticks;
        continue;
      }

      const htmlImg = parseHtmlImgAt(line, cursor);
      if (htmlImg) {
        const safeAlt = htmlImg.alt.replace(/[[\]]/g, "");
        const normalizedUrl = /^(?:file:\/\/|[A-Za-z]:\\|\.\.?\\)/i.test(htmlImg.url)
          ? htmlImg.url.replace(/\\/g, "/")
          : htmlImg.url;
        const wrappedUrl = /[\s()]/.test(normalizedUrl) ? `<${normalizedUrl}>` : normalizedUrl;
        out += `![${safeAlt}](${wrappedUrl})`;
        cursor = htmlImg.end;
        continue;
      }

      if (line[cursor] === "]" && line[cursor + 1] === "(") {
        const dest = parseLinkDestination(line, cursor + 1);
        if (dest && dest.url.includes("\\") && /^(?:file:\/\/|[A-Za-z]:\\|\.\.?\\)/i.test(dest.url)) {
          const rawSegment = line.slice(cursor + 2, dest.end - 1);
          const replaced = rawSegment.replace(dest.url, dest.url.replace(/\\/g, "/"));
          out += `](${replaced})`;
          cursor = dest.end;
          continue;
        }
      }

      out += line[cursor]!;
      cursor++;
    }
    outLines.push(out);
  }

  return outLines.join("\n");
}

/**
 * Splits Markdown into alternating prose blocks and image embeds so native mobile
 * Markdown (which cannot fetch host files or animate GIFs) can render images with
 * `expo-image` while keeping code blocks, inline code, and GFM tables intact.
 */
export function splitMarkdownImages(markdown: string): MarkdownSegment[] {
  if (!markdown.includes("![") && !/<img\b/i.test(markdown)) {
    return [{ kind: "markdown", text: markdown }];
  }

  const lines = markdown.split("\n");
  const segments: MarkdownSegment[] = [];
  let textBuffer: string[] = [];
  let deferredTableImages: { url: string; alt: string }[] = [];
  let fenceChar = "";
  let fenceLen = 0;

  const flushText = () => {
    if (textBuffer.length === 0) return;
    const joined = textBuffer.join("\n").replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
    textBuffer = [];
    if (joined.trim().length > 0) {
      segments.push({ kind: "markdown", text: joined });
    }
  };

  const flushDeferredTableImages = () => {
    if (deferredTableImages.length === 0) return;
    flushText();
    for (const img of deferredTableImages) {
      segments.push({ kind: "image", url: img.url, alt: img.alt });
    }
    deferredTableImages = [];
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!fenceChar) {
      const openFence = /^(`{3,}|~{3,})/.exec(trimmed);
      if (openFence && line.length - trimmed.length <= 3) {
        flushDeferredTableImages();
        fenceChar = openFence[1]![0]!;
        fenceLen = openFence[1]!.length;
        textBuffer.push(line);
        continue;
      }
    } else {
      const closeFence = new RegExp(`^${fenceChar === "`" ? "`" : "~"}{${fenceLen},}\\s*$`);
      textBuffer.push(line);
      if (line.length - trimmed.length <= 3 && closeFence.test(trimmed)) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }

    const inTable = isTableRowLine(line);
    if (!inTable && deferredTableImages.length > 0) {
      flushDeferredTableImages();
    }

    if (!line.includes("![") && !/<img\b/i.test(line)) {
      textBuffer.push(line);
      continue;
    }

    let cursor = 0;
    let outLine = "";
    let lineHasExtracted = false;

    while (cursor < line.length) {
      // Preserve inline code spans verbatim.
      if (line[cursor] === "`") {
        let ticks = 0;
        while (cursor + ticks < line.length && line[cursor + ticks] === "`") ticks++;
        const closeIdx = line.indexOf("`".repeat(ticks), cursor + ticks);
        if (closeIdx >= 0) {
          outLine += line.slice(cursor, closeIdx + ticks);
          cursor = closeIdx + ticks;
          continue;
        }
        outLine += line.slice(cursor, cursor + ticks);
        cursor += ticks;
        continue;
      }

      const token =
        parseLinkedImageAt(line, cursor) ??
        parseMarkdownImageAt(line, cursor) ??
        parseHtmlImgAt(line, cursor);

      if (token) {
        if (inTable) {
          // Keep the GFM table structure valid and render its images immediately below the table.
          outLine += token.alt || "图片";
          deferredTableImages.push({ url: token.url, alt: token.alt });
        } else {
          if (outLine.trim().length > 0) {
            textBuffer.push(outLine);
          }
          outLine = "";
          flushText();
          segments.push({ kind: "image", url: token.url, alt: token.alt });
          lineHasExtracted = true;
        }
        cursor = token.end;
        continue;
      }

      outLine += line[cursor]!;
      cursor++;
    }

    if (inTable) {
      textBuffer.push(outLine);
    } else if (outLine.trim().length > 0 || !lineHasExtracted) {
      textBuffer.push(outLine);
    }
  }

  flushDeferredTableImages();
  flushText();

  return segments.length > 0 ? segments : [{ kind: "markdown", text: markdown }];
}

export interface HostImageReader {
  call(
    method: "fs.read",
    params: { path: string; offset?: number; maxBytes?: number },
    timeoutMs?: number,
  ): Promise<{
    kind: "text" | "image" | "binary";
    data?: string;
    mimeType?: string;
  }>;
}

/**
 * Bounded LRU cache for host images fetched via `fs.read` so scrolling timelines and
 * re-rendered Markdown blocks never re-download the same file over RPC.
 */
export class HostImageCache {
  private readonly entries = new Map<string, Promise<string>>();
  private readonly resolved = new Map<string, string>();
  private readonly sizes = new Map<string, number>();
  private totalChars = 0;
  private readonly maxChars: number;

  constructor(maxChars = 24 * 1024 * 1024) {
    this.maxChars = maxChars;
  }

  private forget(key: string): void {
    this.entries.delete(key);
    this.resolved.delete(key);
    this.totalChars -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
  }

  peek(key: string): string | undefined {
    const hit = this.resolved.get(key);
    if (hit !== undefined) {
      this.resolved.delete(key);
      this.resolved.set(key, hit);
    }
    return hit;
  }

  load(key: string, reader: HostImageReader, path: string, timeoutMs = 20_000): Promise<string> {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const promise = reader
      .call("fs.read", { path, maxBytes: 512_000 }, timeoutMs)
      .then((res) => {
        if (res.kind !== "image" || !res.data) {
          throw new Error("不是支持预览的图片文件");
        }
        const dataUri = `data:${res.mimeType || "image/png"};base64,${res.data}`;
        this.resolved.set(key, dataUri);
        this.sizes.set(key, dataUri.length);
        this.totalChars += dataUri.length;
        for (const oldest of this.entries.keys()) {
          if (this.totalChars <= this.maxChars || oldest === key) break;
          this.forget(oldest);
        }
        return dataUri;
      })
      .catch((error: unknown) => {
        this.forget(key);
        throw error;
      });
    this.entries.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
    this.resolved.clear();
    this.sizes.clear();
    this.totalChars = 0;
  }
}
