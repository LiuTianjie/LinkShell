import type { MethodResult } from "@linkshell/wire";

type FileResult = MethodResult<"fs.read">;

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const divisor = bytes < 1024 * 1024 ? 1024 : 1024 * 1024;
  return `${(bytes / divisor).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ${divisor === 1024 ? "KB" : "MB"}`;
}

/** Never join chunks from two different versions of a file. */
export function appendFileChunk(
  file: FileResult,
  chunk: FileResult,
): FileResult {
  if (
    file.kind !== "text" ||
    chunk.kind !== "text" ||
    chunk.path !== file.path ||
    chunk.size !== file.size ||
    chunk.modifiedAt !== file.modifiedAt ||
    file.nextOffset === undefined ||
    (chunk.nextOffset !== undefined && chunk.nextOffset <= file.nextOffset)
  )
    throw new Error("文件内容已变化，请重新打开文件");
  return { ...chunk, text: (file.text ?? "") + (chunk.text ?? "") };
}

/** Highlight a line without creating one DOM element per line of a large file. */
export function splitFileAtLine(text: string, line: number) {
  if (!Number.isInteger(line) || line < 1) return undefined;
  let start = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf("\n", start);
    if (next === -1) return undefined;
    start = next + 1;
  }
  const newline = text.indexOf("\n", start);
  const end = newline === -1 ? text.length : newline + 1;
  return {
    before: text.slice(0, start),
    target: text.slice(start, end),
    after: text.slice(end),
  };
}

/** A line link must load enough bytes to reach the requested line before scrolling. */
export async function readFileAtLine(
  read: (offset?: number) => Promise<FileResult>,
  line?: number,
): Promise<FileResult> {
  let file = await read();
  let lines = file.text?.split("\n").length ?? 0;
  while (
    file.kind === "text" &&
    line &&
    lines <= line &&
    file.nextOffset !== undefined
  ) {
    const chunk = await read(file.nextOffset);
    lines += (chunk.text?.split("\n").length ?? 1) - 1;
    file = appendFileChunk(file, chunk);
  }
  return file;
}
