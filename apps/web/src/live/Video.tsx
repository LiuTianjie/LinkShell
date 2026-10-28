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
import { ScreenConnectionLoading } from "./ScreenConnectionLoading";
import {
  EmptyState,
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
  Play,
  RotateCw,
  Square,
  SlidersHorizontal,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "../lib/utils";
import { isDesktop, isElectronDesktop, isWindowsDesktop, readDesktopStorage, saveDesktopStorage } from "./desktop";
import { useDesktopVisibility } from "./desktop-visibility";
import { DesktopScreen } from "./DesktopScreen";
import {
  autoScreenWidth,
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
    <EmptyState
      icon={<Monitor />}
      title="还没有操作画面"
      description="Agent 操作电脑时，画面会显示在这里。"
    />
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
      __linkshellReload: (to: { width?: string; mode?: string; display?: number; maxFps?: number }) => void;
    }
  ).__linkshellReload = (to) =>
    parent.postMessage(
      { channel, type: "reload", width: to.width, mode: to.mode, display: to.display, maxFps: to.maxFps },
      "*",
    );
  (
    window as unknown as { __linkshellReport: (stats: unknown) => void }
  ).__linkshellReport = (stats) =>
    parent.postMessage({ channel, type: "screen-stats", stats }, "*");
  (
    window as unknown as { __linkshellSession: (message: { type: string; session: unknown }) => void }
  ).__linkshellSession = (message) => {
    if (message?.type === "screenSession")
      parent.postMessage({ channel, type: "screenSession", session: message.session }, "*");
  };
  (
    window as unknown as { __linkshellScreenState: (phase: string) => void }
  ).__linkshellScreenState = (phase) =>
    parent.postMessage({ channel, type: "screen-state", phase }, "*");
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    if (event.data.type === "screen-session") {
      const configure = (window as unknown as {
        linkshellSession?: (state: unknown) => void;
      }).linkshellSession;
      if (configure) configure(event.data.state);
      else parent.postMessage({ channel, type: "screen-session-unavailable" }, "*");
      return;
    }
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
    if (isDesktop) return readDesktopStorage<string | undefined>(`screen:${key}`, undefined);
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStored(key: string, value: string): void {
  try {
    if (isDesktop) { saveDesktopStorage(`screen:${key}`, value); return; }
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

export interface ScreenProps {
  title?: string;
  embedded?: boolean;
  primaryAction?: boolean;
  onOpen?: () => void;
  autoStart?: boolean;
  active?: boolean;
}

export function Screen(props: ScreenProps) {
  const visible = useDesktopVisibility();
  // The WKWebView shell draws the picture natively; Chromium (Electron, WebView2) decodes it itself.
  return isDesktop && !isWindowsDesktop && !isElectronDesktop ? <DesktopScreen {...props} /> : <BrowserScreen {...props} active={(props.active ?? true) && (!isDesktop || visible)} />;
}

function BrowserScreen({
  title = "电脑屏幕",
  embedded = false,
  primaryAction = false,
  onOpen,
  autoStart = false,
  active = true,
}: ScreenProps) {
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
  const stage = useRef<HTMLDivElement>(null);
  // What "auto" resolved to for the track now running: shown beside the choice,
  // and only read when a stream starts — a window being resized must not
  // renegotiate the picture under the hands using it.
  const [fitted, setFitted] = useState<string>();
  const [slow, setSlow] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [viewerState, setViewerState] = useState<string>();
  const [stats, setStats] = useState<{
    width?: number;
    height?: number;
    fps?: number;
    codec?: string;
    bitrateMbps?: number;
    presented?: boolean;
    live?: boolean;
  }>();
  // What the viewer page last chose (its own storage is not its own in a sandboxed srcdoc): kept here.
  const [view, setView] = useState(() => screenPreferences(readStored));
  function configure(key: keyof ScreenPreferences, value: string) {
    writeStored(`linkshell.screen.${key}`, value);
    if (key === "width") setFitted(value === "auto" ? autoScreenWidth({ width: stage.current?.clientWidth ?? 0, ratio: window.devicePixelRatio }) : undefined);
    setView((current) => ({ ...current, [key]: value }));
  }
  const [displays, setDisplays] = useState<{ index: number; name: string }[]>(
    [],
  );
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState<string>();
  const [sessionError, setSessionError] = useState<string>();
  const [reusable, setReusable] = useState<boolean>();
  const frame = useRef<HTMLIFrameElement>(null);
  const desired = useRef({ active, display, view });
  desired.current = { active, display, view };
  const session = useRef<{
    initial: { display: number; width: string; maxFps: string };
    reply: (data: object) => void;
  } | undefined>(undefined);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Desktop windows release media and pressed inputs while hidden, matching the native Mac receiver.
  const keepSession = started && (active || (!isDesktop && reusable === true));
  function tellSession() {
    const current = session.current;
    if (!current) return;
    const next = desired.current;
    // Hidden stages have no width. Resuming the same "auto" selection keeps
    // the established resolution; a new selection is measured explicitly.
    const width = next.view.width === "auto"
      ? fitted ?? current.initial.width
      : next.view.width;
    current.reply({
      type: "screen-session",
      state: { active: next.active, display: next.display, width, maxFps: Number(next.view.maxFps) },
    });
  }
  useEffect(() => {
    if (active) return;
    setFocused(false);
    if (document.fullscreenElement === surface.current)
      void document.exitFullscreen().catch(() => {});
  }, [active]);
  useEffect(() => {
    if (!focused || !surface.current) return;
    const previous = document.activeElement;
    const hidden: { node: HTMLElement; inert: boolean }[] = [];
    // The desktop Shell owns inert state so both layers cannot restore stale values.
    let node: HTMLElement | null = isDesktop ? null : surface.current;
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
    const timer = window.setTimeout(() => setSlow(true), 12000);
    return () => window.clearTimeout(timer);
  }, [started, html, error, retry, link, streams, display, view]);
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
    if (!keepSession || !desired.current.active) {
      setHtml(undefined);
      setReusable(undefined);
      return;
    }
    let alive = true;
    let display = desired.current.display;
    const view = desired.current.view;
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
        display?: unknown;
        maxFps?: unknown;
        mode?: unknown;
        phase?: unknown;
        key?: unknown;
        value?: unknown;
        session?: { t?: unknown; version?: unknown; configure?: unknown; pause?: unknown; paused?: unknown; message?: unknown };
        stats?: {
          width?: unknown;
          height?: unknown;
          fps?: unknown;
          codec?: unknown;
          bitrateMbps?: unknown;
          presented?: unknown;
          live?: unknown;
        };
      };
      if (message.type === "screen-session-unavailable") {
        setReusable(false);
        return;
      }
      if (message.type === "screenSession" && message.session) {
        const report = message.session;
        if (report.t === "capabilities") {
          setReusable(report.version === 1 && report.configure === true && report.pause === true);
        } else if (report.t === "configured") {
          setSessionError(undefined);
          if (report.paused === true) clearTimeout(pauseTimer.current);
        } else if (report.t === "error" && typeof report.message === "string") {
          setSessionError(report.message.slice(0, 500));
          // A failed pause cannot be kept behind another workspace page.
          if (!desired.current.active) setReusable(false);
        }
        return;
      }
      if (message.type === "leave-focus") {
        if (!document.fullscreenElement) setFocused(false);
        return;
      }
      if (message.type === "screen-state") {
        if (typeof message.phase === "string" && ["connecting", "receiving", "recovering", "adjusting", "paused", "blocked", "error", "ready"].includes(message.phase)) setViewerState(message.phase);
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
        ) {
          writeStored(message.key, message.value);
          if (message.key === "linkshell.screen.width" && /^(1280|1920|2560|native)$/.test(message.value)) {
            const width = message.value;
            setFitted(undefined);
            setView((current) => current.width === width ? current : { ...current, width });
          } else if (message.key === "linkshell.screen.mode" && /^(view|trackpad|touch)$/.test(message.value)) {
            const mode = message.value;
            setView((current) => current.mode === mode ? current : { ...current, mode });
          }
        }
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
          presented: data.presented === "gpu",
          live: data.live === true,
        });
        return;
      }
      if (message.type === "reload") {
        if (message.width === undefined && message.mode === undefined && message.display === undefined && message.maxFps === undefined) {
          setRetry((value) => value + 1);
          return;
        }
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
        const display = typeof message.display === "number" && Number.isSafeInteger(message.display) && message.display >= 0 ? message.display : undefined;
        const maxFps = [30, 60, 120].includes(Number(message.maxFps)) ? String(message.maxFps) : undefined;
        if (width) writeStored("linkshell.screen.width", width);
        if (mode) writeStored("linkshell.screen.mode", mode);
        if (maxFps) writeStored("linkshell.screen.maxFps", maxFps);
        if (display !== undefined) setDisplay(display);
        setView((current) => ({
          ...current,
          ...(width ? { width } : {}),
          ...(mode ? { mode } : {}),
          ...(maxFps ? { maxFps } : {}),
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
              if (!alive) return;
              session.current = undefined;
              clearTimeout(pauseTimer.current);
              setReusable(false);
              setHtml(undefined);
              setError(reason || "屏幕连接已断开，请重新连接");
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
    setSessionError(undefined);
    setReusable(undefined);
    setStats(undefined);
    setPreparing(false);
    setViewerState(undefined);
    void link
      .call("screen.start", {})
      .then(async (viewer) => {
        if (!alive) return;
        setPreparing(true);
        port = viewer.port;
        setDisplays(viewer.displays);
        if (
          viewer.displays.length &&
          !viewer.displays.some((entry) => entry.index === display)
        ) {
          display = viewer.displays[0].index;
          setDisplay(display);
        }
        let codecs: { mimeType: string }[] = [];
        try {
          codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
        } catch {
          /* H.264 remains available on older browsers. */
        }
        // The stage is measured once, as the stream starts: the picture the
        // viewer is about to show is the one it has to cover.
        const width =
          view.width === "auto"
            ? autoScreenWidth({
                width: stage.current?.clientWidth ?? 0,
                ratio: window.devicePixelRatio,
              })
            : view.width;
        setFitted(view.width === "auto" ? width : undefined);
        const query = screenQuery(
          viewer.token,
          display,
          { ...view, width },
          codecs,
        );
        session.current = { initial: { display, width, maxFps: view.maxFps }, reply };
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
      session.current = undefined;
      clearTimeout(pauseTimer.current);
      window.removeEventListener("message", listen);
      for (const socket of sockets.values()) socket.close();
      sockets.clear();
      pending.clear();
    };
  }, [keepSession, retry, link, streams, view.codec]);
  useEffect(() => {
    if (!html || !session.current) return;
    const current = session.current;
    const width = view.width === "auto" ? fitted ?? current.initial.width : view.width;
    if (reusable === false && (
      current.initial.display !== display || current.initial.width !== width || current.initial.maxFps !== view.maxFps
    )) {
      setRetry((value) => value + 1);
      return;
    }
    current.reply({
      type: "screen-session",
      state: { active, display, width, maxFps: Number(view.maxFps) },
    });
    clearTimeout(pauseTimer.current);
    if (!active && reusable) {
      // Fail closed if the host cannot confirm that capture actually paused.
      pauseTimer.current = setTimeout(() => setReusable(false), 2000);
    }
    return () => clearTimeout(pauseTimer.current);
  }, [active, display, view.width, view.maxFps, fitted, html, reusable]);
  const screenLive = started && !!html && !error && !sessionError && !!stats?.width && (!viewerState || viewerState === "ready");
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
          {
            value: "auto",
            label: fitted ? `随窗口 · ${fitted}` : "随窗口大小",
          },
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
          { value: "60", label: "流畅 · 最高 60 帧" },
          { value: "120", label: "高刷 · 最高 120 帧" },
          { value: "30", label: "省带宽 · 最高 30 帧" },
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
    const problem = job.error ?? loaded.error;
    return (
      <section
        className="screen-page screen-is-idle"
        aria-label={`${title}观看区域`}
      >
        <div className="screen-idle-status" role="status">
          <StatusDot on={Boolean(access?.supported && !needsPermission && !problem)} />
          <div>
            <strong>
              {problem
                ? "检查失败"
                : !access
                  ? "正在检查屏幕…"
                  : !access.supported
                    ? "暂不支持共享"
                    : needsPermission
                      ? "等待授权"
                      : "在线"}
            </strong>
            <span title={problem}>
              {problem ??
                (!access
                  ? "正在读取屏幕与权限状态"
                  : !access.supported
                    ? "此系统无法共享屏幕"
                    : needsPermission
                      ? "需要屏幕录制权限"
                      : access.control
                        ? "可观看与控制"
                        : "仅观看桌面")}
            </span>
          </div>
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
                      setViewerState(undefined);
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
      <div className="screen-stage" ref={stage}>
        {!started && (
          <div className="screen-start">
            {!compact && (
              <div className="screen-display-mark" aria-hidden="true">
                <Monitor size={32} strokeWidth={1.65} />
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
          <ScreenConnectionLoading preparing={preparing} slow={slow} error={error} retry={() => setRetry((value) => value + 1)} />
        )}
        {html && (
          <iframe
            ref={frame}
            title={title === "电脑屏幕" ? title : `${title}的屏幕画面`}
            sandbox="allow-scripts allow-pointer-lock"
            allow="autoplay; fullscreen"
            srcDoc={html}
            onLoad={tellSession}
          />
        )}
      </div>
      {html && <ErrorNotice error={sessionError} />}
      {!compact && (
        <div className="screen-caption">
          <span className="screen-signal">
            <StatusDot on={screenLive} />
            {screenLive
              ? stats?.live
                ? stats?.presented
                  ? "视频直连 · 自绘"
                  : "视频直连"
                : "兼容画面"
              : (error || sessionError || viewerState === "error") && started
                ? "连接失败，可重试"
                : viewerState === "blocked"
                  ? "轻点屏幕开始观看"
                  : viewerState === "recovering"
                    ? "正在恢复画面"
                    : viewerState === "adjusting"
                      ? "正在调整屏幕"
                    : viewerState === "paused"
                      ? "屏幕已暂停"
                    : started
                      ? preparing ? "正在接收画面" : "正在连接电脑"
                      : "尚未开始观看"}
          </span>
          {screenLive && stats ? (
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
