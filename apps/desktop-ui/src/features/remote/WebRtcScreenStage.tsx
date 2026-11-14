import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { rawPlatform } from "../../bridge/desktop-bridge";
import {
  ScreenReceiver,
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
  type ReceiverState,
} from "../../core/screen-client";
import type { SharedStageProps } from "./stage-types";

/**
 * Unified WebRTC Video + 4 DataChannels + WebCodecs/Canvas Byte-Stream Fallback Stage.
 * Powers Windows Desktop, Linux/Browser dev mode, and automatic macOS fallback when direct Metal
 * UDP/ICE is blocked by strict corporate firewalls.
 */
export function WebRtcScreenStage({
  link,
  streams,
  active,
  fullscreen,
  display,
  widthChoice,
  fpsChoice,
  codecChoice,
  transportMode,
  controlWanted,
  remotePlatform,
  revision,
  onDisplayChange,
  onStatusChange,
}: SharedStageProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imeRef = useRef<HTMLTextAreaElement | null>(null);
  const receiverRef = useRef<ScreenReceiver | null>(null);
  const composingRef = useRef(false);

  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [stageSize, setStageSize] = useState<{
    width: number;
    height: number;
    dpr: number;
  }>({ width: 1280, height: 720, dpr: 1 });
  const [receiverState, setReceiverState] = useState<ReceiverState | null>(null);
  const [cursorEcho, setCursorEcho] = useState<{
    x: number;
    y: number;
    at: number;
  } | null>(null);

  const localPlat = screenPlatform(rawPlatform);
  const remotePlat = screenPlatform(remotePlatform);

  // Measure viewport dimensions + devicePixelRatio for whole-pixel snapped presentation.
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return undefined;
    const measure = () => {
      const dpr =
        typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      if (node.clientWidth > 0 && node.clientHeight > 0) {
        setStageSize({
          width: node.clientWidth,
          height: node.clientHeight,
          dpr,
        });
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const aspect =
    receiverState?.picture &&
    receiverState.picture.width > 0 &&
    receiverState.picture.height > 0
      ? receiverState.picture.width / receiverState.picture.height
      : undefined;

  const autoFittedPx = useMemo(
    () =>
      fittedScreenWidth(
        { width: stageSize.width, height: stageSize.height },
        stageSize.dpr,
        aspect,
      ),
    [aspect, stageSize.dpr, stageSize.height, stageSize.width],
  );

  const targetWidthPx = useMemo(
    () => chosenScreenWidth(widthChoice, autoFittedPx),
    [autoFittedPx, widthChoice],
  );
  const targetMaxFps = Number(fpsChoice) || 60;

  const latestTargetRef = useRef({
    display,
    width: targetWidthPx,
    maxFps: targetMaxFps,
    active,
    controlWanted,
    onDisplayChange,
  });
  latestTargetRef.current = {
    display,
    width: targetWidthPx,
    maxFps: targetMaxFps,
    active,
    controlWanted,
    onDisplayChange,
  };

  // Create & manage ScreenReceiver instance.
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return undefined;

    const initial = latestTargetRef.current;
    let echoClearTimer: ReturnType<typeof setTimeout> | undefined;

    const receiver = new ScreenReceiver({
      link,
      streams,
      target: {
        display: initial.display,
        width: initial.width,
        maxFps: initial.maxFps,
      },
      active: initial.active,
      control: initial.controlWanted,
      hevc: codecChoice === "auto",
      relayed: false,
      videoTrack: transportMode !== "compat",
      video,
      canvas,
      onState: (next) => {
        setReceiverState(next);
        if (next.display !== latestTargetRef.current.display && next.displays.length > 0) {
          latestTargetRef.current.onDisplayChange(next.display);
        }
      },
      onCursor: (x, y) => {
        setCursorEcho({ x, y, at: Date.now() });
        clearTimeout(echoClearTimer);
        echoClearTimer = setTimeout(() => {
          setCursorEcho(null);
        }, 900);
      },
    });
    receiverRef.current = receiver;

    return () => {
      clearTimeout(echoClearTimer);
      receiver.stop();
      if (receiverRef.current === receiver) receiverRef.current = null;
    };
  }, [codecChoice, link, reconnectNonce, revision, streams, transportMode]);

  // Apply in-band display / resolution / fps updates without tearing down WebRTC when supported.
  useEffect(() => {
    const receiver = receiverRef.current;
    if (!receiver) return;
    const outcome = receiver.setTarget({
      display,
      width: targetWidthPx,
      maxFps: targetMaxFps,
    });
    if (outcome === "reconnect") {
      setReconnectNonce((n) => n + 1);
    }
  }, [display, targetMaxFps, targetWidthPx]);

  useEffect(() => {
    receiverRef.current?.setActive(active);
  }, [active]);

  useEffect(() => {
    receiverRef.current?.setControl(controlWanted);
  }, [controlWanted]);

  // Report structured status upward to unified RemoteScreenWorkspace chrome.
  useEffect(() => {
    if (!receiverState) {
      onStatusChange({
        phase: "connecting",
        live: false,
        displays: [],
        controlling: false,
        controlRequested: controlWanted,
        canControl: false,
        telemetry: {
          engine: transportMode === "compat" ? "compat" : "webrtc",
        },
      });
      return;
    }

    const isLive =
      (receiverState.phase === "live" || receiverState.phase === "receiving") &&
      Boolean(receiverState.picture);
    const phase =
      receiverState.phase === "error"
        ? "error"
        : receiverState.phase === "paused"
          ? "paused"
          : receiverState.phase === "recovering"
            ? "retrying"
            : isLive
              ? "live"
              : "connecting";

    onStatusChange({
      phase,
      live: isLive,
      displays: receiverState.displays,
      controlling: receiverState.canInput,
      controlRequested:
        controlWanted &&
        !receiverState.canInput &&
        receiverState.control.available !== false,
      canControl:
        !receiverState.control.known || receiverState.control.available,
      taken: receiverState.taken,
      idle: receiverState.idle,
      error: receiverState.error,
      notice: receiverState.notice,
      telemetry: {
        engine: receiverState.transport === "socket" ? "compat" : "webrtc",
        path: receiverState.stats?.path,
        width: receiverState.stats?.width ?? receiverState.picture?.width,
        height: receiverState.stats?.height ?? receiverState.picture?.height,
        fps: receiverState.stats?.fps,
        codec:
          receiverState.stats?.codec ??
          (codecChoice === "auto" ? "Auto" : "H.264"),
        bitrateMbps: receiverState.stats?.bitrateMbps,
        rttMs: receiverState.stats?.rttMs,
        hardware: receiverState.stats?.hardware,
      },
    });
  }, [codecChoice, controlWanted, onStatusChange, receiverState, transportMode]);

  const snappedStageBox = useMemo(() => {
    const pic = receiverState?.picture;
    if (!pic || pic.width <= 0 || pic.height <= 0) {
      return {
        x: 0,
        y: 0,
        width: stageSize.width,
        height: stageSize.height,
      };
    }
    const raw = fittedRect(pic, {
      width: stageSize.width,
      height: stageSize.height,
    });
    return snappedRect(raw, stageSize.dpr);
  }, [receiverState?.picture, stageSize.dpr, stageSize.height, stageSize.width]);

  const resolvePointerFraction = useCallback(
    (clientX: number, clientY: number, clamp = false) => {
      const node = frameRef.current;
      if (!node) return undefined;
      const box = node.getBoundingClientRect();
      return pictureFraction(
        { x: box.left, y: box.top, width: box.width, height: box.height },
        clientX,
        clientY,
        clamp,
        fullscreen,
      );
    },
    [fullscreen],
  );

  const canInput = Boolean(receiverState?.canInput);

  const customCursorStyle = useMemo(() => {
    if (!canInput) return undefined;
    const shape = receiverState?.shape;
    if (!shape) return undefined;
    const cssW = Math.max(1, Math.round(shape.w / shape.scale));
    const cssH = Math.max(1, Math.round(shape.h / shape.scale));
    const hotX = Math.min(cssW - 1, Math.max(0, Math.round(shape.hotX / shape.scale)));
    const hotY = Math.min(cssH - 1, Math.max(0, Math.round(shape.hotY / shape.scale)));
    return `url("${shape.url}") ${hotX} ${hotY}, default`;
  }, [canInput, receiverState?.shape]);

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canInput) return;
    const pt = resolvePointerFraction(
      event.clientX,
      event.clientY,
      event.buttons > 0,
    );
    if (pt) receiverRef.current?.pointer(pt.x, pt.y);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canInput) return;
    const btn = mouseButton(event.button);
    if (!btn) return;
    const pt = resolvePointerFraction(event.clientX, event.clientY, false);
    if (!pt) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Ignore synthetic pointer events in tests.
    }
    imeRef.current?.focus({ preventScroll: true });
    receiverRef.current?.button(
      true,
      btn,
      pt.x,
      pt.y,
      event.detail || 1,
      remoteModifiers(event, localPlat, remotePlat),
    );
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const btn = mouseButton(event.button);
    if (!btn) return;
    const pt =
      resolvePointerFraction(event.clientX, event.clientY, true) ?? {
        x: 0.5,
        y: 0.5,
      };
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore.
    }
    receiverRef.current?.button(
      false,
      btn,
      pt.x,
      pt.y,
      1,
      remoteModifiers(event, localPlat, remotePlat),
    );
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!canInput) return;
    const pt = resolvePointerFraction(event.clientX, event.clientY, false);
    if (!pt) return;
    event.preventDefault();
    const { dx, dy } = wheelPixels(event);
    receiverRef.current?.scroll(
      dx,
      dy,
      pt.x,
      pt.y,
      remoteModifiers(event, localPlat, remotePlat),
    );
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!canInput || composingRef.current || event.nativeEvent.isComposing) {
      return;
    }
    const mods = remoteModifiers(event, localPlat, remotePlat);
    const hasCommandMod = mods.some((m) => m !== "shift");
    const keyName = hasCommandMod ? shortcutKey(event) : namedKey(event);
    if (keyName) {
      event.preventDefault();
      receiverRef.current?.key(keyName, mods);
    }
  };

  const showVideo =
    receiverState?.transport === "video" && Boolean(receiverState.picture);
  const showCanvas =
    receiverState?.transport === "socket" && Boolean(receiverState.picture);

  return (
    <div
      ref={viewportRef}
      data-stage-engine="webrtc"
      className="ls-screen-stage-viewport"
    >
      <div
        ref={frameRef}
        data-controlling={canInput ? "true" : undefined}
        style={{
          width: `${snappedStageBox.width}px`,
          height: `${snappedStageBox.height}px`,
          cursor: customCursorStyle,
        }}
        className="ls-screen-fitted-frame"
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        onContextMenu={(event) => {
          if (canInput) event.preventDefault();
        }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          data-hidden={!showVideo ? "true" : undefined}
          className="ls-screen-media"
        />
        <canvas
          ref={canvasRef}
          data-hidden={!showCanvas ? "true" : undefined}
          className="ls-screen-media"
        />
        {cursorEcho && (showVideo || showCanvas) ? (
          <span
            aria-hidden="true"
            style={{
              left: `${(cursorEcho.x * 100).toFixed(2)}%`,
              top: `${(cursorEcho.y * 100).toFixed(2)}%`,
            }}
            className="ls-screen-cursor-echo"
          />
        ) : null}
      </div>

      <textarea
        ref={imeRef}
        tabIndex={canInput ? 0 : -1}
        aria-hidden="true"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="ls-screen-ime-input"
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          const committed = event.data;
          if (committed && canInput) {
            receiverRef.current?.input(textInput(committed));
          }
          event.currentTarget.value = "";
        }}
        onChange={(event) => {
          if (composingRef.current) return;
          const value = event.currentTarget.value;
          if (value && canInput) {
            receiverRef.current?.input(textInput(value));
          }
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
