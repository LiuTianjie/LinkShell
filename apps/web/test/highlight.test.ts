import { describe, expect, it } from "vitest";
import { grammarFor, grammarForPath, worthHighlighting } from "../src/live/highlight";
import { loadableGrammars, tokenize } from "../src/live/highlight-engine";

describe("grammarFor", () => {
  it("resolves fence names and aliases", () => {
    expect(grammarFor("ts")).toBe("typescript");
    expect(grammarFor("TSX")).toBe("tsx");
    expect(grammarFor("shell")).toBe("bash");
    expect(grammarFor("c++")).toBe("cpp");
    expect(grammarFor("py")).toBe("python");
  });

  it("leaves unknown and missing languages plain", () => {
    expect(grammarFor(undefined)).toBeUndefined();
    expect(grammarFor("text")).toBeUndefined();
    expect(grammarFor("brainfuck")).toBeUndefined();
  });

  it("knows only grammars the engine can load", () => {
    const loadable = new Set(loadableGrammars);
    for (const name of loadableGrammars) expect(grammarFor(name)).toBe(name);
    for (const fence of ["ts", "js", "sh", "yml", "rs", "kt", "objc", "cs", "tf", "ps1", "svg", "patch", "json5"]) {
      expect(loadable.has(grammarFor(fence)!)).toBe(true);
    }
  });
});

describe("grammarForPath", () => {
  it("reads extensions and well-known names", () => {
    expect(grammarForPath("/repo/src/App.tsx")).toBe("tsx");
    expect(grammarForPath("apps/mac/Package.swift")).toBe("swift");
    expect(grammarForPath("/repo/Dockerfile")).toBe("dockerfile");
    expect(grammarForPath("Makefile")).toBe("makefile");
    expect(grammarForPath("README")).toBeUndefined();
    expect(grammarForPath(".gitignore")).toBeUndefined();
  });
});

describe("worthHighlighting", () => {
  it("skips very long code", () => {
    expect(worthHighlighting("const a = 1;")).toBe(true);
    expect(worthHighlighting("x\n".repeat(2500))).toBe(false);
    expect(worthHighlighting("x".repeat(70_000))).toBe(false);
  });
});

describe("tokenize", () => {
  it("colours with the theme's variables and keeps the text", async () => {
    const code = 'const greeting = "hi";\n// done\nexport function run() {}';
    const lines = await tokenize(code, "typescript");
    expect(lines.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(code);
    const colors = new Set(lines.flat().map((token) => token.color).filter(Boolean));
    expect(colors).toContain("var(--code-token-keyword)");
    expect(colors).toContain("var(--code-token-string-expression)");
    expect(colors).toContain("var(--code-token-comment)");
    // Text the grammar doesn't colour carries no colour of its own.
    expect([...colors].every((color) => color!.startsWith("var(--code-token-"))).toBe(true);
  });

  it("loads each grammar once and on demand", async () => {
    const [a, b] = await Promise.all([tokenize("fn main() {}", "rust"), tokenize("let x = 1;", "rust")]);
    expect(a[0]!.map((token) => token.content).join("")).toBe("fn main() {}");
    expect(b[0]!.length).toBeGreaterThan(1);
  });
});
