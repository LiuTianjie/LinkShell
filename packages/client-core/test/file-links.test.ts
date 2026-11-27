import { describe, expect, it, vi } from "vitest";
import {
  HostImageCache,
  isImagePath,
  isImageResource,
  normalizeMarkdownForDisplay,
  parentDirectory,
  parseFileLink,
  splitMarkdownImages,
} from "../src/file-links.js";

describe("parseFileLink", () => {
  it("resolves Windows file:// URLs with non-line HTML fragments and queries", () => {
    expect(
      parseFileLink("file:///D:/DEV/xian/_artifacts/attack-effects-v82.html#weapons-001"),
    ).toEqual({
      path: "D:/DEV/xian/_artifacts/attack-effects-v82.html",
    });
    expect(
      parseFileLink("file:///D:/DEV/xian/_artifacts/attack-effects-v82.html?v=2#weapons-001"),
    ).toEqual({
      path: "D:/DEV/xian/_artifacts/attack-effects-v82.html",
    });
    expect(
      parseFileLink("file://localhost/D:/DEV/xian/_artifacts/demo.gif"),
    ).toEqual({
      path: "D:/DEV/xian/_artifacts/demo.gif",
    });
    expect(
      parseFileLink("/D:/DEV/xian/_artifacts/attack-effects-v82.html#weapons-001"),
    ).toEqual({
      path: "D:/DEV/xian/_artifacts/attack-effects-v82.html",
    });
    expect(
      parseFileLink("D:\\DEV\\xian\\_artifacts\\attack-effects-v82.html#weapons-001"),
    ).toEqual({
      path: "D:\\DEV\\xian\\_artifacts\\attack-effects-v82.html",
    });
    expect(
      parseFileLink("file://server/share/effects/slash.gif"),
    ).toEqual({
      path: "\\\\server\\share\\effects\\slash.gif",
    });
  });

  it("preserves line anchors, percent-encoded characters, and `#` inside directory names", () => {
    expect(parseFileLink("file:///C:/Users/dev/a.ts#L12-L20")).toEqual({
      path: "C:/Users/dev/a.ts",
      line: 12,
      endLine: 20,
    });
    expect(parseFileLink("file:///project/my%20file.ts:3:8")).toEqual({
      path: "/project/my file.ts",
      line: 3,
    });
    expect(parseFileLink("file:///D:/DEV/c%23/app.cs#L10")).toEqual({
      path: "D:/DEV/c#/app.cs",
      line: 10,
    });
    expect(parseFileLink("/repo/c#/app.cs")).toEqual({
      path: "/repo/c#/app.cs",
    });
    expect(parseFileLink("vscode://file/c%3A/Users/dev/a.ts:9")).toEqual({
      path: "c:/Users/dev/a.ts",
      line: 9,
    });
  });

  it("joins relative paths against Windows and POSIX base directories", () => {
    expect(parseFileLink(".\\_artifacts\\slash.gif", "D:\\DEV\\xian")).toEqual({
      path: "D:\\DEV\\xian\\_artifacts\\slash.gif",
    });
    expect(parseFileLink("_artifacts/slash.gif?v=1", "D:\\DEV\\xian\\")).toEqual({
      path: "D:\\DEV\\xian\\_artifacts\\slash.gif",
    });
    expect(parseFileLink("docs/guide.md#install", "/Users/dev/app")).toEqual({
      path: "/Users/dev/app/docs/guide.md",
    });
    expect(parseFileLink("src/a.ts#L42")).toBeUndefined();
    expect(parseFileLink("scripts\\build", undefined, { allowRelativeWithoutBase: true })).toEqual({
      path: "scripts\\build",
    });
  });

  it("rejects web URLs, pure anchors, and executable or data schemes", () => {
    for (const value of [
      "",
      "#weapons-001",
      "https://example.com/demo.gif",
      "http://localhost:3000/a.html",
      "mailto:a@b.com",
      "tel:123",
      "sms:123",
      "data:image/gif;base64,R0lGODlh",
      "javascript:alert(1)",
      "linkshell://pair?code=123456",
    ]) {
      expect(parseFileLink(value, "D:\\DEV\\xian")).toBeUndefined();
    }
  });
});

describe("path & image helpers", () => {
  it("recognizes image extensions and MIME types", () => {
    expect(isImagePath("D:\\DEV\\xian\\_artifacts\\slash.gif?v=1#top")).toBe(true);
    expect(isImagePath("/tmp/preview.WEBP")).toBe(true);
    expect(isImagePath("/tmp/attack-effects-v82.html")).toBe(false);
    expect(isImageResource("/tmp/blob", "image/gif")).toBe(true);
    expect(isImageResource("file:///D:/a.gif")).toBe(true);
    expect(isImageResource("file:///D:/a.html", "text/html")).toBe(false);
  });

  it("computes parent directories for POSIX and Windows paths", () => {
    expect(parentDirectory("D:\\DEV\\xian\\_artifacts\\attack-effects-v82.html")).toBe("D:\\DEV\\xian\\_artifacts");
    expect(parentDirectory("D:\\attack-effects-v82.html")).toBe("D:\\");
    expect(parentDirectory("D:/DEV/xian/_artifacts/attack-effects-v82.html")).toBe("D:/DEV/xian/_artifacts");
    expect(parentDirectory("/Users/dev/app/README.md")).toBe("/Users/dev/app");
    expect(parentDirectory("/README.md")).toBe("/");
  });
});

describe("splitMarkdownImages", () => {
  it("returns markdown untouched when no image syntax is present", () => {
    const text = "普通文本 [链接](file:///D:/DEV/xian/index.html#weapons-001)";
    expect(splitMarkdownImages(text)).toEqual([{ kind: "markdown", text }]);
  });

  it("extracts standalone, inline, linked, Windows-path, and HTML images", () => {
    const md = [
      "效果预览：",
      "![剑气特效](file:///D:/DEV/xian/_artifacts/slash.gif)",
      "Windows 路径：![火球](D:\\DEV\\xian\\_artifacts\\fire.gif \"火球\")",
      "带空格：![冰霜](<file:///D:/DEV/my dir/ice.gif>)",
      "嵌套链接：[![雷电](https://example.com/bolt.gif)](https://example.com/bolt.gif)",
      '<img src="/tmp/demo.gif" alt="HTML动图" />',
    ].join("\n\n");

    expect(splitMarkdownImages(md)).toEqual([
      { kind: "markdown", text: "效果预览：" },
      { kind: "image", url: "file:///D:/DEV/xian/_artifacts/slash.gif", alt: "剑气特效" },
      { kind: "markdown", text: "Windows 路径：" },
      { kind: "image", url: "D:\\DEV\\xian\\_artifacts\\fire.gif", alt: "火球" },
      { kind: "markdown", text: "带空格：" },
      { kind: "image", url: "file:///D:/DEV/my dir/ice.gif", alt: "冰霜" },
      { kind: "markdown", text: "嵌套链接：" },
      { kind: "image", url: "https://example.com/bolt.gif", alt: "雷电" },
      { kind: "image", url: "/tmp/demo.gif", alt: "HTML动图" },
    ]);
  });

  it("does not extract images inside fenced code blocks or inline code spans", () => {
    const md = [
      "行内代码：`![not-an-image](file:///D:/a.gif)`",
      "```markdown",
      "![fenced](file:///D:/b.gif)",
      "<img src=\"/tmp/c.gif\" />",
      "```",
      "真实图片：![real](file:///D:/real.gif)",
    ].join("\n");

    expect(splitMarkdownImages(md)).toEqual([
      {
        kind: "markdown",
        text: [
          "行内代码：`![not-an-image](file:///D:/a.gif)`",
          "```markdown",
          "![fenced](file:///D:/b.gif)",
          "<img src=\"/tmp/c.gif\" />",
          "```",
          "真实图片：",
        ].join("\n"),
      },
      { kind: "image", url: "file:///D:/real.gif", alt: "real" },
    ]);
  });

  it("keeps GFM tables intact and defers table images right below the table", () => {
    const md = [
      "| 技能 | 效果 |",
      "| --- | --- |",
      "| 剑气 | ![剑气](file:///D:/slash.gif) |",
      "",
      "总结完成。",
    ].join("\n");

    expect(splitMarkdownImages(md)).toEqual([
      {
        kind: "markdown",
        text: ["| 技能 | 效果 |", "| --- | --- |", "| 剑气 | 剑气 |"].join("\n"),
      },
      { kind: "image", url: "file:///D:/slash.gif", alt: "剑气" },
      { kind: "markdown", text: "总结完成。" },
    ]);
  });
});

describe("normalizeMarkdownForDisplay", () => {
  it("converts Windows backslash link/image destinations and raw HTML img tags without touching code", () => {
    const input = [
      "链接：[效果页](D:\\DEV\\xian\\_artifacts\\attack-effects-v82.html#weapons-001)",
      "图片：![剑气](D:\\DEV\\xian\\_artifacts\\slash.gif)",
      'HTML：<img src="D:\\DEV\\xian\\_artifacts\\fire.gif" alt="火焰" width="320" />',
      "行内代码：`![code](D:\\DEV\\xian\\_artifacts\\a.gif)`",
      "```md",
      '<img src="D:\\DEV\\xian\\_artifacts\\code.gif" />',
      "[raw](D:\\DEV\\xian\\_artifacts\\raw.html)",
      "```",
    ].join("\n");

    expect(normalizeMarkdownForDisplay(input)).toBe(
      [
        "链接：[效果页](D:/DEV/xian/_artifacts/attack-effects-v82.html#weapons-001)",
        "图片：![剑气](D:/DEV/xian/_artifacts/slash.gif)",
        "HTML：![火焰](D:/DEV/xian/_artifacts/fire.gif)",
        "行内代码：`![code](D:\\DEV\\xian\\_artifacts\\a.gif)`",
        "```md",
        '<img src="D:\\DEV\\xian\\_artifacts\\code.gif" />',
        "[raw](D:\\DEV\\xian\\_artifacts\\raw.html)",
        "```",
      ].join("\n"),
    );
  });
});

describe("HostImageCache", () => {
  it("deduplicates concurrent loads, caches GIF data URIs, and retries after failures", async () => {
    const cache = new HostImageCache(200);
    const call = vi
      .fn()
      .mockResolvedValueOnce({ kind: "image" as const, mimeType: "image/gif", data: "R0lGODlhAQABAAAAACw=" });
    const reader = { call };

    const [a, b] = await Promise.all([
      cache.load("k1", reader, "D:/DEV/slash.gif"),
      cache.load("k1", reader, "D:/DEV/slash.gif"),
    ]);
    expect(a).toBe("data:image/gif;base64,R0lGODlhAQABAAAAACw=");
    expect(b).toBe(a);
    expect(call).toHaveBeenCalledTimes(1);
    expect(cache.peek("k1")).toBe(a);

    call.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({
      kind: "image" as const,
      mimeType: "image/gif",
      data: "R0lGODlh",
    });
    await expect(cache.load("k2", reader, "D:/DEV/retry.gif")).rejects.toThrow("boom");
    expect(cache.peek("k2")).toBeUndefined();
    await expect(cache.load("k2", reader, "D:/DEV/retry.gif")).resolves.toBe("data:image/gif;base64,R0lGODlh");
  });
});
