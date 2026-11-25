import type { SessionEvent, SessionUpdate } from "@linkshell/wire";
import { blobStoreOf, INLINE_BLOB_THRESHOLD, parseBlobUri, type BlobStore } from "./blob-store.js";

// What a client is sent of an event. The log keeps everything an agent
// produced; a phone reading a session through a relay needs the conversation,
// not every screenshot and file dump in it. Pictures become references the
// client loads when it shows them, and very long text is cut.

/** Pictures up to this size (base64 characters) travel inline. */
const INLINE_IMAGE = INLINE_BLOB_THRESHOLD;
/** Text beyond this is cut on the wire to clients. */
const MAX_TEXT = 32 * 1024;
const KEPT_TEXT = 24 * 1024;
/** Hard ceilings for stored SQLite rows so one runaway tool output cannot bloat state.db to multi-MB. */
const MAX_STORED_TEXT = 256 * 1024;
const KEPT_STORED_TEXT = 192 * 1024;
const MAX_STORED_RAW_BYTES = 256 * 1024;
const MAX_STORED_EVENT_BYTES = 512 * 1024;

const IMAGE_URI = /^linkshell-event:(\d+)\/(\d+)$/;

export interface SlimOptions {
  /** The client fetches pictures itself (`sessions.image`); otherwise they become a note. */
  lazyImages?: boolean;
}

type Json = unknown;
type LargeMedia = {
  type: "image" | "audio";
  mimeType: string;
  data?: string;
  blobUri?: string;
  [key: string]: unknown;
};

function largeImage(value: Json): LargeMedia | undefined {
  const block = value as { type?: unknown; data?: unknown; mimeType?: unknown; uri?: unknown };
  if ((block?.type !== "image" && block?.type !== "audio") || typeof block.mimeType !== "string") return undefined;
  if (typeof block.data === "string" && block.data) {
    return block.data.length > INLINE_IMAGE ? (value as LargeMedia) : undefined;
  }
  if (typeof block.uri !== "string") return undefined;
  if (parseBlobUri(block.uri)) {
    const { uri, ...rest } = block as Record<string, unknown>;
    return { ...rest, type: block.type, mimeType: block.mimeType, blobUri: uri as string };
  }
  // Codex echoes uploads as data URLs, including in old logs. Treat the payload as media
  // before the generic text limit can cut it, and read its actual MIME type from the URL.
  const prefix = /^data:((?:image|audio)\/[^;,]+);base64,/i.exec(block.uri);
  if (!prefix || block.uri.length - prefix[0].length <= INLINE_IMAGE) return undefined;
  return { ...(block as Record<string, unknown>), type: block.type, mimeType: prefix[1]!, data: block.uri.slice(prefix[0].length) };
}

/** Visits every large picture in an update, in a fixed order; `replace` returns what takes its place. */
function walk(value: Json, state: { images: number }, replace: (image: LargeMedia, index: number) => Json, cut: boolean): Json {
  if (typeof value === "string") {
    if (!cut || value.length <= MAX_TEXT) return value;
    return `${value.slice(0, KEPT_TEXT)}\n… [已省略 ${Math.round((value.length - KEPT_TEXT) / 1024)} KB，完整内容在电脑上]`;
  }
  if (Array.isArray(value)) {
    let out: Json[] | undefined;
    value.forEach((entry, i) => {
      const next = walk(entry, state, replace, cut);
      if (next !== entry) (out ??= value.slice())[i] = next;
    });
    return out ?? value;
  }
  if (value && typeof value === "object") {
    const image = largeImage(value);
    if (image) return replace(image, state.images++);
    const resource = value as { type?: unknown; resource?: { blob?: unknown; assetUri?: unknown; mimeType?: string } };
    if (resource.type === "resource" && resource.resource) {
      const hasLargeBlob = typeof resource.resource.blob === "string" && resource.resource.blob.length > INLINE_IMAGE;
      const hasBlobUri = typeof resource.resource.assetUri === "string" && Boolean(parseBlobUri(resource.resource.assetUri));
      if (hasLargeBlob || hasBlobUri) {
        const media: LargeMedia = hasLargeBlob
          ? { type: "audio", mimeType: resource.resource.mimeType ?? "application/octet-stream", data: resource.resource.blob as string }
          : { type: "audio", mimeType: resource.resource.mimeType ?? "application/octet-stream", blobUri: resource.resource.assetUri as string };
        const replacement = replace(media, state.images++) as { uri?: string; data?: string; blobUri?: string };
        if (replacement.data || replacement.blobUri) return value;
        const { blob: _blob, assetUri: _assetUri, ...rest } = resource.resource;
        return { ...value, resource: { ...rest, ...(replacement.uri ? { assetUri: replacement.uri } : { text: "[二进制附件]" }) } };
      }
    }
    let out: Record<string, Json> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const next = walk(entry, state, replace, cut);
      if (next !== entry) (out ??= { ...(value as Record<string, Json>) })[key] = next;
    }
    return out ?? value;
  }
  return value;
}

/** The event as sent to a client; the same object when nothing in it is heavy. */
export function slimEvent(event: SessionEvent, options: SlimOptions = {}): SessionEvent {
  const update = walk(
    event.update,
    { images: 0 },
    (image, index) => {
      const { data: _data, blobUri: _blobUri, ...metadata } = image;
      return options.lazyImages
        ? { ...metadata, uri: `linkshell-event:${event.seq}/${index}` }
        : { type: "text", text: image.type === "audio" ? "[音频]" : "[图片]" };
    },
    true,
  );
  return update === event.update ? event : { ...event, update: update as SessionEvent["update"] };
}

/** Which event and which of its pictures a `linkshell-event:` uri names. */
export function parseImageUri(uri: string): { seq: number; index: number } | undefined {
  const match = IMAGE_URI.exec(uri);
  return match ? { seq: Number(match[1]), index: Number(match[2]) } : undefined;
}

/** The picture `slimEvent` replaced with reference `index`, resolving external blobs and legacy inline payloads alike. */
export function imageOf(event: SessionEvent, index: number, blobs?: BlobStore): { mimeType: string; data: string } | undefined {
  let found: { mimeType: string; data?: string; blobUri?: string } | undefined;
  walk(
    event.update,
    { images: 0 },
    (image, at) => {
      if (at === index) found = { mimeType: image.mimeType, data: image.data, blobUri: image.blobUri };
      return image;
    },
    false,
  );
  if (!found) return undefined;
  if (typeof found.data === "string") return { mimeType: found.mimeType, data: found.data };
  if (found.blobUri) {
    const resolved = (blobs ?? blobStoreOf(event.update))?.getBase64(found.blobUri);
    if (resolved !== undefined) return { mimeType: found.mimeType, data: resolved };
  }
  return undefined;
}

function capText(text: string, maxLen: number, keptLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, keptLen)}\n… [已截断 ${Math.round((text.length - keptLen) / 1024)} KB 超长内容]`;
}

function capStrings(value: Json, maxLen: number, keptLen: number): Json {
  if (typeof value === "string") return capText(value, maxLen, keptLen);
  if (Array.isArray(value)) {
    let out: Json[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const next = capStrings(value[i], maxLen, keptLen);
      if (next !== value[i]) (out ??= value.slice())[i] = next;
    }
    return out ?? value;
  }
  if (value && typeof value === "object") {
    let out: Record<string, Json> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const next = capStrings(entry, maxLen, keptLen);
      if (next !== entry) (out ??= { ...(value as Record<string, Json>) })[key] = next;
    }
    return out ?? value;
  }
  return value;
}

function capRawField(raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw;
  const capped = capStrings(raw, 128 * 1024, 96 * 1024);
  const serialized = JSON.stringify(capped);
  if (!serialized || Buffer.byteLength(serialized, "utf8") <= MAX_STORED_RAW_BYTES) return capped;
  return {
    _truncated: true,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    preview: `${serialized.slice(0, 64 * 1024)}\n… [原始数据过大，已截断]`,
  };
}

/**
 * Enforces hard per-row size bounds before inserting an update into SQLite.
 * Call after `BlobStore.externalizeUpdate()` so media > 16 KB is already a short URI.
 */
export function capStoredUpdate(update: SessionUpdate): SessionUpdate {
  let next: unknown = update;
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const rec = update as Record<string, unknown>;
    let cloned: Record<string, unknown> | undefined;
    if (rec.rawInput !== undefined) {
      const cappedInput = capRawField(rec.rawInput);
      if (cappedInput !== rec.rawInput) (cloned ??= { ...rec }).rawInput = cappedInput;
    }
    if (rec.rawOutput !== undefined) {
      const cappedOutput = capRawField(rec.rawOutput);
      if (cappedOutput !== rec.rawOutput) (cloned ??= { ...rec }).rawOutput = cappedOutput;
    }
    if (cloned) next = cloned;
  }
  next = capStrings(next, MAX_STORED_TEXT, KEPT_STORED_TEXT);
  const json = JSON.stringify(next);
  if (Buffer.byteLength(json, "utf8") <= MAX_STORED_EVENT_BYTES) {
    return next as SessionUpdate;
  }
  // Fallback when many moderate strings combine past 512 KB: tighten every nested string.
  const tighter = capStrings(next, 16 * 1024, 12 * 1024);
  if (Buffer.byteLength(JSON.stringify(tighter), "utf8") <= MAX_STORED_EVENT_BYTES) {
    return tighter as SessionUpdate;
  }
  const tightest = capStrings(tighter, 2 * 1024, 1536);
  return tightest as SessionUpdate;
}
