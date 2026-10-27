import { PageHeader } from "../components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupButton,
} from "@/components/ui/input-group";
import {
  ArrowUpRight,
  CircleAlert,
  Globe,
  LoaderCircle,
  Maximize,
  Minimize,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { httpStreamRequest } from "./http-stream";
import { useEffect, useId, useReducer, useRef, useState, type KeyboardEvent } from "react";
import {
  ErrorNotice,
  EmptyState,
  LoadState,
  useConnection,
  useLoad,
  messageOf,
} from "./common";
import { socketBootstrap } from "./Video";
import { openWebSocket } from "./transport";
import { isDesktop } from "./desktop";
import { initialPortTabs, portTabsReducer } from "./port-tabs";

function previewOrigin() {
  const configured = window.__LINKSHELL_CONFIG__?.previewOrigin;
  const local =
    import.meta.env.DEV &&
    ["localhost", "127.0.0.1"].includes(location.hostname)
      ? `${location.protocol}//${location.hostname === "localhost" ? "127.0.0.1" : "localhost"}:${location.port}`
      : undefined;
  if (!configured && !local) return undefined;
  let url: URL;
  try {
    url = new URL(configured ?? local!);
  } catch {
    return undefined;
  }
  if (
    url.origin === location.origin ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return undefined;
  if (location.protocol === "https:" && url.protocol !== "https:")
    return undefined;
  return url.origin;
}
export function PortPreview({ port, retry }: { port: number; retry(): void }) {
  const { streams } = useConnection();
  const ref = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string>();
  const [waiting, setWaiting] = useState(true);
  const [slow, setSlow] = useState(false);
  const [channel] = useState(() => crypto.randomUUID());
  const origin = previewOrigin();
  useEffect(() => {
    if (!origin) return;
    let alive = true;
    let rootRequest: string | undefined;
    const timeout = setTimeout(() => {
      if (alive) setSlow(true);
    }, 15_000);
    const finish = (id: string, reason?: string) => {
      if (!alive || id !== rootRequest) return;
      clearTimeout(timeout);
      setWaiting(false);
      if (reason) setError(reason);
    };
    const sockets = new Map<
      string,
      Awaited<ReturnType<typeof openWebSocket>>
    >();
    const pending = new Set<string>();
    let requests = 0;
    const cookies = new Map<string, string>();
    const http = new Map<string, AbortController>();
    const reply = (message: object) => {
      if (alive)
        ref.current?.contentWindow?.postMessage(
          { ...message, channel },
          origin,
        );
    };
    const listen = (event: MessageEvent) => {
      if (
        event.source !== ref.current?.contentWindow ||
        event.origin !== origin ||
        event.data?.channel !== channel
      )
        return;
      const message = event.data as {
        type: string;
        id: string;
        path?: string;
        method?: string;
        headers?: [string, string][];
        body?: ArrayBuffer;
        url?: string;
        protocols?: string[];
        data?: string | ArrayBuffer;
      };
      if (message.type === "preview-ready")
        reply({ type: "preview-init", bootstrap: socketBootstrap.toString() });
      if (message.type === "http-cancel") http.get(message.id)?.abort();
      if (message.type === "http-request") {
        rootRequest ??= message.id;
        if (++requests > 128) {
          requests--;
          reply({
            type: "http-error",
            id: message.id,
            error: "同时请求过多",
          });
          return;
        }
        const headers = (message.headers ?? []).filter(
          ([name]) => !/^(cookie|proxy-authorization)$/i.test(name),
        );
        if (cookies.size)
          headers.push([
            "cookie",
            [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
          ]);
        const abort = new AbortController();
        http.set(message.id, abort);
        void httpStreamRequest(
          streams,
          port,
          message.path ?? "/",
          message.method ?? "GET",
          headers,
          message.body ? new Uint8Array(message.body) : new Uint8Array(),
          abort.signal,
        )
          .then(async (response) => {
            if (message.id === rootRequest && response.status >= 400 && alive)
              setError(
                `开发服务返回 HTTP ${response.status}。请检查电脑上的服务日志后重试。`,
              );
            for (const [key, value] of response.headers)
              if (key === "set-cookie") {
                const pair = value.split(";")[0];
                const index = pair.indexOf("=");
                if (index > 0) {
                  const name = pair.slice(0, index);
                  if (/max-age=0/i.test(value)) cookies.delete(name);
                  else cookies.set(name, pair.slice(index + 1));
                }
              }
            let body = response.body;
            const encoding = response.headers.find(
              ([key]) => key === "content-encoding",
            )?.[1];
            if (
              message.method !== "HEAD" &&
              ![204, 205, 304].includes(response.status) &&
              (encoding === "gzip" || encoding === "deflate")
            )
              body = body.pipeThrough(new DecompressionStream(encoding));
            else if (
              encoding &&
              !["identity", "gzip", "deflate"].includes(encoding)
            )
              throw new Error(`预览暂不支持 ${encoding} 压缩`);
            reply({
              type: "http-head",
              id: message.id,
              status: response.status,
              headers: response.headers,
            });
            const reader = body.getReader();
            try {
              while (alive) {
                const chunk = await reader.read();
                if (chunk.done) break;
                reply({
                  type: "http-chunk",
                  id: message.id,
                  body: chunk.value,
                });
              }
            } finally {
              reader.releaseLock();
              if (!alive) abort.abort();
            }
            reply({ type: "http-end", id: message.id });
            finish(message.id);
          })
          .catch((error) => {
            finish(message.id, `无法连接端口 ${port}：${messageOf(error)}`);
            abort.abort();
            reply({ type: "http-error", id: message.id, error: String(error) });
          })
          .finally(() => {
            http.delete(message.id);
            requests--;
          });
      }
      if (message.type === "ws-open") {
        if (
          sockets.has(message.id) ||
          pending.has(message.id) ||
          sockets.size + pending.size >= 24
        )
          return;
        try {
          const url = new URL(message.url!, origin);
          const local = [
            new URL(origin).hostname,
            "localhost",
            "127.0.0.1",
          ].includes(url.hostname);
          if (!local || !["ws:", "wss:"].includes(url.protocol))
            throw new Error("仅代理当前预览端口的 WebSocket");
          const path =
            url.pathname.replace(
              new RegExp(`^/preview/view/${channel}/`),
              "/",
            ) + url.search;
          pending.add(message.id);
          void openWebSocket(
            streams,
            port,
            path,
            {
              open: () => reply({ type: "ws-open", id: message.id }),
              data: (data) => reply({ type: "ws-data", id: message.id, data }),
              close: (reason) => {
                pending.delete(message.id);
                sockets.delete(message.id);
                reply({ type: "ws-close", id: message.id, reason });
              },
            },
            message.protocols,
          ).then(
            (socket) => {
              if (!alive || !pending.has(message.id)) socket.close();
              else {
                pending.delete(message.id);
                sockets.set(message.id, socket);
              }
            },
            (error) => {
              pending.delete(message.id);
              reply({
                type: "ws-close",
                id: message.id,
                reason: String(error),
              });
            },
          );
        } catch (error) {
          reply({ type: "ws-close", id: message.id, reason: String(error) });
        }
      }
      if (
        message.type === "ws-send" &&
        (typeof message.data === "string" ||
          message.data instanceof ArrayBuffer)
      )
        sockets.get(message.id)?.send(message.data);
      if (message.type === "ws-close") {
        pending.delete(message.id);
        sockets.get(message.id)?.close();
        sockets.delete(message.id);
      }
    };
    window.addEventListener("message", listen);
    return () => {
      alive = false;
      clearTimeout(timeout);
      window.removeEventListener("message", listen);
      for (const socket of sockets.values()) socket.close();
      pending.clear();
      for (const request of http.values()) request.abort();
      http.clear();
    };
  }, [streams, port, channel, origin]);
  if (!origin)
    return (
      <Alert>
        <ShieldCheck />
        <AlertTitle>当前部署尚未启用网页预览</AlertTitle>
        <AlertDescription>
          需要配置独立的预览域名后，才能安全打开电脑上的开发服务。请联系管理员设置
          previewOrigin，并在该域名部署 preview 目录。
        </AlertDescription>
      </Alert>
    );
  return (
    <div className="resource-preview-body">
      {error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>预览遇到问题</AlertTitle>
          <AlertDescription>
            {error}
            <div className="resource-alert-actions">
              <Button variant="outline" size="sm" onClick={retry}>
                重新连接预览
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {waiting && !error && (
        <div className="resource-preview-loading" role="status">
          <LoaderCircle className="animate-spin" />
          <div>
            <strong>{slow ? "连接时间较长" : "正在连接开发服务…"}</strong>
            <p>
              {slow
                ? "请确认电脑上的服务仍在运行，也可以重新连接。"
                : `正在请求电脑上的 127.0.0.1:${port}`}
            </p>
          </div>
          {slow && (
            <Button variant="outline" size="sm" onClick={retry}>
              重试
            </Button>
          )}
        </div>
      )}
      <iframe
        className="port-frame"
        ref={ref}
        title={`端口 ${port} 预览`}
        src={`${origin}/preview/bridge.html#${channel}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-pointer-lock"
        allow="autoplay; fullscreen"
        onLoad={() =>
          ref.current?.contentWindow?.postMessage(
            {
              channel,
              type: "preview-init",
              bootstrap: socketBootstrap.toString(),
            },
            origin,
          )
        }
        onError={() => {
          setWaiting(false);
          setError("隔离预览页面加载失败，请检查预览域名配置");
        }}
      />
    </div>
  );
}
export function Ports() {
  const { link } = useConnection();
  const load = useLoad(() => link.call("ports.list", {}), [link], 10000);
  const [{ tabs, selected, focused }, dispatch] = useReducer(portTabsReducer, initialPortTabs);
  const [manual, setManual] = useState("");
  const [addingPort, setAddingPort] = useState(false);
  const [newPort, setNewPort] = useState("");
  const [error, setError] = useState<string>();
  const preview = useRef<HTMLDivElement>(null);
  const manualField = useRef<HTMLInputElement>(null);
  const tabId = useId();
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const changed = () =>
      setFullscreen(document.fullscreenElement === preview.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const services = [...(load.value?.ports ?? [])].sort(
    (a, b) => Number(b.http) - Number(a.http) || a.port - b.port,
  );
  const current = services.find((entry) => entry.port === selected);
  function open(port: number) {
    dispatch({ type: "open", port, multiple: isDesktop });
    setManual(String(port));
    setError(undefined);
    setAddingPort(false);
  }
  function select(port: number) {
    dispatch({ type: "select", port });
    setManual(String(port));
    setError(undefined);
  }
  function close(port: number) {
    const next = portTabsReducer({ tabs, selected, focused }, { type: "close", port });
    dispatch({ type: "close", port });
    setError(undefined);
    if (next.selected !== undefined) setManual(String(next.selected));
    requestAnimationFrame(() => {
      if (next.selected === undefined) manualField.current?.focus();
      else document.getElementById(`${tabId}-tab-${next.selected}`)?.focus();
    });
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, port: number) {
    const index = tabs.findIndex((tab) => tab.port === port);
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
    if (next !== undefined) {
      event.preventDefault();
      select(tabs[next].port);
      document.getElementById(`${tabId}-tab-${tabs[next].port}`)?.focus();
    } else if (event.key === "Delete") {
      event.preventDefault();
      close(port);
    }
  }
  const retry = (port = selected) => {
    if (port !== undefined) dispatch({ type: "refresh", port });
  };
  return (
    <section className="ports-page resource-ports">
      <PageHeader
        title="端口预览"
        actions={<>
      <Button variant="ghost" size="sm" disabled={load.loading} onClick={load.reload}>
        <RefreshCw data-icon="inline-start" className={load.loading ? "animate-spin" : undefined} />
        刷新
      </Button>
        </>}
        detail={services.length ? <span>{services.length} 个服务</span> : undefined}
      />
      <div className="resource-port-connect">
        <div className="resource-port-connect-copy">
          <ShieldCheck aria-hidden="true" />
          <span>电脑本地服务 · 加密连接</span>
        </div>
        <form
          className="resource-port-form"
          onSubmit={(event) => {
            event.preventDefault();
            const port = Number(manual);
            if (Number.isInteger(port) && port >= 1 && port <= 65535)
              open(port);
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel className="sr-only">端口号</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <Server aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  ref={manualField}
                  aria-label="预览端口"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="65535"
                  step="1"
                  value={manual}
                  onChange={(event) => setManual(event.target.value)}
                  required
                  placeholder="输入端口，如 3000"
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    type="submit"
                    variant="secondary"
                    disabled={!manual}
                  >
                    打开
                    <ArrowUpRight data-icon="inline-end" />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </FieldGroup>
        </form>
      </div>
      <LoadState {...load} />
      {load.error && (
        <div className="resource-retry">
          <span className="resource-caption">
            服务发现失败，仍可输入端口手动打开。
          </span>
          <Button variant="outline" size="sm" onClick={load.reload}>
            重新发现
          </Button>
        </div>
      )}
      {!!services.length && (
        <section className="resource-services" aria-label="已发现的开发服务">
          {!isDesktop && (
            <div className="resource-directory-summary">
              <span>已发现 {services.length} 个服务</span>
              <span>每 10 秒自动更新</span>
            </div>
          )}
          <div className="resource-service-list">
            {services.map((port) => (
              <Button
                variant={selected === port.port ? "secondary" : "ghost"}
                key={port.port}
                className="resource-service"
                aria-pressed={selected === port.port}
                title={[
                  port.title ?? port.process,
                  port.cwd,
                  `端口 ${port.port}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                onClick={() => open(port.port)}
              >
                <Globe data-icon="inline-start" />
                <span className="resource-service-main">
                  <strong>{port.title || port.process || "开发服务"}</strong>
                  <span>
                    {port.cwd || port.process}
                    {!port.http ? " · 未识别为 HTTP" : ""}
                  </span>
                </span>
                <Badge variant="outline">{port.port}</Badge>
              </Button>
            ))}
          </div>
        </section>
      )}
      <ErrorNotice error={error} />
      {selected ? (
        <div
          className={`resource-preview${focused ? " port-preview-focused" : ""}`}
          ref={preview}
          onKeyDown={(event) => {
            if (focused && event.key === "Escape" && !event.defaultPrevented) {
              event.preventDefault();
              dispatch({ type: "focus", focused: false });
            }
          }}
        >
          {isDesktop && (
            <div className="port-preview-tab-bar">
              <div className="port-preview-tabs" role="tablist" aria-label="打开的端口预览">
                {tabs.map((tab) => {
                  const service = services.find((entry) => entry.port === tab.port);
                  const title = service?.title || service?.process || "端口预览";
                  return (
                    <div className="port-preview-tab" data-active={tab.port === selected || undefined} key={tab.port}>
                      <Button
                        variant="ghost"
                        size="plain"
                        className="port-preview-tab-trigger"
                        role="tab"
                        id={`${tabId}-tab-${tab.port}`}
                        aria-label={`端口 ${tab.port}`}
                        aria-selected={tab.port === selected}
                        aria-controls={`${tabId}-panel-${tab.port}`}
                        tabIndex={tab.port === selected ? 0 : -1}
                        title={`${title} · 127.0.0.1:${tab.port}`}
                        onClick={() => select(tab.port)}
                        onKeyDown={(event) => tabKey(event, tab.port)}
                      >
                        <Globe aria-hidden="true" />
                        <span>{title}</span>
                        <small>{tab.port}</small>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="port-preview-tab-close"
                        aria-label={`关闭端口 ${tab.port} 预览`}
                        title={`关闭端口 ${tab.port} 预览`}
                        onClick={() => close(tab.port)}
                      ><X /></Button>
                    </div>
                  );
                })}
              </div>
              <Popover open={addingPort} onOpenChange={setAddingPort}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="打开新的端口预览" title="打开新的端口预览">
                    <Plus />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-64">
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    const port = Number(newPort);
                    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
                      open(port);
                      setNewPort("");
                    }
                  }}>
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor={`${tabId}-new-port`}>打开端口预览</FieldLabel>
                        <InputGroup>
                          <InputGroupInput
                            id={`${tabId}-new-port`}
                            aria-label="新预览端口"
                            type="number"
                            inputMode="numeric"
                            min="1"
                            max="65535"
                            step="1"
                            required
                            value={newPort}
                            onChange={(event) => setNewPort(event.target.value)}
                            placeholder="如 3000"
                          />
                          <InputGroupAddon align="inline-end">
                            <InputGroupButton type="submit" variant="secondary" disabled={!newPort}>打开</InputGroupButton>
                          </InputGroupAddon>
                        </InputGroup>
                      </Field>
                    </FieldGroup>
                  </form>
                </PopoverContent>
              </Popover>
            </div>
          )}
          <div className="resource-preview-toolbar">
            <div className="resource-preview-address">
              <Globe aria-hidden="true" />
              {!isDesktop && <strong title={current?.title ?? `端口 ${selected}`}>
                {current?.title || `端口 ${selected}`}
              </strong>}
              <span title={`所连接电脑上的本地服务：127.0.0.1:${selected}`}>127.0.0.1:{selected}</span>
            </div>
            <div className="resource-inline-actions">
              <Button
                variant="ghost"
                size="icon"
                title="重新加载预览"
                aria-label="重新加载预览"
                onClick={() => retry()}
              >
                <RefreshCw />
              </Button>
              {isDesktop ? (
                <Button
                  variant={focused ? "outline" : "ghost"}
                  size="sm"
                  aria-label={focused ? "退出铺满窗口" : "铺满窗口"}
                  aria-pressed={focused}
                  title={focused ? "退出铺满窗口" : "在当前窗口铺满预览"}
                  onClick={() => dispatch({ type: "focus", focused: !focused })}
                >
                  {focused ? <Minimize /> : <Maximize />}
                  {focused ? "退出铺满窗口" : "铺满窗口"}
                </Button>
              ) : document.fullscreenEnabled && (
                <Button
                  variant="ghost"
                  size="icon"
                  title={fullscreen ? "退出全屏" : "全屏预览"}
                  aria-label={fullscreen ? "退出全屏" : "全屏预览"}
                  onClick={() => {
                    const action = fullscreen
                      ? document.exitFullscreen()
                      : preview.current?.requestFullscreen();
                    void action?.catch((reason) =>
                      setError(`无法切换全屏：${messageOf(reason)}`),
                    );
                  }}
                >
                  {fullscreen ? <Minimize /> : <Maximize />}
                </Button>
              )}
              {!isDesktop && <Button
                variant="ghost"
                size="icon"
                title="关闭预览"
                aria-label="关闭预览"
                onClick={() => close(selected)}
              >
                <X />
              </Button>}
            </div>
          </div>
          {current && !current.http && (
            <p className="resource-caption resource-preview-note">
              此端口未识别为 HTTP 服务。终端、数据库等服务无法作为网页预览。
            </p>
          )}
          {tabs.map((tab) => (
            <div
              className="port-preview-panel"
              role={isDesktop ? "tabpanel" : undefined}
              id={`${tabId}-panel-${tab.port}`}
              aria-labelledby={isDesktop ? `${tabId}-tab-${tab.port}` : undefined}
              hidden={tab.port !== selected}
              key={tab.port}
            >
              <PortPreview
                key={tab.revision}
                port={tab.port}
                retry={() => retry(tab.port)}
              />
            </div>
          ))}
        </div>
      ) : (
        // On the desktop the list of services already says what to do; the hint is for an empty page.
        !load.loading && !(isDesktop && services.length) && (
          <EmptyState
            icon={<Server />}
            title={services.length ? "选择一个开发服务" : "还没有发现开发服务"}
            description={
              services.length
                ? "选择上方服务打开预览，或输入端口号访问其他服务。"
                : "先在电脑或终端中启动项目，再刷新服务列表。已知端口号时也可以直接输入。"
            }
          />
        )
      )}
    </section>
  );
}
