import { useEffect, useState } from "react";
import { acpAgentSettingsSchema, acpRemoteAgentSchema, type AcpProvider, type AcpRemoteAgent, type MethodResult } from "@linkshell/wire";
import { ErrorNotice, useActions, useClient, useConnection, useJob } from "./common";
import { Permission } from "./Permission";

export function AgentInteractions({ agent }: { agent: string }) {
  const pending = useClient((state) => state.interactions[agent]);
  return <>{pending?.map((permission) => <Permission key={permission.requestId} permission={permission} sessionId={`agent:${agent}`} agent={agent} />)}</>;
}

export function AcpSettings({ agent, sessionId }: { agent: string; sessionId?: string }) {
  const { link } = useConnection();
  const actions = useActions();
  const job = useJob();
  const [info, setInfo] = useState<MethodResult<"agents.acp">>();
  const [settings, setSettings] = useState(() => acpAgentSettingsSchema.parse({}));
  const [directories, setDirectories] = useState("");
  const [mcp, setMcp] = useState("[]");
  const [providers, setProviders] = useState<AcpProvider[]>();
  const [terminal, setTerminal] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    let alive = true;
    void link.call("agents.acp", { agent, sessionId }, 60_000).then((value) => {
      if (!alive) return;
      setInfo(value); setSettings(value.settings); setDirectories(value.settings.additionalDirectories.join("\n")); setMcp(JSON.stringify(value.settings.mcpServers, null, 2));
    }, (error: unknown) => { if (alive) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; };
  }, [link, agent, sessionId]);
  return <section className="acp-settings">
    <h3>{agent} · {sessionId ? "会话工具" : "连接与工具"}</h3>
    <AgentInteractions agent={agent} />
    <ErrorNotice error={job.error ?? loadError} />
    {terminal ? <p className="muted">已创建登录终端，请在终端列表中打开它完成登录（{terminal}）。</p> : null}
    {info ? <>
      {!sessionId && <div className="acp-section"><h4>登录</h4><div className="permission-buttons">{info.features.authMethods.map((method) => <button className="button secondary" key={method.id} title={method.description} disabled={job.busy} onClick={() => void job.run(async () => { const result = await link.call("agents.authenticate", { agent, methodId: method.id }, 0); setTerminal(result.terminalId); await actions.refresh(); })}>{method.name}</button>)}{info.features.logout && <button className="button secondary" disabled={job.busy} onClick={() => void job.run(async () => { await link.call("agents.authenticate", { agent, logout: true }); await actions.refresh(); })}>退出登录</button>}</div>{!info.features.authMethods.length && <p className="muted">使用电脑上已有的登录信息。</p>}</div>}
      <form onSubmit={(event) => { event.preventDefault(); void job.run(async () => {
        const next = acpAgentSettingsSchema.parse({ ...settings, additionalDirectories: directories.split("\n").map((value) => value.trim()).filter(Boolean), mcpServers: JSON.parse(mcp) });
        await link.call("agents.configure", { agent, sessionId, settings: next }, 60_000); await actions.refresh(); setSaved(true);
      }); }}>
        <label>附加目录 · 每行一个绝对路径<textarea value={directories} onChange={(event) => { setDirectories(event.target.value); setSaved(false); }} placeholder="/path/to/project" /></label>
        <label>MCP 服务列表（JSON）<textarea className="code-input" rows={7} value={mcp} onChange={(event) => { setMcp(event.target.value); setSaved(false); }} spellCheck={false} /></label>
        <p className="muted">服务支持 stdio、HTTP、SSE 和 ACP，按需填写 command / args、url、env 或 headers。</p>
        {!sessionId && <><label className="choice-option"><input type="checkbox" checked={settings.protocolVersion === 2} onChange={(event) => setSettings((current) => ({ ...current, protocolVersion: event.target.checked ? 2 : 1 }))} />尝试 ACP 2 草案</label><label className="choice-option"><input type="checkbox" checked={settings.experimental} onChange={(event) => setSettings((current) => ({ ...current, experimental: event.target.checked }))} />实验扩展</label><p className="muted">当前 ACP {info.features.protocolVersion}。修改后重新建立连接，请先结束运行中的会话。</p></>}
        <button className="button primary" disabled={job.busy}>{saved ? "已保存" : "保存配置"}</button>
      </form>
      {!sessionId && info.features.providers && <div className="acp-section"><h4>模型供应商</h4>{providers ? providers.map((provider) => <Provider key={provider.providerId} agent={agent} provider={provider} changed={setProviders} />) : <button className="button secondary" onClick={() => void job.run(async () => setProviders((await link.call("agents.providers", { agent, operation: "list" })).providers))}>载入供应商</button>}</div>}
    </> : <p className="muted">正在读取 Agent 的能力…</p>}
  </section>;
}

function Provider({ agent, provider, changed }: { agent: string; provider: AcpProvider; changed(value: AcpProvider[]): void }) {
  const { link } = useConnection(); const job = useJob();
  const [apiType, setApiType] = useState(provider.current?.apiType ?? provider.supported[0] ?? "");
  const [url, setUrl] = useState(provider.current?.baseUrl ?? ""); const [headers, setHeaders] = useState("{}");
  return <form onSubmit={(event) => { event.preventDefault(); void job.run(async () => { changed((await link.call("agents.providers", { agent, operation: "set", config: { providerId: provider.providerId, apiType, baseUrl: url, headers: JSON.parse(headers) } })).providers); setHeaders("{}"); }); }}>
    <strong>{provider.providerId}{provider.required ? " · 必需" : ""}</strong>
    <label>API 协议<select value={apiType} onChange={(event) => setApiType(event.target.value)}>{provider.supported.map((value) => <option key={value}>{value}</option>)}</select></label>
    <label>API 地址<input type="url" required value={url} onChange={(event) => setUrl(event.target.value)} /></label>
    <label>完整请求头（JSON，每次保存会替换）<input type="password" value={headers} autoComplete="off" onChange={(event) => setHeaders(event.target.value)} /></label>
    <div className="permission-buttons"><button className="button secondary" disabled={job.busy}>保存供应商</button>{!provider.required && <button type="button" className="button secondary" disabled={job.busy} onClick={() => void job.run(async () => changed((await link.call("agents.providers", { agent, operation: "disable", config: { providerId: provider.providerId } })).providers))}>停用</button>}</div>
    <ErrorNotice error={job.error} />
  </form>;
}

export function AcpManager() {
  const { link } = useConnection(); const actions = useActions(); const job = useJob();
  const machine = useClient((state) => state.machine);
  const online = useClient((state) => state.status === "online");
  const [agent, setAgent] = useState(""); const [agents, setAgents] = useState<AcpRemoteAgent[]>();
  const [config, setConfig] = useState(JSON.stringify({ id: "my-agent", label: "我的 Agent", transport: "stdio", command: "", args: [] }, null, 2));
  return <section className="acp-settings"><h3>ACP 连接与工具</h3>
    <label>选择 Agent<select value={agent} onChange={(event) => setAgent(event.target.value)}><option value="">请选择</option>{machine?.agents.filter((entry) => entry.capabilities.acp).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
    {agent && <AcpSettings key={agent} agent={agent} />}
    <details><summary>自定义 ACP 连接</summary><p className="muted">支持本地命令、HTTP 和 WebSocket。远程认证使用 headerEnv，将请求头映射到电脑上的环境变量名称。</p>
      <button className="button secondary" disabled={!online || job.busy} onClick={() => void job.run(async () => setAgents((await link.call("agents.custom", {})).agents))}>载入连接</button>
      {agents?.map((entry) => <div className="browser-toolbar" key={entry.id}><strong>{entry.label}</strong><button className="text-button" onClick={() => setConfig(JSON.stringify(entry, null, 2))}>编辑</button><button className="text-button danger-text" onClick={() => void job.run(async () => { setAgents((await link.call("agents.custom", { remove: entry.id }, 60_000)).agents); await actions.refresh(); })}>移除</button></div>)}
      <form onSubmit={(event) => { event.preventDefault(); void job.run(async () => { const save = acpRemoteAgentSchema.parse(JSON.parse(config)); setAgents((await link.call("agents.custom", { save }, 60_000)).agents); await actions.refresh(); setAgent(save.id); }); }}><label>连接配置（JSON）<textarea className="code-input" rows={10} value={config} spellCheck={false} onChange={(event) => setConfig(event.target.value)} /></label><button className="button primary" disabled={!online || job.busy}>保存连接</button></form>
    </details><ErrorNotice error={job.error} />
  </section>;
}
