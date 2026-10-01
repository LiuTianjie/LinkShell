import { mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listDirectory, makeDirectory, readFile, uploadFile } from "../src/fs.js";

describe("fs.list", () => {
  it("lists subdirectories, projects first, hidden ones only on request", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-fs-"));
    for (const name of ["zeta", "alpha", ".secret", "app"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "app", "package.json"), "{}");
    writeFileSync(join(root, "file.txt"), "");
    const listed = await listDirectory({ path: root, hidden: false });
    expect(listed.entries.map((e) => [e.name, Boolean(e.project)])).toEqual([
      ["app", true],
      ["alpha", false],
      ["zeta", false],
    ]);
    expect(listed.parent).toBeTruthy();
    expect((await listDirectory({ path: root, hidden: true })).entries.some((e) => e.name === ".secret")).toBe(true);
    await expect(listDirectory({ path: join(root, "missing"), hidden: false })).rejects.toThrow();
  });

  it("reads text, images and refuses binaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-read-"));
    writeFileSync(join(root, "CHANGELOG.md"), "# 0.2.79\n- 修复");
    writeFileSync(join(root, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, "blob.bin"), Buffer.from([1, 0, 2, 0]));
    writeFileSync(join(root, "big.txt"), "x".repeat(100));
    expect(await readFile({ path: join(root, "CHANGELOG.md"), maxBytes: 1000 })).toMatchObject({ kind: "text", text: "# 0.2.79\n- 修复", truncated: false });
    expect(await readFile({ path: join(root, "a.png"), maxBytes: 1000 })).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(await readFile({ path: join(root, "blob.bin"), maxBytes: 1000 })).toMatchObject({ kind: "binary" });
    expect(await readFile({ path: join(root, "big.txt"), maxBytes: 10 })).toMatchObject({ truncated: true, text: "x".repeat(10) });
    await expect(readFile({ path: root, maxBytes: 10 })).rejects.toThrow();
  });

  it("lists a project's files after its directories, when asked", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-files-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "README.md"), "hello");
    writeFileSync(join(root, "a.ts"), "x");
    writeFileSync(join(root, ".env"), "SECRET=1");
    expect((await listDirectory({ path: root, hidden: false })).entries.map((e) => e.name)).toEqual(["docs", "src"]);
    const listing = await listDirectory({ path: root, hidden: false, files: true });
    expect(listing.entries.map((e) => e.name)).toEqual(["docs", "src", "a.ts", "README.md"]);
    expect(listing.entries[3]).toMatchObject({ file: true, size: 5, path: join(root, "README.md") });
    expect(listing.truncated).toBeUndefined();
    expect((await listDirectory({ path: root, hidden: true, files: true })).entries.map((e) => e.name)).toContain(".env");
  });

  it("reads text a part at a time, never splitting a character", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-parts-"));
    const content = "日志".repeat(500) + "end";
    writeFileSync(join(root, "log.txt"), content);
    let text = "";
    let offset = 0;
    let parts = 0;
    for (;;) {
      const part = await readFile({ path: join(root, "log.txt"), offset, maxBytes: 100 });
      expect(part.text).not.toContain("\uFFFD");
      text += part.text;
      parts += 1;
      if (!part.truncated) {
        expect(part.nextOffset).toBeUndefined();
        break;
      }
      offset = part.nextOffset!;
    }
    expect(text).toBe(content);
    expect(parts).toBeGreaterThan(20);
    // A binary file stays binary wherever the part starts.
    writeFileSync(join(root, "blob.bin"), Buffer.concat([Buffer.from([1, 0, 2, 0]), Buffer.from("text after".repeat(100))]));
    expect(await readFile({ path: join(root, "blob.bin"), offset: 500, maxBytes: 100 })).toMatchObject({ kind: "binary" });
  });

  it("refuses files too big to look at on a phone", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-big-"));
    writeFileSync(join(root, "huge.log"), "");
    truncateSync(join(root, "huge.log"), 21 * 1024 * 1024);
    writeFileSync(join(root, "huge.png"), "");
    truncateSync(join(root, "huge.png"), 11 * 1024 * 1024);
    writeFileSync(join(root, "ok.log"), "");
    truncateSync(join(root, "ok.log"), 3 * 1024 * 1024);
    await expect(readFile({ path: join(root, "huge.log"), maxBytes: 1000 })).rejects.toMatchObject({ appCode: "too_large", message: expect.stringContaining("21 MB") });
    await expect(readFile({ path: join(root, "huge.png"), maxBytes: 1000 })).rejects.toMatchObject({ appCode: "too_large" });
    // Within the limit: the listing shows its size, reading it returns one part.
    expect(await readFile({ path: join(root, "ok.log"), maxBytes: 1000 })).toMatchObject({ kind: "binary", size: 3 * 1024 * 1024 });
  });

  it("saves uploads without overwriting, and makes folders", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-up-"));
    const data = Buffer.from("hello").toString("base64");
    const first = await uploadFile({ dir: root, name: "photo.jpg", data });
    const second = await uploadFile({ dir: root, name: "photo.jpg", data: Buffer.from("again").toString("base64") });
    expect(first).toEqual({ path: join(root, "photo.jpg"), size: 5 });
    expect(second.path).toBe(join(root, "photo 2.jpg"));
    expect(readFileSync(first.path, "utf8")).toBe("hello");
    // A name can't climb out of the directory.
    expect((await uploadFile({ dir: root, name: "../escape.txt", data })).path).toBe(join(root, ".._escape.txt"));
    await expect(uploadFile({ dir: join(root, "missing"), name: "a", data })).rejects.toThrow(/no such directory/);

    expect(await makeDirectory({ parent: root, name: "assets" })).toEqual({ path: join(root, "assets") });
    await expect(makeDirectory({ parent: root, name: "assets" })).rejects.toThrow(/already exists/);
    await expect(makeDirectory({ parent: root, name: ".." })).rejects.toThrow(/invalid name/);
  });
});
