import { acpAgentSettingsSchema, acpRemoteAgentSchema, type AcpProvider, type AcpRemoteAgent, type MethodResult } from "@linkshell/wire";
import { router, useLocalSearchParams } from "expo-router";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Alert, Switch, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { Button } from "@/components/button";
import { AgentTile } from "@/components/agent-tile";
import { Icon } from "@/components/icon";
import { QuestionCard } from "@/components/question-card";
import { PermissionActions } from "@/components/permission-actions";
import { PermissionContext } from "@/components/permission-context";
import { AcpBanner, AcpChoice, AcpDisclosure, AcpDivider, AcpField, AcpLoading, AcpRow, AcpSection, AcpSheet } from "@/components/acp-settings-ui";
import { AcpServerEditor, parseConfigRecord } from "@/components/acp-server-editor";
import { useActions, useClient, useConnection } from "@/lib/client";
import { openAuthorization } from "@/lib/authorization";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";

export function AgentInteractions({ agent }: { agent: string }) {
  const { link } = useConnection();
  const requests = useClient((state) => state.interactions[agent]);
  const online = useClient((state) => state.status === "online");
  const name = useClient((state) => state.machine?.agents.find((entry) => entry.id === agent)?.label ?? agent);
  const choose = async (requestId: string, optionId: string) => {
    const request = requests?.find((entry) => entry.requestId === requestId);
    if (request) openAuthorization(request, optionId);
    await link.call("agents.respond", { agent, requestId, optionId });
  };
  return <>{requests?.map((request) => request.questions?.length
    ? <QuestionCard key={request.requestId} sessionId={`agent:${agent}`} contained request={{ ...request, ts: 0 }} count={requests.length} agentName={name} disabled={!online} onChoose={choose} onAnswer={async (requestId, answers) => { await link.call("agents.respond", { agent, requestId, answers }); }} />
    : <AcpSection key={request.requestId} title="需要你确认"><View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}><Icon sf="hand.raised" md="front_hand" size={20} color={colors.waiting} /><Text style={[type.headline, { flex: 1, color: colors.label }]}>{request.title}</Text></View>{request.detail ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{request.detail}</Text> : null}<PermissionContext request={request} /><PermissionActions options={request.options} disabled={!online} onChoose={(optionId) => choose(request.requestId, optionId)} /></AcpSection>)}</>;
}

export function AcpScreen() {
  const params = useLocalSearchParams<{ agent?: string; sessionId?: string; edit?: string }>();
  return params.agent ? <AgentSettings key={`${params.agent}:${params.sessionId ?? ""}`} agent={params.agent} sessionId={params.sessionId} /> : <CustomAgents key={params.edit ?? "new"} edit={params.edit} />;
}

function AgentSettings({ agent, sessionId }: { agent: string; sessionId?: string }) {
  const { link } = useConnection();
  const actions = useActions();
  const current = useClient((state) => state.machine?.agents.find((entry) => entry.id === agent));
  const online = useClient((state) => state.status === "online");
  const label = current?.label ?? agent;
  const [info, setInfo] = useState<MethodResult<"agents.acp">>();
  const [settings, setSettings] = useState(() => acpAgentSettingsSchema.parse({}));
  const [directories, setDirectories] = useState("");
  const [editingServer, setEditingServer] = useState<number>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [providers, setProviders] = useState<AcpProvider[]>();
  const load = useCallback(async () => {
    const next = await link.call("agents.acp", { agent, sessionId }, 60_000);
    setInfo(next); setSettings(next.settings); setDirectories(next.settings.additionalDirectories.join("\n"));
  }, [agent, link, sessionId]);
  useEffect(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, [load]);
  const nextSettings = { ...settings, additionalDirectories: directories.split("\n").map((path) => path.trim()).filter(Boolean) };
  const dirty = !!info && JSON.stringify(nextSettings) !== JSON.stringify(info.settings);
  const unavailable = !online || !!busy;
  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name); setError(undefined); setSaved(false);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(undefined); }
  };
  const save = () => void run("save", async () => {
    await link.call("agents.configure", { agent, sessionId, settings: acpAgentSettingsSchema.parse(nextSettings) }, 60_000);
    await load(); await actions.refresh(); setSaved(true);
  });
  const close = () => {
    if (dirty) Alert.alert("还有未保存的更改", "保存后，这些设置才会应用到电脑上的 Agent。", [{ text: "继续编辑", style: "cancel" }, { text: "放弃更改", style: "destructive", onPress: () => router.back() }]);
    else router.back();
  };
  if (editingServer !== undefined) return <AcpServerEditor key={editingServer} server={settings.mcpServers[editingServer]} onClose={() => setEditingServer(undefined)} onRemove={settings.mcpServers[editingServer] ? () => {
    setSettings((value) => ({ ...value, mcpServers: value.mcpServers.filter((_, index) => index !== editingServer) })); setEditingServer(undefined);
  } : undefined} onDone={(server) => {
    setSettings((value) => ({ ...value, mcpServers: editingServer === value.mcpServers.length ? [...value.mcpServers, server] : value.mcpServers.map((entry, index) => index === editingServer ? server : entry) }));
    setEditingServer(undefined);
  }} />;
  return <AcpSheet title={sessionId ? "会话工具" : "连接与工具"} onClose={close} focusMessage={error} actions={info ? [{ key: "save", label: "保存更改", icon: { sf: "checkmark", md: "check" }, prominent: true, disabled: unavailable || !dirty, onPress: save }] : []}>
    {error ? <AcpBanner message={error} /> : null}
    {!online ? <AcpBanner kind="info" message="等待电脑连接，连上后即可修改设置。" /> : null}
    <AgentInteractions agent={agent} />
    {!info ? error ? <Button title="重新读取" onPress={() => void run("load", load)} disabled={!online || !!busy} busy={busy === "load"} /> : <AcpLoading /> : <>
      <AcpSection><View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}><AgentTile agent={agent} size={44} /><View style={{ flex: 1, gap: 4 }}><Text numberOfLines={2} accessibilityLabel={label} style={[type.headline, { color: colors.label }]}>{label}</Text><Text style={[type.footnote, { color: colors.secondaryLabel }]}>{sessionId ? "当前会话" : current?.auth?.state === "ok" ? "已登录" : "连接与工具"} · ACP {info.features.protocolVersion}</Text></View></View></AcpSection>
      {saved && !dirty ? <AcpBanner kind="success" message="设置已保存" /> : null}
      {!sessionId ? <AcpSection title="账号" padded={false}>
        {info.features.authMethods.length ? info.features.authMethods.map((method, index) => <Fragment key={method.id}>{index ? <AcpDivider /> : null}<AcpRow title={method.name} detail={method.description ?? (method.type === "terminal" ? "在电脑终端中完成登录" : "继续 Agent 提供的登录流程")} icon={method.type === "terminal" ? { sf: "terminal", md: "terminal" } : { sf: "person.crop.circle", md: "account_circle" }} disabled={unavailable} busy={busy === method.id} onPress={() => void run(method.id, async () => {
          const result = await link.call("agents.authenticate", { agent, methodId: method.id }, 0); await actions.refresh();
          if (result.terminalId) router.push({ pathname: "/terminal/[id]", params: { id: result.terminalId } });
        })} /></Fragment>) : <AcpRow title="使用电脑上的登录信息" detail="账号由 Agent 管理" icon={{ sf: "person.crop.circle", md: "account_circle" }} />}
        {info.features.logout ? <><AcpDivider /><AcpRow title="退出登录" destructive icon={{ sf: "rectangle.portrait.and.arrow.right", md: "logout" }} disabled={unavailable} busy={busy === "logout"} onPress={() => void run("logout", async () => { await link.call("agents.authenticate", { agent, logout: true }); await actions.refresh(); })} /></> : null}
      </AcpSection> : null}
      <AcpSection title="工具服务" padded={false} detail="让 Agent 访问额外的 MCP 工具和数据。">
        {settings.mcpServers.map((server, index) => <Fragment key={`${index}:${server.name}`}>{index ? <AcpDivider /> : null}<AcpRow title={server.name} detail={`${server.type === "stdio" ? "本地" : server.type.toUpperCase()} · ${"url" in server ? server.url : server.command}`} icon={{ sf: "server.rack", md: "dns" }} onPress={() => setEditingServer(index)} disabled={unavailable} /></Fragment>)}
        {settings.mcpServers.length ? <AcpDivider /> : <AcpRow title="尚未添加工具服务" detail="Agent 自带的工具仍然可用" icon={{ sf: "square.stack.3d.up", md: "layers" }} />}
        <AcpRow title="添加工具服务" icon={{ sf: "plus.circle", md: "add_circle" }} disabled={unavailable || settings.mcpServers.length >= 32} onPress={() => setEditingServer(settings.mcpServers.length)} />
      </AcpSection>
      <AcpSection title="工作范围">
        <AcpDisclosure title="附加目录" detail={nextSettings.additionalDirectories.length ? `已添加 ${nextSettings.additionalDirectories.length} 个目录` : "默认只使用会话的工作目录"}>
          <AcpField label="电脑上的目录" value={directories} onChange={setDirectories} multiline code editable={!unavailable && info.features.additionalDirectories} placeholder="/Users/you/another-project" helper="每行一个绝对路径。" />
          {!info.features.additionalDirectories ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>这个 Agent 当前不支持附加目录。</Text> : null}
        </AcpDisclosure>
      </AcpSection>
      {!sessionId && info.features.providers ? <AcpSection title="模型供应商">
        <AcpDisclosure title="管理供应商" detail={providers ? `${providers.length} 个可配置的供应商` : "配置模型服务和访问凭证"}>
          {providers ? providers.length ? providers.map((provider) => <ProviderForm key={provider.providerId} agent={agent} provider={provider} changed={setProviders} />) : <Text style={[type.footnote, { color: colors.secondaryLabel }]}>Agent 尚未提供供应商配置。</Text> : <Button title="读取供应商" busy={busy === "providers"} disabled={unavailable} onPress={() => void run("providers", async () => setProviders((await link.call("agents.providers", { agent, operation: "list" })).providers))} />}
        </AcpDisclosure>
      </AcpSection> : null}
      {!sessionId ? <AcpSection>
        <AcpDisclosure title="高级选项" detail={`ACP ${info.features.protocolVersion} · 实验扩展${settings.experimental ? "已开启" : "已关闭"}`}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}><View style={{ flex: 1, gap: 4 }}><Text style={[type.subhead, { color: colors.label }]}>尝试 ACP 2</Text><Text style={[type.footnote, { color: colors.secondaryLabel }]}>草案协议，需要 Agent 支持。</Text></View><Switch accessibilityLabel="尝试 ACP 2 草案" disabled={unavailable} trackColor={{ true: colors.accent }} value={settings.protocolVersion === 2} onValueChange={(on) => setSettings((value) => ({ ...value, protocolVersion: on ? 2 : 1 }))} /></View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}><View style={{ flex: 1, gap: 4 }}><Text style={[type.subhead, { color: colors.label }]}>实验扩展</Text><Text style={[type.footnote, { color: colors.secondaryLabel }]}>子代理、编辑建议等可选能力。</Text></View><Switch accessibilityLabel="实验扩展" disabled={unavailable} trackColor={{ true: colors.accent }} value={settings.experimental} onValueChange={(experimental) => setSettings((value) => ({ ...value, experimental }))} /></View>
          <Text style={[type.caption, { color: colors.secondaryLabel }]}>保存后会重新连接，请先结束运行中的会话。</Text>
        </AcpDisclosure>
      </AcpSection> : null}
      {dirty || busy === "save" ? <View style={{ gap: 8 }}><Button title="保存更改" variant="primary" size="large" busy={busy === "save"} disabled={unavailable} onPress={save} /><Text style={[type.caption, { color: colors.secondaryLabel, textAlign: "center" }]}>更改尚未应用到电脑</Text></View> : null}
    </>}
  </AcpSheet>;
}

function ProviderForm({ agent, provider, changed }: { agent: string; provider: AcpProvider; changed(value: AcpProvider[]): void }) {
  const { link } = useConnection();
  const online = useClient((state) => state.status === "online");
  const [apiType, setApiType] = useState(provider.current?.apiType ?? provider.supported[0] ?? "");
  const [url, setUrl] = useState(provider.current?.baseUrl ?? "");
  const [headers, setHeaders] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const submit = async (operation: "set" | "disable") => {
    setBusy(true); setError(undefined); setSaved(false);
    try { changed((await link.call("agents.providers", { agent, operation, config: { providerId: provider.providerId, apiType, baseUrl: operation === "set" ? url.trim() : undefined, headers: operation === "set" ? parseConfigRecord(headers) : undefined } })).providers); setHeaders("{}"); setSaved(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };
  return <View style={{ gap: 14, padding: 14, borderRadius: radius.row, backgroundColor: colors.fill }}>
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}><Icon sf="network" md="hub" size={18} color={colors.accent} /><Text style={[type.subhead, { flex: 1, color: colors.label, fontWeight: "600" }]}>{provider.providerId}</Text>{provider.required ? <Text style={[type.caption, { color: colors.secondaryLabel }]}>必需</Text> : null}</View>
    {error ? <AcpBanner message={error} /> : saved ? <AcpBanner kind="success" message="供应商已更新" /> : null}
    <AcpChoice label="API 协议" value={apiType} onChange={setApiType} choices={provider.supported.map((value) => ({ value, label: value }))} disabled={busy || !online} />
    <AcpField label="API 地址" value={url} onChange={(value) => { setUrl(value); setSaved(false); }} placeholder="https://…" keyboardType="url" code editable={!busy && online} />
    <AcpDisclosure title="访问凭证" detail="填写完整请求头；每次保存会替换原值。"><AcpField label="请求头（JSON）" value={headers} onChange={setHeaders} secureTextEntry code placeholder="{}" editable={!busy && online} /></AcpDisclosure>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Button title="保存供应商" busy={busy} disabled={!online || !url.trim() || !apiType} onPress={() => void submit("set")} />{!provider.required ? <Button title="停用" variant="plain" disabled={busy || !online} onPress={() => void submit("disable")} /> : null}</View>
  </View>;
}

function CustomAgents({ edit }: { edit?: string }) {
  const { link } = useConnection();
  const actions = useActions();
  const online = useClient((state) => state.status === "online");
  const [agents, setAgents] = useState<AcpRemoteAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(!!edit);
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
  }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setLoading(false)); }, [edit, link]);
  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error("连接标识请使用小写字母开头，可包含数字、短横线或下划线。");
      if (!label.trim() || !address.trim()) throw new Error("请填写显示名称和连接地址或命令。");
      if (transport === "http" && !/^https?:\/\//i.test(address.trim())) throw new Error("HTTP 连接需要以 https:// 或 http:// 开头的地址。");
      if (transport === "websocket" && !/^wss?:\/\//i.test(address.trim())) throw new Error("WebSocket 连接需要以 wss:// 或 ws:// 开头的地址。");
      const existing = agents.find((agent) => agent.id === id);
      if (!edit && existing) throw new Error("这个连接标识已经使用，请换一个标识，或返回列表编辑已有连接。");
      const agent = acpRemoteAgentSchema.parse({ ...existing, id, label: label.trim(), transport, command: transport === "stdio" ? address.trim() : undefined, url: transport === "stdio" ? undefined : address.trim(), args: args.split("\n").filter(Boolean), headerEnv: parseConfigRecord(headers) });
      await link.call("agents.custom", { save: agent }, 60_000); await actions.refresh(); router.replace({ pathname: "/acp", params: { agent: id } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };
  const showForm = adding || !loading && agents.length === 0;
  return <AcpSheet title={edit ? "编辑连接" : showForm ? "添加 ACP 连接" : "ACP 连接"} focusMessage={error} actions={showForm && !loading ? [{ key: "save", label: "保存连接", icon: { sf: "checkmark", md: "check" }, prominent: true, disabled: busy || !online, onPress: () => void save() }] : []}>
    {error ? <AcpBanner message={error} /> : null}
    {loading ? <AcpLoading /> : <>
      {!showForm ? <><AcpSection title="已配置的连接" padded={false}>{agents.map((agent, index) => <Fragment key={agent.id}>{index ? <AcpDivider /> : null}<AcpRow title={agent.label} detail={`${agent.transport === "stdio" ? "本地命令" : agent.transport.toUpperCase()} · ${agent.id}`} icon={{ sf: "point.3.connected.trianglepath.dotted", md: "hub" }} onPress={() => router.push({ pathname: "/acp", params: { edit: agent.id } })} /></Fragment>)}</AcpSection><Button title="添加连接" icon={{ sf: "plus", md: "add" }} variant="primary" size="large" disabled={!online} onPress={() => setAdding(true)} /></> : <>
        <AcpSection title="连接信息" detail="连接后，可在电脑页选择这个 Agent。">
          <AcpField label="显示名称" value={label} onChange={setLabel} placeholder="我的 Agent" editable={!busy && online} />
          <AcpChoice<AcpRemoteAgent["transport"]> label="连接方式" value={transport} onChange={setTransport} choices={[{ value: "stdio", label: "本地命令" }, { value: "http", label: "HTTP" }, { value: "websocket", label: "WebSocket" }]} disabled={busy || !online} />
          <AcpField label={transport === "stdio" ? "启动命令" : "服务地址"} value={address} onChange={setAddress} placeholder={transport === "stdio" ? "/path/to/agent" : transport === "http" ? "https://…/acp" : "wss://…/acp"} keyboardType={transport === "stdio" ? "default" : "url"} code editable={!busy && online} />
          <AcpField label="连接标识" value={id} onChange={setId} placeholder="my-agent" code editable={!edit && !busy && online} helper={edit ? "用于关联会话历史，创建后保持不变。" : "小写字母开头，可包含数字、短横线或下划线。"} />
        </AcpSection>
        <AcpSection><AcpDisclosure title="高级配置" detail={transport === "stdio" ? "启动参数" : "请求头与电脑环境变量"} initiallyOpen={!!edit && (args.length > 0 || headers !== "{}")}>
          {transport === "stdio" ? <AcpField label="启动参数" value={args} onChange={setArgs} multiline code placeholder="--acp" helper="每行一个参数。" editable={!busy && online} /> : <AcpField label="请求头映射（JSON）" value={headers} onChange={setHeaders} multiline code placeholder={'{"Authorization":"ACP_AUTHORIZATION"}'} helper="右侧填写电脑上的环境变量名，凭证保留在电脑上。" editable={!busy && online} />}
        </AcpDisclosure></AcpSection>
        <Button title="保存连接" variant="primary" size="large" busy={busy} disabled={!online || loading} onPress={() => void save()} />
        {edit ? <Button title="移除此连接" variant="destructive" disabled={busy || !online} onPress={() => Alert.alert("移除连接", "会话历史会保留。", [{ text: "取消", style: "cancel" }, { text: "移除", style: "destructive", onPress: () => { void link.call("agents.custom", { remove: edit }, 60_000).then(async () => { await actions.refresh(); router.back(); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); } }])} /> : agents.length ? <Button title="返回连接列表" variant="plain" onPress={() => setAdding(false)} /> : null}
      </>}
    </>}
  </AcpSheet>;
}
