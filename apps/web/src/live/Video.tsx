import { Choice } from "../components/Choice";
import { useEffect, useRef, useState } from "react";
import { ComputerPreviewSubscription } from "@linkshell/client-core";
import {
  ErrorNotice,
  LoadState,
  useConnection,
  useJob,
  useLoad,
} from "./common";
import { httpRequest, openWebSocket } from "./transport";

export function ComputerPreview({ sessionId }: { sessionId: string }) {
  const { link, streams } = useConnection();
  const [image, setImage] = useState<string>();
  useEffect(() => {
    let current: string | undefined;
    const subscription = new ComputerPreviewSubscription(
      link,
      streams,
      sessionId,
      (frame) => {
        if (current) URL.revokeObjectURL(current);
        current = URL.createObjectURL(
          new Blob([frame.bytes as Uint8Array<ArrayBuffer>], {
            type: frame.mimeType,
          }),
        );
        setImage(current);
      },
    );
    return () => {
      subscription.close();
      if (current) URL.revokeObjectURL(current);
    };
  }, [link, streams, sessionId]);
  return image ? (
    <img
      className="computer-live-preview"
      src={image}
      alt="Agent 当前电脑操作画面"
    />
  ) : (
    <p className="muted">
      等待 Agent 的电脑操作画面。当前会话没有画面时，此处保持等待。
    </p>
  );
}

/** Runs inside the isolated screen viewer. Only a port-specific WebSocket bridge is exposed. */
export function socketBootstrap(channel: string) {
  const sockets = new Map<string, BridgeSocket>();
  class BridgeSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 0;
    binaryType = "blob";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    id = crypto.randomUUID();
    constructor(
      public url: string,
      protocols: string | string[] = [],
    ) {
      super();
      sockets.set(this.id, this);
      parent.postMessage(
        {
          channel,
          type: "ws-open",
          id: this.id,
          url: String(url),
          protocols: typeof protocols === "string" ? [protocols] : protocols,
        },
        "*",
      );
    }
    send(data: string | ArrayBuffer | ArrayBufferView | Blob) {
      if (this.readyState !== 1) throw new Error("WebSocket is not open");
      if (data instanceof Blob) {
        void data.arrayBuffer().then((bytes) => this.send(bytes));
        return;
      }
      const value = ArrayBuffer.isView(data)
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
      parent.postMessage(
        { channel, type: "ws-send", id: this.id, data: value },
        "*",
      );
    }
    close() {
      this.readyState = 2;
      parent.postMessage({ channel, type: "ws-close", id: this.id }, "*");
    }
    receive(type: string, data: unknown, reason?: string) {
      if (type === "ws-open") {
        this.readyState = 1;
        const event = new Event("open");
        this.dispatchEvent(event);
        this.onopen?.(event);
      }
      if (type === "ws-data") {
        const event = new MessageEvent("message", {
          data:
            data instanceof ArrayBuffer && this.binaryType === "blob"
              ? new Blob([data])
              : data,
        });
        this.dispatchEvent(event);
        this.onmessage?.(event);
      }
      if (type === "ws-close") {
        this.readyState = 3;
        if (reason) {
          const error = new Event("error");
          this.dispatchEvent(error);
          this.onerror?.(error);
        }
        const event = new CloseEvent("close", {
          code: reason ? 1006 : 1000,
          reason: reason ?? "",
          wasClean: !reason,
        });
        this.dispatchEvent(event);
        this.onclose?.(event);
        sockets.delete(this.id);
      }
    }
  }
  window.WebSocket = BridgeSocket as unknown as typeof WebSocket;
  // The page has no address of its own to load again with another width: this page does it.
  (
    window as unknown as {
      __linkshellReload: (to: { width?: string; mode?: string }) => void;
    }
  ).__linkshellReload = (to) =>
    parent.postMessage(
      { channel, type: "reload", width: to.width, mode: to.mode },
      "*",
    );
  window.addEventListener("message", (event) => {
    if (event.source === parent && event.data?.channel === channel)
      sockets
        .get(event.data.id)
        ?.receive(event.data.type, event.data.data, event.data.reason);
  });
}

function readStored(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not kept: the next visit starts at the page's own choice.
  }
}

export function Screen() {
  const { link, streams } = useConnection();
  const job = useJob();
  const loaded = useLoad(() => link.call("screen.access", {}), [link]);
  const [started, setStarted] = useState(false);
  const [display, setDisplay] = useState(0);
  const [retry, setRetry] = useState(0);
  // What the viewer page last chose (its own storage is not its own in a sandboxed srcdoc): kept here.
  const [view, setView] = useState(() => ({
    width: readStored("linkshell.screen.width"),
    mode: readStored("linkshell.screen.mode"),
  }));
  const [displays, setDisplays] = useState<{ index: number; name: string }[]>(
    [],
  );
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState<string>();
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!started) return;
    let alive = true;
    const sockets = new Map<
      string,
      Awaited<ReturnType<typeof openWebSocket>>
    >();
    const pending = new Set<string>();
    const channel = crypto.randomUUID();
    let port = 0;
    const reply = (data: object) =>
      frame.current?.contentWindow?.postMessage({ channel, ...data }, "*");
    const listen = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.channel !== channel ||
        !port
      )
        return;
      const message = event.data as {
        type: string;
        id: string;
        url?: string;
        protocols?: string[];
        data?: string | ArrayBuffer;
        width?: unknown;
        mode?: unknown;
      };
      if (message.type === "reload") {
        const width =
          typeof message.width === "string" &&
          /^(\d{3,4}|native)$/.test(message.width)
            ? message.width
            : undefined;
        const mode =
          typeof message.mode === "string" &&
          /^(view|trackpad|touch)$/.test(message.mode)
            ? message.mode
            : undefined;
        if (width) writeStored("linkshell.screen.width", width);
        if (mode) writeStored("linkshell.screen.mode", mode);
        setView({ width, mode });
        return;
      }
      if (message.type === "ws-open") {
        if (
          sockets.has(message.id) ||
          pending.has(message.id) ||
          sockets.size + pending.size >= 4
        )
          return;
        const target = new URL(message.url!);
        if (
          !["ws:", "wss:"].includes(target.protocol) ||
          target.hostname !== "127.0.0.1" ||
          Number(target.port) !== port ||
          target.pathname !== "/stream"
        )
          return;
        pending.add(message.id);
        void openWebSocket(
          streams,
          port,
          target.pathname + target.search,
          {
            open: () => reply({ id: message.id, type: "ws-open" }),
            data: (data) => reply({ id: message.id, type: "ws-data", data }),
            close: (reason) => {
              pending.delete(message.id);
              sockets.delete(message.id);
              reply({ id: message.id, type: "ws-close", reason });
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
            reply({ id: message.id, type: "ws-close", reason: String(error) });
          },
        );
      } else if (
        message.type === "ws-send" &&
        (typeof message.data === "string" ||
          message.data instanceof ArrayBuffer)
      )
        sockets.get(message.id)?.send(message.data);
      else if (message.type === "ws-close") {
        pending.delete(message.id);
        sockets.get(message.id)?.close();
        sockets.delete(message.id);
      }
    };
    window.addEventListener("message", listen);
    setHtml(undefined);
    setError(undefined);
    void link
      .call("screen.start", {})
      .then(async (viewer) => {
        port = viewer.port;
        if (alive) setDisplays(viewer.displays);
        const query =
          `?token=${encodeURIComponent(viewer.token)}&display=${display}` +
          (view.width ? `&width=${view.width}` : "") +
          (view.mode ? `&mode=${view.mode}` : "");
        const response = await httpRequest(streams, port, "/" + query);
        if (response.status !== 200)
          throw new Error(`屏幕页面返回 ${response.status}`);
        let source = new TextDecoder().decode(response.body);
        source = source
          .replaceAll("location.search", JSON.stringify(query))
          .replaceAll("location.host", JSON.stringify(`127.0.0.1:${port}`))
          .replaceAll("location.protocol", '"http:"');
        source = source.replace(
          "<head>",
          `<head><script>(${socketBootstrap.toString()})(${JSON.stringify(channel)})</script>`,
        );
        if (alive) setHtml(source);
      })
      .catch((error) => {
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
      window.removeEventListener("message", listen);
      for (const socket of sockets.values()) socket.close();
      sockets.clear();
      pending.clear();
    };
  }, [started, display, retry, link, streams, view]);
  return (
    <section className="screen-page">
      <div className="browser-toolbar">
        <h2>电脑屏幕</h2>
        {displays.length > 1 && (
          <div className="w-48">
            <Choice
              label="选择显示器"
              value={String(display)}
              onValueChange={(value) => setDisplay(Number(value))}
              options={displays.map((display) => ({
                value: String(display.index),
                label: display.name,
              }))}
            />
          </div>
        )}
        {started && (
          <>
            <button
              className="button secondary"
              onClick={() => setRetry((value) => value + 1)}
            >
              重新连接
            </button>
            <button
              className="button secondary"
              onClick={() =>
                void frame.current?.requestFullscreen().catch(() => {})
              }
            >
              全屏
            </button>
            <button
              className="text-button"
              onClick={() => {
                setStarted(false);
                setHtml(undefined);
              }}
            >
              停止观看
            </button>
          </>
        )}
      </div>
      <LoadState {...loaded} />
      <ErrorNotice error={error ?? job.error} />
      {!started && loaded.value && (
        <div className="notice-card">
          <p>
            {loaded.value.problem ??
              (loaded.value.supported
                ? "电脑支持屏幕共享"
                : "此电脑暂不支持屏幕共享")}
          </p>
          <p className="muted">
            屏幕录制：
            {loaded.value.recording === null
              ? "未知"
              : loaded.value.recording
                ? "已授权"
                : "未授权"}{" "}
            · 操作控制：
            {loaded.value.control === null
              ? "未知"
              : loaded.value.control
                ? "已授权"
                : "未授权"}
          </p>
          {loaded.value.supported && (
            <div className="permission-buttons">
              <button
                className="button primary"
                onClick={() => setStarted(true)}
              >
                开始观看
              </button>
              <button
                className="button secondary"
                disabled={job.busy}
                onClick={() =>
                  void job.run(async () => {
                    await link.call("screen.access", { ask: true });
                    loaded.reload();
                  })
                }
              >
                在电脑上检查权限
              </button>
            </div>
          )}
        </div>
      )}
      {started && !html && !error && (
        <p className="muted">正在打开加密屏幕通道…</p>
      )}
      {html && (
        <iframe
          ref={frame}
          title="电脑屏幕"
          sandbox="allow-scripts allow-pointer-lock"
          allow="autoplay; fullscreen"
          srcDoc={html}
        />
      )}
    </section>
  );
}
