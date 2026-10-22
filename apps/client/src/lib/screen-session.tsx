import { createContext, use, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { AppState, Platform, View } from "react-native";
import Animated from "react-native-reanimated";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { HostLink } from "@linkshell/client-core";
import { NativeScreenPane } from "@/components/native-screen-pane";
import { ScreenConnectionLoading } from "@/components/screen-connection-loading";
import { nativeScreenAvailable } from "../../modules/link-screen";
import { useAccount } from "./account";
import { useClient, useConnection, useStreamPath } from "./client";
import { forwardPort, type Forward } from "./preview";
import { ScreenSessionLease, ScreenSessionPauseWatchdog } from "./screen-session-lease";
import type { ScreenPlaybackMode } from "./screen-playback";
import { isScreenWidth, loadScreenMode, loadScreenWidth, saveScreenMode, saveScreenWidth, type ScreenMode } from "./settings";

export interface ScreenViewport { x: number; y: number; width: number; height: number }

export interface ScreenPageMessage {
  type?: string;
  on?: boolean;
  mode?: string;
  kind?: string;
  list?: unknown;
  width?: unknown;
  reason?: string;
  session?: { t?: string; configure?: boolean; pause?: boolean; paused?: boolean; version?: number };
}

export interface ScreenPresentation {
  viewport: ScreenViewport | null;
  clipTop: number;
  chrome: string;
  keyboardLift: ComponentProps<typeof Animated.View>["style"];
  onMessage(message: ScreenPageMessage, generation: number): void;
}

interface Viewer {
  link: HostLink;
  accountId: string | undefined;
  generation: number;
  forward: Forward;
  displays: { index: number; name: string }[];
  source: { uri: string };
  bootstrap: string;
  playback: ScreenPlaybackMode;
  via: "direct" | "relay";
  initialTarget: { display: number; width: string };
}

interface ScreenSessionContextValue {
  viewer: Viewer | null;
  preparing: boolean;
  generation: number;
  failure: string | null;
  display: number | null;
  mode: ScreenMode;
  playback: ScreenPlaybackMode;
  attach(owner: object): void;
  detach(owner: object): void;
  present(owner: object, presentation: ScreenPresentation): void;
  inject(owner: object, script: string, generation?: number): void;
  focus(owner: object): void;
  selectDisplay(display: number): void;
  retry(): void;
}

/** The host's words when another device takes the screen (screen-viewer.ts SCREEN_TAKEN). */
const SCREEN_TAKEN = "屏幕画面被另一台设备接手了";

const ScreenSessionContext = createContext<ScreenSessionContextValue | null>(null);
const initialPlayback = (): ScreenPlaybackMode => nativeScreenAvailable ? "native" : "standard";

/** The real receiver stays in this slot while route components come and go. */
export function ScreenSessionProvider({ children }: { children: ReactNode }) {
  const { link, streams, computer } = useConnection();
  const status = useClient((state) => state.status);
  const path = useStreamPath();
  const accountId = useAccount((state) => state.session?.userId);
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const [lease] = useState(() => new ScreenSessionLease<Viewer>((viewer) => viewer.forward.stop(), redraw));
  const [pauseWatchdog] = useState(() => new ScreenSessionPauseWatchdog((generation) => {
    if (lease.isCurrent(generation) && !lease.getSnapshot().active) lease.reset();
  }));
  const snapshot = lease.getSnapshot();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [failure, setFailure] = useState<string | null>(null);
  const [preparingGeneration, setPreparingGeneration] = useState<number | null>(null);
  const [readyGeneration, setReadyGeneration] = useState<number | null>(null);
  const [display, setDisplay] = useState<number | null>(null);
  const [width, setWidth] = useState(loadScreenWidth);
  const [mode, setMode] = useState(loadScreenMode);
  const [playback, setPlayback] = useState(initialPlayback);
  const [presentation, setPresentation] = useState<ScreenPresentation | null>(null);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const root = useRef<View>(null);
  const web = useRef<WebView>(null);
  const owner = useRef<object | null>(null);
  const route = useRef<ScreenPresentation | null>(null);
  const desired = useRef({ display, width, mode });
  desired.current = { display, width, mode };
  const configurable = useRef<boolean | null>(null);
  const starting = useRef<number | null>(null);
  const context = useRef({ link, accountId });

  const sendSession = useCallback((active: boolean) => {
    const target = { active, display: desired.current.display ?? 0, width: desired.current.width, maxFps: 120 };
    web.current?.injectJavaScript(`window.linkshellSession && window.linkshellSession(${JSON.stringify(target)}); true;`);
  }, []);
  const sendChrome = useCallback(() => {
    if (route.current) web.current?.injectJavaScript(`window.linkshellChrome && window.linkshellChrome(${route.current.chrome}); true;`);
  }, []);
  const reset = useCallback(() => {
    pauseWatchdog.clear();
    configurable.current = null;
    lease.reset();
  }, [lease, pauseWatchdog]);

  useLayoutEffect(() => {
    if (context.current.link === link && context.current.accountId === accountId) return;
    context.current = { link, accountId };
    setDisplay(null);
    setPlayback(initialPlayback());
    setFailure(null);
    reset();
  }, [link, accountId, reset]);

  useEffect(() => link.onStatus((next) => {
    if (context.current.link === link && next !== "online") reset();
  }), [link, reset]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      setForeground(next === "active");
      if (next !== "active") reset();
    });
    return () => subscription.remove();
  }, [reset]);
  useEffect(() => () => { pauseWatchdog.clear(); lease.dispose(); }, [lease, pauseWatchdog]);

  const attach = useCallback((nextOwner: object) => {
    pauseWatchdog.clear();
    owner.current = nextOwner;
    lease.activate(nextOwner);
    sendSession(AppState.currentState === "active");
  }, [lease, pauseWatchdog, sendSession]);
  const detach = useCallback((previousOwner: object) => {
    if (owner.current !== previousOwner) return;
    // Pause before the route loses its callback; opacity alone cannot stop input or capture.
    const current = lease.getSnapshot();
    if (current.reusable && current.resource) pauseWatchdog.wait(current.generation);
    sendSession(false);
    owner.current = null;
    lease.deactivate(previousOwner);
  }, [lease, pauseWatchdog, sendSession]);
  const present = useCallback((routeOwner: object, next: ScreenPresentation) => {
    if (owner.current !== routeOwner) return;
    route.current = next;
    setPresentation(next);
    sendChrome();
  }, [sendChrome]);
  const inject = useCallback((routeOwner: object, script: string, generation?: number) => {
    if (owner.current !== routeOwner || !lease.getSnapshot().active || AppState.currentState !== "active" || (generation !== undefined && !lease.isCurrent(generation))) return;
    web.current?.injectJavaScript(script);
  }, [lease]);
  const focus = useCallback((routeOwner: object) => {
    if (owner.current === routeOwner && lease.getSnapshot().active) web.current?.requestFocus();
  }, [lease]);
  const selectDisplay = useCallback((next: number) => {
    if (desired.current.display === next) return;
    desired.current.display = next;
    setDisplay(next);
    if (configurable.current === false) reset();
  }, [reset]);
  const retry = useCallback(() => {
    setFailure(null);
    setPlayback(initialPlayback());
    reset();
  }, [reset]);

  useEffect(() => {
    if (!snapshot.active || snapshot.resource || failure || !foreground || status !== "online") return;
    const generation = snapshot.generation;
    const start = () => {
      if (starting.current === generation || !lease.isCurrent(generation) || !lease.getSnapshot().active) return;
      starting.current = generation;
      const via = playback === "relay" || path !== "direct" ? "relay" : "direct";
      void link.call("screen.start", {}, 20_000).then(async ({ port, token, displays }) => {
        if (!lease.isCurrent(generation)) return;
        setPreparingGeneration(generation);
        const forward = await forwardPort(streams, port, { direct: playback !== "relay" });
        const targetDisplay = displays.some((entry) => entry.index === desired.current.display) ? desired.current.display! : displays[0]?.index ?? 0;
        const target = { active: true, display: targetDisplay, width: desired.current.width, maxFps: 120 };
        // These are the initial target only. The immutable source object survives every later
        // configuration, including the native receiver which starts before the page bridge.
        const query = new URLSearchParams({ token, video: playback === "relay" ? "0" : "1", display: String(targetDisplay), width: target.width, mode: desired.current.mode });
        if (via === "relay" && computer.kind !== "direct") query.set("q", "low");
        if (Platform.OS === "ios" && playback !== "relay") query.set("fallback", "relay");
        const initialChrome = route.current?.chrome ?? "{}";
        const viewer: Viewer = {
          link, accountId, generation, forward, displays, playback, via, initialTarget: { display: targetDisplay, width: target.width },
          source: { uri: `${forward.url}?${query.toString()}` },
          bootstrap: `window.__linkshellChrome = ${initialChrome}; window.__linkshellSession = ${JSON.stringify(target)}; true;`,
        };
        if (lease.install(generation, viewer)) {
          desired.current.display = targetDisplay;
          setDisplay(targetDisplay);
        }
      }).catch((reason: unknown) => {
        if (lease.isCurrent(generation)) setFailure(reason instanceof Error ? reason.message : String(reason));
      });
    };
    // Waiting briefly is useful only before the first forward exists. A later bulk-path upgrade
    // must not replace a healthy media peer or its authenticated signaling socket.
    if (path === "connecting") {
      const timer = setTimeout(start, 3000);
      return () => clearTimeout(timer);
    }
    start();
  }, [snapshot.active, snapshot.resource, snapshot.generation, failure, foreground, status, path, playback, link, streams, computer.kind, accountId, lease]);

  const viewer = snapshot.resource?.link === link && snapshot.resource.accountId === accountId ? snapshot.resource : null;
  const active = snapshot.active && foreground && status === "online";
  useEffect(() => {
    if (viewer) sendSession(active);
  }, [viewer, active, display, width, sendSession]);

  const unavailable = useCallback((failed: Viewer, description?: string) => {
    if (lease.getSnapshot().resource !== failed) return;
    // Another device has the screen now: trying the next path would only take it back from them.
    if (failed.playback === "relay" || Platform.OS !== "ios" || description === SCREEN_TAKEN) setFailure(description || "屏幕显示已中断，请重新连接");
    else setPlayback(failed.playback === "native" ? "standard" : "relay");
    reset();
  }, [lease, reset]);

  const enableLegacy = useCallback((current: Viewer) => {
    if (lease.getSnapshot().resource !== current) return;
    configurable.current = false;
    lease.setReusable(current.generation, false);
    // A target chosen before capability discovery was queued in the page. An older native
    // receiver needs that queued target in a fresh URL; its initial target already works.
    if (current.initialTarget.display !== desired.current.display || current.initialTarget.width !== desired.current.width) reset();
  }, [lease, reset]);

  const onMessage = useCallback((current: Viewer, event: WebViewMessageEvent) => {
    if (lease.getSnapshot().resource !== current) return;
    let message: ScreenPageMessage;
    try { message = JSON.parse(event.nativeEvent.data) as ScreenPageMessage; } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.type === "screenRetry") {
      if (lease.getSnapshot().active && AppState.currentState === "active") retry();
      return;
    }
    if (message.type === "screenClosed") {
      const wasActive = lease.close(current.generation);
      if (wasActive === null) return;
      pauseWatchdog.clear();
      configurable.current = null;
      setFailure(wasActive ? (message.reason === "taken" ? SCREEN_TAKEN : "屏幕连接已断开，请重新连接") : null);
      return;
    }
    if (message.type === "screenSession" && !lease.getSnapshot().active) {
      // The page only forwards acknowledgements for its latest requested configuration.
      // A failed or missing pause must never leave capture running behind an invisible view.
      if (message.session?.t === "error") { reset(); return; }
      if (message.session?.t === "configured" && message.session.paused === true) pauseWatchdog.acknowledge(current.generation);
    }
    if (message.type === "nativeUnavailable") unavailable(current);
    else if (message.type === "screenFallback" && Platform.OS === "ios") unavailable(current);
    else if (message.type === "screenLegacy") enableLegacy(current);
    else if (message.type === "screenSession" && message.session?.t === "capabilities") {
      const supported = message.session.version === 1 && message.session.configure === true;
      configurable.current = supported;
      lease.setReusable(current.generation, supported && message.session.pause === true);
      if (!supported) enableLegacy(current);
    } else if (message.type === "width" && isScreenWidth(message.width)) {
      saveScreenWidth(message.width);
      if (desired.current.width !== message.width) {
        desired.current.width = message.width;
        setWidth(message.width);
        if (configurable.current === false) reset();
      }
    } else if (message.type === "mode" || message.type === "ready") {
      if (message.type === "mode" && (message.mode === "view" || message.mode === "trackpad" || message.mode === "touch")) {
        setMode(message.mode);
        saveScreenMode(message.mode);
      }
      if (message.type === "ready") {
        setReadyGeneration(current.generation);
        sendChrome();
        sendSession(lease.getSnapshot().active && AppState.currentState === "active");
      }
    }
    if (owner.current && lease.getSnapshot().active && AppState.currentState === "active") route.current?.onMessage(message, current.generation);
  }, [lease, pauseWatchdog, unavailable, enableLegacy, reset, retry, sendChrome, sendSession]);

  const onLoading = useCallback((current: Viewer) => {
    if (lease.getSnapshot().resource === current) setReadyGeneration(null);
  }, [lease]);

  const onLoaded = useCallback((current: Viewer) => {
    if (lease.getSnapshot().resource !== current) return;
    web.current?.injectJavaScript(`${current.playback === "native" ? 'if (!window.linkshellNative) window.ReactNativeWebView.postMessage(JSON.stringify({type:"nativeUnavailable"}));' : ""} if (typeof window.linkshellSession !== "function") window.ReactNativeWebView.postMessage(JSON.stringify({type:"screenLegacy"})); true;`);
    sendChrome();
    sendSession(lease.getSnapshot().active && AppState.currentState === "active");
  }, [lease, sendChrome, sendSession]);

  const measureRoot = useCallback(() => root.current?.measureInWindow((x, y) => {
    setOrigin((previous) => previous.x === x && previous.y === y ? previous : { x, y });
  }), []);
  const viewport = presentation?.viewport;
  const clipTop = Math.min(viewport?.height ?? 0, Math.max(0, presentation?.clipTop ?? 0));
  const visible = active && viewport !== null && viewport !== undefined && !failure;
  const preparing = preparingGeneration === snapshot.generation;
  const value = useMemo<ScreenSessionContextValue>(() => ({ viewer, failure, preparing, generation: snapshot.generation, display, mode, playback, attach, detach, present, inject, focus, selectDisplay, retry }), [viewer, failure, preparing, snapshot.generation, display, mode, playback, attach, detach, present, inject, focus, selectDisplay, retry]);

  return <ScreenSessionContext value={value}>
    <View ref={root} collapsable={false} onLayout={measureRoot} style={{ flex: 1 }}>
      {children}
      {viewer ? <View
        pointerEvents={visible ? "auto" : "none"}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
        style={{ position: "absolute", left: (viewport?.x ?? 0) - origin.x, top: (viewport?.y ?? 0) - origin.y + clipTop, width: viewport?.width ?? 1, height: Math.max(1, (viewport?.height ?? 1) - clipTop), overflow: "hidden", opacity: visible ? 1 : 0 }}
      >
        <Animated.View style={[{ position: "absolute", left: 0, top: -clipTop, width: viewport?.width ?? 1, height: viewport?.height ?? 1, backgroundColor: "#000000" }, presentation?.keyboardLift]}>
          <PersistentScreenSurface key={viewer.generation} viewer={viewer} active={active} web={web} onMessage={onMessage} onUnavailable={unavailable} onLoaded={onLoaded} onLoading={onLoading} />
          {visible && readyGeneration !== viewer.generation ? <View style={{ position: "absolute", inset: 0, backgroundColor: "#08090e" }}>
            <ScreenConnectionLoading key={viewer.generation} preparing onRetry={retry} top={clipTop} bottom={0} />
          </View> : null}
        </Animated.View>
      </View> : null}
    </View>
  </ScreenSessionContext>;
}

function PersistentScreenSurface({ viewer, active, web, onMessage, onUnavailable, onLoaded, onLoading }: {
  viewer: Viewer;
  active: boolean;
  web: React.RefObject<WebView | null>;
  onMessage(viewer: Viewer, event: WebViewMessageEvent): void;
  onUnavailable(viewer: Viewer, description?: string): void;
  onLoaded(viewer: Viewer): void;
  onLoading(viewer: Viewer): void;
}) {
  const page = <WebView
    ref={web}
    source={viewer.source}
    onLoadStart={() => onLoading(viewer)}
    originWhitelist={["http://127.0.0.1*"]}
    onMessage={(event) => onMessage(viewer, event)}
    onLoadEnd={() => onLoaded(viewer)}
    onError={({ nativeEvent }) => onUnavailable(viewer, nativeEvent.description || "屏幕页面加载失败，请重试")}
    // A stale token answers 403: without this the page stays blank behind the loading cover.
    onHttpError={({ nativeEvent }) => onUnavailable(viewer, nativeEvent.statusCode === 403 ? "屏幕连接已过期，请重新连接" : "屏幕页面加载失败，请重试")}
    onContentProcessDidTerminate={() => onUnavailable(viewer)}
    injectedJavaScriptBeforeContentLoaded={viewer.bootstrap}
    bounces={false}
    scrollEnabled={false}
    overScrollMode="never"
    setBuiltInZoomControls={false}
    textZoom={100}
    automaticallyAdjustContentInsets={false}
    contentInsetAdjustmentBehavior="never"
    hideKeyboardAccessoryView
    keyboardDisplayRequiresUserAction={false}
    allowsInlineMediaPlayback
    mediaPlaybackRequiresUserAction={false}
    style={{ flex: 1, backgroundColor: viewer.playback === "native" ? "transparent" : "#000000" }}
    containerStyle={{ backgroundColor: viewer.playback === "native" ? "transparent" : "#000000" }}
  />;
  return viewer.playback === "native" ? <NativeScreenPane url={viewer.source.uri} active={active} onUnavailable={(message) => onUnavailable(viewer, message)}>{page}</NativeScreenPane> : page;
}

export function useScreenSession() {
  const value = use(ScreenSessionContext);
  if (!value) throw new Error("ScreenSessionProvider is missing");
  return value;
}
