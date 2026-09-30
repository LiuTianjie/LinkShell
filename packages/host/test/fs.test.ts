import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
