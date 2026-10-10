import { acpAgentSettingsSchema, acpRemoteAgentSchema, type AcpProvider, type AcpRemoteAgent, type MethodResult } from "@linkshell/wire";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, ScrollView, Switch, View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { Button } from "@/components/button";
import { SheetHeader } from "@/components/sheet-header";
import { QuestionCard } from "@/components/question-card";
import { PermissionActions } from "@/components/permission-actions";
import { PermissionContext } from "@/components/permission-context";
import { useActions, useClient, useConnection } from "@/lib/client";
import { openAuthorization } from "@/lib/authorization";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <View style={{ gap: 10, padding: 16, backgroundColor: colors.card, borderRadius: 20 }}><Text style={[type.headline, { color: colors.label }]}>{title}</Text>{children}</View>;
}
function Field({ label, value, onChange, multiline = false, secret = false, placeholder }: { label: string; value: string; onChange(value: string): void; multiline?: boolean; secret?: boolean; placeholder?: string }) {
  return <View style={{ gap: 5 }}><Text style={[type.footnote, { color: colors.secondaryLabel }]}>{label}</Text><TextInput value={value} onChangeText={onChange} multiline={multiline} secureTextEntry={secret} autoCapitalize="none" autoCorrect={false} placeholder={placeholder} placeholderTextColor={colors.placeholder as string} accessibilityLabel={label} style={[type.body, { color: colors.label, backgroundColor: colors.fill, padding: 12, borderRadius: 12, minHeight: multiline ? 100 : 46, maxHeight: multiline ? 260 : undefined, fontFamily: multiline ? mono : undefined, textAlignVertical: "top" }]} /></View>;
}

export function AgentInteractions({ agent }: { agent: string }) {
  const { link } = useConnection();
  const requests = useClient((state) => state.interactions[agent]);
  const online = useClient((state) => state.status === "online");
  const choose = async (requestId: string, optionId: string) => {
    const request = requests?.find((entry) => entry.requestId === requestId);
    if (request) openAuthorization(request, optionId);
    await link.call("agents.respond", { agent, requestId, optionId });
  };
  return <>{requests?.map((request) => request.questions?.length ? <QuestionCard key={request.requestId} sessionId={`agent:${agent}`} contained request={{ ...request, ts: 0 }} count={requests.length} agentName={agent} disabled={!online} onChoose={choose} onAnswer={async (requestId, answers) => { await link.call("agents.respond", { agent, requestId, answers }); }} />
    : <Section key={request.requestId} title={request.title}><PermissionContext request={request} /><PermissionActions options={request.options} disabled={!online} onChoose={(optionId) => choose(request.requestId, optionId)} /></Section>)}</>;
}

export function AcpScreen() {
  const params = useLocalSearchParams<{ agent?: string; sessionId?: string; edit?: string }>();
  return params.agent ? <AgentSettings key={`${params.agent}:${params.sessionId ?? ""}`} agent={params.agent} sessionId={params.sessionId} /> : <CustomAgents edit={params.edit} />;
}

function AgentSettings({ agent, sessionId }: { agent: string; sessionId?: string }) {
  const { link } = useConnection();
  const actions = useActions();
  const label = useClient((state) => state.machine?.agents.find((entry) => entry.id === agent)?.label ?? agent);
  const [info, setInfo] = useState<MethodResult<"agents.acp">>();
  const [settings, setSettings] = useState(() => acpAgentSettingsSchema.parse({}));
  const [directories, setDirectories] = useState("");
  const [servers, setServers] = useState("[]");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [providers, setProviders] = useState<AcpProvider[]>();
  const load = useCallback(async () => {
    const next = await link.call("agents.acp", { agent, sessionId }, 60_000);
    setInfo(next); setSettings(next.settings); setDirectories(next.settings.additionalDirectories.join("\n")); setServers(JSON.stringify(next.settings.mcpServers, null, 2));
  }, [agent, link, sessionId]);
  useEffect(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, [load]);
  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name); setError(undefined); setSaved(false);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(undefined); }
  };
  return <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 14 }} keyboardShouldPersistTaps="handled">
    <SheetHeader title={`${label} · ${sessionId ? "会话工具" : "连接与工具"}`} />
    {error ? <Text selectable style={[type.footnote, { color: colors.danger }]}>{error}</Text> : null}
    <AgentInteractions agent={agent} />
    {!info ? error ? <Button title="重试" onPress={() => void run("load", load)} /> : <ActivityIndicator color={colors.accent} /> : <>
      {!sessionId ? <Section title="登录">
        {info.features.authMethods.length ? info.features.authMethods.map((method) => <View key={method.id} style={{ gap: 4 }}><Button title={method.name} busy={busy === method.id} disabled={!!busy} onPress={() => void run(method.id, async () => {
          const result = await link.call("agents.authenticate", { agent, methodId: method.id }, 0);
          await actions.refresh();
          if (result.terminalId) router.push({ pathname: "/terminal/[id]", params: { id: result.terminalId } });
        })} />{method.description ? <Text style={[type.caption, { color: colors.secondaryLabel }]}>{method.description}</Text> : null}</View>) : <Text style={[type.footnote, { color: colors.secondaryLabel }]}>这个 AI 使用电脑上已有的登录信息。</Text>}
        {info.features.logout ? <Button title="退出登录" variant="plain" disabled={!!busy} onPress={() => void run("logout", async () => { await link.call("agents.authenticate", { agent, logout: true }); await actions.refresh(); })} /> : null}
      </Section> : null}
      <Section title="工作范围">
        <Field label="附加目录 · 每行一个绝对路径" value={directories} onChange={setDirectories} multiline placeholder="/Users/you/another-project" />
        {!info.features.additionalDirectories ? <Text style={[type.caption, { color: colors.secondaryLabel }]}>当前 Agent 未声明支持附加目录。</Text> : null}
      </Section>
      <Section title="工具服务器">
        <Text style={[type.footnote, { color: colors.secondaryLabel }]}>配置 MCP 服务。每项填写 type、name，以及 command / args 或 url；env、headers 按服务需要填写。</Text>
        <Field label="MCP 服务列表（JSON）" value={servers} onChange={setServers} multiline placeholder='[{"type":"stdio","name":"tools","command":"…","args":[]}]' />
      </Section>
      {!sessionId ? <Section title="协议选项">
        <Text style={[type.footnote, { color: colors.secondaryLabel }]}>当前连接使用 ACP {info.features.protocolVersion}。修改后会重新建立连接，运行中的会话需要先结束。</Text>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}><Text style={[type.body, { flex: 1, color: colors.label }]}>尝试 ACP 2 草案</Text><Switch accessibilityLabel="尝试 ACP 2 草案" value={settings.protocolVersion === 2} onValueChange={(on) => setSettings((current) => ({ ...current, protocolVersion: on ? 2 : 1 }))} /></View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}><Text style={[type.body, { flex: 1, color: colors.label }]}>实验扩展</Text><Switch accessibilityLabel="实验扩展" value={settings.experimental} onValueChange={(experimental) => setSettings((current) => ({ ...current, experimental }))} /></View>
      </Section> : null}
      <Button title={saved ? "已保存" : "保存配置"} variant="primary" busy={busy === "save"} disabled={!!busy} onPress={() => void run("save", async () => {
        const next = acpAgentSettingsSchema.parse({ ...settings, additionalDirectories: directories.split("\n").map((path) => path.trim()).filter(Boolean), mcpServers: JSON.parse(servers) });
        await link.call("agents.configure", { agent, sessionId, settings: next }, 60_000); await load(); await actions.refresh(); setSaved(true);
      })} />
      {!sessionId && info.features.providers ? <Section title="模型供应商">
        {providers ? providers.map((provider) => <ProviderForm key={provider.providerId} agent={agent} provider={provider} changed={setProviders} />) : <Button title="载入供应商" onPress={() => void run("providers", async () => setProviders((await link.call("agents.providers", { agent, operation: "list" })).providers))} />}
      </Section> : null}
    </>}
  </ScrollView>;
}

function ProviderForm({ agent, provider, changed }: { agent: string; provider: AcpProvider; changed(value: AcpProvider[]): void }) {
  const { link } = useConnection();
  const [apiType, setApiType] = useState(provider.current?.apiType ?? provider.supported[0] ?? "");
  const [url, setUrl] = useState(provider.current?.baseUrl ?? "");
  const [headers, setHeaders] = useState("{}");
  const [busy, setBusy] = useState(false);
  const submit = async (operation: "set" | "disable") => {
    setBusy(true);
    try { changed((await link.call("agents.providers", { agent, operation, config: { providerId: provider.providerId, apiType, baseUrl: operation === "set" ? url : undefined, headers: operation === "set" ? JSON.parse(headers) : undefined } })).providers); setHeaders("{}"); }
    catch (error) { Alert.alert("供应商配置失败", error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  return <View style={{ gap: 8, paddingVertical: 8 }}><Text style={[type.body, { color: colors.label, fontWeight: "600" }]}>{provider.providerId}{provider.required ? " · 必需" : ""}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{provider.supported.map((value) => <Button key={value} title={value} variant={apiType === value ? "primary" : "tonal"} size="small" onPress={() => setApiType(value)} />)}</View>
    <Field label="API 地址" value={url} onChange={setUrl} placeholder="https://…" />
    <Field label="完整请求头（JSON，每次保存会替换）" value={headers} onChange={setHeaders} secret />
    <View style={{ flexDirection: "row", gap: 8 }}><Button title="保存供应商" disabled={busy} onPress={() => void submit("set")} />{!provider.required ? <Button title="停用" variant="destructive" disabled={busy} onPress={() => void submit("disable")} /> : null}</View>
  </View>;
}

function CustomAgents({ edit }: { edit?: string }) {
  const { link } = useConnection();
  const actions = useActions();
  const [agents, setAgents] = useState<AcpRemoteAgent[]>([]);
  const [id, setId] = useState(edit ?? "");
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<AcpRemoteAgent["transport"]>("stdio");
  const [address, setAddress] = useState("");
  const [args, setArgs] = useState("");
  const [headers, setHeaders] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { void link.call("agents.custom", {}).then(({ agents: list }) => {
    setAgents(list); const current = list.find((agent) => agent.id === edit); if (!current) return;
    setId(current.id); setLabel(current.label); setTransport(current.transport); setAddress(current.transport === "stdio" ? current.command ?? "" : current.url ?? ""); setArgs(current.args.join("\n")); setHeaders(JSON.stringify(current.headerEnv, null, 2));
  }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, [edit, link]);
  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      const existing = agents.find((agent) => agent.id === id);
      const agent = acpRemoteAgentSchema.parse({ ...existing, id, label, transport, command: transport === "stdio" ? address : undefined, url: transport === "stdio" ? undefined : address, args: args.split("\n").filter(Boolean), headerEnv: JSON.parse(headers) });
      const result = await link.call("agents.custom", { save: agent }, 60_000); setAgents(result.agents); await actions.refresh(); router.replace({ pathname: "/acp", params: { agent: id } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };
  return <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 14 }} keyboardShouldPersistTaps="handled"><SheetHeader title={edit ? "编辑 ACP Agent" : "自定义 ACP Agent"} />
    {agents.length && !edit ? <Section title="已配置">{agents.map((agent) => <View key={agent.id} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}><Button title={agent.label} wide onPress={() => router.push({ pathname: "/acp", params: { agent: agent.id } })} /><Button title="编辑" size="small" onPress={() => router.push({ pathname: "/acp", params: { edit: agent.id } })} /></View>)}</Section> : null}
    <Section title={edit ? "连接信息" : "添加连接"}>
      <Field label="ID · 小写字母、数字、短横线" value={id} onChange={setId} placeholder="my-agent" />
      <Field label="显示名称" value={label} onChange={setLabel} placeholder="我的 AI" />
      <View style={{ flexDirection: "row", gap: 6 }}>{(["stdio", "http", "websocket"] as const).map((value) => <Button key={value} title={value === "stdio" ? "本地命令" : value.toUpperCase()} variant={transport === value ? "primary" : "tonal"} size="small" onPress={() => setTransport(value)} />)}</View>
      <Field label={transport === "stdio" ? "启动命令" : "服务地址"} value={address} onChange={setAddress} placeholder={transport === "stdio" ? "/path/to/agent" : transport === "http" ? "https://…/acp" : "wss://…/acp"} />
      {transport === "stdio" ? <Field label="启动参数 · 每行一个" value={args} onChange={setArgs} multiline placeholder="--acp" /> : <Field label="请求头对应的电脑环境变量（JSON）" value={headers} onChange={setHeaders} multiline placeholder='{"Authorization":"ACP_AUTHORIZATION"}' />}
      {error ? <Text selectable style={[type.footnote, { color: colors.danger }]}>{error}</Text> : null}
      <Button title="保存连接" variant="primary" busy={busy} onPress={() => void save()} />
      {edit ? <Button title="移除此连接" variant="destructive" disabled={busy} onPress={() => { Alert.alert("移除连接", "会话历史会保留。", [{ text: "取消", style: "cancel" }, { text: "移除", style: "destructive", onPress: () => { void link.call("agents.custom", { remove: edit }, 60_000).then(async () => { await actions.refresh(); router.back(); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); } }]); }} /> : null}
    </Section>
  </ScrollView>;
}
