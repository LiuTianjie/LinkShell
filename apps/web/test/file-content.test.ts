import { expect, it, vi } from "vitest";
import {
  readFileAtLine,
  splitFileAtLine,
  formatFileSize,
} from "../src/live/file-content";
import type { MethodResult } from "@linkshell/wire";

const page = (text: string, nextOffset?: number): MethodResult<"fs.read"> => ({
  kind: "text",
  path: "/test.txt",
  size: 100,
  text,
  nextOffset,
  truncated: nextOffset !== undefined,
});

it("loads a line beyond the first chunk and carries the final truncation status", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(page("one\ntw", 6))
    .mockResolvedValueOnce(page("o\nthree"));
  expect(await readFileAtLine(read, 3)).toMatchObject({
    text: "one\ntwo\nthree",
    truncated: false,
    nextOffset: undefined,
  });
  expect(read.mock.calls).toEqual([[], [6]]);
});

it("finishes the target line across a byte boundary without reading the rest of the file", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(page("one\ntw", 6))
    .mockResolvedValueOnce(page("o\nthree", 13));
  expect(await readFileAtLine(read, 2)).toMatchObject({
    text: "one\ntwo\nthree",
    truncated: true,
    nextOffset: 13,
  });
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps ordinary file opens paged and reports read failures for line links", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(page("one\n", 4))
    .mockRejectedValueOnce(new Error("disconnected"));
  expect(await readFileAtLine(read)).toMatchObject({ nextOffset: 4 });
  await expect(readFileAtLine(read, 10)).rejects.toThrow("disconnected");
});

it("stops if the file stops advancing", async () => {
  const read = vi.fn().mockResolvedValue(page("one", 3));
  await expect(readFileAtLine(read, 10)).rejects.toThrow("文件内容已变化");
});

it("refuses to combine chunks after an external file edit", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ ...page("one\n", 4), modifiedAt: 100 })
    .mockResolvedValueOnce({ ...page("two"), modifiedAt: 101 });
  await expect(readFileAtLine(read, 3)).rejects.toThrow("文件内容已变化");
});

it("splits only around a requested line and handles empty and missing lines", () => {
  expect(splitFileAtLine("one\ntwo\nthree", 2)).toEqual({
    before: "one\n",
    target: "two\n",
    after: "three",
  });
  expect(splitFileAtLine("one\n", 2)).toEqual({
    before: "one\n",
    target: "",
    after: "",
  });
  expect(splitFileAtLine("one", 2)).toBeUndefined();
  expect(splitFileAtLine("one", 0)).toBeUndefined();
});

it("formats empty and small file sizes without rounding them up to one KB", () => {
  expect(formatFileSize(0)).toBe("0 B");
  expect(formatFileSize(12)).toBe("12 B");
  expect(formatFileSize(1536)).toBe("1.5 KB");
});
