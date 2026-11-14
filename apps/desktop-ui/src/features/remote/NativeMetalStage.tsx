import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { DESKTOP_NATIVE_SCREEN_EVENT } from "../../bridge/desktop-bridge";
import {
  getOpenOverlayRects,
  hasOpenOverlay,
  subscribeOpenOverlay,
  useHasOpenOverlay,
} from "../../bridge/top-layer-registry";
import {
  CAPABILITIES_WAIT_MS,
  PAUSE_ACK_MS,
  RETRIES_EARNED_MS,
  autoScreenWidth,
  effectiveNativeScreenRect,
  nativeScreenQuery,
  nativeSessionPolicy,
  postNativeScreen,
  screenRate,
  screenSignal,
  targetChanged,
  type NativeScreenEvent,
  type NativeScreenStatus,
  type NativeScreenTarget,
} from "../../core/screen-client";
import { openWebSocket } from "../../core/transport";
import type { ScreenDisplayInfo, SharedStageProps } from "./stage-types";

interface LiveNativeSession {
  apply(next: NativeScreenTarget): void;
}

function errorMessageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason || "原生屏幕连接失败");
}

/**
 * macOS Native Metal Stage (`DesktopScreenSurface` / AppKit `ScreenClip` + `CAMetalLayer`).
 * Subscribes to `TopLayerRegistry` (`useHasOpenOverlay`) so opening any `<dialog>`,
 * `[popover="auto"|"manual"]`, or `<select>` collapses the native Metal rect to `0×0`
 * immediately without brittle DOM-scraping, and restores whole-pixel snapped geometry on close.
 */
export function NativeMetalStage({
  link,
  streams,
  active,
  fullscreen,
  display,
  widthChoice,
  fpsChoice,
  codecChoice,
  pacingChoice,
  controlWanted,
  revision,
  onDisplayChange,
  onExitFullScreen,
  onStatusChange,
  onFallback,
}: SharedStageProps): JSX.Element {
  const hasOverlay = useHasOpenOverlay();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const liveSessionRef = useRef<LiveNativeSession | undefined>(undefined);
  const retriesRef = useRef(0);
  const lastLayoutJsonRef = useRef("");

  const [internalRetryNonce, setInternalRetryNonce] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [dormant, setDormant] = useState(false);
  const [fittedWidth, setFittedWidth] = useState<string | undefined>(undefined);
  const [displayFps, setDisplayFps] = useState<number | undefined>(undefined);
  const [displays, setDisplays] = useState<ScreenDisplayInfo[]>([]);
  const [nativeStatus, setNativeStatus] = useState<NativeScreenStatus>({});
  const [error, setError] = useState<string | undefined>(undefined);

  const effectiveWidth =
    widthChoice === "auto" ? (fittedWidth ?? "1920") : widthChoice;
  const effectiveMaxFps = screenRate(fpsChoice, displayFps);
  const smooth = pacingChoice === "smooth";
  const smoothRef = useRef(smooth);
  smoothRef.current = smooth;

  const desiredTargetRef = useRef<NativeScreenTarget>({
    display,
    width: effectiveWidth,
    maxFps: effectiveMaxFps,
    paused: !active,
  });
  desiredTargetRef.current = {
    display,
    width: effectiveWidth,
    maxFps: effectiveMaxFps,
    paused: !active,
  };

  const callbacksRef = useRef({
    onDisplayChange,
    onExitFullScreen,
    onFallback,
    autoWidth: widthChoice === "auto",
    hasOverlay,
    fullscreen,
    controlWanted,
  });
  callbacksRef.current = {
    onDisplayChange,
    onExitFullScreen,
    onFallback,
    autoWidth: widthChoice === "auto",
    hasOverlay,
    fullscreen,
    controlWanted,
  };

  const computeStageRect = useCallback((overlayOpen: boolean) => {
    const el = stageRef.current;
    if (!el) return { x: 0, y: 0, width: 0, height: 0 };
    const bounds = el.getBoundingClientRect();
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    return effectiveNativeScreenRect(
      {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
      overlayOpen,
      dpr,
    );
  }, []);

  const pushLayout = useCallback(
    (overlayOpen: boolean) => {
      const id = sessionIdRef.current;
      if (!id) return;
      const rect = computeStageRect(overlayOpen);
      const holes = getOpenOverlayRects();
      const payload = { rect, holes, overlayOpen };
      const serialized = JSON.stringify(payload);
      if (serialized === lastLayoutJsonRef.current) return;
      lastLayoutJsonRef.current = serialized;
      postNativeScreen(id, "layout", payload);
    },
    [computeStageRect],
  );

  // Immediately sync native Metal rect + CAShapeLayer cutout holes whenever TopLayerRegistry state or geometry changes.
  useEffect(() => {
    pushLayout(hasOverlay);
  }, [hasOverlay, pushLayout]);

  useEffect(() => {
    return subscribeOpenOverlay(() => {
      pushLayout(hasOpenOverlay());
    });
  }, [pushLayout]);

  // Forward pacing toggle in-band without restarting the WebRTC / Metal session.
  useEffect(() => {
    if (sessionIdRef.current) {
      postNativeScreen(sessionIdRef.current, "pacing", { smooth });
    }
  }, [smooth]);

  // Forward window fullscreen transitions to native Metal surface.
  useEffect(() => {
    if (sessionIdRef.current) {
      postNativeScreen(sessionIdRef.current, "fullscreen", {
        enabled: fullscreen,
      });
    }
  }, [fullscreen]);

  // Forward control toggle to native Metal surface.
  useEffect(() => {
    if (sessionIdRef.current) {
      postNativeScreen(sessionIdRef.current, "control", {
        enabled: controlWanted,
      });
    }
  }, [controlWanted]);

  // Reset retry counter when manual revision increments.
  useEffect(() => {
    retriesRef.current = 0;
    setRetrying(false);
    setDormant(false);
  }, [revision]);

  // Measure debounced auto stage width on resize.
  useEffect(() => {
    if (widthChoice !== "auto" || !stageRef.current) return undefined;
    const node = stageRef.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      if (node.clientWidth > 0) {
        const dpr =
          typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        setFittedWidth(autoScreenWidth({ width: node.clientWidth, ratio: dpr }));
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 350);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [widthChoice]);

  // Main Native Metal Session Lifecycle.
  useEffect(() => {
    if (dormant || !stageRef.current) return undefined;

    const id = crypto.randomUUID();
    sessionIdRef.current = id;
    lastLayoutJsonRef.current = "";

    let alive = true;
    let socket: Awaited<ReturnType<typeof openWebSocket>> | undefined;
    let socketOpen = false;
    const outgoing: string[] = [];
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let earnedTimer: ReturnType<typeof setTimeout> | undefined;
    let capabilitiesTimer: ReturnType<typeof setTimeout> | undefined;
    let pauseTimer: ReturnType<typeof setTimeout> | undefined;

    const capabilities = { known: false, configure: false, pause: false };
    let requestId = 0;
    let awaitingPauseId: number | undefined;

    const startTarget: NativeScreenTarget = { ...desiredTargetRef.current };
    if (
      callbacksRef.current.autoWidth &&
      stageRef.current.clientWidth > 0
    ) {
      const dpr =
        typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      startTarget.width = autoScreenWidth({
        width: stageRef.current.clientWidth,
        ratio: dpr,
      });
    }
    let appliedTarget: NativeScreenTarget = { ...startTarget, paused: false };

    setNativeStatus({});
    setError(undefined);

    const teardown = () => {
      if (!alive) return;
      alive = false;
      clearTimeout(connectTimer);
      clearTimeout(earnedTimer);
      clearTimeout(capabilitiesTimer);
      clearTimeout(pauseTimer);
      socket?.close();
      postNativeScreen(id, "stop");
      if (sessionIdRef.current === id) sessionIdRef.current = undefined;
      if (liveSessionRef.current === sessionHandle) {
        liveSessionRef.current = undefined;
      }
    };

    const goDormant = () => {
      teardown();
      setDormant(true);
    };

    const fail = (reason: unknown) => {
      if (!alive) return;
      const message = errorMessageOf(reason);
      teardown();
      setNativeStatus({});
      const policy = nativeSessionPolicy(message, {
        paused: desiredTargetRef.current.paused,
        retries: retriesRef.current,
        canFallBack: Boolean(callbacksRef.current.onFallback),
      });
      if (policy === "dormant") {
        setDormant(true);
        return;
      }
      if (policy === "retry") {
        retriesRef.current += 1;
        setRetrying(true);
        setTimeout(() => {
          setInternalRetryNonce((n) => n + 1);
        }, 800 * retriesRef.current);
        return;
      }
      setRetrying(false);
      if (policy === "fallback" && callbacksRef.current.onFallback) {
        callbacksRef.current.onFallback(message);
        return;
      }
      setError(message);
    };

    const sendSignal = (payload: Record<string, unknown>) => {
      const encoded = JSON.stringify(payload);
      if (encoded.length > 262_144) {
        fail("屏幕协商信息过大");
        return;
      }
      if (socket && socketOpen) {
        socket.send(encoded);
      } else if (outgoing.length < 128) {
        outgoing.push(encoded);
      } else {
        fail("屏幕连接未就绪，请重试");
      }
    };

    const flushOutgoing = () => {
      if (!alive || !socket || !socketOpen) return;
      for (const frame of outgoing.splice(0)) {
        socket.send(frame);
      }
    };

    const sendConfigure = (next: NativeScreenTarget) => {
      requestId += 1;
      const message = {
        t: "screen.configure",
        requestId,
        display: next.display,
        width: next.width,
        maxFps: Number(next.maxFps),
        paused: next.paused,
      };
      postNativeScreen(id, "signal", { message });
      sendSignal(message);
      appliedTarget = { ...next };
      clearTimeout(pauseTimer);
      awaitingPauseId = next.paused ? requestId : undefined;
      if (next.paused) {
        pauseTimer = setTimeout(() => {
          if (awaitingPauseId !== undefined) goDormant();
        }, PAUSE_ACK_MS);
      }
    };

    const sessionHandle: LiveNativeSession = {
      apply(next) {
        if (!alive || !capabilities.known) return;
        const diff = targetChanged(appliedTarget, next);
        if (!capabilities.configure || (next.paused && !capabilities.pause)) {
          if (next.paused) goDormant();
          else if (diff.picture) setInternalRetryNonce((n) => n + 1);
          return;
        }
        if (diff.any) sendConfigure(next);
      },
    };
    liveSessionRef.current = sessionHandle;

    const onNativeEvent = (event: Event) => {
      const detail = (event as CustomEvent<NativeScreenEvent>).detail;
      if (!alive || detail?.id !== id) return;
      if (detail.type === "signal" && detail.message) {
        sendSignal(detail.message);
      } else if (detail.type === "error") {
        fail(detail.error || "原生屏幕连接失败");
      } else if (detail.type === "status" && detail.status) {
        const next = detail.status;
        if (next.exitFullScreen === true) {
          callbacksRef.current.onExitFullScreen();
          return;
        }
        if (typeof next.displayFps === "number" && next.displayFps > 0) {
          setDisplayFps(next.displayFps);
        }
        setNativeStatus((prev) => ({ ...prev, ...next }));
        if (next.live) {
          clearTimeout(connectTimer);
          setRetrying(false);
          clearTimeout(earnedTimer);
          earnedTimer = setTimeout(() => {
            retriesRef.current = 0;
          }, RETRIES_EARNED_MS);
          if (callbacksRef.current.controlWanted) {
            postNativeScreen(id, "control", { enabled: true });
          }
        }
      }
    };

    window.addEventListener(DESKTOP_NATIVE_SCREEN_EVENT, onNativeEvent);

    const onWindowLayout = () => pushLayout(callbacksRef.current.hasOverlay);
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(onWindowLayout)
        : undefined;
    resizeObserver?.observe(stageRef.current);
    window.addEventListener("resize", onWindowLayout);
    window.addEventListener("scroll", onWindowLayout, true);

    const initialOverlayOpen = callbacksRef.current.hasOverlay;
    const initialRect = computeStageRect(initialOverlayOpen);
    const initialHoles = getOpenOverlayRects();
    lastLayoutJsonRef.current = JSON.stringify({
      rect: initialRect,
      holes: initialHoles,
      overlayOpen: initialOverlayOpen,
    });

    if (
      !postNativeScreen(id, "start", {
        rect: initialRect,
        holes: initialHoles,
        overlayOpen: initialOverlayOpen,
        smooth: smoothRef.current,
        fullscreen: callbacksRef.current.fullscreen,
      })
    ) {
      fail("原生屏幕组件不可用");
    } else {
      connectTimer = setTimeout(
        () => fail("原生视频直连超时"),
        30_000,
      );
      void link
        .call("screen.start", {})
        .then(async (viewer) => {
          if (!alive) return;
          const nextDisplays = viewer.displays.slice(0, 16);
          setDisplays(nextDisplays);
          if (
            nextDisplays.length > 0 &&
            !nextDisplays.some((d) => d.index === startTarget.display)
          ) {
            startTarget.display = nextDisplays[0]!.index;
            appliedTarget = { ...appliedTarget, display: startTarget.display };
            callbacksRef.current.onDisplayChange(startTarget.display);
          }
          const opened = await openWebSocket(
            streams,
            viewer.port,
            nativeScreenQuery(
              viewer.token,
              startTarget.display,
              startTarget.width,
              startTarget.maxFps,
              codecChoice === "auto",
            ),
            {
              open: () => {
                socketOpen = true;
                flushOutgoing();
              },
              data: (raw) => {
                if (!alive) return;
                try {
                  const message = screenSignal(raw);
                  postNativeScreen(id, "signal", { message });
                  const sess = message.session as
                    | {
                        t?: string;
                        configure?: boolean;
                        pause?: boolean;
                        version?: number;
                        requestId?: number;
                        paused?: boolean;
                      }
                    | undefined;
                  if (
                    !capabilities.known &&
                    sess?.t === "capabilities" &&
                    sess.version === 1
                  ) {
                    capabilities.known = true;
                    capabilities.configure = sess.configure === true;
                    capabilities.pause = sess.pause === true;
                    clearTimeout(capabilitiesTimer);
                    const desired = desiredTargetRef.current;
                    if (
                      capabilities.configure &&
                      !(desired.paused && !capabilities.pause)
                    ) {
                      sendConfigure(desired);
                    } else {
                      sessionHandle.apply(desired);
                    }
                  } else if (
                    sess?.t === "configured" &&
                    sess.requestId === awaitingPauseId &&
                    sess.paused === true
                  ) {
                    clearTimeout(pauseTimer);
                    awaitingPauseId = undefined;
                  }
                } catch (err) {
                  fail(err);
                }
              },
              close: (reason) => {
                if (alive) fail(reason || "屏幕连接已断开");
              },
            },
          );
          if (!alive) {
            opened.close();
          } else {
            socket = opened;
            flushOutgoing();
            capabilitiesTimer = setTimeout(() => {
              if (!alive || capabilities.known) return;
              capabilities.known = true;
              sessionHandle.apply(desiredTargetRef.current);
            }, CAPABILITIES_WAIT_MS);
          }
        })
        .catch(fail);
    }

    return () => {
      teardown();
      resizeObserver?.disconnect();
      window.removeEventListener(DESKTOP_NATIVE_SCREEN_EVENT, onNativeEvent);
      window.removeEventListener("resize", onWindowLayout);
      window.removeEventListener("scroll", onWindowLayout, true);
    };
  }, [
    codecChoice,
    computeStageRect,
    dormant,
    internalRetryNonce,
    link,
    pushLayout,
    revision,
    streams,
  ]);

  // Apply in-band display / width / fps / pause changes to the running session.
  useEffect(() => {
    const next: NativeScreenTarget = {
      display,
      width: effectiveWidth,
      maxFps: effectiveMaxFps,
      paused: !active,
    };
    desiredTargetRef.current = next;
    if (liveSessionRef.current) {
      liveSessionRef.current.apply(next);
    } else if (active && dormant) {
      setDormant(false);
    }
  }, [active, display, dormant, effectiveMaxFps, effectiveWidth]);

  // Report structured status upward to unified RemoteScreenWorkspace chrome.
  useEffect(() => {
    const isLive = Boolean(nativeStatus.live && !error);
    onStatusChange({
      phase: error
        ? "error"
        : !active || dormant
          ? "paused"
          : retrying
            ? "retrying"
            : isLive
              ? "live"
              : "connecting",
      live: isLive,
      displays,
      controlling: nativeStatus.control === true,
      controlRequested: nativeStatus.controlRequested === true,
      canControl: isLive,
      error: error ?? nativeStatus.controlError,
      telemetry: {
        engine: "metal",
        path: "direct",
        codec: nativeStatus.codec || (codecChoice === "auto" ? "HEVC" : "H.264"),
        hardware: nativeStatus.hardware ?? true,
        displayFps,
      },
    });
  }, [
    active,
    codecChoice,
    displayFps,
    displays,
    dormant,
    error,
    nativeStatus,
    onStatusChange,
    retrying,
  ]);

  return (
    <div
      ref={stageRef}
      data-stage-engine="metal"
      data-overlay-yielded={hasOverlay ? "true" : undefined}
      className="ls-screen-stage-viewport"
    />
  );
}
