import { mcpServerSchema, type AcpMcpServer } from "@linkshell/wire";
import { useState } from "react";
import { Button } from "./button";
import { AcpBanner, AcpChoice, AcpDisclosure, AcpField, AcpSection, AcpSheet } from "./acp-settings-ui";

export function parseConfigRecord(value: string): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("请填写有效的 JSON 对象，例如 {\"名称\":\"值\"}。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((entry) => typeof entry !== "string")) throw new Error("配置中的名称和值都需要是文本。");
  return parsed as Record<string, string>;
}

export function AcpServerEditor({ server, onDone, onClose, onRemove }: { server?: AcpMcpServer; onDone(server: AcpMcpServer): void; onClose(): void; onRemove?(): void }) {
  const [transport, setTransport] = useState<AcpMcpServer["type"]>(server?.type ?? "stdio");
  const [name, setName] = useState(server?.name ?? "");
  const [command, setCommand] = useState(server && "command" in server ? server.command : "");
  const [url, setUrl] = useState(server && "url" in server ? server.url : "");
  const [args, setArgs] = useState(server && "args" in server ? server.args.join("\n") : "");
  const [env, setEnv] = useState(JSON.stringify(server && "env" in server ? server.env : {}, null, 2));
  const [headers, setHeaders] = useState(JSON.stringify(server && "headers" in server ? server.headers : {}, null, 2));
  const [error, setError] = useState<string>();
  const local = transport === "stdio" || transport === "acp";
  const finish = () => {
    setError(undefined);
    try {
      if (!name.trim()) throw new Error("请为工具服务填写名称。");
      if (local && !command.trim()) throw new Error("请填写电脑上运行的命令。");
      if (!local && !/^https?:\/\//i.test(url.trim())) throw new Error("请填写以 https:// 或 http:// 开头的服务地址。");
      const parsed = mcpServerSchema.safeParse(local
        ? { type: transport, name: name.trim(), command: command.trim(), args: args.split("\n").filter(Boolean), env: parseConfigRecord(env) }
        : { type: transport, name: name.trim(), url: url.trim(), headers: parseConfigRecord(headers) });
      if (!parsed.success) throw new Error("请检查服务地址或启动命令的格式。");
      onDone(parsed.data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <AcpSheet title={server ? "编辑工具服务" : "添加工具服务"} onClose={onClose} focusMessage={error} actions={[{ key: "done", label: "完成", icon: { sf: "checkmark", md: "check" }, prominent: true, onPress: finish }]}>
    {error ? <AcpBanner message={error} /> : null}
    <AcpSection title="服务信息" detail="完成后，在连接设置中保存更改。">
      <AcpField label="服务名称" value={name} onChange={setName} placeholder="例如：项目文档" autoFocus={!server} />
      <AcpChoice<AcpMcpServer["type"]> label="连接方式" value={transport} onChange={setTransport} choices={[{ value: "stdio", label: "本地" }, { value: "http", label: "HTTP" }, { value: "sse", label: "SSE" }, { value: "acp", label: "ACP" }]} />
      <AcpField label={local ? "启动命令" : "服务地址"} value={local ? command : url} onChange={local ? setCommand : setUrl} placeholder={local ? "/path/to/mcp-server" : "https://example.com/mcp"} keyboardType={local ? "default" : "url"} code helper={local ? "命令在连接的电脑上运行。" : undefined} />
    </AcpSection>
    <AcpSection>
      <AcpDisclosure title="高级配置" detail={local ? "启动参数与环境变量" : "服务需要的请求头"} initiallyOpen={!!server && (local ? args.length > 0 || env !== "{}" : headers !== "{}")}>
        {local ? <><AcpField label="启动参数" value={args} onChange={setArgs} multiline code placeholder={"--directory\n/path/to/project"} helper="每行一个参数，顺序会保留。" /><AcpField label="环境变量（JSON）" value={env} onChange={setEnv} multiline code placeholder="{}" /></> : <AcpField label="请求头（JSON）" value={headers} onChange={setHeaders} multiline code placeholder="{}" />}
      </AcpDisclosure>
    </AcpSection>
    <Button title="完成" variant="primary" size="large" onPress={finish} />
    {onRemove ? <Button title="移除工具服务" variant="destructive" onPress={onRemove} /> : null}
  </AcpSheet>;
}
