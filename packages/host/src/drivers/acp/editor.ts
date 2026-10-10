import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { editSuggestionSchema, RpcError, type AcpAgentSettings, type EditorRequest, type EditorResult, type EditSuggestion, type TextPosition } from "@linkshell/wire";
import type { AcpAgentCapabilities } from "./connection.js";
import { scopedPath, type AcpScope } from "./client-services.js";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const invalid = (message: string) => RpcError.app("invalid_params", message);
type Encoding = "utf-8" | "utf-16" | "utf-32";
const LIMIT = 256 * 1024;

/** ACP's offsets count encoded code points, not JavaScript string indices. */
export function positionOffset(text: string, position: TextPosition, encoding: Encoding): number {
  if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0) throw invalid("光标位置无效");
  const lines = text.split("\n");
  const raw = lines[position.line]; if (raw === undefined) throw invalid("编辑建议的行号超出了文件");
  const line = raw.replace(/\r$/, "");
  let units = 0, offset = 0;
  for (const char of line) {
    if (units === position.character) break;
    units += encoding === "utf-8" ? Buffer.byteLength(char) : encoding === "utf-32" ? 1 : char.length;
    offset += char.length;
  }
  if (units !== position.character) throw invalid("编辑建议的位置超出了文本或落在字符中间");
  return lines.slice(0, position.line).reduce((length, value) => length + value.length + 1, 0) + offset;
}

export function encodedPosition(text: string, position: TextPosition, encoding: Encoding): TextPosition {
  positionOffset(text, position, "utf-16");
  const prefix = text.split("\n")[position.line]!.slice(0, position.character);
  return { line: position.line, character: encoding === "utf-8" ? Buffer.byteLength(prefix) : encoding === "utf-32" ? [...prefix].length : prefix.length };
}

function utf16Position(text: string, position: TextPosition, encoding: Encoding): TextPosition {
  const offset = positionOffset(text, position, encoding), prefix = text.slice(0, offset);
  return { line: position.line, character: prefix.length - (prefix.lastIndexOf("\n") + 1) };
}

export function applyTextEdits(text: string, edits: Extract<EditSuggestion, { kind: "edit" }>["edits"], encoding: Encoding): string {
  const ranges = edits.map((edit) => ({ start: positionOffset(text, edit.range.start, encoding), end: positionOffset(text, edit.range.end, encoding), text: edit.newText })).sort((a, b) => b.start - a.start || b.end - a.end);
  let boundary = text.length + 1;
  for (const edit of ranges) {
    if (edit.start > edit.end || edit.end > boundary) throw invalid("编辑建议包含相互重叠的范围");
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end); boundary = edit.start;
  }
  return text;
}

/** Agent-provided regexes run outside the host event loop, with a bounded lifetime. */
async function replaceText(text: string, suggestion: Extract<EditSuggestion, { kind: "searchAndReplace" }>): Promise<string> {
  if (!suggestion.search) throw invalid("搜索内容不能为空");
  if (!suggestion.isRegex) return text.split(suggestion.search).join(suggestion.replace);
  const worker = new Worker(`const {parentPort,workerData:d}=require('node:worker_threads');try{parentPort.postMessage({text:d.text.replace(new RegExp(d.search,'gu'),d.replace)})}catch(e){parentPort.postMessage({error:String(e)})}`, { eval: true, workerData: { text, search: suggestion.search, replace: suggestion.replace }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { void worker.terminate(); reject(invalid("正则替换耗时过长，请修改建议")); }, 1000);
    worker.once("message", (result: { text?: string; error?: string }) => { clearTimeout(timer); void worker.terminate(); if (typeof result.text === "string") resolve(result.text); else reject(invalid(result.error ?? "正则替换失败")); });
    worker.once("error", (error) => { clearTimeout(timer); reject(error); });
    worker.once("exit", (code) => { if (code) { clearTimeout(timer); reject(invalid("正则替换未完成")); } });
  });
}

interface Editor {
  nativeId: string; scope: AcpScope; path: string; text: string; diskText: string; version: number;
  suggestions: Map<string, { value: EditSuggestion; version: number }>;
  preview?: { id: string; suggestionId: string; path: string; before: string; diskText: string; after: string; kind: "edit" | "jump" | "searchAndReplace"; position?: TextPosition };
}

export class AcpEditor {
  private readonly editors = new Map<string, Editor>();
  constructor(private readonly options: {
    capabilities(): AcpAgentCapabilities;
    settings(): AcpAgentSettings;
    request<T>(method: string, params: unknown): Promise<T>;
    notify(method: string, params: unknown): void;
  }) {}

  private get encoding(): Encoding {
    const value = this.options.capabilities().positionEncoding ?? "utf-16";
    if (!["utf-8", "utf-16", "utf-32"].includes(value)) throw invalid("Agent 选择了未支持的位置编码");
    return value as Encoding;
  }
  private get capabilities(): Json { return object(this.options.capabilities().nes); }
  private document(editor: Editor, event: string, params: Json): void {
    if (object(object(this.capabilities.events).document)[event] == null) return;
    this.options.notify(`document/${event}`, { sessionId: editor.nativeId, uri: pathToFileURL(editor.path).href, ...params });
  }
  private async read(path: string): Promise<string> {
    if ((await stat(path)).size > LIMIT) throw invalid("编辑建议仅支持 256 KB 以内的文本文件");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(path));
  }
  private result(id: string, editor: Editor): EditorResult { return { editorId: id, path: editor.path, text: editor.text, version: editor.version }; }
  private language(path: string): string {
    return ({ ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".py": "python", ".rs": "rust", ".go": "go", ".swift": "swift", ".md": "markdown", ".json": "json" } as Record<string, string>)[extname(path)] ?? "plaintext";
  }
  private openDocument(editor: Editor): void { this.document(editor, "didOpen", { languageId: this.language(editor.path), version: editor.version, text: editor.text }); }
  private changedDocument(editor: Editor, before: string): void {
    const lines = before.split("\n"), end = encodedPosition(before, { line: lines.length - 1, character: lines.at(-1)!.replace(/\r$/, "").length }, this.encoding);
    const sync = object(object(object(this.capabilities.events).document).didChange).syncKind;
    this.document(editor, "didChange", { version: editor.version, contentChanges: [{ ...(sync === "incremental" ? { range: { start: { line: 0, character: 0 }, end } } : {}), text: editor.text }] });
  }

  async run(input: EditorRequest): Promise<EditorResult> {
    if (!this.options.settings().experimental || !this.options.capabilities().nes) throw RpcError.app("not_supported", "这个 AI 未声明支持编辑建议");
    if (input.operation === "open") {
      if (!input.path || !input.cwd) throw invalid("缺少文件或工作目录");
      if (this.editors.size >= 16) throw RpcError.app("busy", "请先关闭不用的编辑页面");
      const scope = { cwd: input.cwd, additionalDirectories: this.options.settings().additionalDirectories }, path = await scopedPath(scope, input.path), text = await this.read(path);
      const { sessionId } = await this.options.request<{ sessionId: string }>("nes/start", { workspaceUri: pathToFileURL(scope.cwd).href, workspaceFolders: [scope.cwd, ...scope.additionalDirectories].map((dir) => ({ uri: pathToFileURL(dir).href, name: basename(dir) })) });
      if (typeof sessionId !== "string") throw invalid("Agent 未返回编辑会话 ID");
      const id = randomUUID(), editor: Editor = { nativeId: sessionId, scope, path, text, diskText: text, version: 1, suggestions: new Map() };
      this.editors.set(id, editor); this.openDocument(editor);
      return this.result(id, editor);
    }
    const id = input.editorId, editor = id ? this.editors.get(id) : undefined;
    if (!id || !editor) throw RpcError.app("not_found", "编辑页面已关闭，请重新打开");
    if (input.operation === "close") { await this.close(id); return {}; }
    if (input.text !== undefined && input.text !== editor.text) {
      if (Buffer.byteLength(input.text) > LIMIT) throw invalid("文件超过 256 KB");
      const before = editor.text;
      editor.text = input.text; editor.version++; editor.preview = undefined;
      this.changedDocument(editor, before);
    }
    if (input.operation === "save") {
      await this.write(editor.path, editor.diskText, editor.text); editor.diskText = editor.text;
      this.document(editor, "didSave", {}); return this.result(id, editor);
    }
    if (input.operation === "suggest") {
      const contextCaps = object(this.capabilities.context), documentCaps = object(object(this.capabilities.events).document);
      if (editor.text !== editor.diskText && !documentCaps.didChange && !contextCaps.recentFiles) throw RpcError.app("not_supported", "这个 AI 不能接收未保存的更改，请先保存文件");
      for (const previous of editor.suggestions.keys()) this.options.notify("nes/reject", { sessionId: editor.nativeId, id: previous, reason: "replaced" });
      editor.suggestions.clear(); editor.preview = undefined;
      const position = encodedPosition(editor.text, input.position ?? { line: 0, character: 0 }, this.encoding);
      this.document(editor, "didFocus", { version: editor.version, position, visibleRange: { start: position, end: position } });
      const uri = pathToFileURL(editor.path).href;
      const context = {
        ...(contextCaps.openFiles ? { openFiles: [{ uri, languageId: this.language(editor.path) }] } : {}),
        ...(contextCaps.recentFiles ? { recentFiles: [{ uri, languageId: this.language(editor.path), text: editor.text }] } : {}),
        ...(contextCaps.diagnostics ? { diagnostics: [] } : {}),
      };
      const version = editor.version;
      const result = await this.options.request<{ suggestions: unknown[] }>("nes/suggest", { sessionId: editor.nativeId, uri, version, position, triggerKind: "manual", context });
      if (editor.version !== version) throw RpcError.app("busy", "文件已继续编辑，请重新获取建议");
      const suggestions = (result.suggestions ?? []).flatMap((value) => { const parsed = editSuggestionSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
      for (const value of suggestions) editor.suggestions.set(value.id, { value, version });
      return { ...this.result(id, editor), suggestions };
    }
    if (input.operation === "reject") {
      if (!input.suggestionId || !editor.suggestions.has(input.suggestionId)) throw invalid("建议已失效");
      this.options.notify("nes/reject", { sessionId: editor.nativeId, id: input.suggestionId, reason: "rejected" });
      editor.suggestions.delete(input.suggestionId); editor.preview = undefined; return {};
    }
    if (input.operation === "preview") {
      const entry = input.suggestionId ? editor.suggestions.get(input.suggestionId) : undefined;
      if (!entry || entry.version !== editor.version) throw invalid("建议已失效，请重新获取");
      const suggestion = entry.value;
      if (suggestion.kind === "rename") throw RpcError.app("not_supported", "语义重命名需要语言服务，请在电脑编辑器中执行");
      const path = await scopedPath(editor.scope, fileURLToPath(suggestion.uri));
      const diskText = path === editor.path ? editor.diskText : await this.read(path);
      const before = path === editor.path ? editor.text : diskText;
      const after = suggestion.kind === "edit" ? applyTextEdits(before, suggestion.edits, this.encoding) : suggestion.kind === "searchAndReplace" ? await replaceText(before, suggestion) : before;
      if (Buffer.byteLength(after) > LIMIT) throw invalid("建议结果超过 256 KB");
      const position = suggestion.kind === "jump" ? utf16Position(before, suggestion.position, this.encoding) : suggestion.kind === "edit" && suggestion.cursorPosition ? utf16Position(after, suggestion.cursorPosition, this.encoding) : undefined;
      const preview = { id: randomUUID(), suggestionId: suggestion.id, path, before, diskText, after, kind: suggestion.kind, position };
      editor.preview = preview;
      return { preview: { id: preview.id, path, before, after, kind: preview.kind, position } };
    }
    if (input.operation === "apply") {
      const preview = editor.preview;
      if (!preview || preview.id !== input.previewId) throw invalid("预览已失效，请重新预览");
      if (preview.path !== editor.path && editor.text !== editor.diskText) throw RpcError.app("busy", "请先保存当前文件的更改");
      if (preview.kind !== "jump") await this.write(preview.path, preview.diskText, preview.after);
      else if (await this.read(preview.path) !== preview.diskText) throw RpcError.app("busy", "目标文件已修改，请重新获取建议");
      const moved = preview.path !== editor.path;
      const before = editor.text;
      if (moved) this.document(editor, "didClose", {});
      editor.path = preview.path; editor.diskText = preview.after; editor.text = preview.after; editor.version++;
      if (moved) this.openDocument(editor);
      else this.changedDocument(editor, before);
      if (preview.kind !== "jump") this.document(editor, "didSave", {});
      this.options.notify("nes/accept", { sessionId: editor.nativeId, id: preview.suggestionId });
      editor.suggestions.clear(); editor.preview = undefined;
      return { ...this.result(id, editor), position: preview.position };
    }
    throw invalid("未知的编辑操作");
  }

  private async write(path: string, before: string, after: string): Promise<void> {
    if (await this.read(path) !== before) throw RpcError.app("busy", "电脑上的文件已修改，请重新打开后再应用，未覆盖任何内容");
    await writeFile(path, after, "utf8");
  }
  async close(id?: string): Promise<void> {
    const closing: Promise<unknown>[] = [];
    for (const [key, editor] of this.editors) {
      if (id && key !== id) continue;
      this.editors.delete(key); this.document(editor, "didClose", {});
      closing.push(this.options.request("nes/close", { sessionId: editor.nativeId }));
    }
    await Promise.allSettled(closing);
  }
}
