import { useEffect, useRef, useState } from "react";
import { AppWindowMac, ArrowDownLeft, Expand, LoaderCircle, Maximize, Minimize, Monitor, RotateCw, SlidersHorizontal, Square } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { ErrorNotice, LoadState, messageOf, useClient, useConnection, useJob, useLoad } from "./common";
import { DESKTOP_FULLSCREEN_EVENT, isElectronDesktop, readDesktopStorage, saveDesktopStorage, setDesktopScreenFullScreen } from "./desktop";
import { canUseFusionMode, startComputerFusion } from "./fusion";
import { useDesktopVisibility } from "./desktop-visibility";
import { NATIVE_SCREEN_EVENT, leaveScreenFullscreen, nativeScreenQuery, postNativeScreen, screenSignal, windowFullscreenChanged, type NativeScreenEvent, type NativeScreenStatus, type ScreenFullscreen } from "./desktop-screen";
import { RemoteScreen } from "./RemoteScreen";
import { autoScreenWidth, screenPreferences } from "./screen-preferences";
import { CAPABILITIES_WAIT_MS, PAUSE_ACK_MS, RETRIES_EARNED_MS, nativeSessionPolicy, screenRate, targetChanged, type ScreenTarget } from "./desktop-screen-session";
import { openWebSocket } from "./transport";
import { ScreenToolsMenu, type ScreenProps } from "./Video";

/** One native session, as the effects that outlive a render reach it. */
interface Live { apply(next: ScreenTarget): void }

/**
 * The Mac's remote screen: native first, as on the phone. Should the native video not get
 * through (no direct path, a network that blocks it), the page's own receiver shows the picture,
 * over the encrypted relay when it must, as the phone falls back to its web viewer.
 */
export function MacScreen(props: ScreenProps) {
  const [fallback, setFallback] = useState<string>();
  if (fallback && isElectronDesktop) return <RemoteScreen title={props.title ?? "电脑屏幕"} active={props.active ?? true} />;
  return <DesktopScreen {...props} onFallback={isElectronDesktop ? setFallback : undefined} />;
}

const DESKTOP_WINDOW_EVENT = "linkshell-desktop-window";

/** The DOM owns chrome and authenticated signalling; AppKit owns the video surface and input. */
export function DesktopScreen({ title = "电脑屏幕", embedded = false, primaryAction = false, onOpen, autoStart = false, active = true, onFallback }: ScreenProps & { onFallback?: (reason: string) => void }) {
  const { computer, link, streams } = useConnection();
  const remotePlatform = useClient((state) => state.machine?.platform);
  const fusionAvailable = canUseFusionMode(computer.key, remotePlatform);
  const visible = useDesktopVisibility();
  const job = useJob();
  const fusionJob = useJob();
  const access = useLoad(() => link.call("screen.access", {}), [link]);
  const [started, setStarted] = useState(autoStart);
  const [focused, setFocused] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Only the screen that asked for the window's full screen follows it or ends it.
  const fullscreenState = useRef<ScreenFullscreen>({ owns: false, fullscreen: false });
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const adoptableRef = useRef(active && started);
  adoptableRef.current = active && started;
  const fullscreenRequest = (enabled: boolean) => {
    if (!enabled) {
      const next = leaveScreenFullscreen(fullscreenState.current);
      if (!next) return;
      fullscreenState.current = next;
      setFullscreen(false);
    } else fullscreenState.current = { ...fullscreenState.current, owns: true };
    if (!setDesktopScreenFullScreen(enabled, { immersive: true })) { fullscreenState.current = { ...fullscreenState.current, owns: false }; setFocused(enabled); }
  };
  const [settings, setSettings] = useState(false);
  const [display, setDisplay] = useState(0);
  const [displays, setDisplays] = useState<{ index: number; name: string }[]>([]);
  const [preferences, setPreferences] = useState(() => {
    const read = (key: string) => readDesktopStorage<string | undefined>(`screen:${key}`, undefined);
    const view = screenPreferences(read);
    // Like the phone: ask for 120 unless a rate was chosen; it is then held to what this Mac's display shows.
    return read("linkshell.screen.maxFps") ? view : { ...view, maxFps: "120" };
  });
  // The lowest latency unless the user chose even pacing: on Wi-Fi the buffer grows to cover radio pauses (ScreenPacing.swift).
  const [smooth, setSmooth] = useState(() => readDesktopStorage<string | undefined>("screen:linkshell.screen.pacing", undefined) === "smooth");
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<NativeScreenStatus>({});
  const [error, setError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const [controlRequested, setControlRequested] = useState(false);
  // The rate this Mac's display shows: the native view says, and again when the window moves.
  const [displayFps, setDisplayFps] = useState<number>();
  // "Auto" width, measured from the stage: it follows the window and its full screen.
  const [fitted, setFitted] = useState<string>();
  // The session was let go while its page was hidden (the host can't pause, or didn't confirm).
  const [dormant, setDormant] = useState(false);
  const controlling = status.control === true;
  const stage = useRef<HTMLDivElement>(null);
  const sessionID = useRef<string | undefined>(undefined);
  const live = useRef<Live | undefined>(undefined);
  const retries = useRef(0);
  const compact = embedded && !started;
  const keep = started && visible && !dormant;
  const width = preferences.width === "auto" ? fitted ?? "1920" : preferences.width;
  const maxFps = screenRate(preferences.maxFps, displayFps);
  const desired = useRef<ScreenTarget>({ display, width, maxFps, paused: !active });
  // Read when the session needs them, without making a new session when they change.
  const latest = useRef({ onFallback, autoWidth: preferences.width === "auto" });
  latest.current = { onFallback, autoWidth: preferences.width === "auto" };

  useEffect(() => {
    if (!active || !visible) { setFocused(false); fullscreenRequest(false); }
  }, [active, visible]);
  useEffect(() => {
    // The window's own full screen; while it lasts the page also fills the window.
    const apply = (fullscreen: boolean, adopt: boolean) => {
      const next = windowFullscreenChanged(fullscreenState.current, fullscreen, adopt);
      if (!next) return;
      fullscreenState.current = { owns: next.owns, fullscreen: next.fullscreen };
      setFullscreen(next.fullscreen);
      setFocused(next.focused);
    };
    const changed = (event: Event) => apply((event as CustomEvent<{ fullscreen?: unknown }>).detail?.fullscreen === true, false);
    const windowChanged = (event: Event) => apply(
      (event as CustomEvent<{ fullscreen?: unknown }>).detail?.fullscreen === true,
      adoptableRef.current && !document.querySelector(".terminal-fullscreen"),
    );
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFocused(false);
      fullscreenRequest(false);
    };
    window.addEventListener(DESKTOP_FULLSCREEN_EVENT, changed);
    window.addEventListener(DESKTOP_WINDOW_EVENT, windowChanged);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener(DESKTOP_FULLSCREEN_EVENT, changed);
      window.removeEventListener(DESKTOP_WINDOW_EVENT, windowChanged);
      window.removeEventListener("keydown", escape);
      fullscreenRequest(false);
    };
  }, []);
  useEffect(() => {
    if (sessionID.current) postNativeScreen(sessionID.current, "fullscreen", { enabled: fullscreen });
  }, [fullscreen]);

  // "Auto" follows the stage once it has settled after a resize or a full-screen change, and is
  // applied in-band: the picture stays as sharp as the stage, without reconnecting.
  useEffect(() => {
    if (!started || preferences.width !== "auto" || !stage.current) return;
    const node = stage.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      // Hidden while another page is shown: the stage has no width, and keeps what it had.
      if (node.clientWidth > 0) setFitted(autoScreenWidth({ width: node.clientWidth, ratio: window.devicePixelRatio }));
    };
    measure();
    const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(measure, 400); });
    observer.observe(node);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [started, preferences.width]);

  // The session itself. Display, width, rate and pausing are applied to it in-band (below); only
  // what needs a new negotiation (the codec, the pacing) or a retry makes a new one.
  useEffect(() => {
    if (!keep || !stage.current) return;
    const id = crypto.randomUUID();
    sessionID.current = id;
    let alive = true;
    let socket: Awaited<ReturnType<typeof openWebSocket>> | undefined;
    let socketOpen = false;
    const outgoing: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let earned: ReturnType<typeof setTimeout> | undefined;
    let capabilitiesTimer: ReturnType<typeof setTimeout> | undefined;
    let pauseTimer: ReturnType<typeof setTimeout> | undefined;
    const capabilities = { known: false, configure: false, pause: false };
    let requestId = 0;
    let awaitingPause: number | undefined;
    const start = { ...desired.current };
    if (latest.current.autoWidth && stage.current.clientWidth > 0) {
      start.width = autoScreenWidth({ width: stage.current.clientWidth, ratio: window.devicePixelRatio });
    }
    // What the host is asked for now: the address's values until the first configuration.
    let applied: ScreenTarget = { ...start, paused: false };
    setStatus({});
    setError(undefined);
    setControlRequested(false);
    const finish = () => {
      if (!alive) return;
      alive = false;
      clearTimeout(timer); clearTimeout(earned); clearTimeout(capabilitiesTimer); clearTimeout(pauseTimer);
      socket?.close();
      postNativeScreen(id, "stop");
      if (sessionID.current === id) sessionID.current = undefined;
      if (live.current === session) live.current = undefined;
    };
    const release = () => { finish(); setDormant(true); };
    const fail = (reason: unknown) => {
      if (!alive) return;
      const message = messageOf(reason);
      finish();
      setStatus({});
      setControlRequested(false);
      const action = nativeSessionPolicy(message, { paused: desired.current.paused, retries: retries.current, canFallBack: Boolean(latest.current.onFallback) });
      if (action === "dormant") return setDormant(true);
      if (action === "retry") {
        retries.current += 1;
        setRetrying(true);
        setTimeout(() => setRevision((value) => value + 1), 800 * retries.current);
        return;
      }
      setRetrying(false);
      if (action === "fallback") return latest.current.onFallback?.(message);
      setError(message);
    };
    const send = (message: Record<string, unknown>) => {
      const text = JSON.stringify(message);
      if (text.length > 262_144) return fail("屏幕协商信息过大");
      if (socket && socketOpen) socket.send(text);
      else if (outgoing.length < 128) outgoing.push(text);
      else fail("屏幕连接未就绪，请重试");
    };
    const flush = () => {
      if (!alive || !socket || !socketOpen) return;
      for (const message of outgoing) socket.send(message);
      outgoing.length = 0;
    };
    const configure = (next: ScreenTarget) => {
      requestId += 1;
      const message = { t: "screen.configure", requestId, display: next.display, width: next.width, maxFps: Number(next.maxFps), paused: next.paused };
      // The native receiver holds input back until the matching acknowledgement.
      postNativeScreen(id, "signal", { message });
      send(message);
      applied = { ...next };
      clearTimeout(pauseTimer);
      awaitingPause = next.paused ? requestId : undefined;
      // As on the phone: a pause that isn't confirmed releases the session rather than leave a hidden capture running.
      if (next.paused) pauseTimer = setTimeout(() => { if (awaitingPause !== undefined) release(); }, PAUSE_ACK_MS);
    };
    const session: Live = {
      apply(next) {
        // Before the host says what it can do, the target is kept; the first configuration carries it.
        if (!alive || !capabilities.known) return;
        const change = targetChanged(applied, next);
        if (!capabilities.configure || (next.paused && !capabilities.pause)) {
          // An older host or Mac app: as before, a change means a new session, and hiding ends it.
          if (next.paused) release();
          else if (change.picture) setRevision((value) => value + 1);
          return;
        }
        if (change.any) configure(next);
      },
    };
    live.current = session;
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<NativeScreenEvent>).detail;
      if (!alive || detail?.id !== id) return;
      if (detail.type === "signal" && detail.message) send(detail.message);
      else if (detail.type === "error") fail(detail.error || "原生屏幕连接失败");
      else if (detail.type === "status" && detail.status) {
        const next = detail.status;
        if (next.exitFullScreen === true) {
          fullscreenRequest(false);
          return;
        }
        if (typeof next.displayFps === "number" && next.displayFps > 0) setDisplayFps(next.displayFps);
        setStatus((previous) => ({ ...previous, ...next }));
        if (next.live) {
          clearTimeout(timer);
          setRetrying(false);
          clearTimeout(earned);
          earned = setTimeout(() => { retries.current = 0; }, RETRIES_EARNED_MS);
        }
        if (typeof next.controlRequested === "boolean") setControlRequested(next.controlRequested);
      }
    };
    window.addEventListener(NATIVE_SCREEN_EVENT, changed);
    const rect = () => {
      const bounds = stage.current?.getBoundingClientRect();
      if (!bounds) return { x: 0, y: 0, width: 0, height: 0 };
      // Native video must not cover modal overlays or DOM menus that intersect the video stage.
      const modal = document.querySelector('[data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"], [data-slot="sheet-overlay"]');
      const popups = document.querySelectorAll('[data-slot="dropdown-menu-content"], [data-slot="select-content"], [data-slot="popover-content"]');
      const overlaps = Array.from(popups).some((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.right > bounds.left && box.left < bounds.right && box.bottom > bounds.top && box.top < bounds.bottom;
      });
      const blocked = Boolean(modal) || overlaps;
      return { x: bounds.x, y: bounds.y, width: blocked ? 0 : bounds.width, height: blocked ? 0 : bounds.height };
    };
    let previousRect = "";
    const layout = () => {
      const next = rect();
      const serialized = JSON.stringify(next);
      if (alive && serialized !== previousRect) {
        previousRect = serialized;
        postNativeScreen(id, "layout", { rect: next });
      }
    };
    // While another workspace page is shown the stage has no size: the native view hides with
    // it, and drops pictures until it is back.
    const observer = new ResizeObserver(layout);
    observer.observe(stage.current);
    // Portal opening/closing does not resize the stage; the retained page is hidden by attribute.
    const overlays = new MutationObserver(layout);
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    window.addEventListener("resize", layout);
    window.addEventListener("scroll", layout, true);
    if (!postNativeScreen(id, "start", { rect: rect(), smooth, fullscreen: fullscreenRef.current })) fail("原生屏幕组件不可用，请更新 LinkShell App");
    else {
      timer = setTimeout(() => fail("视频直连超时，请确认电脑在线、已授权屏幕录制且网络允许直连"), 30_000);
      void link.call("screen.start", {}).then(async (viewer) => {
        if (!alive) return;
        setDisplays(viewer.displays);
        if (viewer.displays.length && !viewer.displays.some((entry) => entry.index === start.display)) {
          start.display = viewer.displays[0].index;
          applied = { ...applied, display: start.display };
          setDisplay(start.display);
        }
        const opened = await openWebSocket(streams, viewer.port, nativeScreenQuery(viewer.token, start.display, start.width, start.maxFps, preferences.codec === "auto"), {
          open: () => { socketOpen = true; flush(); },
          data: (data) => {
            if (!alive) return;
            try {
              const message = screenSignal(data);
              postNativeScreen(id, "signal", { message });
              const state = message.session as { t?: string; configure?: boolean; pause?: boolean; version?: number; requestId?: number; paused?: boolean } | undefined;
              if (!capabilities.known && state?.t === "capabilities" && state.version === 1) {
                capabilities.known = true;
                capabilities.configure = state.configure === true;
                capabilities.pause = state.pause === true;
                clearTimeout(capabilitiesTimer);
                // The first configuration also turns input generations on; it carries what changed meanwhile.
                const next = desired.current;
                if (capabilities.configure && !(next.paused && !capabilities.pause)) configure(next);
                else session.apply(next);
              } else if (state?.t === "configured" && state.requestId === awaitingPause && state.paused === true) {
                clearTimeout(pauseTimer);
                awaitingPause = undefined;
              }
            } catch (problem) { fail(problem); }
          },
          close: (reason) => { if (alive) fail(reason || "屏幕连接已断开，请重新连接"); },
        });
        if (!alive) opened.close();
        else {
          socket = opened;
          flush();
          capabilitiesTimer = setTimeout(() => {
            if (!alive || capabilities.known) return;
            capabilities.known = true;
            session.apply(desired.current);
          }, CAPABILITIES_WAIT_MS);
        }
      }).catch(fail);
    }
    return () => {
      finish();
      observer.disconnect();
      overlays.disconnect();
      window.removeEventListener(NATIVE_SCREEN_EVENT, changed);
      window.removeEventListener("resize", layout);
      window.removeEventListener("scroll", layout, true);
    };
  }, [keep, revision, link, streams, preferences.codec, smooth]);

  // Display, width, rate and whether this page is shown, applied to the running session in-band:
  // the peer, its track and channels stay, as on the phone. Hidden, the session is paused and kept
  // while the workspace retains the page (two minutes); coming back resumes it where it was.
  useEffect(() => {
    const next: ScreenTarget = { display, width, maxFps, paused: !active };
    desired.current = next;
    if (live.current) live.current.apply(next);
    else if (active && dormant) setDormant(false);
  }, [active, display, width, maxFps, dormant]);
  function choose(key: "width" | "maxFps", value: string) {
    saveDesktopStorage(`screen:linkshell.screen.${key}`, value);
    setPreferences((current) => ({ ...current, [key]: value }));
  }
  function choosePacing(value: boolean) {
    saveDesktopStorage("screen:linkshell.screen.pacing", value ? "smooth" : "immediate");
    setSmooth(value);
  }
  function retry() {
    retries.current = 0;
    setRetrying(false);
    setDormant(false);
    setRevision((value) => value + 1);
  }
  function control() {
    const enabled = !controlRequested;
    if (sessionID.current) postNativeScreen(sessionID.current, "control", { enabled });
    setControlRequested(enabled);
    setStatus((current) => ({ ...current, controlError: undefined }));
  }
  const checkPermissions = () => void job.run(async () => { await link.call("screen.access", { ask: true }); access.reload(); });
  const openFusion = () => void fusionJob.run(() => startComputerFusion({ computerKey: computer.key, name: title, link, streams }));
  if (compact) {
    const ready = Boolean(access.value?.supported && access.value.recording !== false);
    const needsPermission = access.value?.recording === false;
    const problem = fusionJob.error ?? job.error ?? access.error;
    const loading = access.loading && !access.value && !problem;
    const statusLabel = problem
      ? "检查失败"
      : loading
        ? "检查屏幕…"
        : !access.value?.supported
          ? "暂不支持共享"
          : needsPermission
            ? "需要录制权限"
            : access.value.control
              ? "可观看与控制"
              : "仅观看桌面";
    return <section className="screen-page screen-is-idle" aria-label={`${title}观看区域`}>
      <div className="screen-idle-status" data-pending={loading || undefined} data-tone={problem ? "danger" : needsPermission ? "waiting" : undefined} role="status" title={problem ?? access.value?.problem}>
        <span className="screen-dot" data-on={ready || undefined} data-tone={problem ? "danger" : needsPermission ? "waiting" : undefined} aria-hidden="true" />
        <span className="screen-idle-label">{statusLabel}</span>
      </div>
      <div className="screen-idle-actions">
        {fusionAvailable && ready && !problem && (
          <Button size="sm" variant="outline" aria-label={`融合模式 · ${title}`} disabled={fusionJob.busy} onClick={openFusion}>
            <AppWindowMac data-icon="inline-start" aria-hidden="true" />
            {fusionJob.busy ? "正在启动…" : "融合模式"}
          </Button>
        )}
        <Button size="sm" variant={primaryAction ? "default" : "outline"} disabled={(!access.value?.supported && !problem) || job.busy} onClick={() => problem ? access.reload() : needsPermission ? checkPermissions() : onOpen ? onOpen() : setStarted(true)}>{problem ? "重新检查" : needsPermission ? (job.busy ? "正在请求…" : "检查权限") : "打开桌面"}</Button>
      </div>
    </section>;
  }
  return <section className={cn("screen-page desktop-native-screen", embedded && "screen-embedded", started && "screen-is-started", focused && "screen-focused", fullscreen && "screen-fullscreen")} aria-label={`${title}观看区域`} role={focused ? "dialog" : undefined} aria-modal={focused || undefined}>
    <div className="screen-toolbar">
      <strong className="screen-view-title"><Monitor size={17} /><span>{title}</span></strong>
      <div className="screen-actions">
        {fusionAvailable && (
          <Button variant="outline" size="sm" disabled={access.value?.recording === false || fusionJob.busy} onClick={openFusion}>
            <AppWindowMac data-icon="inline-start" aria-hidden="true" />
            {fusionJob.busy ? "正在启动…" : "融合模式"}
          </Button>
        )}
        <Button variant="ghost" size="icon" aria-label="画质设置" aria-expanded={settings} onClick={() => setSettings(!settings)}><SlidersHorizontal /></Button>
        {started && <><ScreenToolsMenu /><Button variant={controlling ? "secondary" : "outline"} disabled={!status.live || access.value?.control === false} aria-pressed={controlling} onClick={control}>{controlling ? "停止控制" : controlRequested ? "取消控制请求" : "控制电脑"}</Button><Button variant="ghost" size="icon" aria-label="重新连接" onClick={retry}><RotateCw /></Button></>}
        {!fullscreen && <Button variant="outline" onClick={() => setFocused(!focused)}>{focused ? <ArrowDownLeft data-icon="inline-start" /> : <Expand data-icon="inline-start" />}{focused ? "退出铺满" : "铺满窗口"}</Button>}
        {started && <Button variant="outline" onClick={() => fullscreenRequest(!fullscreen)}>{fullscreen ? <Minimize data-icon="inline-start" /> : <Maximize data-icon="inline-start" />}{fullscreen ? "退出全屏" : "全屏"}</Button>}
        {started && <Button variant="ghost" size="icon" aria-label="停止观看" onClick={() => { setStarted(false); setFocused(false); fullscreenRequest(false); setStatus({}); setError(undefined); }}><Square /></Button>}
      </div>
    </div>
    {settings && <div className="desktop-screen-settings">
      {displays.length > 1 && <div role="group" aria-label="显示器">{displays.map((entry) => <Button key={entry.index} variant={display === entry.index ? "secondary" : "ghost"} size="sm" onClick={() => setDisplay(entry.index)}>{entry.name}</Button>)}</div>}
      <div role="group" aria-label="画面清晰度"><span>清晰度</span>{[["auto", "随窗口"], ["1280", "省带宽"], ["1920", "标准"], ["2560", "高清"], ["native", "原生"]].map(([value, label]) => <Button key={value} size="sm" variant={preferences.width === value ? "secondary" : "ghost"} onClick={() => choose("width", value)}>{label}</Button>)}</div>
      <div role="group" aria-label="帧率上限"><span>帧率上限</span>{["30", "60", "120"].map((value) => <Button key={value} size="sm" variant={preferences.maxFps === value ? "secondary" : "ghost"} onClick={() => choose("maxFps", value)}>{value} 帧</Button>)}{displayFps !== undefined && maxFps !== preferences.maxFps && <span title="超出本机显示器刷新率的帧不会被看到">本机显示 {maxFps} 帧</span>}</div>
      <div role="group" aria-label="画面节奏"><span>画面节奏</span>{[[false, "延迟优先"], [true, "流畅优先"]].map(([value, label]) => <Button key={String(value)} size="sm" variant={smooth === value ? "secondary" : "ghost"} title={value ? "画面更均匀；Wi-Fi 下延迟约多 50 毫秒，适合只观看" : "最跟手；网络抖动会表现为短暂停顿"} onClick={() => choosePacing(value as boolean)}>{label as string}</Button>)}</div>
    </div>}
    {(fusionJob.error || status.controlError) && <ErrorNotice error={fusionJob.error ?? status.controlError} />}
    <div ref={stage} className="screen-stage" aria-label="原生远程桌面画面">
      {!started ? <div className="screen-start"><Monitor size={32} /><LoadState {...access} /><ErrorNotice error={job.error} /><h3>{access.value?.recording === false ? "需要屏幕录制权限" : access.value?.supported ? "可以连接桌面" : "此电脑暂不支持屏幕共享"}</h3><p>{access.value?.problem ?? "打开画面，继续电脑上的工作。"}</p><div className="screen-start-actions"><Button disabled={!access.value?.supported || access.value?.recording === false} onClick={() => setStarted(true)}>打开桌面</Button>{fusionAvailable && access.value?.supported && access.value?.recording !== false && <Button variant="outline" disabled={fusionJob.busy} onClick={openFusion}><AppWindowMac data-icon="inline-start" aria-hidden="true" />{fusionJob.busy ? "正在启动…" : "融合模式"}</Button>}{access.value?.supported && (!access.value.recording || !access.value.control) && <Button variant="outline" disabled={job.busy} onClick={checkPermissions}>在电脑上检查权限</Button>}<Button variant="ghost" onClick={access.reload}>刷新状态</Button></div></div>
        : (!status.live || error) && <div className="screen-start" role="status">{error ? <Monitor size={32} /> : <LoaderCircle className="animate-spin" size={32} />}<h3>{error ? "暂时无法打开画面" : retrying ? "正在重新连接屏幕" : "正在连接屏幕"}</h3>{error ? <><ErrorNotice error={error} /><Button variant="outline" onClick={retry}>重新连接</Button></> : <p>正在建立原生视频连接</p>}</div>}
    </div>
    <div className="screen-caption"><span>{status.live && status.hardware ? `原生画面 · ${status.codec || "H.264"} 硬件解码 · Metal` : error ? "连接失败，可重试" : started ? "正在接收画面" : "尚未开始观看"}</span><span>{controlling ? "点击画面操作电脑；停止控制可释放输入" : "仅观看 · 点击“控制电脑”启用操作"}</span></div>
  </section>;
}
