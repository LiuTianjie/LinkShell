import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { downloadFile, listDirectory, makeDirectory, readFile, uploadFile, writeTextFile } from "../src/fs.js";

describe("fs.list", () => {
  it("downloads original binary bytes in chunks beyond the preview limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-download-"));
    const path = join(root, "movie.mp4");
    const content = Buffer.from([0, 255, 0x80, 1, 2, 3, 4]);
    writeFileSync(path, content);
    const first = await downloadFile({ path, offset: 0, maxBytes: 3 });
    const second = await downloadFile({ path, offset: first.nextOffset, maxBytes: 10, revision: first.revision });
    expect(Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(second.data, "base64")])).toEqual(content);
    expect(first.done).toBe(false);
    expect(second).toMatchObject({ done: true, size: content.length, nextOffset: content.length, revision: first.revision });
    truncateSync(path, 32 * 1024 * 1024);
    await expect(readFile({ path, maxBytes: 100 })).rejects.toMatchObject({ appCode: "too_large" });
    const tail = await downloadFile({ path, offset: 32 * 1024 * 1024 - 8, maxBytes: 100 });
    expect(Buffer.from(tail.data, "base64")).toEqual(Buffer.alloc(8));
    expect(tail.done).toBe(true);
  });

  it("handles empty downloads and rejects directories, missing files, and changed revisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-download-"));
    const path = join(root, "empty.bin");
    writeFileSync(path, "");
    const empty = await downloadFile({ path, offset: 0, maxBytes: 10 });
    expect(empty).toMatchObject({ size: 0, data: "", nextOffset: 0, done: true });
    writeFileSync(path, "changed");
    await expect(downloadFile({ path, offset: 0, maxBytes: 10, revision: empty.revision })).rejects.toThrow("文件已变化");
    await expect(downloadFile({ path, offset: 100, maxBytes: 10 })).rejects.toThrow("下载位置");
    await expect(downloadFile({ path: root, offset: 0, maxBytes: 10 })).rejects.toThrow();
    await expect(downloadFile({ path: join(root, "missing"), offset: 0, maxBytes: 10 })).rejects.toThrow();
  });

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
    await expect(uploadFile({ dir: join(root, "missing"), name: "a", data })).rejects.toThrow(/找不到文件夹/);

    expect(await makeDirectory({ parent: root, name: "assets" })).toEqual({ path: join(root, "assets") });
    await expect(makeDirectory({ parent: root, name: "assets" })).rejects.toThrow(/已经有同名/);
    await expect(makeDirectory({ parent: root, name: ".." })).rejects.toThrow(/名称无效/);
  });

  it("caps fs.list directory listings at 1000 entries even when files:false", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-many-dirs-"));
    for (let i = 0; i < 1005; i++) {
      mkdirSync(join(root, `dir-${String(i).padStart(4, "0")}`));
    }
    const listed = await listDirectory({ path: root, hidden: false, files: false });
    expect(listed.entries).toHaveLength(1000);
    expect(listed.truncated).toBe(true);
  });

  it("supports chunked uploads via offset + appendPath while blocking offset mismatches and symlink escapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-chunk-up-"));
    const outside = mkdtempSync(join(tmpdir(), "lsh-outside-up-"));
    const secret = join(outside, "secret.bin");
    writeFileSync(secret, "keep");
    symlinkSync(secret, join(root, "sym.bin"));

    const part1 = Buffer.from("Hello, ");
    const part2 = Buffer.from("chunked ");
    const part3 = Buffer.from("world!");

    await expect(
      uploadFile({ dir: root, name: "video.bin", data: part1.toString("base64"), offset: 5 }),
    ).rejects.toMatchObject({ appCode: "invalid_params" });

    const c1 = await uploadFile({ dir: root, name: "video.bin", data: part1.toString("base64"), offset: 0 });
    expect(c1).toEqual({ path: join(root, "video.bin"), size: part1.length });

    // Wrong offset is rejected without corrupting file.
    await expect(
      uploadFile({ dir: root, name: "video.bin", data: part2.toString("base64"), offset: 99, appendPath: c1.path }),
    ).rejects.toMatchObject({ appCode: "invalid_params" });

    const c2 = await uploadFile({
      dir: root,
      name: "video.bin",
      data: part2.toString("base64"),
      offset: c1.size,
      appendPath: c1.path,
    });
    const c3 = await uploadFile({
      dir: root,
      name: "video.bin",
      data: part3.toString("base64"),
      offset: c2.size,
      appendPath: c1.path,
    });
    expect(c3.size).toBe(part1.length + part2.length + part3.length);
    expect(readFileSync(c1.path, "utf8")).toBe("Hello, chunked world!");

    // Path traversal and symlink append targets are rejected.
    await expect(
      uploadFile({ dir: root, name: "secret.bin", data: part1.toString("base64"), offset: 4, appendPath: secret }),
    ).rejects.toMatchObject({ appCode: "invalid_params" });
    await expect(
      uploadFile({ dir: root, name: "sym.bin", data: part1.toString("base64"), offset: 4, appendPath: join(root, "sym.bin") }),
    ).rejects.toMatchObject({ appCode: "invalid_params" });
    expect(readFileSync(secret, "utf8")).toBe("keep");
  });

  it("fs.write saves text atomically, keeps the mode and reports the new revision", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-write-"));
    const path = join(root, "script.sh");
    writeFileSync(path, "echo old\n");
    if (process.platform !== "win32") chmodSync(path, 0o755);
    const before = await readFile({ path, maxBytes: 1000 });
    const saved = await writeTextFile({ path, text: "echo 新\n", expectedModifiedAt: before.modifiedAt });
    expect(readFileSync(path, "utf8")).toBe("echo 新\n");
    expect(saved).toMatchObject({ path, size: Buffer.byteLength("echo 新\n") });
    expect(saved.modifiedAt).toBe(statSync(path).mtimeMs);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(readdirSync(root)).toEqual(["script.sh"]);
    // A new file in an existing folder is fine without a revision.
    await writeTextFile({ path: join(root, "new.txt"), text: "hi" });
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("hi");
  });

  it("fs.write refuses a file changed on disk since it was read", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-write-"));
    const path = join(root, "a.txt");
    writeFileSync(path, "one");
    const read = await readFile({ path, maxBytes: 100 });
    writeFileSync(path, "agent edit");
    const { utimesSync } = await import("node:fs");
    utimesSync(path, new Date(), new Date(read.modifiedAt + 5000));
    await expect(writeTextFile({ path, text: "mine", expectedModifiedAt: read.modifiedAt })).rejects.toMatchObject({ appCode: "conflict" });
    expect(readFileSync(path, "utf8")).toBe("agent edit");
    await expect(writeTextFile({ path: join(root, "gone.txt"), text: "x", expectedModifiedAt: read.modifiedAt })).rejects.toMatchObject({ appCode: "conflict" });
  });

  it("fs.write stays out of missing folders, directories, symlinks and relative paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsh-write-"));
    await expect(writeTextFile({ path: join(root, "missing", "a.txt"), text: "x" })).rejects.toMatchObject({ appCode: "not_found" });
    expect(() => statSync(join(root, "missing"))).toThrow();
    mkdirSync(join(root, "dir"));
    await expect(writeTextFile({ path: join(root, "dir"), text: "x" })).rejects.toMatchObject({ appCode: "invalid_params" });
    await expect(writeTextFile({ path: "relative.txt", text: "x" })).rejects.toMatchObject({ appCode: "invalid_params" });
    if (process.platform !== "win32") {
      const outside = mkdtempSync(join(tmpdir(), "lsh-outside-"));
      writeFileSync(join(outside, "target.txt"), "keep");
      symlinkSync(join(outside, "target.txt"), join(root, "link.txt"));
      await expect(writeTextFile({ path: join(root, "link.txt"), text: "x" })).rejects.toMatchObject({ appCode: "invalid_params" });
      expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("keep");
    }
  });
});
