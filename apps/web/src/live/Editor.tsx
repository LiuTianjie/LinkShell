import { useEffect, useRef, useState } from "react";
import type { EditorResult, EditSuggestion } from "@linkshell/wire";
import { useDialogs } from "@/components/Dialogs";
import { ErrorNotice, useClient, useConnection, useJob } from "./common";
import { AgentInteractions } from "./Acp";
import { Diff } from "./Timeline";

export function FileEditor({ path, close }: { path: string; close(): void }) {
  const { link } = useConnection(); const dialogs = useDialogs(); const job = useJob();
  const agents = useClient((state) => state.machine?.agents);
  const [agent, setAgent] = useState(""); const [editor, setEditor] = useState<EditorResult>();
  const [text, setText] = useState(""); const [saved, setSaved] = useState("");
  const [suggestions, setSuggestions] = useState<EditSuggestion[]>(); const [preview, setPreview] = useState<EditorResult["preview"]>();
  const field = useRef<HTMLTextAreaElement>(null);
  const active = useRef<{ agent: string; id: string } | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    const current = active.current;
    if (current) void link.call("agents.editor", { agent: current.agent, operation: "close", editorId: current.id }).catch(() => {});
  }; }, [link]);
  const open = async () => {
    const result = await link.call("agents.editor", { agent, operation: "open", path, cwd: path.slice(0, path.lastIndexOf("/")) || "/" }, 60_000);
    if (!mounted.current) { if (result.editorId) await link.call("agents.editor", { agent, operation: "close", editorId: result.editorId }); return; }
    active.current = { agent, id: result.editorId! }; setEditor(result); setText(result.text ?? ""); setSaved(result.text ?? "");
  };
  return <div className="acp-editor"><div className="browser-toolbar"><strong>AI 编辑建议</strong><button className="text-button" onClick={async () => { if (text === saved || await dialogs.confirm("当前文件还有未保存的修改。放弃这些修改并返回阅读？")) close(); }}>返回阅读</button></div>
    <ErrorNotice error={job.error} />
    {agent && <AgentInteractions agent={agent} />}
    {!editor ? <div className="inline-form"><select aria-label="选择支持编辑建议的 ACP Agent" value={agent} onChange={(event) => setAgent(event.target.value)}><option value="">选择支持编辑建议的 AI</option>{agents?.filter((entry) => entry.installed && entry.capabilities.acp).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select><button className="button primary" disabled={!agent || job.busy} onClick={() => void job.run(open)}>打开编辑</button></div> : <>
      <code>{editor.path}</code>
      <textarea ref={field} className="code-input" aria-label="文件内容" spellCheck={false} value={text} disabled={job.busy} onChange={(event) => { setText(event.target.value); setPreview(undefined); setSuggestions(undefined); }} />
      <div className="permission-buttons">
        <button className="button secondary" disabled={job.busy || text === saved} onClick={() => void job.run(async () => { const result = await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "save", text }); setEditor(result); setSaved(text); })}>保存文件</button>
        <button className="button primary" disabled={job.busy} onClick={() => void job.run(async () => {
          const lines = text.slice(0, field.current?.selectionStart ?? 0).split("\n");
          const result = await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "suggest", text, position: { line: lines.length - 1, character: lines.at(-1)!.length } }, 60_000);
          setEditor(result); setSuggestions(result.suggestions ?? []);
        })}>获取建议</button>
      </div>
      {suggestions?.length === 0 && <p className="muted">这个位置暂时没有编辑建议。</p>}
      {suggestions?.map((suggestion) => <article className="notice-card" key={suggestion.id}><strong>{suggestion.kind === "jump" ? "跳转" : suggestion.kind === "rename" ? `重命名为 ${suggestion.newName}` : suggestion.kind === "searchAndReplace" ? "搜索替换" : `${suggestion.edits.length} 处编辑`}</strong><p className="muted">{suggestion.uri}</p><div className="permission-buttons"><button className="button secondary" disabled={job.busy} onClick={() => void job.run(async () => setPreview((await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "preview", suggestionId: suggestion.id })).preview))}>预览</button><button className="text-button" disabled={job.busy} onClick={() => void job.run(async () => { await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "reject", suggestionId: suggestion.id }); setSuggestions((current) => current?.filter((entry) => entry.id !== suggestion.id)); setPreview(undefined); })}>忽略</button></div></article>)}
      {preview && <article className="notice-card"><strong>{preview.path}{preview.position ? `:${preview.position.line + 1}` : ""}</strong>{preview.kind !== "jump" && <Diff change={{ type: "diff", path: preview.path, oldText: preview.before, newText: preview.after }} />}<button className="button primary" disabled={job.busy} onClick={() => void job.run(async () => {
        const result = await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "apply", previewId: preview.id }); setEditor(result); setText(result.text ?? ""); setSaved(result.text ?? ""); setPreview(undefined); setSuggestions(undefined);
        if (result.position) requestAnimationFrame(() => { const lines = (result.text ?? "").split("\n"); const offset = lines.slice(0, result.position!.line).reduce((length, line) => length + line.length + 1, 0) + result.position!.character; field.current?.focus(); field.current?.setSelectionRange(offset, offset); });
      })}>{preview.kind === "jump" ? "跳转到这里" : "应用修改"}</button></article>}
    </>}
  </div>;
}
