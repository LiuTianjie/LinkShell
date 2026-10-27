import { describe, expect, it } from "vitest";
import { diffLines, diffStat, hunks, parsePatch } from "../src/live/line-diff";

const render = (before: string, after: string) =>
  diffLines(before, after).map((line) => (line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ") + line.text);

describe("diffLines", () => {
  it("finds a changed line in the middle", () => {
    expect(render("a\nb\nc", "a\nB\nc")).toEqual([" a", "-b", "+B", " c"]);
  });
  it("keeps moved-around context as kept lines", () => {
    expect(render("a\nb\nc\nd", "a\nc\nd\ne")).toEqual([" a", "-b", " c", " d", "+e"]);
  });
  it("treats a new file as all added and an emptied one as all removed", () => {
    expect(render("", "x\ny")).toEqual(["+x", "+y"]);
    expect(render("x\ny", "")).toEqual(["-x", "-y"]);
  });
  it("numbers lines on both sides", () => {
    const lines = diffLines("a\nb\nc", "a\nx\nb\nc");
    expect(lines.find((line) => line.kind === "add")).toMatchObject({ text: "x", new: 2 });
    expect(lines.at(-1)).toMatchObject({ text: "c", old: 3, new: 4 });
  });
  it("counts what changed", () => {
    expect(diffStat(diffLines("a\nb\nc", "a\nB\nc\nd"))).toEqual({ added: 2, removed: 1 });
  });
  it("ignores a trailing newline", () => {
    expect(render("a\n", "a")).toEqual([" a"]);
  });
});

describe("hunks", () => {
  it("keeps three lines around each change and counts what it leaves out", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "L10");
    const result = hunks(diffLines(before, after));
    expect(result).toHaveLength(1);
    expect(result[0]!.skipped).toBe(7);
    expect(result[0]!.lines.map((line) => line.text)).toEqual(["l7", "l8", "l9", "l10", "L10", "l11", "l12", "l13"]);
  });
  it("splits far apart changes", () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l5", "L5").replace("l30", "L30");
    expect(hunks(diffLines(before, after))).toHaveLength(2);
  });
});

describe("parsePatch", () => {
  it("reads a unified diff's numbers from its hunk header", () => {
    const lines = parsePatch("--- a/x\n+++ b/x\n@@ -10,3 +10,3 @@\n keep\n-old\n+new\n keep");
    expect(lines).toEqual([
      { kind: "same", text: "keep", old: 10, new: 10 },
      { kind: "del", text: "old", old: 11 },
      { kind: "add", text: "new", new: 11 },
      { kind: "same", text: "keep", old: 12, new: 12 },
    ]);
  });
});
