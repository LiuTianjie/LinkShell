import type { EditSuggestion, EditorResult } from "@linkshell/wire";
import { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { Text, TextInput } from "./fixed-text";
import { Button } from "./button";
import { DiffView } from "./timeline/tool-call";
import { fileChanges } from "@/lib/describe";
import { useClient, useConnection } from "@/lib/client";
import { AgentInteractions } from "@/screens/acp-screen";
import { AcpBanner, AcpSection } from "./acp-settings-ui";
import { AgentTile } from "./agent-tile";
import { Icon } from "./icon";
import { PressableScale } from "./pressable-scale";
import { colors } from "@/theme/colors";
import { mono, radius, type } from "@/theme/type";

export function AcpFileEditor({ path, onClose }: { path: string; onClose(): void }) {
  const { link } = useConnection();
  const agents = useClient((state) => state.machine?.agents);
  const online = useClient((state) => state.status === "online");
  const [agent, setAgent] = useState("");
  const [editor, setEditor] = useState<EditorResult>();
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const field = useRef<TextInput>(null);
  const [suggestions, setSuggestions] = useState<EditSuggestion[]>([]);
  const [preview, setPreview] = useState<EditorResult["preview"]>();
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<string>();
  const [error, setError] = useState<string>();
  const [requested, setRequested] = useState(false);
  const active = useRef<{ agent: string; id: string } | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    const current = active.current;
    if (current) void link.call("agents.editor", { agent: current.agent, operation: "close", editorId: current.id }).catch(() => {});
  }; }, [link]);
  const run = async (action: () => Promise<void>, operation = "other") => {
    setBusy(true); setOperation(operation); setError(undefined);
    try { await action(); } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); } finally { if (mounted.current) { setBusy(false); setOperation(undefined); } }
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
  const availableAgents = agents?.filter((entry) => entry.installed && entry.capabilities.acp) ?? [];
  return <ScrollView automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 44 }}><View style={{ width: "100%", maxWidth: 600, alignSelf: "center", gap: 20 }}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}><View style={{ flex: 1, gap: 4 }}><Text style={[type.headline, { color: colors.label }]}>AI 编辑建议</Text><Text style={[type.footnote, { color: colors.secondaryLabel }]}>先预览，再应用到文件</Text></View><Button title="返回阅读" size="small" variant="plain" onPress={close} /></View>
    {error ? <AcpBanner message={error} /> : null}
    {!online ? <AcpBanner kind="info" message="等待电脑连接，连上后可继续编辑。" /> : null}
    {agent ? <AgentInteractions agent={agent} /> : null}
    {!editor ? <AcpSection title="选择提供编辑建议的 AI">{availableAgents.length ? availableAgents.map((entry) => <PressableScale key={entry.id} disabled={busy || !online} accessibilityRole="button" accessibilityLabel={`使用 ${entry.label} 编辑`} onPress={() => void run(() => open(entry.id))}><View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, opacity: busy || !online ? 0.5 : 1 }}><AgentTile agent={entry.id} size={36} /><View style={{ flex: 1, gap: 3 }}><Text style={[type.subhead, { color: colors.label, fontWeight: "500" }]}>{entry.label}</Text><Text style={[type.footnote, { color: colors.secondaryLabel }]}>{busy && agent === entry.id ? "正在打开编辑页面…" : "读取文件并获取编辑建议"}</Text></View><Icon sf="chevron.right" md="chevron_right" size={13} color={colors.tertiaryLabel} /></View></PressableScale>) : <Text style={[type.subhead, { color: colors.secondaryLabel }]}>电脑上还没有可用的 ACP Agent，请先在电脑页添加连接。</Text>}</AcpSection> : <>
      <View style={{ backgroundColor: colors.code, borderRadius: radius.row, borderCurve: "continuous", overflow: "hidden" }}>
        <View style={{ padding: 12, flexDirection: "row", alignItems: "center", gap: 8 }}><Icon sf="doc.text" md="description" size={16} color={colors.secondaryLabel} /><Text selectable numberOfLines={2} style={[type.caption, { flex: 1, color: colors.secondaryLabel }]}>{editor.path}</Text><Text style={[type.caption2, { color: text === saved ? colors.tertiaryLabel : colors.accent }]}>{text === saved ? "已保存" : "未保存"}</Text></View>
        <TextInput ref={field} multiline value={text} selection={selection} onChangeText={(value) => { setText(value); setPreview(undefined); setSuggestions([]); setRequested(false); }} onSelectionChange={(event) => setSelection(event.nativeEvent.selection)} editable={!busy && online} autoCapitalize="none" autoCorrect={false} selectionColor={colors.accent} accessibilityLabel="文件内容" style={{ fontFamily: mono, fontSize: 13, lineHeight: 20, color: colors.codeText, minHeight: 260, maxHeight: 480, padding: 12, paddingTop: 0, textAlignVertical: "top" }} />
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title="保存文件" wide busy={operation === "save"} disabled={busy || !online || text === saved} onPress={() => void run(async () => { const result = await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "save", text }); setEditor(result); setSaved(text); }, "save")} />
        <Button title="获取建议" wide variant="primary" busy={operation === "suggest"} disabled={busy || !online} onPress={() => void run(async () => {
          const lines = text.slice(0, selection.start).split("\n");
          const result = await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "suggest", text, position: { line: lines.length - 1, character: lines.at(-1)!.length } }, 60_000);
          setEditor(result); setSuggestions(result.suggestions ?? []); setRequested(true);
        }, "suggest")} />
      </View>
      {requested && !suggestions.length ? <AcpBanner kind="info" message="这个位置暂时没有编辑建议，可以换个位置再试。" /> : null}
      {suggestions.map((suggestion) => <View key={suggestion.id} style={{ padding: 16, backgroundColor: colors.fill, borderRadius: radius.row, borderCurve: "continuous", gap: 12 }}>
        <Text numberOfLines={2} style={[type.footnote, { color: colors.label }]}>{suggestion.kind === "jump" ? "跳转" : suggestion.kind === "rename" ? `重命名为 ${suggestion.newName}` : suggestion.kind === "searchAndReplace" ? "搜索替换" : `${suggestion.edits.length} 处编辑`} · {suggestion.uri}</Text>
        <View style={{ flexDirection: "row", gap: 8 }}><Button title="预览修改" disabled={busy || !online} onPress={() => void run(async () => setPreview((await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "preview", suggestionId: suggestion.id })).preview))} /><Button title="忽略" variant="plain" disabled={busy || !online} onPress={() => void run(async () => { await link.call("agents.editor", { agent, editorId: editor.editorId, operation: "reject", suggestionId: suggestion.id }); setSuggestions((current) => current.filter((entry) => entry.id !== suggestion.id)); setPreview(undefined); })} /></View>
      </View>)}
      {preview ? <View style={{ gap: 10 }}>
        <Text selectable style={[type.footnote, { color: colors.label }]}>{preview.path}{preview.position ? `:${preview.position.line + 1}` : ""}</Text>
        {preview.kind !== "jump" ? fileChanges([{ type: "diff", path: preview.path, oldText: preview.before, newText: preview.after }]).map((change) => <DiffView key={change.path} change={change} />) : <Text style={[type.footnote, { color: colors.secondaryLabel }]}>跳转后会打开该位置。</Text>}
        <Button title={preview.kind === "jump" ? "跳转到这里" : "应用修改"} variant="primary" size="large" disabled={busy || !online} onPress={() => void run(async () => {
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
  </View></ScrollView>;
}
