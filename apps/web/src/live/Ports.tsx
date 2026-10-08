import { httpStreamRequest } from "./http-stream";
import { useEffect, useRef, useState } from "react";
import { ErrorNotice, LoadState, useConnection, useLoad } from "./common";
import { socketBootstrap } from "./Video";
import { openWebSocket } from "./transport";

function previewOrigin() {
  const configured = window.__LINKSHELL_CONFIG__?.previewOrigin;
  const local =
    import.meta.env.DEV &&
    ["localhost", "127.0.0.1"].includes(location.hostname)
      ? `${location.protocol}//${location.hostname === "localhost" ? "127.0.0.1" : "localhost"}:${location.port}`
      : undefined;
  if (!configured && !local) return undefined;
  const url = new URL(configured ?? local!);
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
export function PortPreview({ port }: { port: number }) {
  const { streams } = useConnection();
  const ref = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string>();
  const [channel] = useState(() => crypto.randomUUID());
  const origin = previewOrigin();
  useEffect(() => {
    if (!origin) return;
    let alive = true;
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
          })
          .catch((error) => {
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
      window.removeEventListener("message", listen);
      for (const socket of sockets.values()) socket.close();
      pending.clear();
      for (const request of http.values()) request.abort();
      http.clear();
    };
  }, [streams, port, channel, origin]);
  if (!origin)
    return (
      <p className="notice-card">
        此部署尚未配置独立的预览域名。管理员需要设置 <code>previewOrigin</code>{" "}
        并在该域名部署网页制品中的 preview
        目录。开发网页与账号页面隔离，避免项目脚本读取登录凭证。
      </p>
    );
  return (
    <>
      <ErrorNotice error={error} />
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
        onError={() => setError("隔离预览页面加载失败，请检查预览域名配置")}
      />
    </>
  );
}
export function Ports() {
  const { link } = useConnection();
  const load = useLoad(() => link.call("ports.list", {}), [link], 10000);
  const [selected, setSelected] = useState<number>();
  const [manual, setManual] = useState("");
  return (
    <section className="ports-page">
      <div className="browser-toolbar">
        <h2>端口预览</h2>
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            setSelected(Number(manual));
          }}
        >
          <input
            aria-label="预览端口"
            type="number"
            min="1"
            max="65535"
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            required
            placeholder="端口号"
          />
          <button className="button secondary">打开</button>
        </form>
      </div>
      <LoadState {...load} />
      <div className="terminal-tabs">
        {load.value?.ports.map((port) => (
          <button
            key={port.port}
            className={selected === port.port ? "selected" : ""}
            onClick={() => setSelected(port.port)}
          >
            {port.port} · {port.title ?? port.process}
            {!port.http && "（未识别为 HTTP）"}
          </button>
        ))}
      </div>
      {selected ? (
        <PortPreview key={selected} port={selected} />
      ) : (
        <p className="muted">选择电脑上的 HTTP 服务。请求通过加密通道传输。</p>
      )}
    </section>
  );
}
