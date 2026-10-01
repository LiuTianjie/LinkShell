import type { SessionEvent } from "@linkshell/wire";

// What a client is sent of an event. The log keeps everything an agent
// produced; a phone reading a session through a relay needs the conversation,
// not every screenshot and file dump in it. Pictures become references the
// client loads when it shows them, and very long text is cut.

/** Pictures up to this size (base64 characters) travel inline. */
const INLINE_IMAGE = 16 * 1024;
/** Text beyond this is cut. */
const MAX_TEXT = 32 * 1024;
const KEPT_TEXT = 24 * 1024;

const IMAGE_URI = /^linkshell-event:(\d+)\/(\d+)$/;

export interface SlimOptions {
  /** The client fetches pictures itself (`sessions.image`); otherwise they become a note. */
  lazyImages?: boolean;
}

type Json = unknown;

function isLargeImage(value: Json): value is { type: "image"; mimeType: string; data: string } {
  const block = value as { type?: unknown; data?: unknown; mimeType?: unknown };
  return block?.type === "image" && typeof block.data === "string" && block.data.length > INLINE_IMAGE && typeof block.mimeType === "string";
}

/** Visits every large picture in an update, in a fixed order; `replace` returns what takes its place. */
function walk(value: Json, state: { images: number }, replace: (image: { mimeType: string; data: string }, index: number) => Json, cut: boolean): Json {
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
    if (isLargeImage(value)) return replace(value, state.images++);
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
    (image, index) =>
      options.lazyImages
        ? { type: "image", mimeType: image.mimeType, uri: `linkshell-event:${event.seq}/${index}` }
        : { type: "text", text: "[图片]" },
    true,
  );
  return update === event.update ? event : { ...event, update: update as SessionEvent["update"] };
}

/** Which event and which of its pictures a `linkshell-event:` uri names. */
export function parseImageUri(uri: string): { seq: number; index: number } | undefined {
  const match = IMAGE_URI.exec(uri);
  return match ? { seq: Number(match[1]), index: Number(match[2]) } : undefined;
}

/** The picture `slimEvent` replaced with reference `index`. */
export function imageOf(event: SessionEvent, index: number): { mimeType: string; data: string } | undefined {
  let found: { mimeType: string; data: string } | undefined;
  walk(
    event.update,
    { images: 0 },
    (image, at) => {
      if (at === index) found = { mimeType: image.mimeType, data: image.data };
      return image;
    },
    false,
  );
  return found;
}
