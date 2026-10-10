import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acpAgentSettingsSchema, type EditSuggestion } from "@linkshell/wire";
import { AcpEditor, applyTextEdits, encodedPosition, positionOffset } from "../src/drivers/acp/editor.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const pos = (character: number, line = 0) => ({ line, character });

describe("ACP editing positions and checked application", () => {
  it("converts UTF-8/16/32 positions without splitting Chinese characters or surrogate pairs", () => {
    const text = "中🙂文\nnext";
    expect(encodedPosition(text, pos(3), "utf-8")).toEqual(pos(7));
    expect(encodedPosition(text, pos(3), "utf-32")).toEqual(pos(2));
    expect(positionOffset(text, pos(7), "utf-8")).toBe(3);
    expect(positionOffset(text, pos(2), "utf-32")).toBe(3);
    expect(() => positionOffset(text, pos(4), "utf-8")).toThrow("字符中间");
    expect(() => positionOffset(text, pos(2), "utf-16")).toThrow("字符中间");
    expect(applyTextEdits("ab", [{ range: { start: pos(0), end: pos(1) }, newText: "A" }, { range: { start: pos(1), end: pos(2) }, newText: "B" }], "utf-16")).toBe("AB");
    expect(() => applyTextEdits("ab", [{ range: { start: pos(0), end: pos(2) }, newText: "A" }, { range: { start: pos(1), end: pos(2) }, newText: "B" }], "utf-16")).toThrow("重叠");
  });

  async function setup() {
    const cwd = await mkdtemp(join(tmpdir(), "linkshell-acp-editor-")), path = join(cwd, "test.ts");
    cleanups.push(() => rm(cwd, { recursive: true, force: true })); await writeFile(path, "中文\nconst a = 1;\n");
    const notices: { method: string; params: unknown }[] = [], requests: { method: string; params: unknown }[] = [];
    let suggestions: EditSuggestion[] = [{ kind: "edit", id: "edit-1", uri: pathToFileURL(path).href, edits: [{ range: { start: pos(0), end: pos(3) }, newText: "英" }] }];
    const editor = new AcpEditor({ settings: () => acpAgentSettingsSchema.parse({}), capabilities: () => ({ nes: { events: { document: { didOpen: {}, didChange: { syncKind: "incremental" }, didSave: {}, didClose: {}, didFocus: {} } }, context: { recentFiles: {}, openFiles: {} } }, positionEncoding: "utf-8" }),
      request: async <T>(method: string, params: unknown): Promise<T> => { requests.push({ method, params }); return (method === "nes/start" ? { sessionId: "native-editor" } : method === "nes/suggest" ? { suggestions } : {}) as T; },
      notify: (method, params) => { notices.push({ method, params }); },
    });
    cleanups.push(() => editor.close());
    const opened = await editor.run({ agent: "test", operation: "open", cwd, path });
    const run = (input: Parameters<AcpEditor["run"]>[0]) => editor.run({ editorId: opened.editorId, ...input });
    return { editor, run, path, cwd, notices, requests, suggestions: (next: EditSuggestion[]) => { suggestions = next; } };
  }

  it("previews before writing, detects changed files, then applies and acknowledges a fresh suggestion", async () => {
    const f = await setup();
    await f.run({ agent: "test", operation: "suggest", position: pos(2) });
    expect(f.requests.find((entry) => entry.method === "nes/suggest")?.params).toMatchObject({ position: pos(6), context: { recentFiles: [{ text: "中文\nconst a = 1;\n" }] } });
    const first = await f.run({ agent: "test", operation: "preview", suggestionId: "edit-1" });
    expect(first.preview?.after).toBe("英文\nconst a = 1;\n");
    expect(await readFile(f.path, "utf8")).toBe("中文\nconst a = 1;\n");
    await writeFile(f.path, "external edit");
    await expect(f.run({ agent: "test", operation: "apply", previewId: first.preview!.id })).rejects.toThrow("已修改");
    expect(await readFile(f.path, "utf8")).toBe("external edit");
    await writeFile(f.path, first.preview!.before);
    await f.run({ agent: "test", operation: "apply", previewId: first.preview!.id });
    expect(await readFile(f.path, "utf8")).toBe(first.preview!.after);
    expect(f.notices.find((entry) => entry.method === "nes/accept")?.params).toEqual({ sessionId: "native-editor", id: "edit-1" });
    expect(f.notices.find((entry) => entry.method === "document/didChange")?.params).toMatchObject({ contentChanges: [{ range: { start: pos(0), end: pos(0, 2) }, text: first.preview!.after }] });
  });

  it("rejects stale suggestions and paths outside the chosen workspace", async () => {
    const f = await setup(); await f.run({ agent: "test", operation: "suggest" });
    await f.run({ agent: "test", operation: "save", text: "changed" });
    await expect(f.run({ agent: "test", operation: "preview", suggestionId: "edit-1" })).rejects.toThrow("已失效");
    f.suggestions([{ kind: "jump", id: "escape", uri: pathToFileURL(join(f.cwd, "..", "outside.txt")).href, position: pos(0) }]);
    await f.run({ agent: "test", operation: "suggest" });
    await expect(f.run({ agent: "test", operation: "preview", suggestionId: "escape" })).rejects.toThrow("工作目录");
    await f.run({ agent: "test", operation: "reject", suggestionId: "escape" });
    expect(f.notices.at(-1)).toMatchObject({ method: "nes/reject", params: { id: "escape", reason: "rejected" } });
  });
});
