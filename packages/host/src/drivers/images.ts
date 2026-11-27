import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ContentBlock } from "@linkshell/wire";
import { normalizeHostPath } from "../fs.js";

// Images every driver forwards the same way: inline base64, bounded in size so
// one screenshot can't bloat the event log.

/** Largest image forwarded inline (base64 bytes, ~10 MB raw; externalized to BlobStore > 16 KB). */
export const MAX_INLINE_IMAGE = 14 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  avif: "image/avif",
  bmp: "image/bmp",
};

/** An inline image block, or undefined when the data is missing, too big or not base64. */
export function inlineImage(data: string | undefined, mimeType: string | undefined): Extract<ContentBlock, { type: "image" }> | undefined {
  if (!data || data.length > MAX_INLINE_IMAGE || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 256))) return undefined;
  return { type: "image", mimeType: mimeType && mimeType.startsWith("image/") ? mimeType : "image/png", data };
}

function resolveLocalImagePath(raw: string): string {
  let path = raw.trim();
  if (/^file:\/\//i.test(path)) {
    const cleanUrl = path.replace(/[?#].*$/, "");
    try {
      path = fileURLToPath(cleanUrl);
    } catch {
      path = cleanUrl.replace(/^file:\/\//i, "");
    }
  }
  return normalizeHostPath(path);
}

/** A local image file, inlined so a client on another device can show it. */
export function imageFromPath(path: string | undefined): Extract<ContentBlock, { type: "image" }> | undefined {
  if (!path) return undefined;
  const resolved = resolveLocalImagePath(path);
  const mimeType = IMAGE_TYPES[resolved.split(".").pop()?.toLowerCase() ?? ""];
  if (!mimeType) return undefined;
  try {
    if (statSync(resolved).size * 1.37 > MAX_INLINE_IMAGE) return undefined;
    return inlineImage(readFileSync(resolved).toString("base64"), mimeType);
  } catch {
    return undefined;
  }
}
