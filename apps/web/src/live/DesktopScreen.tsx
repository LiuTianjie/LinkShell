import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, Expand, LoaderCircle, Maximize, Minimize, Monitor, RotateCw, SlidersHorizontal, Square } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { ErrorNotice, LoadState, messageOf, useConnection, useJob, useLoad } from "./common";
import { DESKTOP_FULLSCREEN_EVENT, readDesktopStorage, saveDesktopStorage, setDesktopScreenFullScreen } from "./desktop";
import { useDesktopVisibility } from "./desktop-visibility";
import { NATIVE_SCREEN_EVENT, leaveScreenFullscreen, nativeScreenQuery, postNativeScreen, screenSignal, windowFullscreenChanged, type NativeScreenEvent, type NativeScreenStatus, type ScreenFullscreen } from "./desktop-screen";
import { autoScreenWidth, screenPreferences } from "./screen-preferences";
import { openWebSocket } from "./transport";
import type { ScreenProps } from "./Video";

/** The DOM owns chrome and authenticated signalling; AppKit owns the video surface and input. */
export function DesktopScreen({ title = "电脑屏幕", embedded = false, primaryAction = false, onOpen, autoStart = false, active = true }: ScreenProps) {
  const { link, streams } = useConnection();
  const visible = useDesktopVisibility();
  const job = useJob();
  const access = useLoad(() => link.call("screen.access", {}), [link]);
  const [started, setStarted] = useState(autoStart);
  const [focused, setFocused] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Only the screen that asked for the window's full screen follows it or ends it.
  const fullscreenState = useRef<ScreenFullscreen>({ owns: false, fullscreen: false });
  const fullscreenRequest = (enabled: boolean) => {
    if (!enabled) {
      const next = leaveScreenFullscreen(fullscreenState.current);
      if (!next) return;
      fullscreenState.current = next;
      setFullscreen(false);
    } else fullscreenState.current = { ...fullscreenState.current, owns: true };
    if (!setDesktopScreenFullScreen(enabled)) { fullscreenState.current = { ...fullscreenState.current, owns: false }; setFocused(enabled); }
  };
  const [settings, setSettings] = useState(false);
  const [display, setDisplay] = useState(0);
  const [displays, setDisplays] = useState<{ index: number; name: string }[]>([]);
  const [preferences, setPreferences] = useState(() => {
    const read = (key: string) => readDesktopStorage<string | undefined>(`screen:${key}`, undefined);
    const view = screenPreferences(read);
    // Like the phone: ask for 120 unless a rate was chosen; the sender still bounds it by both displays.
    return read("linkshell.screen.maxFps") ? view : { ...view, maxFps: "120" };
  });
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<NativeScreenStatus>({});
  const [error, setError] = useState<string>();
  const [controlRequested, setControlRequested] = useState(false);
  const controlling = status.control === true;
  const stage = useRef<HTMLDivElement>(null);
  const sessionID = useRef<string | undefined>(undefined);
  const compact = embedded && !started;
  const running = started && active && visible;

  useEffect(() => {
    if (!active || !visible) { setFocused(false); fullscreenRequest(false); }
  }, [active, visible]);
  useEffect(() => {
    // The window's own full screen; while it lasts the page also fills the window.
    const changed = (event: Event) => {
      const next = windowFullscreenChanged(fullscreenState.current, (event as CustomEvent<{ fullscreen?: unknown }>).detail?.fullscreen === true);
      if (!next) return;
      fullscreenState.current = { owns: next.owns, fullscreen: next.fullscreen };
      setFullscreen(next.fullscreen);
      setFocused(next.focused);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFocused(false);
      fullscreenRequest(false);
    };
    window.addEventListener(DESKTOP_FULLSCREEN_EVENT, changed);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener(DESKTOP_FULLSCREEN_EVENT, changed);
      window.removeEventListener("keydown", escape);
      fullscreenRequest(false);
    };
  }, []);

  useEffect(() => {
    if (!running || !stage.current) return;
    const id = crypto.randomUUID();
    sessionID.current = id;
    let alive = true;
    let socket: Awaited<ReturnType<typeof openWebSocket>> | undefined;
    let socketOpen = false;
    const outgoing: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let configured = false;
    let appliedDisplay = display;
    const width = preferences.width === "auto" ? autoScreenWidth({ width: stage.current.clientWidth, ratio: window.devicePixelRatio }) : preferences.width;
    setStatus({});
    setError(undefined);
    setControlRequested(false);
    const finish = () => {
      if (!alive) return;
      alive = false;
      clearTimeout(timer);
      socket?.close();
      postNativeScreen(id, "stop");
      if (sessionID.current === id) sessionID.current = undefined;
    };
    const fail = (reason: unknown) => {
      if (!alive) return;
      setError(messageOf(reason));
      setStatus({});
      setControlRequested(false);
      finish();
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
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<NativeScreenEvent>).detail;
      if (!alive || detail?.id !== id) return;
      if (detail.type === "signal" && detail.message) send(detail.message);
      else if (detail.type === "error") fail(detail.error || "原生屏幕连接失败");
      else if (detail.type === "status" && detail.status) {
        setStatus((previous) => ({ ...previous, ...detail.status }));
        if (detail.status.live) clearTimeout(timer);
        if (typeof detail.status.controlRequested === "boolean") setControlRequested(detail.status.controlRequested);
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
    const observer = new ResizeObserver(layout);
    observer.observe(stage.current);
    // Portal opening/closing does not resize the stage.
    const overlays = new MutationObserver(layout);
    overlays.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", layout);
    window.addEventListener("scroll", layout, true);
    if (!postNativeScreen(id, "start", { rect: rect() })) fail("原生屏幕组件不可用，请更新 LinkShell App");
    else {
      timer = setTimeout(() => fail("视频直连超时，请确认电脑在线、已授权屏幕录制且网络允许直连"), 30_000);
      void link.call("screen.start", {}).then(async (viewer) => {
        if (!alive) return;
        setDisplays(viewer.displays);
        if (viewer.displays.length && !viewer.displays.some((entry) => entry.index === display)) appliedDisplay = viewer.displays[0].index;
        const opened = await openWebSocket(streams, viewer.port, nativeScreenQuery(viewer.token, appliedDisplay, width, preferences.maxFps, preferences.codec === "auto"), {
          open: () => { socketOpen = true; flush(); },
          data: (data) => {
            if (!alive) return;
            try {
              const message = screenSignal(data);
              postNativeScreen(id, "signal", { message });
              const state = message.session as { t?: string; configure?: boolean; version?: number } | undefined;
              if (!configured && state?.t === "capabilities" && state.version === 1 && state.configure === true) {
                configured = true;
                const configure = { t: "screen.configure", requestId: 1, display: appliedDisplay, width, maxFps: Number(preferences.maxFps), paused: false };
                postNativeScreen(id, "signal", { message: configure });
                send(configure);
              }
            } catch (problem) { fail(problem); }
          },
          close: (reason) => { if (alive) fail(reason || "屏幕连接已断开，请重新连接"); },
        });
        if (!alive) opened.close();
        else {
          socket = opened;
          flush();
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
  }, [running, revision, link, streams, display, preferences.width, preferences.maxFps, preferences.codec]);

  function choose(key: "width" | "maxFps", value: string) {
    saveDesktopStorage(`screen:linkshell.screen.${key}`, value);
    setPreferences((current) => ({ ...current, [key]: value }));
  }
  function control() {
    const enabled = !controlRequested;
    if (sessionID.current) postNativeScreen(sessionID.current, "control", { enabled });
    setControlRequested(enabled);
    setStatus((current) => ({ ...current, controlError: undefined }));
  }
  const checkPermissions = () => void job.run(async () => { await link.call("screen.access", { ask: true }); access.reload(); });
  if (compact) {
    const ready = Boolean(access.value?.supported && access.value.recording !== false);
    const problem = job.error ?? access.error;
    return <section className="screen-page screen-is-idle" aria-label={`${title}观看区域`}>
      <div className="screen-idle-status" role="status">
        <span className="screen-dot" data-on={ready || undefined} aria-hidden="true" />
        <div>
          <strong>{problem ? "检查失败" : access.loading && !access.value ? "正在检查屏幕…" : !access.value?.supported ? "屏幕共享" : access.value.recording === false ? "等待授权" : "远程桌面"}</strong>
          <span title={problem}>{problem ?? (access.value?.recording === false ? "需要屏幕录制权限" : "原生画面 · 硬件解码")}</span>
        </div>
      </div>
      <div className="screen-idle-actions">
        <Button variant={primaryAction ? "default" : "outline"} disabled={(!access.value?.supported && !problem) || job.busy} onClick={() => problem ? access.reload() : access.value?.recording === false ? checkPermissions() : onOpen ? onOpen() : setStarted(true)}>{problem ? "重新检查" : access.value?.recording === false ? "检查权限" : "打开桌面"}</Button>
      </div>
    </section>;
  }
  return <section className={cn("screen-page desktop-native-screen", embedded && "screen-embedded", started && "screen-is-started", focused && "screen-focused", fullscreen && "screen-fullscreen")} aria-label={`${title}观看区域`} role={focused ? "dialog" : undefined} aria-modal={focused || undefined}>
    <div className="screen-toolbar">
      <strong className="screen-view-title"><Monitor size={17} /><span>{title}</span></strong>
      <div className="screen-actions">
        <Button variant="ghost" size="icon" aria-label="画质设置" aria-expanded={settings} onClick={() => setSettings(!settings)}><SlidersHorizontal /></Button>
        {started && <><Button variant={controlling ? "secondary" : "outline"} disabled={!status.live || access.value?.control === false} aria-pressed={controlling} onClick={control}>{controlling ? "停止控制" : controlRequested ? "取消控制请求" : "控制电脑"}</Button><Button variant="ghost" size="icon" aria-label="重新连接" onClick={() => setRevision((value) => value + 1)}><RotateCw /></Button></>}
        {!fullscreen && <Button variant="outline" onClick={() => setFocused(!focused)}>{focused ? <ArrowDownLeft data-icon="inline-start" /> : <Expand data-icon="inline-start" />}{focused ? "退出铺满" : "铺满窗口"}</Button>}
        {started && <Button variant="outline" onClick={() => fullscreenRequest(!fullscreen)}>{fullscreen ? <Minimize data-icon="inline-start" /> : <Maximize data-icon="inline-start" />}{fullscreen ? "退出全屏" : "全屏"}</Button>}
        {started && <Button variant="ghost" size="icon" aria-label="停止观看" onClick={() => { setStarted(false); setFocused(false); fullscreenRequest(false); setStatus({}); setError(undefined); }}><Square /></Button>}
      </div>
    </div>
    {settings && <div className="desktop-screen-settings">
      {displays.length > 1 && <div role="group" aria-label="显示器">{displays.map((entry) => <Button key={entry.index} variant={display === entry.index ? "secondary" : "ghost"} size="sm" onClick={() => setDisplay(entry.index)}>{entry.name}</Button>)}</div>}
      <div role="group" aria-label="画面清晰度"><span>清晰度</span>{[["auto", "随窗口"], ["1280", "省带宽"], ["1920", "标准"], ["2560", "高清"], ["native", "原生"]].map(([value, label]) => <Button key={value} size="sm" variant={preferences.width === value ? "secondary" : "ghost"} onClick={() => choose("width", value)}>{label}</Button>)}</div>
      <div role="group" aria-label="帧率上限"><span>帧率上限</span>{["30", "60", "120"].map((value) => <Button key={value} size="sm" variant={preferences.maxFps === value ? "secondary" : "ghost"} onClick={() => choose("maxFps", value)}>{value} 帧</Button>)}</div>
    </div>}
    {status.controlError && <ErrorNotice error={status.controlError} />}
    <div ref={stage} className="screen-stage" aria-label="原生远程桌面画面">
      {!started ? <div className="screen-start"><Monitor size={32} /><LoadState {...access} /><ErrorNotice error={job.error} /><h3>{access.value?.recording === false ? "需要屏幕录制权限" : access.value?.supported ? "可以连接桌面" : "此电脑暂不支持屏幕共享"}</h3><p>{access.value?.problem ?? "打开画面，继续电脑上的工作。"}</p><div className="screen-start-actions"><Button disabled={!access.value?.supported || access.value?.recording === false} onClick={() => setStarted(true)}>打开桌面</Button>{access.value?.supported && (!access.value.recording || !access.value.control) && <Button variant="outline" disabled={job.busy} onClick={checkPermissions}>在电脑上检查权限</Button>}<Button variant="ghost" onClick={access.reload}>刷新状态</Button></div></div>
        : (!status.live || error) && <div className="screen-start" role="status">{error ? <Monitor size={32} /> : <LoaderCircle className="animate-spin" size={32} />}<h3>{error ? "暂时无法打开画面" : "正在连接屏幕"}</h3>{error ? <><ErrorNotice error={error} /><Button variant="outline" onClick={() => setRevision((value) => value + 1)}>重新连接</Button></> : <p>正在建立原生视频连接</p>}</div>}
    </div>
    <div className="screen-caption"><span>{status.live && status.hardware ? `原生画面 · ${status.codec || "H.264"} 硬件解码 · Metal` : error ? "连接失败，可重试" : started ? "正在接收画面" : "尚未开始观看"}</span><span>{controlling ? "点击画面操作电脑；停止控制可释放输入" : "仅观看 · 点击“控制电脑”启用操作"}</span></div>
  </section>;
}
