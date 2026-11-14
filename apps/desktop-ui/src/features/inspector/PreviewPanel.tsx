import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { PortInfo } from "@linkshell/wire";
import {
  desktopInvoke,
  isElectronDesktop,
  openExternalUrl,
  previewOriginUrl,
} from "../../bridge/desktop-bridge";
import type { Connection } from "../../core/connections";
import { engine } from "../../core/engine";
import { httpStreamRequest } from "../../core/http-stream";
import {
  appendPreviewError,
  formatPreviewErrorForAgent,
  portTabsReducer,
  readOpenPortTabs,
  saveOpenPortTabs,
  type PreviewRuntimeError,
} from "../../core/port-tabs";
import { DESKTOP_LOCAL } from "../../core/storage";
import { openWebSocket } from "../../core/transport";
import { DesktopIcon } from "../../icons";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  StatusDot,
  useDialogs,
} from "../../primitives";
import { useInspectorI18n } from "./i18n-inspector";
import { parsePortOrUrlInput } from "./InspectorNewTabView";
import { INSPECTOR_OPEN_PORT_EVENT } from "./inspector-tabs-store";
import type { InspectorSessionActions } from "./use-inspector-connection";

const REMOTE_PORT_REQ_EVENT = "linkshell-desktop-remote-port-req";
const livePreviewConnections = new Map<string, Connection>();
let responderWindow: Window | null = null;

interface RemotePortProxyRequestDetail {
  reqId?: string;
  computerKey?: string;
  port?: number;
  method?: string;
  path?: string;
  headers?:
    | [string, string][]
    | Record<string, string | string[] | undefined>;
  bodyBase64?: string;
}

function base64ToBytes(b64?: string): Uint8Array {
  if (!b64) return new Uint8Array();
  try {
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      out[i] = raw.charCodeAt(i);
    }
    return out;
  } catch {
    return new Uint8Array();
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return "";
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function normalizeProxyRequestHeaders(
  raw: RemotePortProxyRequestDetail["headers"],
): [string, string][] {
  const out: [string, string][] = [];
  if (Array.isArray(raw)) {
    for (const pair of raw) {
      if (
        Array.isArray(pair) &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string" &&
        !/^proxy-authorization$/i.test(pair[0])
      ) {
        out.push([pair[0], pair[1]]);
      }
    }
    return out;
  }
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (/^proxy-authorization$/i.test(k) || v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          out.push([k, String(item)]);
        }
      } else {
        out.push([k, String(v)]);
      }
    }
  }
  return out;
}

function resolveConnectionForProxy(computerKey: string): {
  connection?: Connection;
  release?: () => void;
} {
  const mounted = livePreviewConnections.get(computerKey);
  if (mounted) {
    return { connection: mounted };
  }
  const active = engine.state.getState().connection;
  if (active?.computer.key === computerKey) {
    return { connection: active };
  }
  const comp = engine.computerForKey(computerKey);
  if (comp) {
    try {
      const retained = engine.retainComputer(comp);
      return { connection: retained.connection, release: retained.release };
    } catch {
      return {};
    }
  }
  return {};
}

export function ensureRemotePortProxyResponder(): void {
  if (typeof window === "undefined") return;
  if (responderWindow === window) return;
  responderWindow = window;

  window.addEventListener(REMOTE_PORT_REQ_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<RemotePortProxyRequestDetail>).detail;
    const reqId = detail?.reqId;
    const computerKey = detail?.computerKey;
    const port = detail?.port;
    if (
      !reqId ||
      !computerKey ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      return;
    }

    const { connection, release } = resolveConnectionForProxy(computerKey);
    if (!connection) {
      const errMsg = "Remote host connection is unavailable";
      void desktopInvoke("remotePortReply", {
        reqId,
        status: 502,
        headers: [["content-type", "text/plain; charset=utf-8"]],
        bodyBase64: bytesToBase64(new TextEncoder().encode(errMsg)),
        error: errMsg,
      });
      return;
    }

    const reqPath =
      typeof detail.path === "string" && detail.path.startsWith("/")
        ? detail.path
        : `/${detail.path ?? ""}`;
    const method =
      typeof detail.method === "string" && detail.method.trim()
        ? detail.method.trim().toUpperCase()
        : "GET";
    const safeHeaders = normalizeProxyRequestHeaders(detail.headers);
    const bodyBytes = base64ToBytes(detail.bodyBase64);

    void (async () => {
      try {
        const response = await httpStreamRequest(
          connection.streams,
          port,
          reqPath,
          method,
          safeHeaders,
          bodyBytes,
          AbortSignal.timeout(15_000),
        );
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = response.body.getReader();
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            if (part.value && part.value.byteLength > 0) {
              chunks.push(part.value);
              total += part.value.byteLength;
            }
          }
        } finally {
          reader.releaseLock();
        }
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        await desktopInvoke("remotePortReply", {
          reqId,
          status: response.status,
          headers: response.headers,
          bodyBase64: bytesToBase64(merged),
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await desktopInvoke("remotePortReply", {
          reqId,
          status: 502,
          headers: [["content-type", "text/plain; charset=utf-8"]],
          bodyBase64: bytesToBase64(new TextEncoder().encode(errMsg)),
          error: errMsg,
        });
      } finally {
        release?.();
      }
    })();
  });
}

ensureRemotePortProxyResponder();

/**
 * Injected into preview HTML documents by `public/preview/worker.js` so hot-reload WebSockets
 * inside the isolated `localhost` preview iframe proxy over `postMessage` back to the host tunnel.
 * Self-contained with zero outer-scope closures so `.toString()` serializes cleanly.
 */
export function previewSocketBootstrap(channel: string): void {
  interface ManagedSocket {
    receive(type: string, data: unknown, reason?: string): void;
  }
  const sockets = new Map<string, ManagedSocket>();

  class BridgeWebSocket extends EventTarget implements ManagedSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 0;
    binaryType: BinaryType = "blob";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    url: string;
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    id = crypto.randomUUID();

    constructor(url: string | URL, protocols: string | string[] = []) {
      super();
      this.url = String(url);
      sockets.set(this.id, this);
      window.parent.postMessage(
        {
          channel,
          type: "ws-open",
          id: this.id,
          url: this.url,
          protocols: typeof protocols === "string" ? [protocols] : protocols,
        },
        "*",
      );
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState !== 1) throw new Error("WebSocket is not open");
      if (data instanceof Blob) {
        void data.arrayBuffer().then((buf) => this.send(buf));
        return;
      }
      const payload = ArrayBuffer.isView(data)
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
      window.parent.postMessage(
        { channel, type: "ws-send", id: this.id, data: payload },
        "*",
      );
    }

    close(): void {
      this.readyState = 2;
      window.parent.postMessage(
        { channel, type: "ws-close", id: this.id },
        "*",
      );
    }

    receive(type: string, data: unknown, reason?: string): void {
      if (type === "ws-open") {
        this.readyState = 1;
        const ev = new Event("open");
        this.dispatchEvent(ev);
        this.onopen?.(ev);
      } else if (type === "ws-data") {
        const ev = new MessageEvent("message", {
          data:
            data instanceof ArrayBuffer && this.binaryType === "blob"
              ? new Blob([data])
              : data,
        });
        this.dispatchEvent(ev);
        this.onmessage?.(ev);
      } else if (type === "ws-close") {
        this.readyState = 3;
        if (reason) {
          const errEv = new Event("error");
          this.dispatchEvent(errEv);
          this.onerror?.(errEv);
        }
        const closeEv = new CloseEvent("close", {
          code: reason ? 1006 : 1000,
          reason: reason ?? "",
          wasClean: !reason,
        });
        this.dispatchEvent(closeEv);
        this.onclose?.(closeEv);
        sockets.delete(this.id);
      }
    }
  }

  window.WebSocket = BridgeWebSocket as unknown as typeof WebSocket;

  window.addEventListener("error", (event) => {
    window.parent.postMessage(
      {
        channel,
        type: "preview-runtime-error",
        source: "error",
        url: event.filename || window.location.href,
        message: event.message || "Uncaught runtime error",
        stack: event.error instanceof Error ? event.error.stack : undefined,
      },
      "*",
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    window.parent.postMessage(
      {
        channel,
        type: "preview-runtime-error",
        source: "unhandledrejection",
        url: window.location.href,
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      },
      "*",
    );
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.channel !== channel) {
      return;
    }
    const target = sockets.get(event.data.id as string);
    if (target && typeof event.data.type === "string") {
      target.receive(event.data.type, event.data.data, event.data.reason);
    }
  });
}

/** Validates that the preview origin is a distinct HTTP(S) origin from the account/workspace UI (#8 §1.7). */
export function resolveSafePreviewOrigin(): string | undefined {
  const candidate = previewOriginUrl();
  if (!candidate || typeof window === "undefined") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.origin === window.location.origin
  ) {
    return undefined;
  }
  if (window.location.protocol === "https:" && parsed.protocol !== "https:") {
    return undefined;
  }
  return parsed.origin;
}

interface SandboxedPortFrameProps {
  port: number;
  revision: number;
  subPath: string;
  connection?: Connection;
  onOpenExternal: () => void;
  onRuntimeError: (
    incoming: Omit<PreviewRuntimeError, "id" | "timestamp">,
  ) => void;
}

function SandboxedPortFrame({
  port,
  revision,
  subPath,
  connection,
  onOpenExternal,
  onRuntimeError,
}: SandboxedPortFrameProps) {
  const { ti } = useInspectorI18n();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [channel] = useState(() => `${crypto.randomUUID()}-${revision}`);
  const origin = resolveSafePreviewOrigin();

  const onRuntimeErrorRef = useRef(onRuntimeError);
  onRuntimeErrorRef.current = onRuntimeError;

  useEffect(() => {
    if (!origin || !connection) return undefined;

    let alive = true;
    let inFlightCount = 0;
    const cookies = new Map<string, string>();
    const httpAborts = new Map<string, AbortController>();
    const sockets = new Map<
      string,
      Awaited<ReturnType<typeof openWebSocket>>
    >();
    const pendingSockets = new Set<string>();

    const postToBridge = (payload: Record<string, unknown>) => {
      if (!alive) return;
      iframeRef.current?.contentWindow?.postMessage(
        { ...payload, channel },
        origin,
      );
    };

    const onMessage = (event: MessageEvent) => {
      const frameWin = iframeRef.current?.contentWindow;
      if (
        (frameWin && event.source !== frameWin) ||
        event.origin !== origin ||
        !event.data ||
        typeof event.data !== "object" ||
        (event.data as { channel?: string }).channel !== channel
      ) {
        return;
      }

      const msg = event.data as {
        type?: string;
        id?: string;
        path?: string;
        method?: string;
        headers?: [string, string][];
        body?: ArrayBuffer;
        url?: string;
        protocols?: string[];
        data?: string | ArrayBuffer;
        source?: string;
        message?: string;
        stack?: string;
      };

      if (
        msg.type === "preview-runtime-error" &&
        typeof msg.message === "string"
      ) {
        const srcRaw = msg.source;
        const normalizedSource: PreviewRuntimeError["source"] =
          srcRaw === "unhandledrejection" || srcRaw === "console"
            ? srcRaw
            : "error";
        onRuntimeErrorRef.current({
          port,
          url: typeof msg.url === "string" ? msg.url.slice(0, 512) : undefined,
          source: normalizedSource,
          message: msg.message.slice(0, 1000),
          stack:
            typeof msg.stack === "string" ? msg.stack.slice(0, 2000) : undefined,
        });
        return;
      }

      if (msg.type === "preview-ready") {
        postToBridge({
          type: "preview-init",
          bootstrap: previewSocketBootstrap.toString(),
          initialPath: subPath,
        });
        return;
      }

      if (msg.type === "http-cancel" && msg.id) {
        httpAborts.get(msg.id)?.abort();
        return;
      }

      if (msg.type === "http-request" && msg.id) {
        const reqId = msg.id;
        if (++inFlightCount > 128) {
          inFlightCount--;
          postToBridge({
            type: "http-error",
            id: reqId,
            error: "Too many concurrent preview requests",
          });
          return;
        }

        const safeHeaders = (msg.headers ?? []).filter(
          ([name]) => !/^(cookie|proxy-authorization)$/i.test(name),
        );
        if (cookies.size > 0) {
          safeHeaders.push([
            "cookie",
            [...cookies]
              .map(([name, val]) => `${name}=${val}`)
              .join("; "),
          ]);
        }

        const abort = new AbortController();
        httpAborts.set(reqId, abort);

        const requestPath =
          msg.path === "/" && subPath && subPath.startsWith("/")
            ? subPath
            : (msg.path ?? "/");

        void httpStreamRequest(
          connection.streams,
          port,
          requestPath,
          msg.method ?? "GET",
          safeHeaders,
          msg.body ? new Uint8Array(msg.body) : new Uint8Array(),
          abort.signal,
        )
          .then(async (response) => {
            for (const [k, v] of response.headers) {
              if (k === "set-cookie") {
                const pair = v.split(";")[0] ?? "";
                const eqIdx = pair.indexOf("=");
                if (eqIdx > 0) {
                  const cookieName = pair.slice(0, eqIdx);
                  if (/max-age=0/i.test(v)) cookies.delete(cookieName);
                  else cookies.set(cookieName, pair.slice(eqIdx + 1));
                }
              }
            }

            let streamBody = response.body;
            const encoding = response.headers.find(
              ([k]) => k === "content-encoding",
            )?.[1];
            if (
              msg.method !== "HEAD" &&
              ![204, 205, 304].includes(response.status) &&
              (encoding === "gzip" || encoding === "deflate") &&
              typeof DecompressionStream !== "undefined"
            ) {
              streamBody = streamBody.pipeThrough(
                new DecompressionStream(encoding),
              );
            }

            postToBridge({
              type: "http-head",
              id: reqId,
              status: response.status,
              headers: response.headers,
            });

            const reader = streamBody.getReader();
            try {
              while (alive) {
                const part = await reader.read();
                if (part.done) break;
                postToBridge({
                  type: "http-chunk",
                  id: reqId,
                  body: part.value,
                });
              }
            } finally {
              reader.releaseLock();
              if (!alive) abort.abort();
            }
            postToBridge({ type: "http-end", id: reqId });
          })
          .catch((err) => {
            abort.abort();
            postToBridge({
              type: "http-error",
              id: reqId,
              error: String(err),
            });
          })
          .finally(() => {
            httpAborts.delete(reqId);
            inFlightCount--;
          });
        return;
      }

      if (msg.type === "ws-open" && msg.id && msg.url) {
        const wsId = msg.id;
        if (
          sockets.has(wsId) ||
          pendingSockets.has(wsId) ||
          sockets.size + pendingSockets.size >= 24
        ) {
          return;
        }
        try {
          const parsedUrl = new URL(msg.url, origin);
          const wsPath =
            parsedUrl.pathname.replace(
              new RegExp(`^/preview/view/${channel}/`),
              "/",
            ) + parsedUrl.search;
          pendingSockets.add(wsId);
          void openWebSocket(
            connection.streams,
            port,
            wsPath.startsWith("/") ? wsPath : `/${wsPath}`,
            {
              open: () => postToBridge({ type: "ws-open", id: wsId }),
              data: (data) => postToBridge({ type: "ws-data", id: wsId, data }),
              close: (reason) => {
                pendingSockets.delete(wsId);
                sockets.delete(wsId);
                postToBridge({ type: "ws-close", id: wsId, reason });
              },
            },
            msg.protocols,
          ).then(
            (sock) => {
              if (!alive || !pendingSockets.has(wsId)) {
                sock.close();
              } else {
                pendingSockets.delete(wsId);
                sockets.set(wsId, sock);
              }
            },
            (err) => {
              pendingSockets.delete(wsId);
              postToBridge({
                type: "ws-close",
                id: wsId,
                reason: String(err),
              });
            },
          );
        } catch (err) {
          postToBridge({
            type: "ws-close",
            id: wsId,
            reason: String(err),
          });
        }
        return;
      }

      if (msg.type === "ws-send" && msg.id && msg.data !== undefined) {
        sockets.get(msg.id)?.send(msg.data);
        return;
      }

      if (msg.type === "ws-close" && msg.id) {
        sockets.get(msg.id)?.close();
        sockets.delete(msg.id);
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      alive = false;
      window.removeEventListener("message", onMessage);
      for (const ctrl of httpAborts.values()) ctrl.abort();
      httpAborts.clear();
      for (const sock of sockets.values()) sock.close();
      sockets.clear();
    };
  }, [origin, connection, port, channel, subPath]);

  if (!origin) {
    return (
      <EmptyState
        icon="port-preview"
        title={ti("isolationUnavailableTitle")}
        description={ti("isolationUnavailableDesc")}
        actions={
          <Button
            size="sm"
            variant="primary"
            leadingIcon="external-link"
            onClick={onOpenExternal}
          >
            {ti("openInBrowser")}
          </Button>
        }
      />
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title={`Port ${port}`}
      src={`${origin}/preview/bridge.html#${channel}`}
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-pointer-lock"
      referrerPolicy="no-referrer"
      data-preview-channel={channel}
      className="inspector-preview-iframe"
    />
  );
}

export interface PreviewPanelProps {
  computerKey: string;
  connection?: Connection;
  online: boolean;
  cwd?: string;
  actions?: InspectorSessionActions;
  onPortCountChange?: (count: number) => void;
}

export function PreviewPanel({
  computerKey,
  connection,
  online,
  cwd,
  actions,
  onPortCountChange,
}: PreviewPanelProps) {
  const { t, ti } = useInspectorI18n();
  const dialogs = useDialogs();

  const effectiveComputerKey = computerKey || DESKTOP_LOCAL;

  const [tabsState, dispatchTabs] = useReducer(
    portTabsReducer,
    computerKey || "default",
    (key) => readOpenPortTabs(key),
  );
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [loadingPorts, setLoadingPorts] = useState(false);
  const [customPortInput, setCustomPortInput] = useState("");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [pathByPort, setPathByPort] = useState<Record<number, string>>({});
  const [errorsByPort, setErrorsByPort] = useState<
    Record<number, PreviewRuntimeError[]>
  >({});

  useEffect(() => {
    ensureRemotePortProxyResponder();
    if (!connection) return undefined;
    livePreviewConnections.set(effectiveComputerKey, connection);
    return () => {
      if (livePreviewConnections.get(effectiveComputerKey) === connection) {
        livePreviewConnections.delete(effectiveComputerKey);
      }
    };
  }, [effectiveComputerKey, connection]);

  useEffect(() => {
    saveOpenPortTabs(computerKey || "default", tabsState);
  }, [computerKey, tabsState]);

  const loadPorts = useCallback(async () => {
    if (!connection || !online) return;
    setLoadingPorts(true);
    try {
      const res = await connection.link.call("ports.list", {});
      const nextPorts = Array.isArray(res?.ports) ? res.ports : [];
      setPorts(nextPorts);
      onPortCountChange?.(nextPorts.length);
    } catch {
      // Ignore transient poll errors while reconnecting.
    } finally {
      setLoadingPorts(false);
    }
  }, [connection, online, onPortCountChange]);

  useEffect(() => {
    if (!connection || !online) return undefined;
    void loadPorts();
    const timer = setInterval(() => {
      void loadPorts();
    }, 10_000);
    return () => clearInterval(timer);
  }, [connection, online, loadPorts]);

  const sortedPorts = useMemo(() => {
    return [...ports].sort((a, b) => {
      const aMatch = cwd && a.cwd && a.cwd.startsWith(cwd) ? 1 : 0;
      const bMatch = cwd && b.cwd && b.cwd.startsWith(cwd) ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      if (a.http !== b.http) return a.http ? -1 : 1;
      return a.port - b.port;
    });
  }, [ports, cwd]);

  const activeTab = useMemo(
    () =>
      tabsState.tabs.find((tab) => tab.port === tabsState.selected) ??
      tabsState.tabs[0],
    [tabsState.tabs, tabsState.selected],
  );

  const activePort = activeTab?.port;
  const activePath = activePort ? (pathByPort[activePort] ?? "/") : "/";
  const activeErrors = useMemo(
    () => (activePort ? (errorsByPort[activePort] ?? []) : []),
    [activePort, errorsByPort],
  );

  const handleOpenPort = useCallback(
    (portNum: number, initialPath?: string) => {
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return;
      dispatchTabs({ type: "open", port: portNum, multiple: true });
      if (initialPath && initialPath !== "/") {
        setPathByPort((prev) => ({
          ...prev,
          [portNum]: initialPath.startsWith("/")
            ? initialPath
            : `/${initialPath}`,
        }));
      }
    },
    [],
  );

  const openPortExternally = useCallback(
    async (portNum: number, subPath = "/") => {
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return;
      const safePath = subPath.startsWith("/") ? subPath : `/${subPath}`;
      const hasDesktopBridge =
        isElectronDesktop ||
        (typeof window !== "undefined" &&
          typeof window.linkshellDesktop?.postMessage === "function");
      if (hasDesktopBridge) {
        try {
          const res = await desktopInvoke<{ url?: string; localPort?: number }>(
            "openRemotePortExternal",
            {
              computerKey: effectiveComputerKey,
              port: portNum,
              path: safePath,
            },
          );
          if (res?.url) {
            return;
          }
        } catch (err) {
          await dialogs.alert(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      openExternalUrl(`http://127.0.0.1:${portNum}${safePath}`);
    },
    [effectiveComputerKey, dialogs],
  );

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onOpenPort = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          computerKey?: string;
          port?: number;
          path?: string;
        }>
      ).detail;
      if (!detail || typeof detail.port !== "number") return;
      if (
        detail.computerKey &&
        computerKey &&
        detail.computerKey !== computerKey
      ) {
        return;
      }
      handleOpenPort(detail.port, detail.path);
    };
    window.addEventListener(INSPECTOR_OPEN_PORT_EVENT, onOpenPort);
    return () => {
      window.removeEventListener(INSPECTOR_OPEN_PORT_EVENT, onOpenPort);
    };
  }, [computerKey, handleOpenPort]);

  const parsedCustom = useMemo(
    () => parsePortOrUrlInput(customPortInput),
    [customPortInput],
  );

  const handleCustomInternalSubmit = useCallback(() => {
    if (!parsedCustom) return;
    handleOpenPort(parsedCustom.port, parsedCustom.path);
    setCustomPortInput("");
    setSwitcherOpen(false);
  }, [parsedCustom, handleOpenPort]);

  const handleCustomExternalSubmit = useCallback(() => {
    if (!parsedCustom) return;
    void openPortExternally(parsedCustom.port, parsedCustom.path);
    setCustomPortInput("");
    setSwitcherOpen(false);
  }, [parsedCustom, openPortExternally]);

  const handleCloseAllPreviews = useCallback(() => {
    for (const tab of tabsState.tabs) {
      dispatchTabs({ type: "close", port: tab.port });
    }
    setSwitcherOpen(false);
  }, [tabsState.tabs]);

  const handleSendErrorsToAgent = useCallback(async () => {
    if (!actions || !activePort || activeErrors.length === 0) return;
    const prompt = formatPreviewErrorForAgent(activePort, activeErrors);
    if (!prompt) return;
    try {
      await actions.send(prompt);
      setErrorsByPort((prev) => ({ ...prev, [activePort]: [] }));
    } catch (err) {
      await dialogs.alert(err instanceof Error ? err.message : String(err));
    }
  }, [actions, activePort, activeErrors, dialogs]);

  return (
    <div
      className="ls-preview-panel inspector-panel-fill"
      data-testid="preview-panel"
    >
      {activeTab && activePort !== undefined ? (
        <>
          <div className="ls-preview-bar">
            <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
              <PopoverTrigger>
                <button
                  type="button"
                  className="ls-preview-port-trigger"
                  aria-label={`${ti("tabPorts")} :${activePort}`}
                >
                  <DesktopIcon name="globe" size="xs" />
                  <span data-tabular="">:{activePort}</span>
                  {sortedPorts.length > 1 ? (
                    <Badge variant="count" tone="neutral">
                      {sortedPorts.length}
                    </Badge>
                  ) : null}
                  <DesktopIcon name="chevron-down" size="xs" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                placement="bottom-start"
                className="ls-preview-popover"
              >
                <div className="ls-preview-custom-bar">
                  <Input
                    size="sm"
                    value={customPortInput}
                    placeholder={ti("customPortPlaceholder")}
                    aria-label={ti("customPortPlaceholder")}
                    onChange={(e) => setCustomPortInput(e.target.value)}
                    onEnterSubmit={handleCustomInternalSubmit}
                  />
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={!parsedCustom}
                    onClick={handleCustomInternalSubmit}
                  >
                    {ti("openInternalPreview")}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    leadingIcon="external-link"
                    disabled={!parsedCustom}
                    onClick={handleCustomExternalSubmit}
                  >
                    {ti("openExternalShort")}
                  </Button>
                </div>

                {sortedPorts.length > 0 ? (
                  <div className="ls-preview-port-list">
                    {sortedPorts.map((info) => {
                      const isCurrent = info.port === activePort;
                      return (
                        <div
                          key={info.port}
                          className="ls-preview-port-row"
                          data-active={isCurrent ? "true" : undefined}
                        >
                          <button
                            type="button"
                            className="ls-preview-port-row__main"
                            onClick={() => {
                              handleOpenPort(info.port);
                              setSwitcherOpen(false);
                            }}
                          >
                            <StatusDot tone={info.http ? "ok" : "idle"} />
                            <strong data-tabular="">:{info.port}</strong>
                            <span className="ls-truncate">
                              {info.title || info.process}
                            </span>
                          </button>
                          <div className="ls-preview-port-row__actions">
                            <Button
                              size="xs"
                              variant={isCurrent ? "secondary" : "ghost"}
                              onClick={() => {
                                handleOpenPort(info.port);
                                setSwitcherOpen(false);
                              }}
                            >
                              {ti("openInternalPreview")}
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              leadingIcon="external-link"
                              onClick={() => {
                                void openPortExternally(
                                  info.port,
                                  pathByPort[info.port] ?? "/",
                                );
                                setSwitcherOpen(false);
                              }}
                            >
                              {ti("openExternalShort")}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                <div
                  className="ls-preview-popover__footer"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 6,
                  }}
                >
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={handleCloseAllPreviews}
                  >
                    {ti("viewAllPortsList")}
                  </Button>
                  <IconButton
                    icon="refresh"
                    size="icon-sm"
                    label={ti("refresh")}
                    loading={loadingPorts}
                    disabled={!online}
                    onClick={() => {
                      void loadPorts();
                    }}
                  />
                </div>
              </PopoverContent>
            </Popover>

            <div className="ls-preview-url-pill">
              <input
                type="text"
                className="ls-preview-url-input"
                value={activePath}
                placeholder={ti("urlPathPlaceholder")}
                aria-label={ti("urlPathPlaceholder")}
                onChange={(e) => {
                  const raw = e.target.value;
                  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
                  setPathByPort((prev) => ({
                    ...prev,
                    [activePort]: normalized,
                  }));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    dispatchTabs({ type: "refresh", port: activePort });
                  }
                }}
              />
              <IconButton
                icon="refresh"
                size="icon-sm"
                label={ti("reloadPreview")}
                onClick={() =>
                  dispatchTabs({ type: "refresh", port: activePort })
                }
              />
              <IconButton
                icon="close"
                size="icon-sm"
                label={ti("closeActivePreview")}
                onClick={() =>
                  dispatchTabs({ type: "close", port: activePort })
                }
              />
            </div>

            <Button
              size="xs"
              variant="secondary"
              leadingIcon="external-link"
              className="ls-preview-external-btn"
              onClick={() => {
                void openPortExternally(activePort, activePath);
              }}
            >
              {ti("openExternalShort")}
            </Button>
          </div>

          {activeErrors.length > 0 ? (
            <div
              className="inspector-banner"
              data-tone="danger"
              role="alert"
              style={{ margin: "8px 10px 0" }}
            >
              <div style={{ minWidth: 0 }}>
                <strong data-tabular="">
                  {ti("runtimeErrorsCount", { count: activeErrors.length })}
                </strong>
                <div
                  className="ls-truncate"
                  style={{ fontSize: "var(--ls-text-xs)" }}
                >
                  {activeErrors[activeErrors.length - 1]?.message}
                </div>
              </div>
              <div className="inspector-subbar-group">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    setErrorsByPort((prev) => ({ ...prev, [activePort]: [] }))
                  }
                >
                  {ti("dismissErrors")}
                </Button>
                {actions ? (
                  <Button
                    size="xs"
                    variant="danger"
                    leadingIcon="send-to-agent"
                    onClick={() => {
                      void handleSendErrorsToAgent();
                    }}
                  >
                    {t("desktop.inspector.sendErrorToAgent")}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="inspector-preview-frame-wrap">
            {tabsState.tabs.map((tab) => {
              const isSelected = tab.port === activeTab.port;
              const tabPath = pathByPort[tab.port] ?? "/";
              return (
                <div
                  key={`${tab.port}-${tab.revision}`}
                  className="inspector-panel-fill"
                  style={
                    isSelected
                      ? undefined
                      : {
                          contentVisibility: "hidden",
                          blockSize: 0,
                          flex: "0 0 0px",
                          pointerEvents: "none",
                        }
                  }
                >
                  <SandboxedPortFrame
                    port={tab.port}
                    revision={tab.revision}
                    subPath={tabPath}
                    connection={connection}
                    onOpenExternal={() => {
                      void openPortExternally(tab.port, tabPath);
                    }}
                    onRuntimeError={(incoming) => {
                      setErrorsByPort((prev) => ({
                        ...prev,
                        [tab.port]: appendPreviewError(
                          prev[tab.port] ?? [],
                          incoming,
                        ),
                      }));
                    }}
                  />
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="ls-preview-launcher inspector-panel-scroll">
          <div className="ls-preview-custom-bar">
            <Input
              size="sm"
              leadingIcon="globe"
              value={customPortInput}
              placeholder={ti("customPortPlaceholder")}
              aria-label={ti("customPortPlaceholder")}
              onChange={(e) => setCustomPortInput(e.target.value)}
              onEnterSubmit={handleCustomInternalSubmit}
            />
            <Button
              size="xs"
              variant="primary"
              disabled={!parsedCustom}
              onClick={handleCustomInternalSubmit}
            >
              {ti("openInternalPreview")}
            </Button>
            <Button
              size="xs"
              variant="secondary"
              leadingIcon="external-link"
              disabled={!parsedCustom}
              onClick={handleCustomExternalSubmit}
            >
              {ti("openExternalShort")}
            </Button>
            <IconButton
              icon="refresh"
              size="icon-sm"
              label={ti("refresh")}
              loading={loadingPorts}
              disabled={!online}
              onClick={() => {
                void loadPorts();
              }}
            />
          </div>

          <div className="ls-preview-port-list">
            {sortedPorts.length === 0 ? (
              <EmptyState
                compact
                icon="port-preview"
                title={online ? ti("noPortsTitle") : ti("offlineTitle")}
                description={online ? ti("noPortsDesc") : ti("offlineDesc")}
              />
            ) : (
              sortedPorts.map((info) => (
                <div key={info.port} className="ls-preview-port-row">
                  <button
                    type="button"
                    className="ls-preview-port-row__main"
                    onClick={() => handleOpenPort(info.port)}
                  >
                    <StatusDot tone={info.http ? "ok" : "idle"} />
                    <strong data-tabular="">:{info.port}</strong>
                    <span className="ls-truncate">
                      {info.title || info.process}
                    </span>
                  </button>
                  <div className="ls-preview-port-row__actions">
                    <Button
                      size="xs"
                      variant="secondary"
                      className="ls-preview-row-open-btn"
                      onClick={() => handleOpenPort(info.port)}
                    >
                      {ti("openInternalPreview")}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      leadingIcon="external-link"
                      className="ls-preview-row-external-btn"
                      onClick={() => {
                        void openPortExternally(
                          info.port,
                          pathByPort[info.port] ?? "/",
                        );
                      }}
                    >
                      {ti("openExternalShort")}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
