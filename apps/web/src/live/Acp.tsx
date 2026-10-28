import { Choice } from "@/components/Choice";
import { useDialogs } from "@/components/Dialogs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { useEffect, useId, useRef, useState } from "react";
import {
  acpAgentSettingsSchema,
  acpRemoteAgentSchema,
  type AcpProvider,
  type AcpRemoteAgent,
  type MethodResult,
} from "@linkshell/wire";
import {
  ErrorNotice,
  EmptyState,
  messageOf,
  useActions,
  useClient,
  useSessionOnline,
  useConnection,
  useJob,
} from "./common";
import { Permission } from "./Permission";

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label}不是有效的 JSON，请检查引号、逗号和括号。`);
  }
}

function invalidFields(issues: { path: (string | number)[] }[]) {
  const fields = [...new Set(issues.map((issue) => issue.path.join(".")))];
  return `请检查配置字段：${fields.filter(Boolean).slice(0, 4).join("、") || "配置格式"}。`;
}

function OfflineNotice() {
  return (
    <Alert>
      <AlertDescription>
        电脑尚未连接，暂时无法读取或保存配置。重新连接后可继续操作，当前填写的内容会保留。
      </AlertDescription>
    </Alert>
  );
}

export function AgentInteractions({ agent }: { agent: string }) {
  const pending = useClient((state) => state.interactions[agent]);
  return (
    <>
      {pending?.map((permission) => (
        <Permission
          key={permission.requestId}
          permission={permission}
          sessionId={`agent:${agent}`}
          agent={agent}
        />
      ))}
    </>
  );
}

export function AcpSettings(props: { agent: string; sessionId?: string }) {
  return (
    <AgentSettings key={`${props.agent}:${props.sessionId ?? ""}`} {...props} />
  );
}

function AgentSettings({
  agent,
  sessionId,
}: {
  agent: string;
  sessionId?: string;
}) {
  const { link } = useConnection();
  const actions = useActions();
  const dialogs = useDialogs();
  const online = useSessionOnline();
  const id = useId();
  const dirty = useRef(false);
  const job = useJob();
  const providerJob = useJob();
  const [info, setInfo] = useState<MethodResult<"agents.acp">>();
  const [settings, setSettings] = useState(() =>
    acpAgentSettingsSchema.parse({}),
  );
  const [directories, setDirectories] = useState("");
  const [mcp, setMcp] = useState("[]");
  const [providers, setProviders] = useState<AcpProvider[]>();
  const [terminal, setTerminal] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!online) return;
    let alive = true;
    setLoading(true);
    setLoadError(undefined);
    void link.call("agents.acp", { agent, sessionId }, 60_000).then(
      (value) => {
        if (!alive) return;
        setInfo(value);
        // Reconnection refreshes capabilities without erasing an unsaved draft.
        if (!dirty.current) {
          setSettings(value.settings);
          setDirectories(value.settings.additionalDirectories.join("\n"));
          setMcp(JSON.stringify(value.settings.mcpServers, null, 2));
        }
        setLoading(false);
      },
      (error: unknown) => {
        if (alive) {
          setLoadError(messageOf(error));
          setLoading(false);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [link, agent, sessionId, online, revision]);
  function edited() {
    dirty.current = true;
    setSaved(false);
    job.clear();
  }
  const disabled = !online || job.busy || loading;
  return (
    <section className="acp-settings min-w-0">
      <h3 className="break-words">
        {agent} · {sessionId ? "会话工具" : "连接与工具"}
      </h3>
      {!online && <OfflineNotice />}
      <AgentInteractions agent={agent} />
      <ErrorNotice error={job.error ?? loadError} />
      {loadError && online && (
        <Button
          variant="outline"
          className="justify-self-start"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          {loading ? "正在重试…" : "重新读取能力"}
        </Button>
      )}
      {terminal ? (
        <p className="muted break-all" role="status">
          已创建登录终端，请在终端列表中打开它完成登录（{terminal}）。
        </p>
      ) : null}
      {info ? (
        <>
          {!sessionId && (
            <div className="acp-section">
              <h4>登录</h4>
              <div className="permission-buttons">
                {info.features.authMethods.map((method) => (
                  <Button
                    variant="outline"
                    className="h-auto min-h-9 max-w-full whitespace-normal"
                    key={method.id}
                    title={method.description}
                    disabled={disabled}
                    onClick={() =>
                      void job.run(async () => {
                        setTerminal(undefined);
                        const result = await link.call(
                          "agents.authenticate",
                          { agent, methodId: method.id },
                          0,
                        );
                        setTerminal(result.terminalId);
                        await actions.refresh();
                        setRevision((value) => value + 1);
                      })
                    }
                  >
                    {method.name}
                  </Button>
                ))}
                {info.features.logout && (
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      void job.run(async () => {
                        if (
                          !(await dialogs.confirm(
                            `退出 ${agent} 的登录？之后可能需要在电脑上重新授权。`,
                          ))
                        )
                          return;
                        await link.call("agents.authenticate", {
                          agent,
                          logout: true,
                        });
                        await actions.refresh();
                        setTerminal(undefined);
                        setRevision((value) => value + 1);
                      })
                    }
                  >
                    退出登录
                  </Button>
                )}
              </div>
              {!info.features.authMethods.length && (
                <p className="muted">使用电脑上已有的登录信息。</p>
              )}
            </div>
          )}
          <form
            aria-busy={job.busy}
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled) return;
              void job.run(async () => {
                const paths = [
                  ...new Set(
                    directories
                      .split("\n")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  ),
                ];
                if (paths.some((path) => !/^(\/|[a-z]:[\\/]|\\\\)/i.test(path)))
                  throw new Error(
                    "附加目录需要填写电脑上的绝对路径，每行一个。",
                  );
                if (paths.length > 32)
                  throw new Error("最多支持 32 个附加目录。");
                const parsed = acpAgentSettingsSchema.safeParse({
                  ...settings,
                  additionalDirectories: paths,
                  mcpServers: parseJson(mcp, "MCP 服务列表"),
                });
                if (!parsed.success)
                  throw new Error(invalidFields(parsed.error.issues));
                await link.call(
                  "agents.configure",
                  { agent, sessionId, settings: parsed.data },
                  60_000,
                );
                dirty.current = false;
                setSettings(parsed.data);
                setSaved(true);
                await actions.refresh();
              });
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${id}-directories`}>附加目录</FieldLabel>
                <Textarea
                  id={`${id}-directories`}
                  value={directories}
                  disabled={disabled}
                  aria-describedby={`${id}-directories-help`}
                  onChange={(event) => {
                    setDirectories(event.target.value);
                    edited();
                  }}
                  placeholder="/path/to/project"
                  spellCheck={false}
                />
                <FieldDescription id={`${id}-directories-help`}>
                  每行一个电脑上的绝对路径，最多 32 个。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-mcp`}>
                  MCP 服务列表（JSON）
                </FieldLabel>
                <Textarea
                  id={`${id}-mcp`}
                  className="code-input min-w-0"
                  rows={7}
                  value={mcp}
                  disabled={disabled}
                  aria-describedby={`${id}-mcp-help`}
                  onChange={(event) => {
                    setMcp(event.target.value);
                    edited();
                  }}
                  spellCheck={false}
                />
                <FieldDescription id={`${id}-mcp-help`}>
                  填写 JSON 数组，例如 []。服务支持 stdio、HTTP、SSE 和
                  ACP，按需填写 command / args、url、env 或 headers。
                </FieldDescription>
              </Field>
              {!sessionId && (
                <FieldSet disabled={disabled}>
                  <FieldLegend variant="label">协议与扩展</FieldLegend>
                  <Field orientation="horizontal">
                    <Checkbox
                      id={`${id}-protocol`}
                      disabled={disabled}
                      checked={settings.protocolVersion === 2}
                      onCheckedChange={(checked) => {
                        setSettings((current) => ({
                          ...current,
                          protocolVersion: checked === true ? 2 : 1,
                        }));
                        edited();
                      }}
                    />
                    <FieldLabel htmlFor={`${id}-protocol`}>
                      尝试 ACP 2 草案
                    </FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <Checkbox
                      id={`${id}-experimental`}
                      disabled={disabled}
                      checked={settings.experimental}
                      onCheckedChange={(checked) => {
                        setSettings((current) => ({
                          ...current,
                          experimental: checked === true,
                        }));
                        edited();
                      }}
                    />
                    <FieldLabel htmlFor={`${id}-experimental`}>
                      实验扩展
                    </FieldLabel>
                  </Field>
                  <p className="muted">
                    当前 ACP {info.features.protocolVersion}
                    。修改后重新建立连接，请先结束运行中的会话。
                  </p>
                </FieldSet>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="default" disabled={disabled}>
                  {job.busy ? "正在处理…" : "保存配置"}
                </Button>
                {saved && (
                  <span className="muted" role="status">
                    配置已保存
                  </span>
                )}
              </div>
            </FieldGroup>
          </form>
          {!sessionId && info.features.providers && (
            <div className="acp-section">
              <h4>模型供应商</h4>
              <ErrorNotice error={providerJob.error} />
              {providers?.length === 0 && (
                <EmptyState
                  title="暂无可配置的供应商"
                  description="这个 Agent 没有返回供应商配置。"
                />
              )}
              {providers?.map((provider) => (
                <Provider
                  key={provider.providerId}
                  agent={agent}
                  provider={provider}
                  changed={setProviders}
                  job={providerJob}
                />
              ))}
              <Button
                variant="outline"
                disabled={!online || providerJob.busy}
                onClick={() =>
                  void providerJob.run(async () =>
                    setProviders(
                      (
                        await link.call("agents.providers", {
                          agent,
                          operation: "list",
                        })
                      ).providers,
                    ),
                  )
                }
              >
                {providerJob.busy
                  ? "正在处理…"
                  : providers
                    ? "刷新供应商"
                    : "载入供应商"}
              </Button>
            </div>
          )}
        </>
      ) : online && loading ? (
        <div role="status" className="flex flex-col gap-3">
          <p className="muted">正在读取 Agent 的能力…</p>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : null}
    </section>
  );
}

function Provider({
  agent,
  provider,
  changed,
  job,
}: {
  agent: string;
  provider: AcpProvider;
  changed(value: AcpProvider[]): void;
  job: ReturnType<typeof useJob>;
}) {
  const { link } = useConnection();
  const online = useSessionOnline();
  const dialogs = useDialogs();
  const id = useId();
  const dirty = useRef(false);
  const [apiType, setApiType] = useState(
    provider.current?.apiType ?? provider.supported[0] ?? "",
  );
  const [url, setUrl] = useState(provider.current?.baseUrl ?? "");
  // Existing secrets are intentionally never returned by the host.
  const [headers, setHeaders] = useState("");
  const [errors, setErrors] = useState<{
    api?: string;
    url?: string;
    headers?: string;
  }>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (dirty.current) return;
    setApiType(provider.current?.apiType ?? provider.supported[0] ?? "");
    setUrl(provider.current?.baseUrl ?? "");
  }, [provider]);
  const disabled = !online || job.busy;
  function edited() {
    dirty.current = true;
    setErrors({});
    setSaved(false);
    job.clear();
  }
  return (
    <form
      aria-busy={job.busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        setErrors({});
        let requestHeaders: Record<string, string>;
        let field: "api" | "url" | "headers" = "headers";
        try {
          const parsed = parseJson(headers, "请求头");
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.values(parsed).some((value) => typeof value !== "string")
          )
            throw new Error("请求头必须是 JSON 对象，每个值都需要是字符串。");
          requestHeaders = parsed as Record<string, string>;
          field = "api";
          if (!provider.supported.includes(apiType))
            throw new Error("请选择这个供应商支持的 API 协议。");
          field = "url";
          if (!["http:", "https:"].includes(new URL(url.trim()).protocol))
            throw new Error("API 地址需要以 http:// 或 https:// 开头。");
        } catch (reason) {
          setErrors({
            [field]:
              reason instanceof TypeError
                ? "请输入有效的 API 地址。"
                : messageOf(reason),
          });
          return;
        }
        void job.run(async () => {
          if (
            provider.current &&
            !Object.keys(requestHeaders).length &&
            !(await dialogs.confirm(
              `保存将清空 ${provider.providerId} 的现有认证请求头，确认继续？`,
            ))
          )
            return;
          const result = await link.call("agents.providers", {
            agent,
            operation: "set",
            config: {
              providerId: provider.providerId,
              apiType,
              baseUrl: url.trim(),
              headers: requestHeaders,
            },
          });
          dirty.current = false;
          changed(result.providers);
          setHeaders("");
          setSaved(true);
        });
      }}
    >
      <strong className="break-all">
        {provider.providerId}
        {provider.required ? " · 必需" : ""}
      </strong>
      <FieldGroup>
        <Field data-invalid={!!errors.api}>
          <FieldLabel htmlFor={`${id}-api`}>API 协议</FieldLabel>
          <Choice
            id={`${id}-api`}
            label="API 协议"
            value={apiType}
            onValueChange={(value) => {
              setApiType(value);
              edited();
            }}
            disabled={disabled}
            options={provider.supported.map((value) => ({
              value,
              label: value,
            }))}
          />
          <FieldError>{errors.api}</FieldError>
          {!provider.supported.length && (
            <FieldDescription>
              这个供应商没有返回可用的 API 协议。
            </FieldDescription>
          )}
        </Field>
        <Field data-invalid={!!errors.url}>
          <FieldLabel htmlFor={`${id}-url`}>API 地址</FieldLabel>
          <Input
            id={`${id}-url`}
            type="url"
            required
            value={url}
            disabled={disabled}
            aria-invalid={!!errors.url}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setUrl(event.target.value);
              edited();
            }}
          />
          <FieldError>{errors.url}</FieldError>
        </Field>
        <Field data-invalid={!!errors.headers}>
          <FieldLabel htmlFor={`${id}-headers`}>完整请求头（JSON）</FieldLabel>
          <Input
            id={`${id}-headers`}
            type="password"
            value={headers}
            required
            disabled={disabled}
            aria-invalid={!!errors.headers}
            aria-describedby={`${id}-headers-help`}
            autoComplete="off"
            placeholder='{"Authorization":"Bearer …"}'
            onChange={(event) => {
              setHeaders(event.target.value);
              edited();
            }}
          />
          <FieldDescription id={`${id}-headers-help`}>
            每次保存都会替换全部请求头，已有密钥不会显示。请重新填写完整内容；填写{" "}
            {"{}"} 表示不使用认证请求头。
          </FieldDescription>
          <FieldError>{errors.headers}</FieldError>
        </Field>
        <div className="permission-buttons">
          <Button
            type="submit"
            variant="outline"
            disabled={disabled || !provider.supported.length}
          >
            保存供应商
          </Button>
          {!provider.required && provider.current && (
            <Button
              variant="outline"
              type="button"
              disabled={disabled}
              onClick={() =>
                void job.run(async () => {
                  if (
                    !(await dialogs.confirm(
                      `停用 ${provider.providerId}？使用这个供应商的请求将无法继续。`,
                    ))
                  )
                    return;
                  changed(
                    (
                      await link.call("agents.providers", {
                        agent,
                        operation: "disable",
                        config: { providerId: provider.providerId },
                      })
                    ).providers,
                  );
                  dirty.current = false;
                  setSaved(false);
                })
              }
            >
              停用
            </Button>
          )}
        </div>
        {saved && (
          <span className="muted" role="status">
            供应商已保存
          </span>
        )}
      </FieldGroup>
    </form>
  );
}

export function AcpManager() {
  const { link } = useConnection();
  const actions = useActions();
  const dialogs = useDialogs();
  const id = useId();
  const job = useJob();
  const machine = useClient((state) => state.machine);
  const online = useSessionOnline();
  const [agent, setAgent] = useState("");
  const [agents, setAgents] = useState<AcpRemoteAgent[]>();
  const [editing, setEditing] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [config, setConfig] = useState(
    JSON.stringify(
      {
        id: "my-agent",
        label: "我的 Agent",
        transport: "stdio",
        command: "",
        args: [],
      },
      null,
      2,
    ),
  );
  const options =
    machine?.agents
      .filter((entry) => entry.capabilities.acp)
      .map((entry) => ({ value: entry.id, label: entry.label })) ?? [];
  const disabled = !online || job.busy;
  return (
    <section className="acp-settings min-w-0">
      <div className="acp-settings-heading">
        <h3>ACP 连接与工具</h3>
        <p className="muted">
          管理 Agent 的登录、工具权限和自定义连接。配置保存在当前电脑上。
        </p>
      </div>
      {!online && <OfflineNotice />}
      <Field className="acp-agent-field" orientation="horizontal">
        <FieldLabel htmlFor={`${id}-agent`}>选择 Agent</FieldLabel>
        <Choice
          id={`${id}-agent`}
          label="选择 Agent"
          value={agent}
          onValueChange={setAgent}
          disabled={!online}
          placeholder={
            options.length
              ? "选择要配置的 Agent"
              : "当前电脑没有可用的 ACP Agent"
          }
          options={options}
        />
      </Field>
      {agent && options.some((option) => option.value === agent) && (
        <AcpSettings key={agent} agent={agent} />
      )}
      <details className="min-w-0">
        <summary className="cursor-pointer">自定义 ACP 连接</summary>
        <div className="flex min-w-0 flex-col gap-4 pt-4">
          <p className="muted">
            支持本地命令、HTTP 和 WebSocket。远程认证使用
            headerEnv，将请求头映射到电脑上的环境变量名称。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!online || job.busy}
              onClick={() =>
                void job.run(async () =>
                  setAgents((await link.call("agents.custom", {})).agents),
                )
              }
            >
              {job.busy ? "正在处理…" : agents ? "刷新连接" : "载入连接"}
            </Button>
            {editing && (
              <Button
                variant="ghost"
                disabled={job.busy}
                onClick={() => {
                  setEditing(undefined);
                  setConfig(
                    JSON.stringify(
                      {
                        id: "my-agent",
                        label: "我的 Agent",
                        transport: "stdio",
                        command: "",
                        args: [],
                      },
                      null,
                      2,
                    ),
                  );
                  setError(undefined);
                  setSaved(false);
                }}
              >
                新建连接
              </Button>
            )}
          </div>
          <ErrorNotice error={job.error} />
          {agents?.length === 0 && (
            <EmptyState
              title="尚未添加自定义连接"
              description="在下方填写配置，将其他 ACP Agent 添加到当前电脑。"
            />
          )}
          {agents?.map((entry) => (
            <div
              className="flex min-w-0 flex-wrap items-center justify-between gap-3"
              key={entry.id}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <strong className="break-words">{entry.label}</strong>
                <span className="muted break-all">
                  {entry.id} · {entry.transport}
                </span>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={job.busy}
                  aria-label={`编辑 ${entry.label}`}
                  onClick={() => {
                    setConfig(JSON.stringify(entry, null, 2));
                    setEditing(entry.id);
                    setError(undefined);
                    setSaved(false);
                  }}
                >
                  编辑
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  aria-label={`移除 ${entry.label}`}
                  onClick={() =>
                    void job.run(async () => {
                      if (
                        !(await dialogs.confirm(
                          `移除自定义连接「${entry.label}」？之后无法再用它创建会话；如需恢复，需要重新添加配置。`,
                        ))
                      )
                        return;
                      setAgents(
                        (
                          await link.call(
                            "agents.custom",
                            { remove: entry.id },
                            60_000,
                          )
                        ).agents,
                      );
                      if (agent === entry.id) setAgent("");
                      if (editing === entry.id) {
                        setEditing(undefined);
                        setConfig(
                          JSON.stringify(
                            {
                              id: "my-agent",
                              label: "我的 Agent",
                              transport: "stdio",
                              command: "",
                              args: [],
                            },
                            null,
                            2,
                          ),
                        );
                        setSaved(false);
                      }
                      await actions.refresh();
                    })
                  }
                >
                  移除
                </Button>
              </div>
            </div>
          ))}
          <form
            aria-busy={job.busy}
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled) return;
              setError(undefined);
              let save: AcpRemoteAgent;
              try {
                const parsed = acpRemoteAgentSchema.safeParse(
                  parseJson(config, "连接配置"),
                );
                if (!parsed.success)
                  throw new Error(invalidFields(parsed.error.issues));
                save = parsed.data;
                if (!save.label.trim())
                  throw new Error("请填写连接的显示名称 label。");
                if (editing && save.id !== editing)
                  throw new Error(
                    "编辑连接时不能修改 id。如需另建连接，请先选择「新建连接」。",
                  );
                if (save.transport === "stdio" && !save.command?.trim())
                  throw new Error(
                    "本地命令连接需要填写 command，例如 npx 或 Agent 的可执行文件路径。",
                  );
                if (save.transport !== "stdio") {
                  if (!save.url) throw new Error("远程连接需要填写 url。");
                  const protocols =
                    save.transport === "http"
                      ? ["http:", "https:"]
                      : ["ws:", "wss:"];
                  if (!protocols.includes(new URL(save.url).protocol))
                    throw new Error(
                      save.transport === "http"
                        ? "HTTP 连接的 url 需要以 http:// 或 https:// 开头。"
                        : "WebSocket 连接的 url 需要以 ws:// 或 wss:// 开头。",
                    );
                }
              } catch (reason) {
                setError(messageOf(reason));
                return;
              }
              void job.run(async () => {
                // A stale or unopened list must not let a new draft silently overwrite an existing ID.
                if (!editing) {
                  const existing = (await link.call("agents.custom", {}))
                    .agents;
                  setAgents(existing);
                  if (
                    existing.some((entry) => entry.id === save.id) &&
                    !(await dialogs.confirm(
                      `连接 ${save.id} 已存在。保存会覆盖它的配置，确认继续？`,
                    ))
                  )
                    return;
                }
                setAgents(
                  (await link.call("agents.custom", { save }, 60_000)).agents,
                );
                setEditing(save.id);
                setSaved(true);
                await actions.refresh();
                setAgent(save.id);
              });
            }}
          >
            <FieldGroup>
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor={`${id}-config`}>
                  {editing ? "编辑连接配置" : "新建连接配置"}（JSON）
                </FieldLabel>
                <Textarea
                  id={`${id}-config`}
                  className="code-input min-w-0"
                  rows={10}
                  value={config}
                  spellCheck={false}
                  disabled={job.busy}
                  aria-invalid={!!error}
                  aria-describedby={`${id}-config-help`}
                  onChange={(event) => {
                    setConfig(event.target.value);
                    setError(undefined);
                    setSaved(false);
                    job.clear();
                  }}
                />
                <FieldDescription id={`${id}-config-help`}>
                  id
                  使用小写字母开头，只包含字母、数字、下划线或短横线。本地连接填写
                  command；远程连接填写 url。
                </FieldDescription>
                <FieldError>{error}</FieldError>
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="default" disabled={disabled}>
                  {job.busy ? "正在处理…" : "保存连接"}
                </Button>
                {saved && (
                  <span className="muted" role="status">
                    连接已保存
                  </span>
                )}
              </div>
            </FieldGroup>
          </form>
        </div>
      </details>
    </section>
  );
}
