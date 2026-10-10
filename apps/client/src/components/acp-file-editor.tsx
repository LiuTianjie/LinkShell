import type { EditSuggestion, EditorResult } from "@linkshell/wire";
import { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { Text, TextInput } from "./fixed-text";
import { Button } from "./button";
import { DiffView } from "./timeline/tool-call";
import { fileChanges } from "@/lib/describe";
import { useClient, useConnection } from "@/lib/client";
import { AgentInteractions } from "@/screens/acp-screen";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

export function AcpFileEditor({ path, onClose }: { path: string; onClose(): void }) {
  const { link } = useConnection();
  const agents = useClient((state) => state.machine?.agents);
  const [agent, setAgent] = useState("");
  const [editor, setEditor] = useState<EditorResult>();
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const field = useRef<TextInput>(null);
  const [suggestions, setSuggestions] = useState<EditSuggestion[]>([]);
  const [preview, setPreview] = useState<EditorResult["preview"]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<{ agent: string; id: string } | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    const current = active.current;
    if (current) void link.call("agents.editor", { agent: current.agent, operation: "close", editorId: current.id }).catch(() => {});
  }; }, [link]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(undefined);
    try { await action(); } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); } finally { if (mounted.current) setBusy(false); }
  };
  const open = async (id: string) => {
    setAgent(id);
    const result = await link.call("agents.editor", { agent: id, operation: "open", path, cwd: path.slice(0, path.lastIndexOf("/")) || "/" }, 60_000);
    if (!mounted.current) { if (result.editorId) await link.call("agents.editor", { agent: id, operation: "close", editorId: result.editorId }); return; }
    active.current = { agent: id, id: result.editorId! }; setEditor(result); setText(result.text ?? ""); setSaved(result.text ?? "");
  };
  const close = () => {
    if (text !== saved) Alert.alert("还有未保存的更改", "关闭会丢弃这个编辑页面中的修改。", [{ text: "继续编辑", style: "cancel" }, { text: "放弃修改", style: "destructive", onPress: onClose }]);
    else onClose();
  };
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 12 }}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}><Text style={[type.headline, { color: colors.label }]}>AI 编辑建议</Text><Button title="返回阅读" size="small" onPress={close} /></View>
    {error ? <Text selectable style={[type.footnote, { color: colors.danger }]}>{error}</Text> : null}
    {agent ? <AgentInteractions agent={agent} /> : null}
    {!editor ? <><Text style={[type.footnote, { color: colors.secondaryLabel }]}>选择支持编辑建议的 ACP Agent。</Text><View style={{ gap: 8 }}>{agents?.filter((entry) => entry.installed && entry.capabilities.acp).map((entry) => <Button key={entry.id} title={entry.label} busy={busy && agent === entry.id} disabled={busy} onPress={() => void run(() => open(entry.id))} />)}</View></> : <>
      <Text selectable style={[type.caption, { color: colors.secondaryLabel }]}>{editor.path}</Text>
      <TextInput ref={field} multiline value={text} selection={selection} onChangeText={(value) => { setText(value); setPreview(undefined); setSuggestions([]); }} onSelectionChange={(event) => setSelection(event.nativeEvent.selection)} editable={!busy} autoCapitalize="none" autoCorrect={false} accessibilityLabel="文件内容" style={{ fontFamily: mono, fontSize: 13, lineHeight: 20, color: colors.codeText, backgroundColor: colors.code, borderRadius: 14, minHeight: 280, maxHeight: 500, padding: 12, textAlignVertical: "top" }} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title="保存文件" disabled={busy || text === saved} onPress={() => void run(async () => { const result = await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "save", text }); setEditor(result); setSaved(text); })} />
        <Button title="获取建议" variant="primary" busy={busy} onPress={() => void run(async () => {
          const lines = text.slice(0, selection.start).split("\n");
          const result = await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "suggest", text, position: { line: lines.length - 1, character: lines.at(-1)!.length } }, 60_000);
          setEditor(result); setSuggestions(result.suggestions ?? []); if (!result.suggestions?.length) setError("这个位置暂时没有编辑建议。");
        })} />
      </View>
      {suggestions.map((suggestion) => <View key={suggestion.id} style={{ padding: 12, backgroundColor: colors.fill, borderRadius: 14, gap: 8 }}>
        <Text numberOfLines={2} style={[type.footnote, { color: colors.label }]}>{suggestion.kind === "jump" ? "跳转" : suggestion.kind === "rename" ? `重命名为 ${suggestion.newName}` : suggestion.kind === "searchAndReplace" ? "搜索替换" : `${suggestion.edits.length} 处编辑`} · {suggestion.uri}</Text>
        <View style={{ flexDirection: "row", gap: 8 }}><Button title="预览" disabled={busy} onPress={() => void run(async () => setPreview((await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "preview", suggestionId: suggestion.id })).preview))} /><Button title="忽略" variant="plain" disabled={busy} onPress={() => void run(async () => { await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "reject", suggestionId: suggestion.id }); setSuggestions((current) => current.filter((entry) => entry.id !== suggestion.id)); setPreview(undefined); })} /></View>
      </View>)}
      {preview ? <View style={{ gap: 10 }}>
        <Text selectable style={[type.footnote, { color: colors.label }]}>{preview.path}{preview.position ? `:${preview.position.line + 1}` : ""}</Text>
        {preview.kind !== "jump" ? fileChanges([{ type: "diff", path: preview.path, oldText: preview.before, newText: preview.after }]).map((change) => <DiffView key={change.path} change={change} />) : <Text style={[type.footnote, { color: colors.secondaryLabel }]}>跳转后会打开该位置。</Text>}
        <Button title={preview.kind === "jump" ? "跳转到这里" : "应用修改"} variant="primary" disabled={busy} onPress={() => void run(async () => {
          const result = await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "apply", previewId: preview.id });
          setEditor(result); setText(result.text ?? ""); setSaved(result.text ?? ""); setPreview(undefined); setSuggestions([]);
          if (result.position) {
            const lines = (result.text ?? "").split("\n");
            const offset = lines.slice(0, result.position.line).reduce((length, line) => length + line.length + 1, 0) + result.position.character;
            setSelection({ start: offset, end: offset });
            requestAnimationFrame(() => field.current?.focus());
          }
        })} />
      </View> : null}
    </>}
  </ScrollView>;
}
