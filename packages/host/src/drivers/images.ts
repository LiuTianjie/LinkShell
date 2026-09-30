import { readFileSync, statSync } from "node:fs";
import type { ContentBlock } from "@linkshell/wire";

// Images every driver forwards the same way: inline base64, bounded in size so
// one screenshot can't bloat the event log.

/** Largest image forwarded inline (base64 bytes). */
export const MAX_INLINE_IMAGE = 4 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
};

/** An inline image block, or undefined when the data is missing, too big or not base64. */
export function inlineImage(data: string | undefined, mimeType: string | undefined): Extract<ContentBlock, { type: "image" }> | undefined {
  if (!data || data.length > MAX_INLINE_IMAGE || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 256))) return undefined;
  return { type: "image", mimeType: mimeType && mimeType.startsWith("image/") ? mimeType : "image/png", data };
}

/** A local image file, inlined so a client on another device can show it. */
export function imageFromPath(path: string | undefined): Extract<ContentBlock, { type: "image" }> | undefined {
  const mimeType = path ? IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] : undefined;
  if (!path || !mimeType) return undefined;
  try {
    if (statSync(path).size * 1.37 > MAX_INLINE_IMAGE) return undefined;
    return inlineImage(readFileSync(path).toString("base64"), mimeType);
  } catch {
    return undefined;
  }
}
