import { createElement, useEffect, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { HostLink, HostStreams } from "@linkshell/client-core";
import {
  DESKTOP_FULLSCREEN_EVENT,
  DESKTOP_NATIVE_SCREEN_EVENT,
  isDesktop,
  postDesktopMessage,
  setDesktopScreenFullScreen,
  setDesktopScreenKeys,
} from "../bridge/desktop-bridge";
import { setRemoteKeysCaptured } from "../bridge/shortcuts";
import { hasOpenOverlay } from "../bridge/top-layer-registry";
import { STORAGE_KEYS, readLocal, saveLocal, subscribeStorageReady } from "./storage";
import { openWebSocket } from "./transport";

export { DESKTOP_FULLSCREEN_EVENT };
export const NATIVE_SCREEN_EVENT = DESKTOP_NATIVE_SCREEN_EVENT;
export const SCREEN_TAKEN = "屏幕画面被另一台设备接手了";
export const SCREEN_IDLE = "长时间没有操作，画面已断开";
export const SCREEN_RETAIN_MS = 120_000;
export const AUTO_RETRIES = 2;
export const RETRIES_EARNED_MS = 10_000;
export const PAUSE_ACK_MS = 2_000;
export const CAPABILITIES_WAIT_MS = 10_000;

// ── Unified Screen Preferences (shared across Mac Native Metal, RemoteScreen & Fleet) ──

export const SCREEN_WIDTH_CHOICES = [
  "auto",
  "1280",
  "1600",
  "1920",
  "2560",
  "3200",
  "native",
] as const;
export const SCREEN_FPS_CHOICES = ["30", "60", "120"] as const;
export const SCREEN_CODEC_CHOICES = ["auto", "h264"] as const;
export const SCREEN_PACING_CHOICES = ["smooth", "immediate"] as const;
export const SCREEN_MODE_CHOICES = ["view", "trackpad", "touch"] as const;

export type ScreenWidthChoice = (typeof SCREEN_WIDTH_CHOICES)[number];
export type ScreenFpsChoice = (typeof SCREEN_FPS_CHOICES)[number];
export type ScreenCodecChoice = (typeof SCREEN_CODEC_CHOICES)[number];
export type ScreenPacingChoice = (typeof SCREEN_PACING_CHOICES)[number];
export type ScreenModeChoice = (typeof SCREEN_MODE_CHOICES)[number];

export interface UnifiedScreenPreferences {
  width: ScreenWidthChoice;
  maxFps: ScreenFpsChoice;
  codec: ScreenCodecChoice;
  pacing: ScreenPacingChoice;
  control: boolean;
  mode: ScreenModeChoice;
  byComputer: Record<string, { display?: number }>;
}

export interface ScreenPreferencesStoreState extends UnifiedScreenPreferences {
  setWidth(width: ScreenWidthChoice): void;
  setMaxFps(maxFps: ScreenFpsChoice): void;
  setCodec(codec: ScreenCodecChoice): void;
  setPacing(pacing: ScreenPacingChoice): void;
  setControl(control: boolean): void;
  setMode(mode: ScreenModeChoice): void;
  setComputerDisplay(computerKey: string, display: number): void;
  hydrate(): void;
}

const DEFAULT_SCREEN_PREFERENCES: UnifiedScreenPreferences = {
  width: "auto",
  maxFps: "60",
  codec: "auto",
  pacing: "smooth",
  control: true,
  mode: "view",
  byComputer: {},
};

function sanitizeWidthChoice(raw: unknown): ScreenWidthChoice {
  return typeof raw === "string" &&
    (SCREEN_WIDTH_CHOICES as readonly string[]).includes(raw)
    ? (raw as ScreenWidthChoice)
    : "auto";
}

function sanitizeFpsChoice(raw: unknown): ScreenFpsChoice {
  const text = typeof raw === "number" ? String(raw) : raw;
  return typeof text === "string" &&
    (SCREEN_FPS_CHOICES as readonly string[]).includes(text)
    ? (text as ScreenFpsChoice)
    : "60";
}

function sanitizeCodecChoice(raw: unknown): ScreenCodecChoice {
  return raw === "h264" ? "h264" : "auto";
}

function sanitizePacingChoice(raw: unknown): ScreenPacingChoice {
  return raw === "immediate" ? "immediate" : "smooth";
}

function sanitizeModeChoice(raw: unknown): ScreenModeChoice {
  return typeof raw === "string" &&
    (SCREEN_MODE_CHOICES as readonly string[]).includes(raw)
    ? (raw as ScreenModeChoice)
    : "view";
}

function readFirstLegacyValue<T>(keys: readonly string[]): T | undefined {
  for (const key of keys) {
    const val = readLocal<T | undefined>(key, undefined);
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return undefined;
}

/** Reads unified v2 preferences, migrating split legacy Web/Mac/RemoteScreen keys once if needed. */
export function loadUnifiedScreenPreferences(): UnifiedScreenPreferences {
  const stored = readLocal<Partial<UnifiedScreenPreferences> | null>(
    STORAGE_KEYS.screenPreferences,
    null,
  );
  if (stored && typeof stored === "object") {
    return {
      width: sanitizeWidthChoice(stored.width),
      maxFps: sanitizeFpsChoice(stored.maxFps),
      codec: sanitizeCodecChoice(stored.codec),
      pacing: sanitizePacingChoice(stored.pacing),
      control: typeof stored.control === "boolean" ? stored.control : true,
      mode: sanitizeModeChoice(stored.mode),
      byComputer:
        stored.byComputer && typeof stored.byComputer === "object"
          ? { ...stored.byComputer }
          : {},
    };
  }

  const legacyWidth = readFirstLegacyValue<string>([
    "screen:linkshell.screen.width",
    "linkshell.screen.width",
    "remoteScreenWidth",
    "desktopScreenWidth",
  ]);
  const legacyFps = readFirstLegacyValue<string | number>([
    "screen:linkshell.screen.maxFps",
    "linkshell.screen.maxFps",
    "remoteScreenFps",
    "desktopScreenFps",
  ]);
  const legacyCodec = readFirstLegacyValue<string>([
    "screen:linkshell.screen.codec",
    "linkshell.screen.codec",
    "remoteScreenCodec",
    "desktopScreenCodec",
  ]);
  const legacyPacing = readFirstLegacyValue<string>([
    "desktopScreenPacing",
    "screen:linkshell.screen.pacing",
  ]);
  const legacyControl = readFirstLegacyValue<boolean>([
    "remoteScreenControl",
    "desktopScreenControl",
  ]);
  const legacyMode = readFirstLegacyValue<string>([
    "screen:linkshell.screen.mode",
    "linkshell.screen.mode",
  ]);

  const migrated: UnifiedScreenPreferences = {
    width: sanitizeWidthChoice(legacyWidth),
    maxFps: sanitizeFpsChoice(legacyFps),
    codec: sanitizeCodecChoice(legacyCodec),
    pacing: sanitizePacingChoice(legacyPacing),
    control: typeof legacyControl === "boolean" ? legacyControl : DEFAULT_SCREEN_PREFERENCES.control,
    mode: sanitizeModeChoice(legacyMode),
    byComputer: {},
  };

  if (
    legacyWidth !== undefined ||
    legacyFps !== undefined ||
    legacyCodec !== undefined ||
    legacyPacing !== undefined ||
    legacyControl !== undefined ||
    legacyMode !== undefined
  ) {
    saveLocal(STORAGE_KEYS.screenPreferences, migrated);
  }

  return migrated;
}

function persistUnifiedScreenPreferences(state: UnifiedScreenPreferences): void {
  saveLocal(STORAGE_KEYS.screenPreferences, {
    width: state.width,
    maxFps: state.maxFps,
    codec: state.codec,
    pacing: state.pacing,
    control: state.control,
    mode: state.mode,
    byComputer: state.byComputer,
  });
}

export function createScreenPreferencesStore() {
  return createStore<ScreenPreferencesStoreState>((set, get) => {
    const commit = (patch: Partial<UnifiedScreenPreferences>) => {
      const current = get();
      const next: UnifiedScreenPreferences = {
        width: patch.width ?? current.width,
        maxFps: patch.maxFps ?? current.maxFps,
        codec: patch.codec ?? current.codec,
        pacing: patch.pacing ?? current.pacing,
        control: patch.control ?? current.control,
        mode: patch.mode ?? current.mode,
        byComputer: patch.byComputer ?? current.byComputer,
      };
      set(next);
      persistUnifiedScreenPreferences(next);
    };
    return {
      ...loadUnifiedScreenPreferences(),
      setWidth: (width) => commit({ width: sanitizeWidthChoice(width) }),
      setMaxFps: (maxFps) => commit({ maxFps: sanitizeFpsChoice(maxFps) }),
      setCodec: (codec) => commit({ codec: sanitizeCodecChoice(codec) }),
      setPacing: (pacing) => commit({ pacing: sanitizePacingChoice(pacing) }),
      setControl: (control) => commit({ control: Boolean(control) }),
      setMode: (mode) => commit({ mode: sanitizeModeChoice(mode) }),
      setComputerDisplay: (computerKey, display) =>
        commit({
          byComputer: {
            ...get().byComputer,
            [computerKey]: { ...get().byComputer[computerKey], display },
          },
        }),
      hydrate: () => set(loadUnifiedScreenPreferences()),
    };
  });
}

export const screenPreferencesStore = createScreenPreferencesStore();
subscribeStorageReady(() => {
  screenPreferencesStore.getState().hydrate();
});

export function useScreenPreferences(): ScreenPreferencesStoreState {
  return useStore(screenPreferencesStore);
}

const FITTED_STAGE_WIDTHS = ["1280", "1920", "2560"] as const;

export function autoScreenWidth(stage: { width: number; ratio: number }): string {
  const ratio = Math.min(Math.max(stage.ratio || 1, 1), 2);
  const target = Math.max(stage.width, 0) * ratio;
  return FITTED_STAGE_WIDTHS.find((width) => Number(width) >= target) ?? "2560";
}

export function screenQuery(
  token: string,
  display: number,
  view: Pick<UnifiedScreenPreferences, "width" | "maxFps" | "codec" | "mode">,
  codecs: readonly { mimeType: string }[],
): string {
  const query = new URLSearchParams({
    token,
    display: String(display),
    width: view.width,
    maxFps: view.maxFps,
    mode: view.mode,
  });
  if (
    view.codec === "auto" &&
    codecs.some((codec) => codec.mimeType.toLowerCase() === "video/h265")
  ) {
    query.set("codec", "hevc");
  }
  return `?${query}`;
}

// ── Input & Stage Geometry ─────────────────────────────────────────────────────────────

export type Modifier = "cmd" | "shift" | "alt" | "ctrl";
export type ScreenPlatform = "mac" | "windows" | "other";
export type ScreenInput =
  | { t: "move"; x: number; y: number }
  | { t: "down" | "up"; b: "left" | "right"; n?: number; m?: Modifier[] }
  | { t: "scroll"; dx: number; dy: number; m?: Modifier[] }
  | { t: "key"; k: string; m?: Modifier[] }
  | { t: "text"; s: string };

export function screenPlatform(value: string | undefined): ScreenPlatform {
  return value === "darwin" ? "mac" : value === "win32" ? "windows" : "other";
}

export interface ModifierKeyState {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function remoteModifiers(
  event: ModifierKeyState,
  local: ScreenPlatform,
  remote: ScreenPlatform,
): Modifier[] {
  const across = local !== remote && local !== "other" && remote !== "other";
  const held = new Set<Modifier>();
  if (event.metaKey) held.add(across ? "ctrl" : "cmd");
  if (event.ctrlKey) held.add(across && local === "windows" ? "cmd" : "ctrl");
  if (event.altKey) held.add("alt");
  if (event.shiftKey) held.add("shift");
  return [...held];
}

const NAMED_KEYS: Record<string, string> = {
  Enter: "return",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "escape",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Delete: "delete",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

const SYMBOL_CODES: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

export interface KeyCodeState {
  key: string;
  code: string;
}

export function namedKey(event: KeyCodeState): string | undefined {
  if (NAMED_KEYS[event.key]) return NAMED_KEYS[event.key];
  return /^F([1-9]|1[0-2])$/.test(event.key) ? event.key.toLowerCase() : undefined;
}

export function shortcutKey(event: KeyCodeState): string | undefined {
  const named = namedKey(event);
  if (named) return named;
  if (event.code === "Space" || event.key === " ") return "space";
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  if (SYMBOL_CODES[event.code]) return SYMBOL_CODES[event.code];
  return /^[\x21-\x7e]$/.test(event.key) ? event.key : undefined;
}

export function textInput(text: string): ScreenInput[] {
  const out: ScreenInput[] = [];
  let piece = "";
  const flush = () => {
    if (piece) out.push({ t: "text", s: piece });
    piece = "";
  };
  for (const character of text.replace(/\r\n/g, "\n")) {
    if (character === "\n" || character === "\r" || character === "\t") {
      flush();
      out.push({ t: "key", k: character === "\t" ? "tab" : "return" });
      continue;
    }
    if (piece.length + character.length > 4000) flush();
    piece += character;
  }
  flush();
  return out;
}

export function mouseButton(button: number): "left" | "right" | undefined {
  return button === 0 ? "left" : button === 2 ? "right" : undefined;
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Rect = ScreenRect;

export function fittedRect(
  picture: { width: number; height: number },
  stage: { width: number; height: number },
): ScreenRect {
  if (
    !(picture.width > 0 && picture.height > 0 && stage.width > 0 && stage.height > 0)
  ) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const wide = stage.width / stage.height < picture.width / picture.height;
  const width = wide
    ? stage.width
    : picture.width * (stage.height / picture.height);
  const height = wide
    ? picture.height * (stage.width / picture.width)
    : stage.height;
  return {
    x: (stage.width - width) / 2,
    y: (stage.height - height) / 2,
    width,
    height,
  };
}

export function snappedRect(rect: ScreenRect, ratio: number): ScreenRect {
  const grid = ratio > 0 ? ratio : 1;
  const snap = (value: number) => Math.round(value * grid) / grid;
  return {
    x: snap(rect.x),
    y: snap(rect.y),
    width: snap(rect.width),
    height: snap(rect.height),
  };
}

/**
 * Computes the snapped AppKit `ScreenClip` (`CAMetalLayer`) stage rect (`#73` §3B).
 * Never collapses `rect` to `0×0` when an HTML `<dialog>` or `[popover]` is open — instead,
 * `NativeMetalStage` passes `holes: getOpenOverlayRects()` alongside `rect` so AppKit masks
 * rounded cutouts out of the Metal layer while keeping the live stream visible underneath.
 */
export function effectiveNativeScreenRect(
  rect: ScreenRect,
  _overlayOpen: boolean = hasOpenOverlay(),
  devicePixelRatio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
): ScreenRect {
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return snappedRect(rect, devicePixelRatio);
}

export const FULLSCREEN_TOP_SNAP_LIMIT = 96;

export function pictureFraction(
  rect: ScreenRect,
  x: number,
  y: number,
  clamp = false,
  topEdgeSnap = false,
): { x: number; y: number } | undefined {
  if (!(rect.width > 0 && rect.height > 0)) return undefined;
  const u = (x - rect.x) / rect.width;
  const v = (y - rect.y) / rect.height;
  const bound = (value: number) => Math.min(1, Math.max(0, value));
  if (!clamp && (u < 0 || u > 1 || v < 0 || v > 1)) {
    if (
      topEdgeSnap &&
      rect.y > 0 &&
      rect.y <= FULLSCREEN_TOP_SNAP_LIMIT &&
      y >= 0 &&
      y <= rect.y &&
      u >= 0 &&
      u <= 1
    ) {
      return { x: +bound(u).toFixed(5), y: 0 };
    }
    return undefined;
  }
  return { x: +bound(u).toFixed(5), y: +bound(v).toFixed(5) };
}

export const SCREEN_WIDTHS = [1280, 1600, 1920, 2560, 3200, 3840] as const;
export const WIDEST_SCREEN = 3840;

export function fittedScreenWidth(
  stage: { width: number; height: number },
  ratio: number,
  aspect?: number,
): number {
  const shown =
    aspect && aspect > 0 ? Math.min(stage.width, stage.height * aspect) : stage.width;
  const target = Math.max(0, shown) * Math.min(Math.max(ratio || 1, 1), 2);
  return SCREEN_WIDTHS.find((width) => width >= target * 0.97) ?? WIDEST_SCREEN;
}

export function chosenScreenWidth(choice: string, fitted: number): number {
  if (choice === "native") return WIDEST_SCREEN;
  const width = Number(choice);
  return Number.isInteger(width) && width >= 640 ? Math.min(width, WIDEST_SCREEN) : fitted;
}

export function wheelPixels(event: {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}): { dx: number; dy: number } {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  const bound = (value: number) => Math.max(-2000, Math.min(2000, value));
  return {
    dx: bound(-event.deltaX * unit),
    dy: bound(-event.deltaY * unit),
  };
}

// ── Native Metal Bridge & Session Policy ───────────────────────────────────────────────

export interface NativeScreenStatus {
  live?: boolean;
  hardware?: boolean;
  codec?: string;
  decoder?: string;
  control?: boolean;
  controlRequested?: boolean;
  controlError?: string;
  displayFps?: number;
  pacing?: "smooth" | "immediate";
  exitFullScreen?: boolean;
}

export interface NativeScreenEvent {
  id: string;
  type: "signal" | "status" | "error";
  message?: Record<string, unknown>;
  status?: NativeScreenStatus;
  error?: string;
}

export function postNativeScreen(
  id: string,
  type: string,
  payload: Record<string, unknown> = {},
): boolean {
  return postDesktopMessage({ action: "screen", id, type, ...payload });
}

export function setScreenKeysCaptured(captured: boolean): void {
  setDesktopScreenKeys(captured);
  // The page's own shortcuts step aside together with the native menu's.
  setRemoteKeysCaptured(captured);
}

export function requestScreenFullScreen(
  enabled: boolean,
  options?: { immersive?: boolean },
): boolean {
  return setDesktopScreenFullScreen(enabled, options);
}

export function screenSignal(data: string | ArrayBuffer): Record<string, unknown> {
  if (typeof data !== "string") {
    throw new Error("此电脑未能建立原生视频直连，请重试或检查网络");
  }
  if (data.length > 262_144) throw new Error("屏幕协商信息过大");
  const parsed: unknown = JSON.parse(data);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("屏幕协商信息无效");
  }
  const message = parsed as Record<string, unknown>;
  if (typeof message.error === "string") throw new Error(message.error.slice(0, 2048));
  const state = message.session as { t?: string; message?: string } | undefined;
  if (state?.t === "error") {
    throw new Error(
      typeof state.message === "string"
        ? state.message.slice(0, 2048)
        : "屏幕设置未能应用，请重新连接",
    );
  }
  return message;
}

export function nativeScreenQuery(
  token: string,
  display: number,
  width: string,
  maxFps: string,
  hevc = false,
): string {
  const query = new URLSearchParams({
    token,
    display: String(display),
    width,
    maxFps,
    video: "1",
    turn: "1",
  });
  if (hevc) query.set("codec", "hevc");
  return `/stream?${query}`;
}

export interface ScreenFullscreen {
  owns: boolean;
  fullscreen: boolean;
}

export function leaveScreenFullscreen(
  state: ScreenFullscreen,
): ScreenFullscreen | undefined {
  return state.owns ? { owns: false, fullscreen: false } : undefined;
}

export function windowFullscreenChanged(
  state: ScreenFullscreen,
  fullscreen: boolean,
  adopt = false,
): (ScreenFullscreen & { focused: boolean }) | undefined {
  if (fullscreen) {
    const owns = state.owns || (adopt && !state.fullscreen);
    return owns ? { owns: true, fullscreen: true, focused: true } : undefined;
  }
  return state.owns || state.fullscreen
    ? { owns: false, fullscreen: false, focused: false }
    : undefined;
}

export interface NativeScreenTarget {
  display: number;
  width: string;
  maxFps: string;
  paused: boolean;
}

export function screenRate(preferred: string, displayFps: number | undefined): string {
  const shown =
    displayFps === undefined || !Number.isFinite(displayFps)
      ? 120
      : displayFps >= 120
        ? 120
        : displayFps >= 60
          ? 60
          : 30;
  const wanted = [30, 60, 120].includes(Number(preferred)) ? Number(preferred) : 60;
  return String(Math.min(wanted, shown));
}

export type FailureAction = "dormant" | "retry" | "fallback" | "show";

export function nativeSessionPolicy(
  message: string,
  state: { paused: boolean; retries: number; canFallBack: boolean },
): FailureAction {
  if (state.paused) return "dormant";
  if (/不支持|不可用|权限|更新 LinkShell/.test(message)) return "show";
  if (state.retries < AUTO_RETRIES) return "retry";
  if (state.canFallBack && /直连|超时|网络|无法建立|中断|断开/.test(message)) {
    return "fallback";
  }
  return "show";
}

export function targetChanged(
  applied: NativeScreenTarget,
  next: NativeScreenTarget,
): { picture: boolean; any: boolean } {
  const picture =
    applied.display !== next.display ||
    applied.width !== next.width ||
    applied.maxFps !== next.maxFps;
  return { picture, any: picture || applied.paused !== next.paused };
}

export function ScreenSessionSlot({
  activeKey,
  selectedKey,
  enabled = true,
  children,
}: {
  activeKey?: string;
  selectedKey?: string;
  enabled?: boolean;
  children: (key: string, active: boolean) => ReactNode;
}) {
  const [retained, setRetained] = useState(activeKey);
  const [visible, setVisible] = useState(
    () => isDesktop || typeof document === "undefined" || !document.hidden,
  );
  useEffect(() => {
    if (isDesktop || typeof document === "undefined") return;
    const changed = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (!enabled || !visible) {
      setRetained(undefined);
      return;
    }
    if (activeKey) {
      setRetained(activeKey);
      return;
    }
    if (retained && retained !== selectedKey) {
      setRetained(undefined);
      return;
    }
    if (!retained) return;
    const timer = setTimeout(() => setRetained(undefined), SCREEN_RETAIN_MS);
    return () => clearTimeout(timer);
  }, [activeKey, selectedKey, retained, enabled, visible]);

  const key =
    enabled && visible
      ? (activeKey ?? (retained === selectedKey ? retained : undefined))
      : undefined;
  if (!key) return null;
  const active = key === activeKey;
  return createElement(
    "div",
    { key, hidden: !active, className: active ? "contents" : undefined },
    children(key, active),
  );
}

// ── ScreenGate (`screen.configure` + input generation gating) ──────────────────────────

export interface ScreenTarget {
  display: number;
  width: number;
  maxFps: number;
  paused: boolean;
}

export interface ScreenConfigureMessage extends ScreenTarget {
  t: "screen.configure";
  requestId: number;
}

export class ScreenGate {
  private known = false;
  private configurable = false;
  private pausable = false;
  private requestId = 0;
  private pending?: { requestId: number; display: number; paused: boolean };
  private last?: { requestId: number; display: number; paused: boolean };
  private applied?: ScreenTarget;
  generation?: number;

  capabilities(message: Record<string, unknown>): boolean {
    if (message.version !== 1) return false;
    this.known = true;
    this.configurable = message.configure === true;
    this.pausable = this.configurable && message.pause === true;
    this.generation = undefined;
    if (this.configurable && this.last) {
      this.pending = { ...this.last };
      return false;
    }
    this.pending = undefined;
    return this.configurable;
  }

  assumeLegacy(): void {
    if (this.known) return;
    this.known = true;
    this.configurable = false;
  }

  get canConfigure(): boolean {
    return this.configurable;
  }
  get canPause(): boolean {
    return this.pausable;
  }
  get capabilitiesKnown(): boolean {
    return this.known;
  }
  get current(): ScreenTarget | undefined {
    return this.applied;
  }

  request(target: ScreenTarget): ScreenConfigureMessage {
    const requestId = ++this.requestId;
    this.pending = { requestId, display: target.display, paused: target.paused };
    this.last = { ...this.pending };
    return { t: "screen.configure", requestId, ...target };
  }

  configured(message: Record<string, unknown>): boolean {
    const pending = this.pending;
    if (
      !pending ||
      message.requestId !== pending.requestId ||
      message.display !== pending.display ||
      message.paused !== pending.paused
    ) {
      return false;
    }
    const generation = message.generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
      return false;
    }
    this.pending = undefined;
    this.generation = generation;
    this.applied = {
      display: pending.display,
      width: typeof message.width === "number" ? message.width : 0,
      maxFps: typeof message.maxFps === "number" ? message.maxFps : 0,
      paused: pending.paused,
    };
    return true;
  }

  failed(message: Record<string, unknown>): string | undefined {
    if (message.requestId !== undefined && message.requestId !== this.pending?.requestId) {
      return undefined;
    }
    this.pending = undefined;
    return typeof message.message === "string"
      ? message.message.slice(0, 500)
      : "屏幕设置未能应用，请重新连接";
  }

  get allowsInput(): boolean {
    if (!this.known || this.pending) return false;
    if (!this.configurable) return true;
    return this.generation !== undefined && this.applied?.paused === false;
  }

  stamp<T extends object>(event: T): T & { screenGeneration?: number } {
    return this.configurable && this.generation !== undefined
      ? { ...event, screenGeneration: this.generation }
      : event;
  }
}

// ── ScreenReceiver (WebRTC Video + 4 DataChannels + WebCodecs/JPEG Socket Fallback) ────

export type ScreenPhase =
  | "starting"
  | "connecting"
  | "receiving"
  | "live"
  | "recovering"
  | "paused"
  | "error";

export interface ScreenStats {
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  bitrateMbps?: number;
  rttMs?: number;
  path?: "lan" | "direct" | "relay" | "socket";
  decoder?: string;
  hardware?: boolean;
  jitterMs?: number;
}

export interface ControlState {
  known: boolean;
  available: boolean;
  trusted: boolean;
  reason?: string;
  app?: string;
}

export interface CursorShape {
  id: string;
  url: string;
  w: number;
  h: number;
  hotX: number;
  hotY: number;
  scale: number;
}

export interface ReceiverState {
  phase: ScreenPhase;
  error?: string;
  taken: boolean;
  idle?: boolean;
  transport?: "video" | "socket";
  displays: { index: number; name: string }[];
  display: number;
  picture?: { width: number; height: number };
  stats?: ScreenStats;
  control: ControlState;
  canInput: boolean;
  notice?: string;
  shape?: CursorShape;
  appliedWidth?: number;
  configurable: boolean;
}

export interface ReceiverOptions {
  link: HostLink;
  streams: HostStreams;
  target: Omit<ScreenTarget, "paused">;
  active: boolean;
  control: boolean;
  hevc: boolean;
  relayed: boolean;
  videoTrack?: boolean;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  onState(state: ReceiverState): void;
  onCursor(x: number, y: number): void;
}

type StreamSocket = Awaited<ReturnType<typeof openWebSocket>>;
type InputLane = "input" | "pointer";

const MAX_SIGNAL_MESSAGE = 262_144;
const PATIENCE_MS = 25_000;
const FIRST_PICTURE_MS = 45_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asFraction(value: unknown): number | undefined {
  const number = asFinite(value);
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined;
}

const roundTo = (value: number | undefined, digits = 1) =>
  value === undefined || !Number.isFinite(value) ? undefined : +value.toFixed(digits);

function extractSps(unit: Uint8Array): Uint8Array | undefined {
  for (let i = 0; i + 3 < unit.length; i++) {
    if (
      unit[i] === 0 &&
      unit[i + 1] === 0 &&
      unit[i + 2] === 1 &&
      (unit[i + 3]! & 0x1f) === 7
    ) {
      return unit.subarray(i + 3);
    }
  }
  return undefined;
}

const toHex = (value: number) => value.toString(16).padStart(2, "0");
const nowClock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class ScreenReceiver {
  state: ReceiverState;
  private readonly gate = new ScreenGate();
  private readonly options: ReceiverOptions;
  private target: Omit<ScreenTarget, "paused">;
  private active: boolean;
  private controlWanted: boolean;
  private closed = false;
  private socket?: StreamSocket;
  private socketOpen = false;
  private readonly outgoing: string[] = [];
  private port = 0;
  private pc?: RTCPeerConnection;
  private channels: Record<string, RTCDataChannel> = {};
  private described: Promise<void> = Promise.resolve();
  private connectedOnce = false;
  private gaveUp = false;
  private tried = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private usedAt = -Infinity;
  private patience?: ReturnType<typeof setTimeout>;
  private away?: ReturnType<typeof setTimeout>;
  private firstPicture?: ReturnType<typeof setTimeout>;
  private statsTimer?: ReturnType<typeof setInterval>;
  private controlAsked = false;
  private sent = 0;
  private readonly held = new Map<string, ScreenInput & { t: "down" }>();
  private pendingMove?: { x: number; y: number };
  private moveFrame = 0;
  private lastLane: InputLane = "input";
  private rest?: ReturnType<typeof setTimeout>;
  private movedAt = -Infinity;
  private readonly trail: { x: number; y: number; t: number }[] = [];
  private cursorNumber = 0;
  private readonly shapes = new Map<string, CursorShape>();
  private decoder?: VideoDecoder;
  private skipping = false;
  private keyAsked = -Infinity;
  private decodeFailures = 0;
  private jpegPending?: { seq: number; unit: Uint8Array };
  private jpegDrawing = false;
  private lastShown = 0;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private socketFrames = 0;
  private socketBytes = 0;
  private statsBefore?: {
    at: number;
    frames: number;
    bytes: number;
    raw?: Record<string, unknown>;
  };
  private readonly context: CanvasRenderingContext2D | null;
  private frameCallback?: number;

  constructor(options: ReceiverOptions) {
    this.options = options;
    this.target = options.target;
    this.active = options.active;
    this.controlWanted = options.control;
    this.context = options.canvas.getContext("2d");
    this.state = {
      phase: "starting",
      taken: false,
      displays: [],
      display: options.target.display,
      control: { known: false, available: false, trusted: false },
      canInput: false,
      configurable: false,
    };
    const video = options.video;
    video.muted = true;
    video.playsInline = true;
    video.addEventListener("resize", this.sized);
    video.addEventListener("loadedmetadata", this.sized);
    video.addEventListener("playing", this.videoShown);
    if (typeof video.requestVideoFrameCallback === "function") {
      const next = () => {
        if (this.closed) return;
        this.videoShown();
        this.frameCallback = video.requestVideoFrameCallback(next);
      };
      this.frameCallback = video.requestVideoFrameCallback(next);
    }
    void this.start();
  }

  private set(next: Partial<ReceiverState>) {
    if (this.closed) return;
    const state = { ...this.state, ...next };
    state.canInput = this.inputAllowed(state);
    this.state = state;
    this.options.onState(state);
  }

  private inputAllowed(state: ReceiverState): boolean {
    return (
      this.active &&
      this.controlWanted &&
      this.gate.allowsInput &&
      state.control.available &&
      state.control.trusted &&
      Boolean(state.picture) &&
      (state.phase === "live" || state.phase === "receiving")
    );
  }

  private later(ms: number, action: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) action();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private cancel(timer: ReturnType<typeof setTimeout> | undefined) {
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  private async start() {
    this.firstPicture = this.later(FIRST_PICTURE_MS, () => {
      if (!this.state.picture && this.active) {
        this.fail("画面一直没有出现。请确认电脑在线、已允许屏幕录制，然后重新连接。");
      }
    });
    let viewer: { port: number; token: string; displays: { index: number; name: string }[] };
    try {
      viewer = await this.options.link.call("screen.start", {}, 20_000);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.closed) return;
    this.port = viewer.port;
    const displays = viewer.displays
      .slice(0, 16)
      .map((entry) => ({ index: entry.index, name: String(entry.name).slice(0, 80) }));
    if (displays.length && !displays.some((entry) => entry.index === this.target.display)) {
      this.target = { ...this.target, display: displays[0]!.index };
    }
    this.set({ phase: "connecting", displays, display: this.target.display });
    const query = new URLSearchParams({
      token: viewer.token,
      display: String(this.target.display),
      width: String(this.target.width),
      maxFps: String(this.target.maxFps),
      video: this.options.videoTrack === false ? "0" : "1",
      turn: "1",
    });
    if (this.options.hevc) query.set("codec", "hevc");
    if (this.options.relayed) query.set("q", "low");
    try {
      const socket = await openWebSocket(
        this.options.streams,
        this.port,
        `/stream?${query}`,
        {
          open: () => {
            this.socketOpen = true;
            for (const message of this.outgoing.splice(0)) this.socket?.send(message);
            this.later(CAPABILITIES_WAIT_MS, () => {
              if (!this.gate.capabilitiesKnown) {
                this.gate.assumeLegacy();
                this.afterGate();
              }
            });
          },
          data: (data) => this.received(data),
          close: (reason) => {
            if (this.closed) return;
            this.socketOpen = false;
            this.fail(
              this.state.taken
                ? SCREEN_TAKEN
                : reason || "屏幕连接已断开，请确认电脑在线后重新连接。",
            );
          },
        },
      );
      if (this.closed) socket.close();
      else this.socket = socket;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  stop(): void {
    if (this.closed) return;
    this.releaseAll();
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.statsTimer !== undefined) clearInterval(this.statsTimer);
    if (this.ackTimer !== undefined) clearTimeout(this.ackTimer);
    if (this.moveFrame && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.moveFrame);
    }
    this.dropPeer();
    this.socket?.close();
    this.socket = undefined;
    try {
      this.decoder?.close();
    } catch {
      // Already closed.
    }
    this.decoder = undefined;
    const video = this.options.video;
    video.removeEventListener("resize", this.sized);
    video.removeEventListener("loadedmetadata", this.sized);
    video.removeEventListener("playing", this.videoShown);
    if (
      this.frameCallback !== undefined &&
      typeof video.cancelVideoFrameCallback === "function"
    ) {
      video.cancelVideoFrameCallback(this.frameCallback);
    }
    video.srcObject = null;
  }

  private fail(message: string) {
    if (this.closed) return;
    const taken = this.state.taken || message === SCREEN_TAKEN;
    this.releaseAll();
    this.set({ phase: "error", error: message.slice(0, 600), taken });
    this.stop();
  }

  private received(data: string | ArrayBuffer) {
    if (this.closed) return;
    if (typeof data !== "string") {
      this.frame(data);
      return;
    }
    if (data.length > MAX_SIGNAL_MESSAGE) return;
    let message: Record<string, unknown> | undefined;
    try {
      message = asRecord(JSON.parse(data));
    } catch {
      return;
    }
    if (!message) return;
    const session = asRecord(message.session);
    if (session) {
      this.sessionMessage(session);
      return;
    }
    if (typeof message.error === "string") {
      if (message.error === SCREEN_TAKEN) this.state = { ...this.state, taken: true };
      if (message.error === SCREEN_IDLE) this.state = { ...this.state, idle: true };
      this.fail(message.error);
      return;
    }
    const rtc = asRecord(message.rtc);
    if (rtc) {
      this.signal(rtc);
      return;
    }
    if (message.restart) {
      this.resetDecoder();
      this.shownUpTo(this.lastShown);
      if (message.lighter === true) {
        this.notice("网络较慢：已降低画质，优先保证跟得上");
      }
    }
    const control = asRecord(message.control);
    if (control) {
      const next: ControlState = {
        known: true,
        available: control.available === true,
        trusted: control.trusted === true,
        reason:
          typeof control.reason === "string" ? control.reason.slice(0, 400) : undefined,
        app: typeof control.app === "string" ? control.app.slice(0, 80) : undefined,
      };
      if (!next.trusted) this.releaseAll();
      this.set({ control: next });
    }
    const cursor = asRecord(message.cursor);
    if (cursor) {
      const x = asFraction(cursor.x);
      const y = asFraction(cursor.y);
      if (x !== undefined && y !== undefined) this.echo(x, y);
    }
  }

  private sessionMessage(session: Record<string, unknown>) {
    if (session.t === "capabilities") {
      if (this.gate.capabilities(session)) this.configure();
      this.set({ configurable: this.gate.canConfigure });
      this.afterGate();
    } else if (session.t === "configured") {
      if (!this.gate.configured(session)) return;
      this.controlAsked = false;
      this.set({
        appliedWidth: asFinite(session.width),
        display: this.gate.current?.display ?? this.target.display,
        phase: this.resumedPhase(),
      });
      this.afterGate();
    } else if (session.t === "error") {
      const reason = this.gate.failed(session);
      if (!reason) return;
      this.notice(reason);
      this.set({});
    }
  }

  private resumedPhase(): ScreenPhase {
    if (!this.active) return "paused";
    if (this.state.picture) {
      return this.state.phase === "recovering" ? "recovering" : "live";
    }
    return this.state.phase === "paused" || this.state.phase === "starting"
      ? "receiving"
      : this.state.phase;
  }

  private afterGate() {
    this.askControl();
    this.set({});
  }

  private askControl() {
    if (
      !this.controlWanted ||
      this.controlAsked ||
      !this.gate.allowsInput ||
      !this.active
    ) {
      return;
    }
    this.controlAsked = true;
    this.sendSocket(this.gate.stamp({ t: "control" }));
  }

  private configure() {
    if (!this.gate.canConfigure) return;
    this.sendSocket(this.gate.request({ ...this.target, paused: !this.active }));
    this.set({});
  }

  private notice(text: string) {
    this.set({ notice: text });
    this.later(4200, () => {
      if (this.state.notice === text) this.set({ notice: undefined });
    });
  }

  private sendSocket(message: object) {
    const text = JSON.stringify(message);
    if (text.length > MAX_SIGNAL_MESSAGE) return;
    if (this.socket && this.socketOpen) this.socket.send(text);
    else if (this.outgoing.length < 128) this.outgoing.push(text);
  }

  private signal(rtc: Record<string, unknown>) {
    if (rtc.t === "off") {
      this.fallBack();
      return;
    }
    if (this.gaveUp) return;
    if (rtc.t === "config") {
      this.createPeer(rtc.iceServers);
      return;
    }
    const pc = this.pc;
    if (!pc) return;
    if (rtc.t === "offer" && typeof rtc.sdp === "string" && rtc.sdp.length < 128_000) {
      this.tried = true;
      this.patience = this.later(PATIENCE_MS, () => this.patient(pc));
      this.described = pc
        .setRemoteDescription({ type: "offer", sdp: rtc.sdp })
        .then(() => {
          this.preferCodecs(pc);
          return pc.createAnswer();
        })
        .then((answer) => pc.setLocalDescription(answer))
        .then(() => {
          if (this.pc === pc && pc.localDescription) {
            this.sendSocket({ t: "rtc.answer", sdp: pc.localDescription.sdp });
          }
        });
      this.described.catch((error: unknown) => {
        if (this.pc === pc) {
          this.giveUp(
            `the offer could not be answered: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      });
    } else if (
      rtc.t === "ice" &&
      typeof rtc.candidate === "string" &&
      rtc.candidate.length < 8192
    ) {
      const index = asFinite(rtc.sdpMLineIndex);
      const candidate = {
        candidate: rtc.candidate,
        sdpMid: typeof rtc.sdpMid === "string" ? rtc.sdpMid.slice(0, 64) : null,
        sdpMLineIndex: index === undefined ? null : index,
      };
      this.described
        .then(() => (this.pc === pc ? pc.addIceCandidate(candidate) : undefined))
        .catch(() => {});
    }
  }

  private createPeer(servers: unknown) {
    this.dropPeer();
    const iceServers = (Array.isArray(servers) ? servers : [])
      .slice(0, 8)
      .flatMap((server): RTCIceServer[] => {
        const entry = asRecord(server);
        const urls = (Array.isArray(entry?.urls) ? entry.urls : [entry?.urls]).filter(
          (url): url is string =>
            typeof url === "string" &&
            url.length <= 1024 &&
            /^(stuns?|turns?):/.test(url),
        );
        const login = (value: unknown) =>
          typeof value === "string" && value.length > 0 && value.length <= 512
            ? value
            : undefined;
        const username = login(entry?.username);
        const credential = login(entry?.credential);
        return urls.length
          ? [{ urls, ...(username && credential ? { username, credential } : {}) }]
          : [];
      });
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
    } catch (error) {
      this.giveUp(
        `the receiver could not start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    this.pc = pc;
    this.channels = {};
    this.connectedOnce = false;
    pc.onicecandidate = ({ candidate }) => {
      if (candidate?.candidate) {
        this.sendSocket({
          t: "rtc.ice",
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        });
      }
    };
    pc.ontrack = ({ receiver, track, streams }) => {
      const tuning = receiver as RTCRtpReceiver & {
        jitterBufferTarget?: number;
        playoutDelayHint?: number;
      };
      try {
        if ("jitterBufferTarget" in tuning) tuning.jitterBufferTarget = 0;
      } catch {
        // Older engines.
      }
      try {
        if ("playoutDelayHint" in tuning) tuning.playoutDelayHint = 0;
      } catch {
        // Older engines.
      }
      const video = this.options.video;
      video.srcObject = streams[0] ?? new MediaStream([track]);
      void video.play().catch(() => {});
    };
    pc.ondatachannel = ({ channel }) => {
      if (
        !["input", "pointer", "cursor", "shape"].includes(channel.label) ||
        this.channels[channel.label]
      ) {
        channel.close();
        return;
      }
      this.channels[channel.label] = channel;
      if (channel.label === "cursor" || channel.label === "shape") {
        channel.onmessage = (event) => {
          if (
            this.pc !== pc ||
            typeof event.data !== "string" ||
            event.data.length > 1_500_000
          ) {
            return;
          }
          try {
            const message = asRecord(JSON.parse(event.data));
            if (message?.t === channel.label) this.told(message);
          } catch {
            // Ignore malformed cursor frame.
          }
        };
      }
      channel.onclose = () => {
        if (this.pc === pc && channel.label === "input" && !this.gaveUp) {
          this.giveUp("the input channel closed");
        }
      };
    };
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = () => {
      if (this.pc === pc) this.watch(pc);
    };
  }

  private preferCodecs(pc: RTCPeerConnection) {
    const transceiver = pc
      .getTransceivers()
      .find((entry) => entry.receiver.track?.kind === "video");
    if (!transceiver?.setCodecPreferences) return;
    try {
      const codecs = (RTCRtpReceiver.getCapabilities("video")?.codecs ?? []).filter(
        (codec) => codec.mimeType.toLowerCase() !== "video/flexfec-03",
      );
      const rank = (mime: string) =>
        mime === "video/h265"
          ? this.options.hevc
            ? 0
            : 1
          : mime === "video/h264"
            ? this.options.hevc
              ? 1
              : 0
            : 2;
      const ordered = [...codecs].sort(
        (a, b) => rank(a.mimeType.toLowerCase()) - rank(b.mimeType.toLowerCase()),
      );
      if (
        ordered.some((codec) =>
          ["video/h264", "video/h265"].includes(codec.mimeType.toLowerCase()),
        )
      ) {
        transceiver.setCodecPreferences(ordered);
      }
    } catch {
      // Browser codec preference stands.
    }
  }

  private watch(pc: RTCPeerConnection) {
    const state: string = pc.connectionState || pc.iceConnectionState;
    if (state === "failed" || pc.iceConnectionState === "failed") {
      this.giveUp(
        this.connectedOnce
          ? "the connection failed"
          : "no path between the two (ICE failed)",
      );
      return;
    }
    if (state === "disconnected") {
      if (this.state.picture) this.set({ phase: "recovering" });
      if (this.connectedOnce && !this.away) {
        this.away = this.later(4000, () => {
          this.away = undefined;
          if (this.pc === pc && this.active) {
            this.giveUp("disconnected for more than 4 s");
          }
        });
      }
    } else if (state === "connected" || state === "completed") {
      this.cancel(this.away);
      this.away = undefined;
      if (this.state.phase === "recovering") {
        this.set({ phase: this.state.picture ? "live" : "receiving" });
      }
      if (this.connectedOnce) return;
      this.connectedOnce = true;
      this.cancel(this.patience);
      if (!this.state.picture) {
        this.set({ phase: "receiving" });
        this.patience = this.later(4000, () => this.frameless(pc));
      }
    }
  }

  private patient(pc: RTCPeerConnection) {
    if (this.pc !== pc) return;
    if (!this.active) this.patience = this.later(PATIENCE_MS, () => this.patient(pc));
    else if (!this.connectedOnce) {
      this.giveUp(`not connected within ${PATIENCE_MS / 1000} s of the offer`);
    }
  }

  private frameless(pc: RTCPeerConnection) {
    if (this.pc !== pc || this.state.picture) return;
    if (!this.active) this.patience = this.later(4000, () => this.frameless(pc));
    else this.giveUp("connected, but no frame within 4 s");
  }

  private giveUp(reason: string) {
    if (this.gaveUp || this.closed) return;
    this.gaveUp = true;
    this.set({ phase: "recovering" });
    const pc = this.pc;
    const reportFailure = (detail: string) => {
      this.dropPeer();
      if (detail) this.sendSocket({ t: "rtc.diagnosis", reason, ice: detail });
      this.sendSocket({ t: "rtc.failed", reason: detail ? `${reason} (${detail})` : reason });
    };
    if (pc) void iceSummary(pc).then(reportFailure, () => reportFailure(""));
    else reportFailure("");
  }

  private fallBack() {
    const wasLive = this.state.transport === "video";
    this.gaveUp = true;
    this.dropPeer();
    this.set({ phase: this.state.picture ? "recovering" : "receiving" });
    if (typeof VideoDecoder === "undefined") {
      this.fail("这个系统版本的浏览器内核不支持视频解码，请更新 LinkShell 后重试。");
      return;
    }
    if (this.tried) {
      this.notice(
        wasLive
          ? "直连断开了：已改用兼容方式传画面，延迟会高一些"
          : "没能和电脑直连：已改用兼容方式传画面，延迟会高一些",
      );
    }
  }

  private dropPeer() {
    this.cancel(this.patience);
    this.cancel(this.away);
    this.away = undefined;
    const pc = this.pc;
    if (!pc) return;
    this.pc = undefined;
    for (const channel of Object.values(this.channels)) {
      channel.onmessage = null;
      channel.onclose = null;
    }
    this.channels = {};
    pc.ontrack =
      pc.ondatachannel =
      pc.onicecandidate =
      pc.oniceconnectionstatechange =
      pc.onconnectionstatechange =
        null;
    pc.close();
  }

  private sized = () => {
    const video = this.options.video;
    if (!this.pc || !video.videoWidth || !video.videoHeight) return;
    const picture = this.state.picture;
    if (
      this.state.transport === "video" &&
      picture?.width === video.videoWidth &&
      picture.height === video.videoHeight
    ) {
      return;
    }
    this.pictureArrived("video", { width: video.videoWidth, height: video.videoHeight });
  };

  private videoShown = () => {
    const video = this.options.video;
    if (!this.pc || video.readyState < 2 || !video.videoWidth) return;
    if (this.state.transport !== "video" || !this.state.picture) {
      this.pictureArrived("video", { width: video.videoWidth, height: video.videoHeight });
    }
  };

  private pictureArrived(
    transport: "video" | "socket",
    picture: { width: number; height: number },
  ) {
    this.cancel(this.patience);
    this.cancel(this.firstPicture);
    const first = !this.state.picture || this.state.transport !== transport;
    if (transport === "socket" && this.state.transport === "video") {
      this.options.video.srcObject = null;
    }
    this.set({
      transport,
      picture,
      phase: this.active ? "live" : "paused",
      error: undefined,
    });
    if (first) {
      this.startStats();
      this.askControl();
    }
  }

  private told(message: Record<string, unknown>) {
    if (message.t === "cursor") {
      const number = asFinite(message.i);
      if (number !== undefined) {
        if (number <= this.cursorNumber) return;
        this.cursorNumber = number;
      }
      const x = asFraction(message.x);
      const y = asFraction(message.y);
      if (x !== undefined && y !== undefined) this.echo(x, y);
      return;
    }
    if (message.t !== "shape" || typeof message.id !== "string" || message.id.length > 64) {
      return;
    }
    if (typeof message.png === "string") {
      const w = asFinite(message.w);
      const h = asFinite(message.h);
      const hotX = asFinite(message.hotX);
      const hotY = asFinite(message.hotY);
      if (
        message.png.length <= 1_400_000 &&
        /^[A-Za-z0-9+/=]+$/.test(message.png) &&
        w &&
        h &&
        w > 0 &&
        h > 0 &&
        w <= 256 &&
        h <= 256 &&
        hotX !== undefined &&
        hotY !== undefined
      ) {
        if (this.shapes.size >= 64) this.shapes.clear();
        const scale = asFinite(message.scale);
        this.shapes.set(message.id, {
          id: message.id,
          url: `data:image/png;base64,${message.png}`,
          w,
          h,
          hotX: Math.min(w, Math.max(0, hotX)),
          hotY: Math.min(h, Math.max(0, hotY)),
          scale: scale && scale >= 1 && scale <= 4 ? scale : 2,
        });
      }
    }
    const shape = this.shapes.get(message.id);
    if (shape && shape !== this.state.shape) this.set({ shape });
  }

  private echo(x: number, y: number) {
    const now = nowClock();
    if (
      this.state.canInput &&
      (now - this.movedAt < 250 ||
        this.trail.some(
          (point) =>
            now - point.t < 1000 &&
            Math.abs(point.x - x) < 0.003 &&
            Math.abs(point.y - y) < 0.003,
        ))
    ) {
      return;
    }
    this.options.onCursor(x, y);
  }

  setTarget(
    next: Partial<Omit<ScreenTarget, "paused">>,
  ): "applied" | "unchanged" | "reconnect" {
    const target = { ...this.target, ...next };
    if (
      target.display === this.target.display &&
      target.width === this.target.width &&
      target.maxFps === this.target.maxFps
    ) {
      return "unchanged";
    }
    if (!this.gate.canConfigure) {
      if (target.display === this.target.display && target.width === this.target.width) {
        this.target = target;
        return "unchanged";
      }
      return this.gate.capabilitiesKnown ? "reconnect" : "unchanged";
    }
    this.releaseAll();
    this.target = target;
    this.configure();
    this.set({ display: target.display });
    return "applied";
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) this.releaseAll();
    if (this.gate.canConfigure) this.configure();
    else if (this.gate.capabilitiesKnown) {
      this.sendSocket({ t: active ? "shown" : "hidden" });
    }
    if (active) this.askControl();
    this.set({ phase: this.resumedPhase() });
  }

  get canPause(): boolean {
    return this.gate.canPause;
  }

  setControl(wanted: boolean): void {
    if (this.controlWanted === wanted) return;
    this.controlWanted = wanted;
    if (!wanted) this.releaseAll();
    this.askControl();
    this.set({});
  }

  askPermission(): void {
    this.sendSocket(this.gate.stamp({ t: "prompt" }));
  }

  private lanesOpen(): boolean {
    return (
      this.state.transport === "video" &&
      this.channels.input?.readyState === "open" &&
      this.channels.pointer?.readyState === "open"
    );
  }

  used(): void {
    const now = nowClock();
    if (this.closed || now - this.usedAt < 15_000) return;
    this.usedAt = now;
    this.sendSocket({ t: "activity" });
  }

  private post(event: ScreenInput, lane: InputLane) {
    if (!this.state.canInput) return;
    this.used();
    const stamped = this.gate.stamp(event);
    if (!this.lanesOpen()) {
      this.sendSocket(stamped);
      return;
    }
    const channel = this.channels[lane]!;
    if (lane === "pointer" && channel.bufferedAmount > 16_384) return;
    channel.send(JSON.stringify({ ...stamped, i: ++this.sent }));
  }

  pointer(x: number, y: number): void {
    if (!this.state.canInput) return;
    this.pendingMove = { x, y };
    this.movedAt = nowClock();
    if (!this.moveFrame && typeof requestAnimationFrame === "function") {
      this.moveFrame = requestAnimationFrame(() => {
        this.moveFrame = 0;
        this.flushMove(false);
      });
    }
  }

  private flushMove(placed: boolean) {
    const move = this.pendingMove;
    if (!move) {
      if (placed && this.lastLane === "pointer" && this.trail.length) {
        const last = this.trail[this.trail.length - 1]!;
        this.post({ t: "move", x: last.x, y: last.y }, "input");
        this.lastLane = "input";
      }
      return;
    }
    this.pendingMove = undefined;
    const now = nowClock();
    this.trail.push({ ...move, t: now });
    while (this.trail.length && now - this.trail[0]!.t > 1000) this.trail.shift();
    const lane: InputLane = placed || this.held.size ? "input" : "pointer";
    this.post({ t: "move", x: move.x, y: move.y }, lane);
    this.lastLane = lane;
    this.cancel(this.rest);
    if (lane === "pointer") {
      this.rest = this.later(80, () => {
        if (this.lastLane !== "pointer" || !this.trail.length) return;
        const last = this.trail[this.trail.length - 1]!;
        this.post({ t: "move", x: last.x, y: last.y }, "input");
        this.lastLane = "input";
      });
    }
  }

  button(
    down: boolean,
    button: "left" | "right",
    x: number,
    y: number,
    clicks: number,
    modifiers: Modifier[],
  ): void {
    if (!this.state.canInput) return;
    if (!down && !this.held.has(button)) return;
    this.pendingMove = { x, y };
    this.flushMove(true);
    const event = {
      t: down ? "down" : "up",
      b: button,
      n: Math.min(3, Math.max(1, clicks)),
      ...(modifiers.length ? { m: modifiers } : {}),
    } as ScreenInput & { t: "down" };
    this.post(event, "input");
    if (down) this.held.set(button, event);
    else this.held.delete(button);
  }

  scroll(
    dx: number,
    dy: number,
    x: number,
    y: number,
    modifiers: Modifier[],
  ): void {
    if (!this.state.canInput || (!dx && !dy)) return;
    this.pendingMove = { x, y };
    this.flushMove(true);
    this.post(
      {
        t: "scroll",
        dx: Math.round(dx),
        dy: Math.round(dy),
        ...(modifiers.length ? { m: modifiers } : {}),
      },
      "input",
    );
  }

  key(name: string, modifiers: Modifier[]): void {
    if (!this.state.canInput || !name || name.length > 16) return;
    this.flushMove(true);
    this.post(
      { t: "key", k: name, ...(modifiers.length ? { m: modifiers } : {}) },
      "input",
    );
  }

  input(events: ScreenInput[]): void {
    if (!this.state.canInput) return;
    this.flushMove(true);
    for (const event of events) this.post(event, "input");
  }

  releaseAll(): void {
    const held = [...this.held.values()];
    this.held.clear();
    const allowed = this.state.canInput;
    for (const event of held) {
      const up = { ...event, t: "up" as const };
      if (allowed) this.post(up, "input");
      else if (this.lanesOpen()) {
        this.channels.input!.send(
          JSON.stringify({ ...this.gate.stamp(up), i: ++this.sent }),
        );
      } else {
        this.sendSocket(this.gate.stamp(up));
      }
    }
  }

  private frame(data: ArrayBuffer) {
    if (data.byteLength < 6) return;
    const head = new DataView(data);
    const kind = head.getUint8(0);
    const seq = head.getUint32(1);
    const unit = new Uint8Array(data, 5);
    this.socketBytes += data.byteLength;
    if (!this.active) {
      this.shownUpTo(seq);
      return;
    }
    if (kind === 2) {
      this.jpegPending = { seq, unit };
      void this.drawJpeg();
      return;
    }
    if (typeof VideoDecoder === "undefined") return;
    const key = kind === 1;
    if (this.decoder && !key && (this.skipping || this.decoder.decodeQueueSize > 8)) {
      this.skipping = true;
      this.askKey();
      this.shownUpTo(seq);
      return;
    }
    this.skipping = false;
    if (!this.decoder) {
      const params = key ? extractSps(unit) : undefined;
      if (!params || params.length < 4) {
        this.askKey();
        this.shownUpTo(seq);
        return;
      }
      this.decoder = new VideoDecoder({
        output: (frame) => {
          try {
            this.drawFrame(
              frame,
              frame.displayWidth,
              frame.displayHeight,
              Number(frame.timestamp),
            );
          } finally {
            frame.close();
          }
        },
        error: (error) => {
          if (this.decodeFailures++ > 4) {
            this.fail(`画面解码失败：${error.message}`);
            return;
          }
          this.decoder = undefined;
          this.askKey();
        },
      });
      this.decoder.configure({
        codec: `avc1.${toHex(params[1]!)}${toHex(params[2]!)}${toHex(params[3]!)}`,
        optimizeForLatency: true,
      });
    }
    this.decoder.decode(
      new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: seq, data: unit }),
    );
  }

  private async drawJpeg() {
    if (this.jpegDrawing) return;
    this.jpegDrawing = true;
    try {
      while (this.jpegPending && !this.closed) {
        const next = this.jpegPending;
        this.jpegPending = undefined;
        const bitmap = await createImageBitmap(
          new Blob([next.unit as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
        );
        try {
          if (!this.closed && this.active) {
            this.drawFrame(bitmap, bitmap.width, bitmap.height, next.seq, true);
          }
        } finally {
          bitmap.close();
        }
      }
    } catch (error) {
      this.fail(`画面解码失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.jpegDrawing = false;
    }
  }

  private drawFrame(
    source: CanvasImageSource,
    width: number,
    height: number,
    seq: number,
    now = false,
  ) {
    if (this.closed || !this.context) return;
    const canvas = this.options.canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.context.drawImage(source, 0, 0);
    this.socketFrames += 1;
    this.shownUpTo(seq, now);
    const picture = this.state.picture;
    if (
      this.state.transport !== "socket" ||
      picture?.width !== width ||
      picture.height !== height
    ) {
      this.pictureArrived("socket", { width, height });
    }
  }

  private resetDecoder() {
    this.jpegPending = undefined;
    try {
      this.decoder?.close();
    } catch {
      // Already closed.
    }
    this.decoder = undefined;
    this.skipping = false;
  }

  private askKey() {
    const now = nowClock();
    if (now - this.keyAsked < 500) return;
    this.keyAsked = now;
    this.sendSocket({ t: "keyframe" });
  }

  private shownUpTo(seq: number, now = false) {
    if (seq > this.lastShown) this.lastShown = seq;
    if (now) {
      this.sendSocket({ t: "ack", n: this.lastShown });
      return;
    }
    if (!this.ackTimer) {
      this.ackTimer = setTimeout(() => {
        this.ackTimer = undefined;
        if (!this.closed) this.sendSocket({ t: "ack", n: this.lastShown });
      }, 40);
    }
  }

  private startStats() {
    if (this.statsTimer) return;
    this.statsBefore = undefined;
    this.statsTimer = setInterval(() => void this.measure(), 2000);
    void this.measure();
  }

  private async measure() {
    if (
      this.closed ||
      (typeof document !== "undefined" && document.hidden) ||
      !this.active
    ) {
      return;
    }
    const now = nowClock();
    if (this.state.transport === "socket") {
      const before = this.statsBefore;
      this.statsBefore = { at: now, frames: this.socketFrames, bytes: this.socketBytes };
      if (!before) return;
      const seconds = (now - before.at) / 1000;
      this.set({
        stats: {
          width: this.state.picture?.width,
          height: this.state.picture?.height,
          path: "socket",
          fps: roundTo((this.socketFrames - before.frames) / seconds),
          bitrateMbps: roundTo(
            ((this.socketBytes - before.bytes) * 8) / seconds / 1e6,
            2,
          ),
          codec: this.decoder ? "H.264" : "JPEG",
        },
      });
      return;
    }
    const pc = this.pc;
    if (!pc) return;
    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return;
    }
    if (this.pc !== pc || this.closed) return;
    let track: Record<string, unknown> = {};
    let transport: Record<string, unknown> = {};
    const pairs: Record<string, unknown>[] = [];
    const ends = new Map<string, Record<string, unknown>>();
    const codecs = new Map<string, Record<string, unknown>>();
    report.forEach((entry: Record<string, unknown>) => {
      if (entry.type === "inbound-rtp" && (entry.kind ?? entry.mediaType) === "video") {
        track = entry;
      } else if (entry.type === "transport") {
        transport = entry;
      } else if (entry.type === "candidate-pair") {
        pairs.push(entry);
      } else if (entry.type === "local-candidate" || entry.type === "remote-candidate") {
        ends.set(String(entry.id), entry);
      } else if (entry.type === "codec") {
        codecs.set(String(entry.id), entry);
      }
    });
    const pair =
      pairs.find((one) => one.id === transport.selectedCandidatePairId) ??
      pairs.find((one) => one.nominated && one.state === "succeeded");
    const near = pair && ends.get(String(pair.localCandidateId));
    const far = pair && ends.get(String(pair.remoteCandidateId));
    const types = [near?.candidateType, far?.candidateType];
    const before = this.statsBefore?.raw;
    const was =
      before &&
      before.id === track.id &&
      Number(track.timestamp) > Number(before.timestamp)
        ? before
        : undefined;
    const since = (field: string) => Number(track[field] ?? 0) - Number(was?.[field] ?? 0);
    const seconds = was ? (Number(track.timestamp) - Number(was.timestamp)) / 1000 : 0;
    this.statsBefore = { at: now, frames: 0, bytes: 0, raw: track };
    const mime = String(codecs.get(String(track.codecId))?.mimeType ?? "").toLowerCase();
    const rtt = asFinite(pair?.currentRoundTripTime);
    this.set({
      stats: {
        width: asFinite(track.frameWidth) ?? this.state.picture?.width,
        height: asFinite(track.frameHeight) ?? this.state.picture?.height,
        fps:
          seconds > 0
            ? roundTo(since("framesDecoded") / seconds)
            : roundTo(asFinite(track.framesPerSecond)),
        bitrateMbps:
          seconds > 0
            ? roundTo((Math.max(0, since("bytesReceived")) * 8) / seconds / 1e6, 2)
            : undefined,
        codec:
          mime === "video/h265"
            ? "H.265"
            : mime === "video/h264"
              ? "H.264"
              : mime
                ? mime.replace("video/", "").toUpperCase()
                : undefined,
        rttMs: rtt === undefined ? undefined : roundTo(rtt * 1000, 0),
        path: types.includes("relay")
          ? "relay"
          : near
            ? privateAddress(near.address) && privateAddress(far?.address)
              ? "lan"
              : "direct"
            : undefined,
        decoder:
          typeof track.decoderImplementation === "string"
            ? track.decoderImplementation.slice(0, 60)
            : undefined,
        hardware:
          typeof track.powerEfficientDecoder === "boolean"
            ? track.powerEfficientDecoder
            : undefined,
        jitterMs:
          since("jitterBufferEmittedCount") > 0
            ? roundTo(
                (since("jitterBufferDelay") / since("jitterBufferEmittedCount")) * 1000,
              )
            : undefined,
      },
    });
  }
}

function privateAddress(value: unknown): boolean {
  if (typeof value !== "string" || !value) return true;
  if (/^(10|127)\./.test(value) || /^192\.168\./.test(value) || /^169\.254\./.test(value)) {
    return true;
  }
  const second = /^172\.(\d+)\./.exec(value)?.[1] ?? /^100\.(\d+)\./.exec(value)?.[1];
  if (second !== undefined) {
    return value.startsWith("172.")
      ? Number(second) >= 16 && Number(second) <= 31
      : Number(second) >= 64 && Number(second) <= 127;
  }
  return /^(f[cd]|fe[89ab])[0-9a-f]*:/i.test(value) || value === "::1";
}

async function iceSummary(pc: RTCPeerConnection): Promise<string> {
  try {
    const report = await pc.getStats();
    const local: Record<string, number> = {};
    const remote: Record<string, number> = {};
    const pairs: Record<string, number> = {};
    let nominated = false;
    report.forEach((entry: Record<string, unknown>) => {
      const count = (into: Record<string, number>, key: unknown) => {
        const name = String(key);
        into[name] = (into[name] ?? 0) + 1;
      };
      if (entry.type === "local-candidate") count(local, entry.candidateType);
      else if (entry.type === "remote-candidate") count(remote, entry.candidateType);
      else if (entry.type === "candidate-pair") {
        count(pairs, entry.state);
        if (entry.nominated && entry.state === "succeeded") nominated = true;
      }
    });
    const list = (counts: Record<string, number>) =>
      Object.entries(counts)
        .map(([kind, n]) => `${kind}×${n}`)
        .join(",") || "none";
    return `local ${list(local)}; remote ${list(remote)}; pairs ${list(pairs)}${
      nominated ? "; nominated" : ""
    }; ice ${pc.iceConnectionState}/${pc.iceGatheringState}`;
  } catch {
    return "no statistics";
  }
}
