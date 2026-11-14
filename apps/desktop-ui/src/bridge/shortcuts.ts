import { useEffect, useRef } from "react";
import type { DesktopI18nKey } from "../core/i18n";
import {
  DESKTOP_COMMAND_EVENT,
  getActiveDesktopPlatform,
  isWindowsDesktop,
  reportDesktopRendererReady,
} from "./desktop-bridge";

export interface ShortcutBinding {
  readonly key: string;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  /** Defaults to `true` (`⌘` on macOS, `Ctrl` on Windows/Linux). Set `false` for non-mod chords like `⇧Tab` or `F11`. */
  readonly mod?: boolean;
}

/**
 * CJK IME composition guard (`PingFang SC` / `Microsoft YaHei` Pinyin & Kana).
 * Never submit or trigger single-key/Enter shortcuts while an IME composition session is active.
 */
export function isImeComposing(
  event:
    | KeyboardEvent
    | { isComposing?: boolean; keyCode?: number; nativeEvent?: KeyboardEvent },
): boolean {
  const native = "nativeEvent" in event && event.nativeEvent ? event.nativeEvent : event;
  return Boolean(native.isComposing || native.keyCode === 229);
}

/** Every app-wide binding the shell handles in `DesktopAppShell`; the shortcuts sheet is generated from it. */
export const DESKTOP_SHORTCUTS = {
  palette: { key: "k" },
  newSession: { key: "n" },
  settings: { key: "," },
  back: { key: "[" },
  forward: { key: "]" },
  previousSession: { key: "[", shift: true },
  nextSession: { key: "]", shift: true },
  closeTab: { key: "w" },
  toggleSidebar: { key: "b" },
  terminal: { key: "j" },
  toggleInspector: { key: "b", alt: true },
  focusComposer: { key: "l" },
  findInSession: { key: "f" },
  goToFile: { key: "p" },
} as const satisfies Record<string, ShortcutBinding>;

export type DesktopShortcutId = keyof typeof DESKTOP_SHORTCUTS;

export type ShortcutSectionId = "navigation" | "panes" | "session" | "screen";

/**
 * `session` shortcuts mean nothing without an open session, so the shell ignores them elsewhere
 * instead of flipping hidden state that surprises the user later.
 */
export const DESKTOP_SHORTCUT_META: Record<
  DesktopShortcutId,
  { label: DesktopI18nKey; section: ShortcutSectionId; scope: "global" | "session" }
> = {
  palette: { label: "desktop.commandCenter", section: "navigation", scope: "global" },
  newSession: { label: "desktop.newSession", section: "navigation", scope: "global" },
  settings: { label: "desktop.shell.openSettings", section: "navigation", scope: "global" },
  back: { label: "desktop.shell.back", section: "navigation", scope: "global" },
  forward: { label: "desktop.shell.forward", section: "navigation", scope: "global" },
  previousSession: { label: "desktop.shell.previousSession", section: "navigation", scope: "global" },
  nextSession: { label: "desktop.shell.nextSession", section: "navigation", scope: "global" },
  closeTab: { label: "desktop.shell.closeTab", section: "navigation", scope: "global" },
  toggleSidebar: { label: "desktop.toggleSidebar", section: "panes", scope: "global" },
  terminal: { label: "desktop.toggleBottomDock", section: "panes", scope: "session" },
  toggleInspector: { label: "desktop.toggleInspector", section: "panes", scope: "session" },
  focusComposer: { label: "desktop.shell.focusComposer", section: "session", scope: "session" },
  findInSession: { label: "desktop.timeline.searchPlaceholder", section: "session", scope: "session" },
  goToFile: { label: "desktop.shell.goToFile", section: "session", scope: "session" },
};

export interface ShortcutSheetExtra {
  /** Rendered verbatim through `formatShortcut`, or as literal text when no binding fits (⌘1…9). */
  binding?: ShortcutBinding;
  text?: string;
  label: DesktopI18nKey;
  section: ShortcutSectionId;
  platforms?: readonly ("macos" | "windows" | "linux")[];
}

export const SHIFT_TAB_SHORTCUT: ShortcutBinding = {
  key: "tab",
  shift: true,
  mod: false,
};

export const FULLSCREEN_SHORTCUT: ShortcutBinding = isWindowsDesktop
  ? { key: "f11", mod: false }
  : { key: "f", ctrl: true, mod: true };

/** Bindings owned by features rather than the shell, listed so the sheet only shows what really works. */
export const SHORTCUT_SHEET_EXTRAS: readonly ShortcutSheetExtra[] = [
  { text: "1…9", label: "desktop.shell.jumpToSession", section: "navigation" },
  { binding: { key: "?", mod: false }, label: "desktop.shortcuts", section: "navigation" },
  { binding: { key: "enter", mod: false }, label: "desktop.composer.send", section: "session" },
  { binding: { key: "enter", shift: true, mod: false }, label: "desktop.shell.newLine", section: "session" },
  { binding: SHIFT_TAB_SHORTCUT, label: "desktop.shell.cycleMode", section: "session" },
  { binding: { key: "s" }, label: "desktop.shell.saveFile", section: "session" },
  {
    binding: { key: "f", ctrl: true, mod: true },
    label: "desktop.screen.fullscreen",
    section: "screen",
    platforms: ["macos"],
  },
  {
    binding: { key: "f11", mod: false },
    label: "desktop.screen.fullscreen",
    section: "screen",
    platforms: ["windows", "linux"],
  },
];

/** Window event the composer listens to; ⌘L and the menu's composer command both end here. */
export const FOCUS_COMPOSER_EVENT = "linkshell-focus-composer";

/**
 * Cancelable window event for ⌘W / the menu's Close item. A feature that closes something on it
 * calls `preventDefault()`; unclaimed, the shell closes the bottom dock or the window.
 */
export const CLOSE_TAB_EVENT = "linkshell-close-tab";

export function requestCloseTab(): boolean {
  if (typeof window === "undefined") return false;
  return !window.dispatchEvent(new CustomEvent(CLOSE_TAB_EVENT, { cancelable: true }));
}

/** ⌘P: the inspector owns the Files tab and its search; the shell only announces the key. */
export const GO_TO_FILE_EVENT = "linkshell-go-to-file";

export function requestGoToFile(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GO_TO_FILE_EVENT));
}

export function requestComposerFocus(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT));
}

function displayKeyName(key: string, windows: boolean): string {
  if (key === "tab") return "Tab";
  if (key === "enter") return windows ? "Enter" : "↵";
  if (key === "escape") return "Esc";
  if (key.startsWith("f") && key.length > 1) return key.toUpperCase();
  return key.length === 1 ? key.toUpperCase() : key;
}

type ShortcutPlatform = "macos" | "windows" | "linux";

/** Pass the platform from a subscribing hook when rendering, so hints follow platform changes. */
export function shortcutParts(
  binding: ShortcutBinding,
  platform: ShortcutPlatform = getActiveDesktopPlatform(),
): string[] {
  const usesMod = binding.mod !== false;
  const win = platform === "windows";
  const key = displayKeyName(binding.key, win);
  if (win) {
    const parts: string[] = [];
    if (usesMod || binding.ctrl) parts.push("Ctrl");
    if (binding.shift) parts.push("Shift");
    if (binding.alt) parts.push("Alt");
    parts.push(key);
    return parts;
  }
  const parts: string[] = [];
  if (binding.ctrl) parts.push("⌃");
  if (binding.alt) parts.push("⌥");
  if (binding.shift) parts.push("⇧");
  if (usesMod) parts.push("⌘");
  parts.push(key);
  return parts;
}

export function formatShortcut(
  binding: ShortcutBinding,
  platform: ShortcutPlatform = getActiveDesktopPlatform(),
): string {
  const parts = shortcutParts(binding, platform);
  return platform === "windows" ? parts.join("+") : parts.join("");
}

function resolvePhysicalKey(event: KeyboardEvent): string {
  const { code } = event;
  if (code.startsWith("Key") && code.length === 4) {
    return code.slice(3).toLowerCase();
  }
  if (code.startsWith("Digit") && code.length === 6) {
    return code.slice(5);
  }
  switch (code) {
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backquote":
      return "`";
    case "Tab":
      return "tab";
    case "Enter":
      return "enter";
    case "Escape":
      return "escape";
    case "F11":
      return "f11";
    default:
      return event.key.toLowerCase();
  }
}

export function matchesShortcut(
  event: KeyboardEvent,
  binding: ShortcutBinding,
): boolean {
  if (isImeComposing(event)) return false;
  const usesMod = binding.mod !== false;
  if (getActiveDesktopPlatform() === "windows") {
    const wantCtrl = usesMod || Boolean(binding.ctrl);
    if (event.ctrlKey !== wantCtrl || event.metaKey) return false;
  } else {
    if (event.metaKey !== usesMod) return false;
    if (event.ctrlKey !== Boolean(binding.ctrl)) return false;
  }
  if (event.altKey !== Boolean(binding.alt)) return false;
  if (event.shiftKey !== Boolean(binding.shift)) return false;
  return resolvePhysicalKey(event) === binding.key.toLowerCase();
}

const REMOTE_KEYS_ATTRIBUTE = "data-remote-keys";

/** The remote screen calls this while it captures the keyboard, so app shortcuts step aside. */
export function setRemoteKeysCaptured(captured: boolean): void {
  if (typeof document === "undefined") return;
  if (captured) document.documentElement.setAttribute(REMOTE_KEYS_ATTRIBUTE, "");
  else document.documentElement.removeAttribute(REMOTE_KEYS_ATTRIBUTE);
}

/** True when an active remote screen or a fullscreen preview owns keyboard input. */
export function keysBelongToRemoteOrPreview(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.fullscreenElement || document.documentElement.hasAttribute(REMOTE_KEYS_ATTRIBUTE),
  );
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(target.closest(".xterm"));
}

export type InspectorPanelId =
  | "changes"
  | "files"
  | "terminal"
  | "tasks"
  | "preview"
  | "settings";

export type ComposerShortcutTarget = "focus";

export type DesktopCommand =
  | { command: "palette" }
  | { command: "new-session"; cwd?: string }
  | { command: "toggle-sidebar" }
  | { command: "inspector"; panel?: InspectorPanelId }
  | { command: "composer"; target: ComposerShortcutTarget }
  | { command: "manage"; page?: string }
  | { command: "workspace" }
  | { command: "fusion"; computerKey: string; launchBundle?: string }
  | { command: "close-tab" }
  | { command: "open-session"; computerKey: string; sessionId: string };

const INSPECTOR_PANELS = new Set<string>([
  "changes",
  "files",
  "terminal",
  "tasks",
  "preview",
  "settings",
]);
const COMPOSER_TARGETS = new Set<string>(["focus"]);

export function parseDesktopCommand(value: unknown): DesktopCommand | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const { command } = raw;
  if (
    command === "palette" ||
    command === "toggle-sidebar" ||
    command === "workspace" ||
    command === "close-tab"
  ) {
    return { command };
  }
  if (command === "manage") {
    return typeof raw.page === "string" && raw.page.length > 0
      ? { command, page: raw.page }
      : { command };
  }
  if (command === "new-session") {
    return typeof raw.cwd === "string" && raw.cwd.length > 0
      ? { command, cwd: raw.cwd }
      : { command };
  }
  if (command === "inspector") {
    return typeof raw.panel === "string" && INSPECTOR_PANELS.has(raw.panel)
      ? { command, panel: raw.panel as InspectorPanelId }
      : { command };
  }
  if (
    command === "composer" &&
    typeof raw.target === "string" &&
    COMPOSER_TARGETS.has(raw.target)
  ) {
    return { command, target: raw.target as ComposerShortcutTarget };
  }
  if (
    command === "open-session" &&
    typeof raw.computerKey === "string" &&
    raw.computerKey.length > 0 &&
    typeof raw.sessionId === "string" &&
    raw.sessionId.length > 0
  ) {
    return { command, computerKey: raw.computerKey, sessionId: raw.sessionId };
  }
  if (
    command === "fusion" &&
    typeof raw.computerKey === "string" &&
    raw.computerKey.length > 0
  ) {
    return typeof raw.launchBundle === "string" && raw.launchBundle.length > 0
      ? { command, computerKey: raw.computerKey, launchBundle: raw.launchBundle }
      : { command, computerKey: raw.computerKey };
  }
  return undefined;
}

export function dispatchDesktopCommand(command: DesktopCommand): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DESKTOP_COMMAND_EVENT, { detail: command }));
}

export function attachDesktopCommandListener(
  handler: (command: DesktopCommand) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const parsed = parseDesktopCommand((event as CustomEvent).detail);
    if (parsed) handler(parsed);
  };
  window.addEventListener(DESKTOP_COMMAND_EVENT, listener);
  reportDesktopRendererReady();
  return () => {
    window.removeEventListener(DESKTOP_COMMAND_EVENT, listener);
  };
}

export function useDesktopCommand(
  handler: (command: DesktopCommand) => void,
): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(
    () => attachDesktopCommandListener((cmd) => ref.current(cmd)),
    [],
  );
}
