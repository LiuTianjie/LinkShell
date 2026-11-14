import { useEffect, useRef } from "react";
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

export const DESKTOP_SHORTCUTS = {
  palette: { key: "k" },
  newSession: { key: "n" },
  focusComposer: { key: "l" },
  modelPicker: { key: "m", shift: true },
  modePicker: { key: "a", shift: true },
  effortPicker: { key: "e", shift: true },
  settings: { key: "," },
  toggleSidebar: { key: "b" },
  toggleInspector: { key: "b", alt: true },
  terminal: { key: "j" },
  back: { key: "[" },
  forward: { key: "]" },
  previousSession: { key: "[", shift: true },
  nextSession: { key: "]", shift: true },
  findInSession: { key: "f" },
  saveFile: { key: "s" },
  workspaceMode: { key: "1" },
  manageMode: { key: "2" },
} as const satisfies Record<string, ShortcutBinding>;

export type DesktopShortcutId = keyof typeof DESKTOP_SHORTCUTS;

export const SHIFT_TAB_SHORTCUT: ShortcutBinding = {
  key: "tab",
  shift: true,
  mod: false,
};

export const FULLSCREEN_SHORTCUT: ShortcutBinding = isWindowsDesktop
  ? { key: "f11", mod: false }
  : { key: "f", ctrl: true, mod: true };

function displayKeyName(key: string): string {
  if (key === "tab") return "Tab";
  if (key === "enter") return "↵";
  if (key === "escape") return "Esc";
  if (key.startsWith("f") && key.length > 1) return key.toUpperCase();
  return key.length === 1 ? key.toUpperCase() : key;
}

export function shortcutParts(binding: ShortcutBinding): string[] {
  const usesMod = binding.mod !== false;
  const key = displayKeyName(binding.key);
  const win = getActiveDesktopPlatform() === "windows";
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

export function formatShortcut(binding: ShortcutBinding): string {
  const parts = shortcutParts(binding);
  return getActiveDesktopPlatform() === "windows" ? parts.join("+") : parts.join("");
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

/** True when an active remote screen or focused port preview owns keyboard input. */
export function keysBelongToRemoteOrPreview(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.fullscreenElement ||
      document.documentElement.hasAttribute("data-remote-keys") ||
      document.querySelector(
        "[data-remote-keys-active], .screen-focused, .port-preview-focused, .remote-screen-fullscreen",
      ),
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

export type ComposerShortcutTarget = "focus" | "model" | "mode" | "effort";

export type DesktopCommand =
  | { command: "palette" }
  | { command: "new-session"; cwd?: string }
  | { command: "toggle-sidebar" }
  | { command: "inspector"; panel?: InspectorPanelId }
  | { command: "composer"; target: ComposerShortcutTarget }
  | { command: "manage"; page?: string }
  | { command: "workspace" }
  | { command: "fusion"; computerKey: string; launchBundle?: string };

const INSPECTOR_PANELS = new Set<string>([
  "changes",
  "files",
  "terminal",
  "tasks",
  "preview",
  "settings",
]);
const COMPOSER_TARGETS = new Set<string>(["focus", "model", "mode", "effort"]);

export function parseDesktopCommand(value: unknown): DesktopCommand | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const { command } = raw;
  if (
    command === "palette" ||
    command === "toggle-sidebar" ||
    command === "workspace"
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
