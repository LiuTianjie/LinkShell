import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";
import { Dialogs } from "../src/components/Dialogs";
import { Runtime } from "../src/live/common";
import { FileView, renameTargetPath } from "../src/live/Files";
import type { Connection } from "../src/live/engine";

describe("File explorer rename & delete helpers and UI", () => {
  it("computes POSIX and Windows sibling rename paths and rejects invalid names", () => {
    expect(renameTargetPath("/Users/dev/app/old.ts", "new.ts")).toBe("/Users/dev/app/new.ts");
    expect(renameTargetPath("/Users/dev/app/dir/", "renamed-dir")).toBe("/Users/dev/app/renamed-dir");
    expect(renameTargetPath("C:\\work\\repo\\a.txt", " b.txt ")).toBe("C:\\work\\repo\\b.txt");
    expect(renameTargetPath("/file.txt", "next.txt")).toBe("/next.txt");

    expect(() => renameTargetPath("/a/b", "")).toThrow("有效");
    expect(() => renameTargetPath("/a/b", ".")).toThrow("有效");
    expect(() => renameTargetPath("/a/b", "..")).toThrow("有效");
    expect(() => renameTargetPath("/a/b", "sub/name")).toThrow("斜杠");
    expect(() => renameTargetPath("/a/b", "sub\\name")).toThrow("斜杠");
    expect(() => renameTargetPath("/a/b", "a".repeat(256))).toThrow("255");
  });

  it("renders rename and delete action buttons on FileView when handlers are provided", () => {
    const connection = {
      store: createStore(() => ({ status: "online" })),
      link: { call: vi.fn() },
    } as unknown as Connection;

    const markup = renderToStaticMarkup(
      createElement(
        Dialogs,
        null,
        createElement(
          Runtime.Provider,
          { value: connection },
          createElement(FileView, {
            path: "/work/app/README.md",
            onRenamed: () => {},
            onDeleted: () => {},
          }),
        ),
      ),
    );

    expect(markup).toContain("README.md");
    expect(markup).toContain('aria-label="重命名文件"');
    expect(markup).toContain('aria-label="删除文件"');
  });
});
