import { useEffect, useRef } from "react";
import { isWindowsDesktop } from "./desktop";
import { parseManagePage, type ManagePage } from "./management-model";

/** Commands that cross components: the shell, the open session and LinkShell.app's top bar all send them. */
export const DESKTOP_COMMAND_EVENT = "linkshell-desktop-command";

export type InspectorPanel = "changes" | "files" | "terminal" | "tasks" | "preview" | "settings";
export type DesktopCommand =
  | { command: "palette" }
  | { command: "new-session"; cwd?: string }
  | { command: "toggle-sidebar" }
  | { command: "inspector"; panel?: InspectorPanel }
  | { command: "manage"; page?: ManagePage }
  | { command: "workspace" };

const inspectorPanels: readonly string[] = ["changes", "files", "terminal", "tasks", "preview", "settings"];

/** The native bridge sends untyped JSON; only these shapes are acted on. */
export function desktopCommand(value: unknown): DesktopCommand | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { command, cwd, panel, page } = value as Record<string, unknown>;
  if (command === "palette" || command === "toggle-sidebar" || command === "workspace") return { command };
  if (command === "manage") {
    // The menu bar names pages by their title ("更新"); an unknown page opens the overview.
    const known = parseManagePage(page);
    return known ? { command, page: known } : { command };
  }
  if (command === "new-session")
    return typeof cwd === "string" && cwd ? { command, cwd } : { command };
  if (command === "inspector")
    return typeof panel === "string" && inspectorPanels.includes(panel)
      ? { command, panel: panel as InspectorPanel }
      : { command };
  return undefined;
}

export function sendDesktopCommand(command: DesktopCommand): void {
  window.dispatchEvent(new CustomEvent(DESKTOP_COMMAND_EVENT, { detail: command }));
}

/**
 * A new session asked for while no workspace that opens one is showing (本机管理, the remote
 * screen): nobody hears it there, so it waits for the workspace to mount and open its page.
 */
let deferredNewSession: { cwd?: string } | undefined;
let newSessionTargets = 0;
export function deferNewSession(cwd?: string): void { deferredNewSession = { cwd }; }
/** Whether a mounted workspace opens new sessions itself. */
export const opensNewSessions = () => newSessionTargets > 0;
/** The workspace that opens the new-session page says so while it is mounted. */
export function useNewSessionTarget(): void {
  useEffect(() => {
    newSessionTargets++;
    return () => { newSessionTargets--; };
  }, []);
}
export function takeDeferredNewSession(): { cwd?: string } | undefined {
  const waiting = deferredNewSession;
  deferredNewSession = undefined;
  return waiting;
}

export function useDesktopCommand(handle: (command: DesktopCommand) => void): void {
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => {
    const receive = (event: Event) => {
      const command = desktopCommand((event as CustomEvent).detail);
      if (command) latest.current(command);
    };
    window.addEventListener(DESKTOP_COMMAND_EVENT, receive);
    return () => window.removeEventListener(DESKTOP_COMMAND_EVENT, receive);
  }, []);
}

/** One table for every workspace shortcut: the handlers, the palette and the shortcut sheet read it. */
export const desktopShortcuts = {
  palette: { key: "k", label: "搜索与命令" },
  newSession: { key: "n", label: "新建会话" },
  toggleSidebar: { key: "b", label: "显示或隐藏侧栏" },
  toggleInspector: { key: "b", alt: true, label: "显示或隐藏检查器" },
  terminal: { key: "j", label: "打开终端" },
  back: { key: "[", label: "后退" },
  forward: { key: "]", label: "前进" },
  previousSession: { key: "[", shift: true, label: "上一个会话" },
  nextSession: { key: "]", shift: true, label: "下一个会话" },
} as const;
export type DesktopShortcut = (typeof desktopShortcuts)[keyof typeof desktopShortcuts];
/** The window's two views. Kept apart from the table: the shortcut sheet lists them on their own. */
export const desktopModeShortcuts = {
  workspace: { key: "1", label: "工作台" },
  manage: { key: "2", label: "本机管理" },
} as const;

/** ⌘ on the Mac, Ctrl on Windows. */
export function shortcutText(shortcut: { key: string; alt?: boolean; shift?: boolean }): string {
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  if (isWindowsDesktop)
    return ["Ctrl", shortcut.shift && "Shift", shortcut.alt && "Alt", key].filter(Boolean).join("+");
  return `${shortcut.shift ? "⇧" : ""}${shortcut.alt ? "⌥" : ""}⌘${key}`;
}

export function matchesShortcut(event: KeyboardEvent, shortcut: { key: string; alt?: boolean; shift?: boolean }): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  const mod = isWindowsDesktop ? event.ctrlKey && !event.metaKey : event.metaKey && !event.ctrlKey;
  if (!mod || event.altKey !== !!shortcut.alt || event.shiftKey !== !!shortcut.shift) return false;
  // ⌥ and ⇧ change event.key ("∫", "{"); the physical key still names the shortcut.
  const code = event.code;
  const physical = code.startsWith("Key") ? code.slice(3).toLowerCase()
    : code === "BracketLeft" ? "[" : code === "BracketRight" ? "]" : event.key.toLowerCase();
  return physical === shortcut.key;
}

/** While a remote screen or a focused preview has the keys, they belong to that computer. */
export function keysBelongToContent(): boolean {
  return !!(document.fullscreenElement || document.querySelector(".screen-focused, .port-preview-focused"));
}
