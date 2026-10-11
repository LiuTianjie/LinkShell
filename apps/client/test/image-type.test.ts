import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";
import { imageMimeType, sniffImageType } from "@/lib/image-type";

const b64 = (...bytes: number[]) => Buffer.from([...bytes, ...new Array(16).fill(0)]).toString("base64");
const ascii = (text: string) => Buffer.from(text + "\0".repeat(16), "latin1").toString("base64");

describe("image type", () => {
  it("reads the type from the first bytes", () => {
    expect(sniffImageType(b64(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageType(b64(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffImageType(ascii("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(ascii("RIFF\x10\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(ascii("\0\0\0\x18ftypheic"))).toBe("image/heic");
  });

  // The picker's base64 is JPEG even for a PNG screenshot it still calls image/png.
  it("prefers the bytes over what the picker called the file", () => {
    expect(imageMimeType(b64(0xff, 0xd8, 0xff, 0xdb), "image/png")).toBe("image/jpeg");
    expect(imageMimeType(b64(0x89, 0x50, 0x4e, 0x47), "image/jpeg")).toBe("image/png");
  });

  it("falls back to the claimed type, then JPEG", () => {
    expect(imageMimeType(b64(1, 2, 3, 4), "image/tiff")).toBe("image/tiff");
    expect(imageMimeType(b64(1, 2, 3, 4), undefined)).toBe("image/jpeg");
    expect(sniffImageType("")).toBeUndefined();
  });

  it("reads only the head of a large image", () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(3_000_000)]).toString("base64");
    const started = performance.now();
    expect(sniffImageType(big)).toBe("image/png");
    expect(performance.now() - started).toBeLessThan(20);
  });
});
