import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from "@/components/ui/popover";
import { Choice } from "../components/Choice";
import { useEffect, useRef, useState } from "react";
import { ComputerPreviewSubscription } from "@linkshell/client-core";
import {
  ErrorNotice,
  LoadState,
  messageOf,
  useConnection,
  useJob,
  useLoad,
} from "./common";
import { httpRequest, openWebSocket } from "./transport";
import { Button } from "../components/ui/button";
import {
  ArrowDownLeft,
  Expand,
  Maximize,
  Minimize,
  Monitor,
  LoaderCircle,
  Play,
  RotateCw,
  Square,
  SlidersHorizontal,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "../lib/utils";
import {
  screenPreferences,
  screenQuery,
  type ScreenPreferences,
} from "./screen-preferences";

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
      className="w-full rounded-md"
      src={image}
      alt="Agent 当前电脑操作画面"
    />
  ) : (
    <p className="text-[13px] text-muted-foreground">
      等待 Agent 的电脑操作画面。当前会话没有画面时，此处保持等待。
    </p>
  );
}

/** Runs inside the isolated screen viewer. Only a port-specific WebSocket bridge is exposed. */
export function socketBootstrap(
  channel: string,
  stored?: Record<string, string>,
) {
  if (stored) {
    // The opaque screen iframe gets only its own preferences, never account storage.
    const keys = [
      "linkshell.screen.shortcuts",
      "linkshell.screen.mode",
      "linkshell.screen.width",
    ];
    const values = new Map(
      keys.flatMap((key) =>
        typeof stored[key] === "string" ? [[key, stored[key]] as const] : [],
      ),
    );
    Object.defineProperty(window, "localStorage", {
      value: {
        get length() {
          return values.size;
        },
        key: (index: number) => [...values.keys()][index] ?? null,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (
            !keys.includes(key) ||
            typeof value !== "string" ||
            value.length > 32768
          )
            return;
          values.set(key, value);
          parent.postMessage(
            { channel, type: "screen-storage", key, value },
            "*",
          );
        },
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
  }
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
  (
    window as unknown as { __linkshellReport: (stats: unknown) => void }
  ).__linkshellReport = (stats) =>
    parent.postMessage({ channel, type: "screen-stats", stats }, "*");
  window.addEventListener("message", (event) => {
    if (event.source === parent && event.data?.channel === channel)
      sockets
        .get(event.data.id)
        ?.receive(event.data.type, event.data.data, event.data.reason);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape")
      parent.postMessage({ channel, type: "leave-focus" }, "*");
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

export function StatusDot({
  on,
  className,
}: {
  on: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("screen-dot", className)}
      data-on={on || undefined}
      aria-hidden="true"
    />
  );
}

export function Screen({
  title = "电脑屏幕",
  embedded = false,
  primaryAction = false,
  onOpen,
  autoStart = false,
}: {
  title?: string;
  embedded?: boolean;
  primaryAction?: boolean;
  onOpen?: () => void;
  autoStart?: boolean;
}) {
  const { link, streams } = useConnection();
  const job = useJob();
  const loaded = useLoad(() => link.call("screen.access", {}), [link]);
  const [started, setStarted] = useState(autoStart);
  const [display, setDisplay] = useState(0);
  const [retry, setRetry] = useState(0);
  const [focused, setFocused] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const compact = embedded && !started && !focused;
  const surface = useRef<HTMLElement>(null);
  const [slow, setSlow] = useState(false);
  const [stats, setStats] = useState<{
    width?: number;
    height?: number;
    fps?: number;
    codec?: string;
    bitrateMbps?: number;
    live?: boolean;
  }>();
  // What the viewer page last chose (its own storage is not its own in a sandboxed srcdoc): kept here.
  const [view, setView] = useState(() => screenPreferences(readStored));
  function configure(key: keyof ScreenPreferences, value: string) {
    writeStored(`linkshell.screen.${key}`, value);
    setView((current) => ({ ...current, [key]: value }));
  }
  const [displays, setDisplays] = useState<{ index: number; name: string }[]>(
    [],
  );
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState<string>();
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!focused || !surface.current) return;
    const previous = document.activeElement;
    const hidden: { node: HTMLElement; inert: boolean }[] = [];
    let node: HTMLElement | null = surface.current;
    // Keep the existing iframe alive while isolating the expanded workspace from keyboard navigation.
    while (node?.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node && sibling instanceof HTMLElement) {
          hidden.push({ node: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      node = node.parentElement;
    }
    return () => {
      for (const entry of hidden) entry.node.inert = entry.inert;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [focused]);
  useEffect(() => {
    setSlow(false);
    if (!started || html || error) return;
    const timer = window.setTimeout(() => setSlow(true), 10000);
    return () => window.clearTimeout(timer);
  }, [started, html, error, retry]);
  useEffect(() => {
    const changed = () =>
      setFullscreen(document.fullscreenElement === surface.current);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.fullscreenElement)
        setFocused(false);
    };
    document.addEventListener("fullscreenchange", changed);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (surface.current?.requestFullscreen && document.fullscreenEnabled)
        await surface.current.requestFullscreen();
      else setFocused((value) => !value);
    } catch {
      setFocused(true);
    }
  }
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
        key?: unknown;
        value?: unknown;
        stats?: {
          width?: unknown;
          height?: unknown;
          fps?: unknown;
          codec?: unknown;
          bitrateMbps?: unknown;
          live?: unknown;
        };
      };
      if (message.type === "leave-focus") {
        if (!document.fullscreenElement) setFocused(false);
        return;
      }
      if (message.type === "screen-storage") {
        if (
          typeof message.key === "string" &&
          [
            "linkshell.screen.shortcuts",
            "linkshell.screen.mode",
            "linkshell.screen.width",
          ].includes(message.key) &&
          typeof message.value === "string" &&
          message.value.length <= 32768
        )
          writeStored(message.key, message.value);
        return;
      }
      if (message.type === "screen-stats" && message.stats) {
        const data = message.stats;
        const number = (value: unknown) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0
            ? value
            : undefined;
        setStats({
          width: number(data.width),
          height: number(data.height),
          fps: number(data.fps),
          bitrateMbps: number(data.bitrateMbps),
          codec:
            typeof data.codec === "string"
              ? data.codec.slice(0, 50)
              : undefined,
          live: data.live === true,
        });
        return;
      }
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
        setView((current) => ({
          ...current,
          ...(width ? { width } : {}),
          ...(mode ? { mode } : {}),
        }));
        return;
      }
      if (message.type === "ws-open") {
        if (
          sockets.has(message.id) ||
          pending.has(message.id) ||
          sockets.size + pending.size >= 4
        )
          return;
        let target: URL;
        try {
          if (typeof message.url !== "string") return;
          target = new URL(message.url);
        } catch {
          return;
        }
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
    setStats(undefined);
    void link
      .call("screen.start", {})
      .then(async (viewer) => {
        if (!alive) return;
        port = viewer.port;
        setDisplays(viewer.displays);
        if (
          viewer.displays.length &&
          !viewer.displays.some((entry) => entry.index === display)
        ) {
          setDisplay(viewer.displays[0].index);
          return;
        }
        let codecs: { mimeType: string }[] = [];
        try {
          codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
        } catch {
          /* H.264 remains available on older browsers. */
        }
        const query = screenQuery(viewer.token, display, view, codecs);
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
          `<head><script>(${socketBootstrap.toString()})(${JSON.stringify(channel)},${JSON.stringify(
            Object.fromEntries(
              [
                "linkshell.screen.shortcuts",
                "linkshell.screen.mode",
                "linkshell.screen.width",
              ].map((key) => [key, readStored(key)]),
            ),
          ).replaceAll("<", "\\u003c")})</script>`,
        );
        if (alive) setHtml(source);
      })
      .catch((error) => {
        if (alive) setError(messageOf(error));
      });
    return () => {
      alive = false;
      window.removeEventListener("message", listen);
      for (const socket of sockets.values()) socket.close();
      sockets.clear();
      pending.clear();
    };
  }, [started, display, retry, link, streams, view]);
  const settings = (
    <div className="screen-settings">
      {displays.length > 1 && (
        <Choice
          container={fullscreen || focused ? surface.current : undefined}
          className="w-auto"
          label="选择显示器"
          value={String(display)}
          onValueChange={(value) => setDisplay(Number(value))}
          options={displays.map((entry) => ({
            value: String(entry.index),
            label: entry.name,
          }))}
        />
      )}
      <Choice
        container={fullscreen || focused ? surface.current : undefined}
        className="w-auto"
        label="画面清晰度"
        value={view.width}
        onValueChange={(value) => configure("width", value)}
        options={[
          { value: "1280", label: "省带宽 · 1280" },
          { value: "1920", label: "标准 · 1920" },
          { value: "2560", label: "高清 · 2560" },
          { value: "native", label: "原生分辨率" },
        ]}
      />
      <Choice
        container={fullscreen || focused ? surface.current : undefined}
        className="w-auto"
        label="帧率上限"
        value={view.maxFps}
        onValueChange={(value) => configure("maxFps", value)}
        options={[
          { value: "120", label: "自适应 · 最高 120 帧" },
          { value: "60", label: "最高 60 帧" },
          { value: "30", label: "最高 30 帧" },
        ]}
      />
      <Choice
        container={fullscreen || focused ? surface.current : undefined}
        className="w-auto"
        label="视频编码"
        value={view.codec}
        onValueChange={(value) => configure("codec", value)}
        options={[
          { value: "auto", label: "自动编码" },
          { value: "h264", label: "兼容编码 · H.264" },
        ]}
      />
    </div>
  );
  if (compact) {
    const access = loaded.value;
    const needsPermission = access?.recording === false;
    return (
      <section
        className="screen-page screen-is-idle"
        aria-label={`${title}观看区域`}
      >
        <div className="screen-idle-status" role="status">
          <LoadState {...loaded} />
          {access && (
            <>
              <StatusDot on={access.supported && !needsPermission} />
              <div>
                <strong>
                  {!access.supported
                    ? "暂不支持共享"
                    : needsPermission
                      ? "等待授权"
                      : "在线"}
                </strong>
                <span>
                  {!access.supported
                    ? "此系统无法共享屏幕"
                    : needsPermission
                      ? "需要屏幕录制权限"
                      : access.control
                        ? "可观看与控制"
                        : "仅观看桌面"}
                </span>
              </div>
            </>
          )}
        </div>
        <div className="screen-idle-actions">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="画质与权限"
                title="画质与权限"
              >
                <SlidersHorizontal />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-80 max-w-[calc(100vw-32px)] gap-4 p-4"
            >
              <PopoverHeader>
                <PopoverTitle>画质与权限</PopoverTitle>
                <PopoverDescription>
                  根据网络情况调整观看体验。
                </PopoverDescription>
              </PopoverHeader>
              {settings}
              {access && (
                <div className="screen-permission-details">
                  {access.problem && <p>{access.problem}</p>}
                  <p>
                    屏幕录制{" "}
                    <strong>
                      {access.recording === null
                        ? "待检查"
                        : access.recording
                          ? "已授权"
                          : "未授权"}
                    </strong>
                  </p>
                  <p>
                    操作控制{" "}
                    <strong>
                      {access.control === null
                        ? "待检查"
                        : access.control
                          ? "已授权"
                          : "未授权"}
                    </strong>
                  </p>
                  {access.supported &&
                    (!access.recording || !access.control) && (
                      <Button
                        variant="outline"
                        disabled={job.busy}
                        onClick={() =>
                          void job.run(async () => {
                            await link.call("screen.access", { ask: true });
                            loaded.reload();
                          })
                        }
                      >
                        在电脑上检查权限
                      </Button>
                    )}
                </div>
              )}
              <Button
                variant="outline"
                disabled={loaded.loading || job.busy}
                onClick={loaded.reload}
              >
                <RotateCw data-icon="inline-start" />
                刷新权限状态
              </Button>
            </PopoverContent>
          </Popover>
          {loaded.error ? (
            <Button variant="outline" onClick={loaded.reload}>
              重新检查
            </Button>
          ) : (
            <Button
              variant={primaryAction ? "default" : "outline"}
              disabled={!access?.supported || job.busy}
              onClick={() => {
                if (needsPermission)
                  void job.run(async () => {
                    await link.call("screen.access", { ask: true });
                    loaded.reload();
                  });
                else if (onOpen) onOpen();
                else setStarted(true);
              }}
            >
              {needsPermission
                ? job.busy
                  ? "正在请求…"
                  : "检查权限"
                : "打开桌面"}
              <ArrowUpRight data-icon="inline-end" />
            </Button>
          )}
        </div>
        <ErrorNotice error={job.error} />
      </section>
    );
  }
  return (
    <section
      ref={surface}
      className={cn(
        "screen-page",
        embedded && "screen-embedded",
        started && "screen-is-started",
        focused && "screen-focused",
      )}
      aria-label={`${title}观看区域`}
      role={focused ? "dialog" : undefined}
      aria-modal={focused || undefined}
    >
      {!compact && (
        <div className="screen-toolbar">
          {(focused || fullscreen || !embedded) && (
            <strong className="screen-view-title">
              <Monitor size={17} />
              <span title={title}>{title}</span>
            </strong>
          )}
          {settings}
          {!compact && (
            <div className="screen-actions">
              {started && (
                <Button
                  variant="ghost"
                  size="icon"
                  title="重新连接"
                  aria-label="重新连接"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  <RotateCw />
                </Button>
              )}
              {!fullscreen && (
                <Button
                  variant="outline"
                  title={focused ? "退出专注观看" : "专注观看"}
                  onClick={() => setFocused((value) => !value)}
                >
                  {focused ? (
                    <ArrowDownLeft data-icon="inline-start" />
                  ) : (
                    <Expand data-icon="inline-start" />
                  )}
                  {focused ? "退出专注" : "专注观看"}
                </Button>
              )}
              {started && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => void toggleFullscreen()}
                  >
                    {fullscreen ? (
                      <Minimize data-icon="inline-start" />
                    ) : (
                      <Maximize data-icon="inline-start" />
                    )}
                    {fullscreen ? "退出全屏" : "全屏"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="停止观看"
                    title="停止观看"
                    onClick={() => {
                      if (document.fullscreenElement === surface.current)
                        void document.exitFullscreen().catch(() => {});
                      setStarted(false);
                      setFocused(false);
                      setHtml(undefined);
                      setStats(undefined);
                      setError(undefined);
                    }}
                  >
                    <Square />
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      <div className="screen-stage">
        {!started && (
          <div className="screen-start">
            {!compact && (
              <div className="screen-display-mark" aria-hidden="true">
                <Monitor size={32} strokeWidth={1.5} />
              </div>
            )}
            <LoadState {...loaded} />
            {loaded.error && (
              <Button variant="outline" onClick={loaded.reload}>
                <RotateCw data-icon="inline-start" />
                重新检查
              </Button>
            )}
            <ErrorNotice error={job.error} />
            {loaded.value && (
              <>
                <h3>
                  {loaded.value.supported
                    ? loaded.value.recording === false
                      ? "需要屏幕录制权限"
                      : loaded.value.control === false
                        ? "可以观看桌面"
                        : "可以连接桌面"
                    : "此电脑暂不支持屏幕共享"}
                </h3>
                {(loaded.value.problem || !compact) && (
                  <p>
                    {loaded.value.problem ?? "打开画面，继续电脑上的工作。"}
                  </p>
                )}
                {(!compact ||
                  loaded.value.recording !== true ||
                  loaded.value.control !== true) && (
                  <div className="screen-permissions">
                    <span>
                      屏幕录制 ·{" "}
                      {loaded.value.recording === null
                        ? "待检查"
                        : loaded.value.recording
                          ? "已授权"
                          : "未授权"}
                    </span>
                    <span>
                      操作控制 ·{" "}
                      {loaded.value.control === null
                        ? "待检查"
                        : loaded.value.control
                          ? "已授权"
                          : "未授权"}
                    </span>
                  </div>
                )}
                {loaded.value.supported && (
                  <div className="screen-start-actions">
                    <Button
                      onClick={() => setStarted(true)}
                    >
                      <Play data-icon="inline-start" />
                      {loaded.value.control === false
                        ? "开始观看（只读）"
                        : "打开桌面"}
                    </Button>
                    {(!loaded.value.recording || !loaded.value.control) && (
                      <Button
                        variant="outline"
                        disabled={job.busy}
                        onClick={() =>
                          void job.run(async () => {
                            await link.call("screen.access", { ask: true });
                            loaded.reload();
                          })
                        }
                      >
                        {job.busy ? "正在请求权限…" : "在电脑上检查权限"}
                      </Button>
                    )}
                    {!compact && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={job.busy || loaded.loading}
                        onClick={loaded.reload}
                      >
                        刷新权限状态
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {started && !html && (
          <div className="screen-start" role="status">
            {error ? (
              <Monitor size={40} strokeWidth={1} />
            ) : (
              <LoaderCircle size={32} className="animate-spin" />
            )}
            <h3>{error ? "暂时无法打开画面" : "正在连接屏幕"}</h3>
            {error ? (
              <>
                <ErrorNotice error={error} />
                <Button
                  variant="outline"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  重试
                </Button>
              </>
            ) : (
              <>
                <p>
                  {slow
                    ? "连接耗时较长，请确认电脑在线且已允许屏幕录制。"
                    : "正在建立屏幕连接，画面准备好后会自动显示。"}
                </p>
                {slow && (
                  <Button
                    variant="outline"
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    重新连接
                  </Button>
                )}
              </>
            )}
          </div>
        )}
        {html && (
          <iframe
            ref={frame}
            title={title === "电脑屏幕" ? title : `${title}的屏幕画面`}
            sandbox="allow-scripts allow-pointer-lock"
            allow="autoplay; fullscreen"
            srcDoc={html}
          />
        )}
      </div>
      {!compact && (
        <div className="screen-caption">
          <span className="screen-signal">
            <StatusDot on={!!stats?.width} />
            {stats?.width
              ? stats.live
                ? "视频直连"
                : "兼容画面"
              : error && started
                ? "连接失败，可重试"
                : started
                  ? "正在接收画面"
                  : "尚未开始观看"}
          </span>
          {stats?.width ? (
            <span className="screen-metrics">
              {stats.width} × {stats.height}
              {stats.fps !== undefined &&
                ` · 接收 ${Math.round(stats.fps)} 帧/秒`}
              {stats.codec && ` · ${stats.codec}`}
              {stats.bitrateMbps !== undefined &&
                ` · ${stats.bitrateMbps} Mbps`}
            </span>
          ) : (
            <span>画质与帧率会随电脑和网络条件调整</span>
          )}
        </div>
      )}
    </section>
  );
}
