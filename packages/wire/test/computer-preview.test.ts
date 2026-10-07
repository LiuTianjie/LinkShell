import { describe, expect, it } from "vitest";
import { encodePreviewFrame, PreviewFrameDecoder, PREVIEW_MAX_BYTES } from "../src/computer-preview.js";

describe("preview framing", () => {
  it("reassembles byte-at-a-time input and preserves image bytes", () => {
    const frame = { id: "a".repeat(64), target: "tab:1", capturedAt: 10, width: 480, height: 240, mimeType: "image/webp" as const, bytes: new Uint8Array([0, 12, 128, 255]) };
    const encoded = encodePreviewFrame(frame);
    const decoder = new PreviewFrameDecoder();
    const decoded = [...encoded].flatMap(byte => decoder.push(new Uint8Array([byte])));
    expect(decoded).toEqual([frame]);
  });
  it("rejects oversize and malformed headers before buffering their contents", () => {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer); view.setUint32(0, 300); view.setUint32(4, PREVIEW_MAX_BYTES + 1);
    expect(() => new PreviewFrameDecoder().push(bytes)).toThrow("invalid preview frame");
    expect(() => new PreviewFrameDecoder().push(new Uint8Array(PREVIEW_MAX_BYTES + 5000))).toThrow("preview buffer too large");
  });
});
