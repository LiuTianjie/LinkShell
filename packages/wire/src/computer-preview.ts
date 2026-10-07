import { z } from "zod";

export const PREVIEW_MAX_BYTES = 48 * 1024;
export const previewFrameSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  target: z.string().max(1024),
  capturedAt: z.number().finite().nonnegative(),
  width: z.number().int().positive().max(2048),
  height: z.number().int().positive().max(2048),
  mimeType: z.literal("image/webp"),
});
export type PreviewFrameInfo = z.infer<typeof previewFrameSchema>;
export interface PreviewFrame extends PreviewFrameInfo { bytes: Uint8Array }

/** Length-prefixed metadata and image bytes, inside an authenticated proxy stream. */
export function encodePreviewFrame(frame: PreviewFrame): Uint8Array {
  const { bytes, ...info } = frame;
  const metadata = new TextEncoder().encode(JSON.stringify(previewFrameSchema.parse(info)));
  if (bytes.length > PREVIEW_MAX_BYTES) throw new Error("preview image too large");
  const packet = new Uint8Array(8 + metadata.length + bytes.length);
  const header = new DataView(packet.buffer);
  header.setUint32(0, metadata.length);
  header.setUint32(4, bytes.length);
  packet.set(metadata, 8);
  packet.set(bytes, 8 + metadata.length);
  return packet;
}

/** Handles split TCP/data-channel chunks without accepting unbounded allocations. */
export class PreviewFrameDecoder {
  private held = new Uint8Array(0);
  push(chunk: Uint8Array): PreviewFrame[] {
    if (this.held.length + chunk.length > PREVIEW_MAX_BYTES + 4104) throw new Error("preview buffer too large");
    const next = new Uint8Array(this.held.length + chunk.length);
    next.set(this.held); next.set(chunk, this.held.length); this.held = next;
    const frames: PreviewFrame[] = [];
    while (this.held.length >= 8) {
      const header = new DataView(this.held.buffer, this.held.byteOffset);
      const meta = header.getUint32(0), size = header.getUint32(4);
      if (meta > 4096 || size > PREVIEW_MAX_BYTES || !meta || !size) throw new Error("invalid preview frame");
      const total = 8 + meta + size;
      if (this.held.length < total) break;
      const info = previewFrameSchema.parse(JSON.parse(new TextDecoder().decode(this.held.subarray(8, 8 + meta))));
      frames.push({ ...info, bytes: this.held.slice(8 + meta, total) });
      this.held = this.held.slice(total);
    }
    return frames;
  }
}
