import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Choice, type ChoiceProps } from "../components/Choice";
import { Fragment, useEffect, useRef, useState } from "react";
import { ComputerPreviewSubscription, getLocale, isLocale } from "@linkshell/client-core";
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
  Clipboard,
  ClipboardCopy,
  ClipboardPaste,
  Expand,
  EyeOff,
  LoaderCircle,
  Lock,
  Maximize,
  Minimize,
  Monitor,
  Play,
  RotateCw,
  Square,
  SlidersHorizontal,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { MAX_ATTACHMENT_LABEL } from "./attachments";
import { supportsScreenAudio } from "./screen-audio";
import { formatScreenUploadSummary, uploadScreenFiles, type ScreenUploadProgress } from "./screen-upload";
import {
  autoScreenWidth,
  screenPreferences,
  screenQuery,
  type ScreenPreferences,
} from "./screen-preferences";
import { setWebLocalePreference, useT } from "./i18n";

export function ScreenToolsMenu({ container }: { container?: HTMLElement | null }) {
  const { link } = useConnection();
  const t = useT();
  const job = useJob();
  const [privacy, setPrivacy] = useState<{
    curtain: boolean;
    lockOnDisconnect: boolean;
    supported: boolean;
  }>({ curtain: false, lockOnDisconnect: false, supported: true });
  const [statusNote, setStatusNote] = useState<string>();

  const flashNote = (note: string) => {
    setStatusNote(note);
    window.setTimeout(() => {
      setStatusNote((current) => (current === note ? undefined : current));
    }, 2200);
  };

  const pasteToComputer = () =>
    void job.run(async () => {
      if (!navigator.clipboard?.readText) {
        flashNote(t("screen.clipboardFailed"));
        return;
      }
      const text = await navigator.clipboard.readText();
      if (!text) {
        flashNote(t("screen.clipboardEmpty"));
        return;
      }
      await link.call("clipboard.write", { text: text.slice(0, 100_000) });
      flashNote(t("screen.clipboardSynced"));
    });

  const copyFromComputer = () =>
    void job.run(async () => {
      const res = await link.call("clipboard.read", {});
      if (!res.text) {
        flashNote(t("screen.clipboardEmpty"));
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(res.text);
      }
      flashNote(t("screen.clipboardSynced"));
    });

  const togglePrivacy = (field: "curtain" | "lockOnDisconnect") =>
    void job.run(async () => {
      const nextValue = !privacy[field];
      const patch =
        field === "curtain"
          ? { curtain: nextValue }
          : { lockOnDisconnect: nextValue };
      const res = await link.call("screen.privacy", patch);
      setPrivacy(res);
      if (field === "curtain") {
        flashNote(
          res.curtain ? t("screen.privacyCurtainOn") : t("screen.privacyCurtainOff"),
        );
      }
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={privacy.curtain || privacy.lockOnDisconnect ? "secondary" : "ghost"}
          size="icon"
          aria-label={t("screen.pasteToComputer")}
          title={statusNote ?? t("screen.pasteToComputer")}
        >
          <Clipboard />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" container={container ?? undefined}>
        <DropdownMenuItem disabled={job.busy} onSelect={pasteToComputer}>
          <ClipboardPaste />
          <span>{t("screen.pasteToComputer")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={job.busy} onSelect={copyFromComputer}>
          <ClipboardCopy />
          <span>{t("screen.copyFromComputer")}</span>
        </DropdownMenuItem>
        {privacy.supported !== false && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("screen.privacyCurtain")}</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={privacy.curtain}
              disabled={job.busy}
              onCheckedChange={() => togglePrivacy("curtain")}
            >
              <EyeOff />
              <span>{t("screen.privacyCurtain")}</span>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={privacy.lockOnDisconnect}
              disabled={job.busy}
              onCheckedChange={() => togglePrivacy("lockOnDisconnect")}
            >
              <Lock />
              <span>{t("screen.lockOnDisconnect")}</span>
            </DropdownMenuCheckboxItem>
          </>
        )}
        {statusNote && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1 text-xs text-muted-foreground">{statusNote}</div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
      "linkshell.screen.lang",
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
      if (typeof data === "string" && data.startsWith("{")) {
        try {
          const parsed = JSON.parse(data) as { t?: unknown; enabled?: unknown };
          if (parsed?.t === "audio" && typeof parsed.enabled === "boolean") {
            parent.postMessage({ channel, type: "screen-audio-state", enabled: parsed.enabled }, "*");
          }
        } catch {
          // Ignore non-JSON control messages.
        }
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
  (
    window as unknown as { __linkshellBridge: (payload: unknown) => void }
  ).__linkshellBridge = (payload) =>
    parent.postMessage({ channel, type: "viewer-bridge", payload }, "*");
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    if (event.data.type === "viewer-call") {
      const target = window as unknown as Record<string, ((arg: unknown) => void) | undefined>;
      const fn = typeof event.data.fn === "string" ? target[event.data.fn] : undefined;
      if (typeof fn === "function") fn(event.data.arg);
      return;
    }
    if (event.data.type === "screen-audio" && typeof event.data.enabled === "boolean") {
      const el = document.getElementById("audiobar");
      if (el && el.getAttribute("aria-pressed") !== String(event.data.enabled)) {
        if (typeof PointerEvent === "function") {
          el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }));
          el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }));
        } else {
          el.click();
        }
      }
      return;
    }
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

export interface ScreenProps {
  title?: string;
  embedded?: boolean;
  primaryAction?: boolean;
  onOpen?: () => void;
  autoStart?: boolean;
  active?: boolean;
  uploadDir?: string;
}

export function Screen(props: ScreenProps) {
  return <BrowserScreen {...props} />;
}

function BrowserScreen({
  title = "电脑屏幕",
  embedded = false,
  primaryAction = false,
  onOpen,
  autoStart = false,
  active = true,
  uploadDir,
}: ScreenProps) {
  const { link, streams } = useConnection();
  const job = useJob();
  const uploadJob = useJob();
  const loaded = useLoad(() => link.call("screen.access", {}), [link]);
  const [started, setStarted] = useState(autoStart);
  const [display, setDisplay] = useState(0);
  const [retry, setRetry] = useState(0);
  const [focused, setFocused] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const audioSupported = supportsScreenAudio();
  const [audio, setAudio] = useState(() => readStored("linkshell.screen.audio") === "1");
  const audioRef = useRef(audio);
  audioRef.current = audio;
  const activeSocketsRef = useRef<Set<{ send(data: string | ArrayBuffer): void }>>(new Set());
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [uploadProgress, setUploadProgress] = useState<ScreenUploadProgress>();
  const [uploadNotice, setUploadNotice] = useState<string>();
  const [uploadError, setUploadError] = useState<string>();
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
  const keepSession = started && (active || reusable === true);
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
    current.reply({ type: "screen-audio", enabled: audioRef.current });
  }
  useEffect(() => {
    if (!uploadNotice) return;
    const timer = setTimeout(() => setUploadNotice(undefined), 4500);
    return () => clearTimeout(timer);
  }, [uploadNotice]);
  function toggleAudio() {
    const next = !audioRef.current;
    audioRef.current = next;
    setAudio(next);
    writeStored("linkshell.screen.audio", next ? "1" : "0");
    if (next && audioSupported) {
      try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctor) {
          const ctx = new Ctor();
          if (ctx.state === "suspended") void ctx.resume().catch(() => {});
          if (typeof ctx.close === "function") void ctx.close().catch(() => {});
        }
      } catch {
        // Ignore AudioContext probe restrictions.
      }
    }
    const payload = JSON.stringify({ t: "audio", enabled: next });
    for (const socket of activeSocketsRef.current) socket.send(payload);
    session.current?.reply({ type: "screen-audio", enabled: next });
  }
  function handleDropFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (!files.length || uploadJob.busy) return;
    setUploadNotice(undefined);
    setUploadError(undefined);
    void uploadJob.run(async () => {
      try {
        const result = await uploadScreenFiles({
          link,
          files,
          preferredDir: uploadDir,
          onProgress: (progress) => setUploadProgress(progress),
        });
        setUploadNotice(formatScreenUploadSummary(result));
      } catch (err) {
        setUploadError(messageOf(err));
        throw err;
      } finally {
        setUploadProgress(undefined);
      }
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
    const activeSockets = activeSocketsRef.current;
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
        enabled?: unknown;
        payload?: unknown;
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
      if (message.type === "screen-audio-state" && typeof message.enabled === "boolean") {
        audioRef.current = message.enabled;
        setAudio(message.enabled);
        writeStored("linkshell.screen.audio", message.enabled ? "1" : "0");
        return;
      }
      if (message.type === "screen-state") {
        if (typeof message.phase === "string" && ["connecting", "receiving", "recovering", "adjusting", "paused", "blocked", "error", "ready"].includes(message.phase)) setViewerState(message.phase);
        return;
      }
      if (message.type === "viewer-bridge" && message.payload && typeof message.payload === "object") {
        const payload = message.payload as Record<string, unknown>;
        if (payload.type === "clipboard-paste-to-computer") {
          void (async () => {
            if (!navigator.clipboard?.readText) {
              reply({ type: "viewer-call", fn: "linkshellClipboardResult", arg: { ok: false } });
              return;
            }
            try {
              const text = await navigator.clipboard.readText();
              if (!text) {
                reply({ type: "viewer-call", fn: "linkshellRemoteClipboard", arg: "" });
                return;
              }
              await link.call("clipboard.write", { text: text.slice(0, 100_000) });
              reply({ type: "viewer-call", fn: "linkshellClipboardResult", arg: { ok: true } });
            } catch (err) {
              reply({ type: "viewer-call", fn: "linkshellClipboardResult", arg: { ok: false, message: messageOf(err) } });
            }
          })();
        } else if (payload.type === "clipboard-write" && typeof payload.text === "string") {
          void link
            .call("clipboard.write", { text: payload.text.slice(0, 100_000) })
            .then(
              () => reply({ type: "viewer-call", fn: "linkshellClipboardResult", arg: { ok: true } }),
              (err) => reply({ type: "viewer-call", fn: "linkshellClipboardResult", arg: { ok: false, message: messageOf(err) } }),
            );
        } else if (payload.type === "clipboard-read") {
          void link
            .call("clipboard.read", {})
            .then(async (res) => {
              if (res.text && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(res.text).catch(() => {});
              }
              reply({ type: "viewer-call", fn: "linkshellRemoteClipboard", arg: res.text });
            })
            .catch((err) => {
              reply({ type: "viewer-call", fn: "linkshellClipboardResult", arg: { ok: false, message: messageOf(err) } });
            });
        } else if (payload.type === "screen-privacy") {
          const patch: { curtain?: boolean; lockOnDisconnect?: boolean } = {};
          if (typeof payload.curtain === "boolean") patch.curtain = payload.curtain;
          if (typeof payload.lockOnDisconnect === "boolean") patch.lockOnDisconnect = payload.lockOnDisconnect;
          void link
            .call("screen.privacy", patch)
            .then((res) => reply({ type: "viewer-call", fn: "linkshellPrivacy", arg: res }))
            .catch(() => {});
        } else if (payload.type === "screen-locale" && isLocale(payload.locale)) {
          setWebLocalePreference(payload.locale);
        }
        return;
      }
      if (message.type === "screen-storage") {
        if (
          typeof message.key === "string" &&
          [
            "linkshell.screen.shortcuts",
            "linkshell.screen.mode",
            "linkshell.screen.width",
            "linkshell.screen.lang",
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
          } else if (message.key === "linkshell.screen.lang" && isLocale(message.value)) {
            setWebLocalePreference(message.value);
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
              const closedSocket = sockets.get(message.id);
              if (closedSocket) activeSockets.delete(closedSocket);
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
              activeSockets.add(socket);
              if (audioSupported && !audioRef.current) {
                socket.send(JSON.stringify({ t: "audio", enabled: false }));
              }
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
          { audio: audioRef.current || audioSupported },
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
            {
              ...Object.fromEntries(
                [
                  "linkshell.screen.shortcuts",
                  "linkshell.screen.mode",
                  "linkshell.screen.width",
                ].map((key) => [key, readStored(key)]),
              ),
              "linkshell.screen.lang": readStored("linkshell.screen.lang") ?? getLocale(),
            },
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
      for (const socket of sockets.values()) {
        activeSockets.delete(socket);
        socket.close();
      }
      sockets.clear();
      pending.clear();
    };
  }, [keepSession, retry, link, streams, view.codec, audioSupported]);
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
  // One set of choices, drawn as the toolbar's row while watching and as labelled rows in a list row's popover.
  const choices: { title: string; choice: Pick<ChoiceProps, "label" | "value" | "onValueChange" | "options"> }[] = [
    ...(displays.length > 1
      ? [{
          title: "显示器",
          choice: {
            label: "选择显示器",
            value: String(display),
            onValueChange: (value: string) => setDisplay(Number(value)),
            options: displays.map((entry) => ({
              value: String(entry.index),
              label: entry.name,
            })),
          },
        }]
      : []),
    {
      title: "清晰度",
      choice: {
        label: "画面清晰度",
        value: view.width,
        onValueChange: (value) => configure("width", value),
        options: [
          {
            value: "auto",
            label: fitted ? `随窗口 · ${fitted}` : "随窗口大小",
          },
          { value: "1280", label: "省带宽 · 1280" },
          { value: "1920", label: "标准 · 1920" },
          { value: "2560", label: "高清 · 2560" },
          { value: "native", label: "原生分辨率" },
        ],
      },
    },
    {
      title: "帧率",
      choice: {
        label: "帧率上限",
        value: view.maxFps,
        onValueChange: (value) => configure("maxFps", value),
        options: [
          { value: "60", label: "流畅 · 最高 60 帧" },
          { value: "120", label: "高刷 · 最高 120 帧" },
          { value: "30", label: "省带宽 · 最高 30 帧" },
        ],
      },
    },
    {
      title: "编码",
      choice: {
        label: "视频编码",
        value: view.codec,
        onValueChange: (value) => configure("codec", value),
        options: [
          { value: "auto", label: "自动编码" },
          { value: "h264", label: "兼容编码 · H.264" },
        ],
      },
    },
  ];
  const settings = (
    <div className="screen-settings">
      {choices.map(({ choice }) => (
        <Choice
          key={choice.label}
          container={fullscreen || focused ? surface.current : undefined}
          className="w-auto"
          {...choice}
        />
      ))}
    </div>
  );
  if (compact) {
    const access = loaded.value;
    const needsPermission = access?.recording === false;
    const problem = job.error ?? loaded.error;
    const ready = Boolean(access?.supported && !needsPermission && !problem);
    const loading = !access && !problem;
    const statusLabel = problem
      ? "检查失败"
      : !access
        ? "检查屏幕…"
        : !access.supported
          ? "暂不支持共享"
          : needsPermission
            ? "需要录制权限"
            : access.control
              ? "可观看与控制"
              : "仅观看桌面";
    return (
      <section
        className="screen-page screen-is-idle"
        aria-label={`${title}观看区域`}
      >
        <div
          className="screen-idle-status"
          data-pending={loading || undefined}
          data-tone={problem ? "danger" : needsPermission ? "waiting" : undefined}
          role="status"
          title={problem ?? access?.problem}
        >
          <span
            className="screen-dot"
            data-on={ready || undefined}
            data-tone={problem ? "danger" : needsPermission ? "waiting" : undefined}
            aria-hidden="true"
          />
          <span className="screen-idle-label">{statusLabel}</span>
        </div>
        <div className="screen-idle-actions">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="computer-row-hover-action"
                aria-label="画质与权限"
                title="画质与权限"
              >
                <SlidersHorizontal />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="screen-settings-popover w-80 max-w-[calc(100vw-32px)] gap-3"
            >
              <PopoverHeader>
                <PopoverTitle>画质与权限</PopoverTitle>
                <PopoverDescription>
                  画面设置对所有电脑生效。
                </PopoverDescription>
              </PopoverHeader>
              <div className="screen-settings-list">
                {choices.map(({ title, choice }) => (
                  <Fragment key={choice.label}>
                    <span>{title}</span>
                    <Choice {...choice} />
                  </Fragment>
                ))}
              </div>
              <div className="screen-permission-details">
                {access?.problem && <p>{access.problem}</p>}
                {access && (
                  <>
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
                  </>
                )}
                <div className="screen-permission-actions">
                  {access?.supported &&
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
                  <Button
                    variant="outline"
                    disabled={loaded.loading || job.busy}
                    onClick={loaded.reload}
                  >
                    <RotateCw data-icon="inline-start" />
                    刷新权限状态
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          {loaded.error ? (
            <Button size="sm" variant="outline" onClick={loaded.reload}>
              重新检查
            </Button>
          ) : (
            <Button
              size="sm"
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
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = uploadJob.busy ? "none" : "copy";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          dragDepth.current = 0;
          setDragging(false);
          return;
        }
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        handleDropFiles(event.dataTransfer.files);
      }}
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
                <>
                  <Button
                    variant={audio ? "secondary" : "outline"}
                    size="sm"
                    aria-pressed={audio}
                    title={audio ? "静音电脑声音" : "开启电脑声音"}
                    disabled={!audioSupported && !audio}
                    onClick={toggleAudio}
                  >
                    {audio ? <Volume2 data-icon="inline-start" /> : <VolumeX data-icon="inline-start" />}
                    {audio ? "声音" : "静音"}
                  </Button>
                  <ScreenToolsMenu
                    container={fullscreen || focused ? surface.current : undefined}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    title="重新连接"
                    aria-label="重新连接"
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    <RotateCw />
                  </Button>
                </>
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
        {dragging && (
          <div className="screen-drop-overlay" role="status" aria-live="polite">
            <Upload size={24} />
            <strong>{uploadJob.busy ? "正在上传文件…" : "松开以上传到电脑"}</strong>
            <span>
              {uploadDir ? `保存到当前目录 · 单个文件最大 ${MAX_ATTACHMENT_LABEL}` : `保存到电脑桌面或主目录 · 单个文件最大 ${MAX_ATTACHMENT_LABEL}`}
            </span>
          </div>
        )}
        {(uploadProgress || uploadNotice || uploadError) && (
          <div className="screen-upload-toast" data-tone={uploadError ? "error" : undefined} role="status">
            {uploadProgress ? (
              <>
                <LoaderCircle className="animate-spin" size={14} />
                <span>
                  正在上传 {uploadProgress.done + 1} / {uploadProgress.total}：{uploadProgress.name}
                </span>
              </>
            ) : (
              <>
                <span>{uploadError ?? uploadNotice}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="关闭上传提示"
                  onClick={() => {
                    setUploadError(undefined);
                    setUploadNotice(undefined);
                  }}
                >
                  <X />
                </Button>
              </>
            )}
          </div>
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
