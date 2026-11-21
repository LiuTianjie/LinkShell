import { chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FUSION_MAX_FILE_CLIPBOARD } from "@linkshell/wire";
import type { FusionClip } from "../src/fusion/platform.js";
import { normalizeClipFiles, WindowsFusionPlatform, type FusionCursorShape } from "../src/fusion/windows.js";

describe("Windows Fusion file-clipboard & cursor shape", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

  it("filters directories and enforces the 50 MiB FUSION_MAX_FILE_CLIPBOARD limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "linkshell-win-clip-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const sub = join(dir, "folder");
    mkdirSync(sub);
    const small = join(dir, "hello.txt");
    writeFileSync(small, "hello");
    const bigA = join(dir, "big-a.bin");
    const bigB = join(dir, "big-b.bin");
    writeFileSync(bigA, "");
    writeFileSync(bigB, "");
    truncateSync(bigA, 30 << 20);
    truncateSync(bigB, 25 << 20);

    expect(normalizeClipFiles([sub, small, ""])).toEqual([small]);
    expect(normalizeClipFiles([sub])).toBeUndefined();
    expect(normalizeClipFiles([bigA, bigB])).toBeUndefined();
    expect(FUSION_MAX_FILE_CLIPBOARD).toBe(50 << 20);
  });

  it("advertises file-clipboard, exchanges file lists via helper stdin/stdout, and emits cursor shapes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "linkshell-win-fusion-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const sampleFile = join(dir, "report.pdf");
    writeFileSync(sampleFile, "%PDF-1.4");
    const oversized = join(dir, "huge.bin");
    writeFileSync(oversized, "");
    truncateSync(oversized, (50 << 20) + 1);

    const helperScript = join(dir, "fake-helper.mjs");
    writeFileSync(helperScript, `#!${process.execPath}
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.t === "clip" && Array.isArray(msg.files)) {
    process.stdout.write(JSON.stringify({ t: "clip", files: msg.files }) + "\\n");
  }
});
process.stdout.write(JSON.stringify({
  t: "shape", id: "win-arrow-1", png: "AAAA", w: 32, h: 32, hotX: 1, hotY: 1, scale: 1.5, displayW: 1706.67, displayH: 960
}) + "\\n");
process.stdout.write(JSON.stringify({
  t: "shape", id: "win-ibeam-2", png: "BBBB", w: 16, h: 32, hotX: 8, hotY: 16, scale: 1.5, displayW: 1706.67, displayH: 960
}) + "\\n");
process.stdout.write(JSON.stringify({ t: "shape", id: "win-arrow-1" }) + "\\n");
`);
    chmodSync(helperScript, 0o755);

    const platform = new WindowsFusionPlatform(helperScript, "ffmpeg");
    cleanups.push(() => platform.stop());

    expect(platform.features).toContain("clipboard");
    expect(platform.features).toContain("file-clipboard");

    const clips: FusionClip[] = [];
    const shapes: FusionCursorShape[] = [];
    platform.watchClipboard(clip => clips.push(clip));
    platform.watchShape(shape => shapes.push(shape));
    platform.watch(() => {});

    await vi.waitFor(() => expect(shapes).toHaveLength(3), { timeout: 5_000 });
    expect(shapes[0]).toMatchObject({ id: "win-arrow-1", png: "AAAA", w: 32, h: 32, scale: 1.5 });
    expect(shapes[1]).toMatchObject({ id: "win-ibeam-2", png: "BBBB" });
    expect(shapes[2]).toEqual({ id: "win-arrow-1" });
    expect(platform.shape("win-arrow-1")?.png).toBe("AAAA");

    // Oversized file list is rejected before writing to helper.
    platform.setClipboard({ files: [oversized] });
    platform.setClipboard({ files: [dir] });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(clips).toHaveLength(0);

    // Valid file list round-trips via helper into FusionClip.files.
    platform.setClipboard({ files: [sampleFile] });
    await vi.waitFor(() => expect(clips).toHaveLength(1), { timeout: 5_000 });
    expect(clips[0]).toEqual({ files: [sampleFile] });
  });
});
