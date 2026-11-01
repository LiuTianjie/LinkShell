import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Command,
  Keyboard,
  LoaderCircle,
  Maximize,
  Minimize,
  Monitor,
  MousePointer2,
  MousePointerClick,
  RotateCw,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { ErrorNotice, useClient, useConnection, useJob, useLoad } from "./common";
import { DESKTOP_FULLSCREEN_EVENT, DESKTOP_LOCAL, isWindowsDesktop, setDesktopScreenFullScreen, setDesktopScreenKeys } from "./desktop";
import { useDesktopVisibility } from "./desktop-visibility";
import { readLocal, saveLocal } from "./storage";
import { ScreenConnectionLoading } from "./ScreenConnectionLoading";
import { askFullscreen, fullscreenShown, idleFullscreen, windowFullscreen, type FullscreenState } from "./screen-fullscreen";
import {
  chosenScreenWidth,
  fittedRect,
  fittedScreenWidth,
  mouseButton,
  namedKey,
  pictureFraction,
  remoteModifiers,
  screenPlatform,
  shortcutKey,
  snappedRect,
  textInput,
  wheelPixels,
  type Rect,
} from "./screen-input";
import { ScreenReceiver, type ReceiverState } from "./screen-receiver";
import "../styles/remote-screen.css";
import { remoteShortcuts, shortcutSign, type RemoteShortcut } from "./screen-shortcuts";

/** The window's own full screen, as the shell reports it (enter by the green button, ⌃⌘F, the menu). */
const DESKTOP_WINDOW_EVENT = "linkshell-desktop-window";

const QUALITY = [
  { value: "auto", label: "随窗口", detail: "按显示的大小取清晰度" },
  { value: "1920", label: "标准", detail: "1920 宽" },
  { value: "2560", label: "高清", detail: "2560 宽" },
  { value: "native", label: "原生", detail: "电脑屏幕本身，最高 4K" },
  { value: "1280", label: "省流量", detail: "1280 宽" },
] as const;
const RATES = ["120", "60", "30"] as const;

interface Preferences { quality: string; maxFps: string; codec: "auto" | "h264"; control: boolean }
function readPreferences(): Preferences {
  const quality = readLocal<string>("remoteScreenQuality", "auto");
  const maxFps = readLocal<string>("remoteScreenFps", "60");
  return {
    quality: QUALITY.some((entry) => entry.value === quality) ? quality : "auto",
    maxFps: (RATES as readonly string[]).includes(maxFps) ? maxFps : "60",
    codec: readLocal<string>("remoteScreenCodec", "auto") === "h264" ? "h264" : "auto",
    control: readLocal<boolean>("remoteScreenControl", true) !== false,
  };
}

function hevcReceivable(): boolean {
  try { return (RTCRtpReceiver.getCapabilities("video")?.codecs ?? []).some((codec) => codec.mimeType.toLowerCase() === "video/h265"); }
  catch { return false; }
}

const LOCAL_PLATFORM = isWindowsDesktop ? "windows" : /Mac/i.test(typeof navigator === "undefined" ? "" : navigator.platform) ? "mac" : "other";

/**
 * The remote screen in the desktop window. The picture is the video track itself, in the page:
 * mouse and keyboard go straight to the computer, its pointer becomes this one's, and the picture
 * is asked for at the size it is shown (sharper in full screen, lighter in a small window).
 */
export function RemoteScreen({ title, active = true, back }: { title: string; active?: boolean; back?: () => void }) {
  const { link, streams, computer } = useConnection();
  const machine = useClient((state) => state.machine);
  const remote = screenPlatform(machine?.platform);
  const visible = useDesktopVisibility();
  const access = useLoad(() => link.call("screen.access", {}), [link]);
  const job = useJob();
  const [preferences, setPreferences] = useState(readPreferences);
  const [display, setDisplay] = useState(() => readLocal<number>("remoteScreenDisplay", 0));
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ReceiverState>();
  const [fullscreen, setFullscreenState] = useState<FullscreenState>(idleFullscreen);
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const shown = fullscreenShown(fullscreen);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [barVisible, setBarVisible] = useState(true);
  const [focused, setFocused] = useState(false);
  const receiver = useRef<ScreenReceiver | undefined>(undefined);
  /** The picture came down the socket when it was ended for being unused: the next connection starts there. */
  const resumeOnSocket = useRef(false);
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const ime = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const pointerAt = useRef({ x: 0.5, y: 0.5 });
  const placeCursorRef = useRef<() => void>(() => {});
  const activeRef = useRef(active);
  activeRef.current = active;
  const running = active && visible;
  const allowed = access.value?.supported !== false && access.value?.recording !== false;

  // ── The connection ───────────────────────────────────────────────────────────────────────
  const widthFor = useCallback((size: { width: number; height: number }, aspect?: number) =>
    chosenScreenWidth(preferences.quality, fittedScreenWidth(size, window.devicePixelRatio, aspect)), [preferences.quality]);
  const startWidth = useRef(1920);
  useEffect(() => {
    if (!video.current || !canvas.current || !access.value || !allowed) return;
    const box = stage.current?.getBoundingClientRect();
    // Measured as it starts: what the stage will show is what the picture has to cover.
    startWidth.current = widthFor({ width: box?.width || 1280, height: box?.height || 800 });
    const created = new ScreenReceiver({
      link, streams,
      target: { display, width: startWidth.current, maxFps: Number(preferences.maxFps) },
      active: running,
      control: preferences.control,
      hevc: preferences.codec === "auto" && hevcReceivable(),
      relayed: computer.gateway !== DESKTOP_LOCAL && streams.path !== "direct",
      // After an idle end, back the way the picture came: no waiting for a video track that didn't get through.
      videoTrack: resumeOnSocket.current ? false : undefined,
      video: video.current,
      canvas: canvas.current,
      onState: (next) => setState(next),
      onCursor: (x, y) => { pointerAt.current = { x, y }; placeCursorRef.current(); },
    });
    receiver.current = created;
    setState(created.state);
    return () => {
      created.stop();
      if (receiver.current === created) receiver.current = undefined;
    };
    // A new connection only for what the open one can't change: the computer, a retry, the codec.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, streams, revision, preferences.codec, !!access.value, allowed]);

  // Off the page or the window hidden: a capable host pauses the capture and keeps the connection.
  useEffect(() => { receiver.current?.setActive(running); }, [running]);
  useEffect(() => { receiver.current?.setControl(preferences.control); }, [preferences.control]);

  // The picture's size follows the stage: full screen asks for more pixels, a small window for fewer.
  const aspect = state?.picture ? state.picture.width / state.picture.height : undefined;
  const wantedWidth = stageSize.width ? widthFor(stageSize, aspect) : undefined;
  useEffect(() => {
    const current = receiver.current;
    if (!current || !wantedWidth || !state?.configurable) return;
    // Settled sizes only: a window being dragged larger asks once it has stopped.
    const timer = setTimeout(() => {
      const result = current.setTarget({ width: wantedWidth });
      if (result === "reconnect") setRevision((value) => value + 1);
    }, 400);
    return () => clearTimeout(timer);
  }, [wantedWidth, state?.configurable]);
  useEffect(() => {
    const result = receiver.current?.setTarget({ maxFps: Number(preferences.maxFps), display });
    if (result === "reconnect") setRevision((value) => value + 1);
  }, [preferences.maxFps, display]);

  const choose = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    const storage = { quality: "remoteScreenQuality", maxFps: "remoteScreenFps", codec: "remoteScreenCodec", control: "remoteScreenControl" }[key];
    try { saveLocal(storage, value); } catch { /* A preference: the screen still works without it. */ }
    setPreferences((current) => ({ ...current, [key]: value }));
  };
  const chooseDisplay = (index: number) => {
    try { saveLocal("remoteScreenDisplay", index); } catch { /* As above. */ }
    setDisplay(index);
  };

  // ── Layout: where the picture is, on whole device pixels ─────────────────────────────────
  const picture = state?.picture;
  const rect: Rect = useMemo(() => picture ? snappedRect(fittedRect(picture, stageSize), window.devicePixelRatio) : { x: 0, y: 0, width: 0, height: 0 },
    [picture, stageSize]);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      setStageSize((size) => size.width === box.width && size.height === box.height ? size : { width: box.width, height: box.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const shape = state?.shape;
  const placeCursor = useCallback(() => {
    const element = cursor.current, box = rectRef.current;
    if (!element || !box.width) return;
    const hotX = shape?.hotX ?? 1.5, hotY = shape?.hotY ?? 1.5;
    element.style.transform = `translate(${box.x + pointerAt.current.x * box.width - hotX}px, ${box.y + pointerAt.current.y * box.height - hotY}px)`;
  }, [shape]);
  placeCursorRef.current = placeCursor;
  useLayoutEffect(placeCursor, [placeCursor, rect]);

  // ── Full screen ──────────────────────────────────────────────────────────────────────────
  const requestFullscreen = useCallback((enabled: boolean) => {
    const { next, request } = askFullscreen(fullscreenRef.current, enabled);
    fullscreenRef.current = next;
    setFullscreenState(next);
    if (request === undefined) return;
    // Outside the desktop app the page's own full screen stands in for the window's.
    if (!setDesktopScreenFullScreen(request)) {
      if (request) void root.current?.requestFullscreen?.().catch(() => {});
      else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    }
  }, []);
  useEffect(() => {
    const changed = (fullscreen: boolean, adopt: boolean) => {
      const next = windowFullscreen(fullscreenRef.current, fullscreen, adopt);
      fullscreenRef.current = next;
      setFullscreenState(next);
    };
    // The answer to this screen's own request, and the window's own control (green button, menu).
    const answer = (event: Event) => changed((event as CustomEvent<{ fullscreen?: unknown }>).detail?.fullscreen === true, false);
    const windowChanged = (event: Event) => changed((event as CustomEvent<{ fullscreen?: unknown }>).detail?.fullscreen === true, activeRef.current && !document.querySelector(".terminal-fullscreen"));
    const page = () => changed(document.fullscreenElement === root.current, false);
    window.addEventListener(DESKTOP_FULLSCREEN_EVENT, answer);
    window.addEventListener(DESKTOP_WINDOW_EVENT, windowChanged);
    document.addEventListener("fullscreenchange", page);
    return () => {
      window.removeEventListener(DESKTOP_FULLSCREEN_EVENT, answer);
      window.removeEventListener(DESKTOP_WINDOW_EVENT, windowChanged);
      document.removeEventListener("fullscreenchange", page);
      // Leaving the page leaves its full screen.
      if (fullscreenRef.current.owns) requestFullscreen(false);
    };
  }, [requestFullscreen]);
  useEffect(() => { if (!active) requestFullscreen(false); }, [active, requestFullscreen]);
  // The bar comes back while the pointer is near the top edge, and on entering full screen.
  useEffect(() => {
    if (!shown) { setBarVisible(true); return; }
    setBarVisible(true);
    const timer = setTimeout(() => setBarVisible(false), 2200);
    return () => clearTimeout(timer);
  }, [shown]);

  // ── Input ────────────────────────────────────────────────────────────────────────────────
  const canInput = !!state?.canInput;
  const canInputRef = useRef(canInput);
  canInputRef.current = canInput;
  const focusStage = useCallback(() => { ime.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { if (canInput && shown) focusStage(); }, [canInput, shown, focusStage]);
  useEffect(() => {
    // The keys belong to the computer while the stage has them: the shell's shortcuts and the
    // window's menu stand aside (⌘W, ⌘Q, ⌘H go over too, as in any remote desktop).
    const captured = focused && canInput;
    document.documentElement.toggleAttribute("data-remote-keys", captured);
    setDesktopScreenKeys(captured);
    return () => {
      document.documentElement.removeAttribute("data-remote-keys");
      if (captured) setDesktopScreenKeys(false);
    };
  }, [focused, canInput]);
  useEffect(() => {
    // Nothing stays pressed when the window loses the keys.
    const blur = () => receiver.current?.releaseAll();
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, []);

  const at = (event: { clientX: number; clientY: number }, clamp = false) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return undefined;
    return pictureFraction(rectRef.current, event.clientX - box.left, event.clientY - box.top, clamp);
  };
  const lastBar = useRef(0);
  const onPointerMove = (event: React.PointerEvent) => {
    if (shown) {
      const box = root.current?.getBoundingClientRect();
      const near = !!box && event.clientY - box.top < 56;
      if (near !== barVisible && (near || performance.now() - lastBar.current > 600)) { lastBar.current = performance.now(); setBarVisible(near); }
    }
    if (!canInput || event.pointerType !== "mouse") return;
    const captured = stage.current?.hasPointerCapture(event.pointerId);
    const point = at(event, captured);
    if (!point) return;
    pointerAt.current = point;
    placeCursor();
    receiver.current?.pointer(point.x, point.y);
  };
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse" || !canInput) return;
    const button = mouseButton(event.button);
    const point = at(event);
    if (!button || !point) return;
    event.preventDefault();
    focusStage();
    stage.current?.setPointerCapture(event.pointerId);
    receiver.current?.button(true, button, point.x, point.y, Math.max(1, event.detail || 1), remoteModifiers(event, LOCAL_PLATFORM, remote));
  };
  const onPointerUp = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const button = mouseButton(event.button);
    const point = at(event, true);
    if (button && point) receiver.current?.button(false, button, point.x, point.y, Math.max(1, event.detail || 1), remoteModifiers(event, LOCAL_PLATFORM, remote));
    if (stage.current?.hasPointerCapture(event.pointerId)) stage.current.releasePointerCapture(event.pointerId);
  };
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    // Not passive: the wheel must not scroll the page under the picture.
    const wheel = (event: WheelEvent) => {
      if (!canInputRef.current) return;
      const point = at(event);
      if (!point) return;
      event.preventDefault();
      const { dx, dy } = wheelPixels(event);
      receiver.current?.scroll(dx, dy, point.x, point.y, remoteModifiers(event, LOCAL_PLATFORM, remote));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [remote]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!canInput) return;
    const native = event.nativeEvent;
    if (native.isComposing || native.keyCode === 229 || composing.current) return;
    const modifiers = remoteModifiers(native, LOCAL_PLATFORM, remote);
    // ⌃⌘F stays with this computer: the way out of full screen while controlling the other one.
    if (LOCAL_PLATFORM === "mac" && native.metaKey && native.ctrlKey && native.code === "KeyF") {
      event.preventDefault();
      requestFullscreen(!fullscreenRef.current.owns);
      return;
    }
    const named = namedKey(native);
    // Text goes through the field (input methods, dead keys, emoji); shortcuts and named keys go as keys.
    const shortcut = native.metaKey || native.ctrlKey || (native.altKey && remote === "windows");
    if (named || shortcut) {
      const key = shortcutKey(native);
      if (!key) return;
      event.preventDefault();
      receiver.current?.key(key, modifiers);
    }
  };
  const onInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    if (composing.current) return;
    const text = field.value;
    field.value = "";
    if (text && canInput) receiver.current?.input(textInput(text));
  };
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Pasted with this computer's ⌘V: what is on its clipboard, typed into the other one.
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain").slice(0, 20_000);
    if (text && canInput) receiver.current?.input(textInput(text));
  };
  const sendShortcut = (shortcut: RemoteShortcut) => {
    receiver.current?.key(shortcut.key, shortcut.modifiers);
    focusStage();
  };
  const pasteClipboard = async () => {
    try {
      const text = (await navigator.clipboard.readText()).slice(0, 20_000);
      if (text) receiver.current?.input(textInput(text));
    } catch { /* Not allowed: nothing typed. */ }
    focusStage();
  };

  // ── What is shown ────────────────────────────────────────────────────────────────────────
  const phase = state?.phase;
  const live = !!picture && (phase === "live" || phase === "recovering" || phase === "receiving");
  const control = state?.control;
  const controlProblem = preferences.control && live && control?.known && (!control.available || !control.trusted)
    ? control.available ? `电脑还没有允许${control.app ? `「${control.app}」` : " LinkShell "}控制。请在电脑的「系统设置 › 隐私与安全性 › 辅助功能」中打开它。` : control.reason || "这台电脑暂时不能被控制"
    : undefined;
  const stats = state?.stats;
  const pathLabel = stats?.path === "lan" ? "局域网直连" : stats?.path === "direct" ? "直连" : stats?.path === "relay" ? "中继" : stats?.path === "socket" ? "兼容方式" : state?.transport === "video" ? "直连" : undefined;
  const checkPermissions = () => void job.run(async () => { await link.call("screen.access", { ask: true }); access.reload(); });
  const retry = () => {
    resumeOnSocket.current = !!state?.idle && state.transport === "socket";
    setState(undefined);
    setRevision((value) => value + 1);
  };
  const shortcuts = remoteShortcuts(remote);

  const toolbar = (
    <div className="remote-screen-bar" data-hidden={shown && !barVisible ? "" : undefined} onPointerEnter={() => shown && setBarVisible(true)}>
      <div className="remote-screen-title">
        {back && !shown
          ? <Button variant="ghost" size="icon" aria-label="返回电脑列表" title="返回电脑列表" onClick={back}><ArrowLeft /></Button>
          : <Monitor size={15} aria-hidden />}
        <strong title={title}>{title}</strong>
        {live && <span className="remote-screen-path" data-path={stats?.path}>{pathLabel}{stats?.fps !== undefined ? ` · ${Math.round(stats.fps)} 帧` : ""}</span>}
      </div>
      <div className="remote-screen-actions">
        {(state?.displays.length ?? 0) > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="选择显示器">{state?.displays.find((entry) => entry.index === state.display)?.name ?? "显示器"}<ChevronDown data-icon="inline-end" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-44" container={root.current}>
              <DropdownMenuRadioGroup value={String(state?.display ?? display)} onValueChange={(value) => chooseDisplay(Number(value))}>
                {state?.displays.map((entry) => <DropdownMenuRadioItem key={entry.index} value={String(entry.index)}>{entry.name}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button
          variant={preferences.control ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={preferences.control}
          title={preferences.control ? "鼠标和键盘正在控制电脑，点击改为只看" : "只看画面，点击开始控制电脑"}
          disabled={access.value?.control === false && !preferences.control}
          onClick={() => choose("control", !preferences.control)}
        >
          {preferences.control ? <MousePointerClick data-icon="inline-start" /> : <MousePointer2 data-icon="inline-start" />}
          {preferences.control ? "控制中" : "只看"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="发送快捷键" title="发送这台电脑会拦下的快捷键" disabled={!canInput}><Command /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="remote-screen-shortcuts w-64" container={root.current}>
            {shortcuts.map((group, index) => (
              <div key={group.title}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel>{group.title}</DropdownMenuLabel>
                {group.items.map((item) => (
                  <DropdownMenuItem key={item.name} variant={item.careful ? "destructive" : "default"} onSelect={() => sendShortcut(item)}>
                    {item.name}<kbd className="ml-auto">{shortcutSign(item, remote).split("`").flatMap((part, index) => index ? [<span key={index} className="remote-screen-grave">`</span>, part] : [part])}</kbd>
                  </DropdownMenuItem>
                ))}
              </div>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void pasteClipboard()}><Keyboard />输入这台电脑剪贴板里的文字</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="画面设置" title="画面设置"><SlidersHorizontal /></Button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={10} className="remote-screen-settings w-72" container={root.current}>
            <section>
              <h4>清晰度</h4>
              <div role="radiogroup" aria-label="清晰度">
                {QUALITY.map((entry) => (
                  <button key={entry.value} type="button" role="radio" aria-checked={preferences.quality === entry.value} onClick={() => choose("quality", entry.value)}>
                    <span><b>{entry.label}</b><small>{entry.value === "auto" && state?.appliedWidth ? `现在 ${state.appliedWidth} 宽` : entry.detail}</small></span>
                    {preferences.quality === entry.value && <Check size={14} />}
                  </button>
                ))}
              </div>
            </section>
            <section>
              <h4>帧率上限</h4>
              <div className="remote-screen-segments" role="radiogroup" aria-label="帧率上限">
                {RATES.map((rate) => (
                  <button key={rate} type="button" role="radio" aria-checked={preferences.maxFps === rate} onClick={() => choose("maxFps", rate)}>{rate}</button>
                ))}
              </div>
              <p>实际帧率还受电脑屏幕刷新率和网络限制。</p>
            </section>
            <section>
              <h4>编码</h4>
              <div className="remote-screen-segments" role="radiogroup" aria-label="视频编码">
                <button type="button" role="radio" aria-checked={preferences.codec === "auto"} onClick={() => choose("codec", "auto")}>自动</button>
                <button type="button" role="radio" aria-checked={preferences.codec === "h264"} onClick={() => choose("codec", "h264")}>兼容 H.264</button>
              </div>
            </section>
            {live && stats && (
              <dl className="remote-screen-stats">
                <div><dt>画面</dt><dd>{stats.width && stats.height ? `${stats.width} × ${stats.height}` : "—"}</dd></div>
                <div><dt>接收</dt><dd>{stats.fps !== undefined ? `${Math.round(stats.fps)} 帧/秒` : "—"}{stats.bitrateMbps !== undefined ? ` · ${stats.bitrateMbps} Mbps` : ""}</dd></div>
                <div><dt>编码</dt><dd>{[stats.codec, stats.hardware === true ? "硬件解码" : stats.hardware === false ? "软件解码" : undefined].filter(Boolean).join(" · ") || "—"}</dd></div>
                <div><dt>连接</dt><dd>{[pathLabel, stats.rttMs !== undefined ? `往返 ${stats.rttMs} 毫秒` : undefined].filter(Boolean).join(" · ") || "—"}</dd></div>
              </dl>
            )}
          </PopoverContent>
        </Popover>
        <Button variant="ghost" size="icon" aria-label="重新连接" title="重新连接" onClick={retry}><RotateCw /></Button>
        <Button variant={shown ? "secondary" : "ghost"} size="sm" onClick={() => requestFullscreen(!fullscreen.owns)} title={LOCAL_PLATFORM === "mac" ? "全屏（⌃⌘F）" : "全屏"}>
          {shown ? <Minimize data-icon="inline-start" /> : <Maximize data-icon="inline-start" />}
          {shown ? "退出全屏" : "全屏"}
        </Button>
      </div>
    </div>
  );

  let overlay: React.ReactNode = null;
  if (access.error || (!access.value && access.loading)) {
    overlay = access.error ? (
      <div className="screen-start"><Monitor size={28} /><h3>无法读取屏幕状态</h3><ErrorNotice error={access.error} /><Button variant="outline" onClick={access.reload}>重新检查</Button></div>
    ) : <ScreenConnectionLoading preparing={false} slow={false} retry={retry} />;
  } else if (access.value && !allowed) {
    overlay = (
      <div className="screen-start">
        <Monitor size={28} />
        <h3>{access.value.supported ? "需要屏幕录制权限" : "这台电脑暂不支持远程桌面"}</h3>
        <p>{access.value.problem ?? (access.value.supported ? "在电脑上允许 LinkShell 录制屏幕后，画面会自动出现。" : "电脑的系统暂不支持共享屏幕。")}</p>
        <ErrorNotice error={job.error} />
        {access.value.supported && <div className="screen-start-actions">
          <Button disabled={job.busy} onClick={checkPermissions}>{job.busy ? "正在请求…" : "在电脑上打开权限设置"}</Button>
          <Button variant="ghost" onClick={access.reload}>刷新状态</Button>
        </div>}
      </div>
    );
  } else if (phase === "error") {
    overlay = (
      <div className="screen-start" role="alert">
        <Monitor size={28} />
        <h3>{state?.taken ? "画面被另一台设备接手了" : state?.idle ? "长时间没有操作，画面已断开" : "画面已断开"}</h3>
        <p>{state?.taken ? "另一台设备打开了这台电脑的屏幕。需要时可以把画面接回来。" : state?.idle ? "画面经中转传输时，3 分钟没有操作会自动断开，以节省流量。" : state?.error}</p>
        <Button onClick={retry}>{state?.taken ? "接回画面" : "重新连接"}</Button>
      </div>
    );
  } else if (!live) {
    overlay = <ScreenConnectionLoading preparing={phase === "receiving" || phase === "recovering"} slow={false} retry={retry} />;
  }

  const cursorStyle: CSSProperties | undefined = shape ? { width: shape.w, height: shape.h, backgroundImage: `url("${shape.url}")` } : undefined;
  // The computer's own pointer picture becomes this one's over the picture: drawn at the
  // computer's resolution, with its hot spot in points.
  const ownCursor = canInput && shape ? `-webkit-image-set(url("${shape.url}") ${shape.scale}x) ${Math.round(shape.hotX)} ${Math.round(shape.hotY)}, default` : undefined;

  return (
    <section
      ref={root}
      className={cn("remote-screen", shown && "remote-screen-fullscreen")}
      data-control={canInput || undefined}
      aria-label={`${title}的远程桌面`}
      onPointerMove={onPointerMove}
      // A relayed picture is ended when no one uses it; looking around it with the pointer counts.
      onPointerMoveCapture={() => receiver.current?.used()}
      onPointerDownCapture={() => receiver.current?.used()}
      onWheelCapture={() => receiver.current?.used()}
      onKeyDownCapture={() => receiver.current?.used()}
    >
      {toolbar}
      <div
        ref={stage}
        className="remote-screen-stage"
        style={{ cursor: canInput ? ownCursor ?? "default" : undefined }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(event) => { if (canInput) event.preventDefault(); }}
        onClick={() => { if (canInput) focusStage(); }}
      >
        <video
          ref={video}
          className="remote-screen-picture"
          data-on={state?.transport === "video" || undefined}
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
          muted
          playsInline
          autoPlay
          disablePictureInPicture
          aria-hidden
        />
        <canvas
          ref={canvas}
          className="remote-screen-picture"
          data-on={state?.transport === "socket" || undefined}
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
          aria-hidden
        />
        {/* The computer's own pointer, drawn where it is while this window isn't moving it. */}
        <div ref={cursor} className="remote-screen-cursor" data-shape={shape ? "" : undefined} data-on={live && !(canInput && focused) || undefined} style={cursorStyle} aria-hidden />
        <textarea
          ref={ime}
          className="remote-screen-keys"
          aria-label="远程电脑键盘输入"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          tabIndex={canInput ? 0 : -1}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); receiver.current?.releaseAll(); }}
          onKeyDown={onKeyDown}
          onInput={onInput}
          onPaste={onPaste}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(event) => {
            composing.current = false;
            const text = event.data || event.currentTarget.value;
            event.currentTarget.value = "";
            if (text && canInputRef.current) receiver.current?.input(textInput(text));
          }}
        />
        {overlay && <div className="remote-screen-overlay">{overlay}</div>}
        {live && phase === "recovering" && <div className="remote-screen-toast"><LoaderCircle className="animate-spin" size={14} />正在恢复画面…</div>}
        {live && !overlay && (state?.notice || controlProblem) && (
          <div className="remote-screen-toast" data-tone={controlProblem ? "warning" : undefined}>
            <span>{controlProblem ?? state?.notice}</span>
            {controlProblem && control?.available && <Button size="xs" variant="outline" onClick={() => receiver.current?.askPermission()}>在电脑上打开</Button>}
          </div>
        )}
        {live && preferences.control && !focused && canInput && !shown && (
          <div className="remote-screen-hint">点击画面开始操作电脑</div>
        )}
      </div>
    </section>
  );
}
