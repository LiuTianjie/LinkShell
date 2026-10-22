import { describe, expect, it } from "vitest";
import { parseParents } from "../src/drivers/claude/holders.js";

describe("Windows process parents", () => {
  it("reads PowerShell's pid/ppid lines, CRLF and blanks included", () => {
    const parents = parseParents("4 0\r\n\r\n812 4\r\n  9120 812 \r\nnot a line\r\n");
    expect([...parents]).toEqual([[4, 0], [812, 4], [9120, 812]]);
  });
});
