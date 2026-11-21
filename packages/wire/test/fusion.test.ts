import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FUSION_DIRECTION,
  FUSION_FILE_CLIPBOARD_CHUNK_BYTES,
  FUSION_MAX_CLIPBOARD,
  FUSION_MAX_FILE_CLIPBOARD,
  FUSION_MAX_FRAME,
  fusionMessageSchema,
  fusionStartResultSchema,
} from "../src/index.js";

// The same files are read by apps/mac/Tests/LinkShellTests/FusionProtocolTests.swift.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/fusion/${name}`, import.meta.url), "utf8")) as unknown[];

describe("fusion protocol fixtures", () => {
  const valid = fixture("messages.json");

  it("accepts every message in messages.json", () => {
    for (const message of valid) {
      const parsed = fusionMessageSchema.safeParse(message);
      expect(parsed.success, JSON.stringify(message)).toBe(true);
    }
  });

  it("has at least one fixture for every message type, and a direction for each", () => {
    const seen = new Set(valid.map((m) => (m as { t: string }).t));
    for (const type of Object.keys(FUSION_DIRECTION)) expect(seen.has(type), type).toBe(true);
    for (const type of seen) expect(FUSION_DIRECTION, type).toHaveProperty(type);
  });

  it("rejects every message in invalid.json", () => {
    for (const entry of fixture("invalid.json") as Array<{ why: string; message: unknown }>) {
      expect(fusionMessageSchema.safeParse(entry.message).success, entry.why).toBe(false);
    }
  });

  it("fits the largest clipboard in one frame after base64", () => {
    // text + rtf + png share the raw budget; base64 is 4/3 plus JSON overhead.
    expect(Math.ceil(FUSION_MAX_CLIPBOARD / 3) * 4 + 4096).toBeLessThan(FUSION_MAX_FRAME);
    expect(Math.ceil(FUSION_FILE_CLIPBOARD_CHUNK_BYTES / 3) * 4 + 4096).toBeLessThan(FUSION_MAX_FRAME);
    expect(FUSION_MAX_FILE_CLIPBOARD).toBe(50 << 20);
  });

  it("requires the remote's protocol and platform from fusion.start", () => {
    expect(fusionStartResultSchema.safeParse({ port: 47391, token: "t", hosts: [] }).success).toBe(false);
    expect(fusionStartResultSchema.safeParse({ port: 47391, token: "t", hosts: ["192.168.1.2"], proto: 2, platform: "macos" }).success).toBe(true);
  });
});
