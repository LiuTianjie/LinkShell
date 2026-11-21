import { describe, expect, it } from "vitest";
import {
  deleteConfirmCopy,
  isSameOrChildPath,
  renameTargetPath,
  rewritePathPrefix,
  validateFileName,
} from "../src/lib/file-actions";

describe("file rename & delete path helpers", () => {
  it("validates file names cleanly", () => {
    expect(validateFileName("  app.tsx  ", "old.tsx")).toEqual({ ok: true, name: "app.tsx" });
    expect(validateFileName("", "old.tsx").ok).toBe(false);
    expect(validateFileName("   ", "old.tsx").ok).toBe(false);
    expect(validateFileName(".", "old.tsx").ok).toBe(false);
    expect(validateFileName("..", "old.tsx").ok).toBe(false);
    expect(validateFileName("dir/name.ts", "old.tsx").ok).toBe(false);
    expect(validateFileName("dir\\name.ts", "old.tsx").ok).toBe(false);
    expect(validateFileName("same.tsx", "same.tsx").ok).toBe(false);
    expect(validateFileName("a".repeat(256), "old.tsx").ok).toBe(false);
  });

  it("computes rename target paths for POSIX, Windows, root, and bare filenames", () => {
    expect(renameTargetPath("/Users/dev/project/old.ts", "new.ts")).toEqual({
      ok: true,
      path: "/Users/dev/project/new.ts",
      name: "new.ts",
    });
    expect(renameTargetPath("/Users/dev/folder/", "renamed-folder")).toEqual({
      ok: true,
      path: "/Users/dev/renamed-folder",
      name: "renamed-folder",
    });
    expect(renameTargetPath("/file.txt", "next.txt")).toEqual({
      ok: true,
      path: "/next.txt",
      name: "next.txt",
    });
    expect(renameTargetPath("notes.md", "todo.md")).toEqual({
      ok: true,
      path: "todo.md",
      name: "todo.md",
    });
    expect(renameTargetPath("C:\\repo\\src\\a.ts", "b.ts")).toEqual({
      ok: true,
      path: "C:\\repo\\src\\b.ts",
      name: "b.ts",
    });
    expect(renameTargetPath("/Users/dev/a.ts", "a.ts").ok).toBe(false);
  });

  it("checks child containment and rewrites selected path prefixes without partial-name collisions", () => {
    expect(isSameOrChildPath("/repo/src", "/repo/src")).toBe(true);
    expect(isSameOrChildPath("/repo/src/index.ts", "/repo/src")).toBe(true);
    expect(isSameOrChildPath("/repo/src-extra/index.ts", "/repo/src")).toBe(false);
    expect(isSameOrChildPath(null, "/repo/src")).toBe(false);

    expect(rewritePathPrefix("/repo/src/index.ts", "/repo/src", "/repo/app")).toBe("/repo/app/index.ts");
    expect(rewritePathPrefix("/repo/src", "/repo/src", "/repo/app")).toBe("/repo/app");
    expect(rewritePathPrefix("/repo/src-extra/index.ts", "/repo/src", "/repo/app")).toBe(
      "/repo/src-extra/index.ts",
    );
  });

  it("formats Chinese confirmation copy separately for files and folders", () => {
    expect(deleteConfirmCopy({ name: "secret.ts", isFile: true })).toEqual({
      title: "删除文件？",
      message: "将永久删除「secret.ts」，此操作无法撤销。",
    });
    expect(deleteConfirmCopy({ name: "dist", isFile: false })).toEqual({
      title: "删除文件夹？",
      message: "将删除文件夹「dist」及其中的全部内容，此操作无法撤销。",
    });
  });
});
