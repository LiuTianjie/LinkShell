import { useEffect, useRef } from "react";

/** Commands that cross workspace components: the shell, command palette, composer, and session inspector. */
export const WORKSPACE_COMMAND_EVENT = "linkshell-workspace-command";

export type InspectorPanel = "changes" | "files" | "terminal" | "tasks" | "preview" | "settings";
export type ComposerShortcutTarget = "focus" | "model" | "mode" | "effort";
export type WorkspaceCommand =
  | { command: "palette" }
  | { command: "new-session"; cwd?: string }
  | { command: "inspector"; panel?: InspectorPanel }
  | { command: "composer"; target: ComposerShortcutTarget };

const inspectorPanels: readonly string[] = ["changes", "files", "terminal", "tasks", "preview", "settings"];
const composerTargets: readonly string[] = ["focus", "model", "mode", "effort"];

export function workspaceCommand(value: unknown): WorkspaceCommand | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { command, cwd, panel, target } = value as Record<string, unknown>;
  if (command === "palette") return { command };
  if (command === "new-session")
    return typeof cwd === "string" && cwd ? { command, cwd } : { command };
  if (command === "inspector")
    return typeof panel === "string" && inspectorPanels.includes(panel)
      ? { command, panel: panel as InspectorPanel }
      : { command };
  if (command === "composer" && typeof target === "string" && composerTargets.includes(target))
    return { command, target: target as ComposerShortcutTarget };
  return undefined;
}

export function sendWorkspaceCommand(command: WorkspaceCommand): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_COMMAND_EVENT, { detail: command }));
}

export function attachWorkspaceCommandListener(handle: (command: WorkspaceCommand) => void): () => void {
  const receive = (event: Event) => {
    const command = workspaceCommand((event as CustomEvent).detail);
    if (command) handle(command);
  };
  window.addEventListener(WORKSPACE_COMMAND_EVENT, receive);
  return () => window.removeEventListener(WORKSPACE_COMMAND_EVENT, receive);
}

export function useWorkspaceCommand(handle: (command: WorkspaceCommand) => void): void {
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => attachWorkspaceCommandListener((command) => latest.current(command)), []);
}

export interface ShortcutBinding {
  key: string;
  label: string;
  alt?: boolean;
  shift?: boolean;
  /** Defaults to true (⌘ on Apple devices, Ctrl elsewhere); false matches chords without ⌘/Ctrl such as ⇧Tab. */
  mod?: boolean;
}

export const workspaceShortcuts = {
  palette: { key: "k", label: "搜索与命令" },
  newSession: { key: "n", label: "新建会话" },
  focusComposer: { key: "l", label: "聚焦输入框" },
  modelPicker: { key: "m", shift: true, label: "选择模型" },
  modePicker: { key: "a", shift: true, label: "切换模式与计划" },
  effortPicker: { key: "e", shift: true, label: "调整推理强度" },
  toggleInspector: { key: "b", alt: true, label: "显示或隐藏检查器" },
  terminal: { key: "j", label: "打开终端" },
} as const satisfies Record<string, ShortcutBinding>;
export type WorkspaceShortcut = (typeof workspaceShortcuts)[keyof typeof workspaceShortcuts];

/** Alternate chord for toggling permission/plan mode inside the composer, matching CLI muscle memory. */
export const shiftTabShortcut: ShortcutBinding = {
  key: "tab",
  shift: true,
  mod: false,
  label: "切换模式与计划（输入框）",
};

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

/** ⌘ on Apple browsers, Ctrl elsewhere. */
export function shortcutText(shortcut: { key: string; alt?: boolean; shift?: boolean; mod?: boolean }): string {
  const key = shortcut.key === "tab" ? "Tab" : shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  const usesMod = shortcut.mod !== false;
  if (!isApplePlatform())
    return [usesMod && "Ctrl", shortcut.shift && "Shift", shortcut.alt && "Alt", key].filter(Boolean).join("+");
  return `${shortcut.shift ? "⇧" : ""}${shortcut.alt ? "⌥" : ""}${usesMod ? "⌘" : ""}${key}`;
}

export function matchesShortcut(event: KeyboardEvent, shortcut: { key: string; alt?: boolean; shift?: boolean; mod?: boolean }): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  const usesMod = shortcut.mod !== false;
  const mod = usesMod
    ? (isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
    : (!event.metaKey && !event.ctrlKey);
  if (!mod || event.altKey !== !!shortcut.alt || event.shiftKey !== !!shortcut.shift) return false;
  // ⌥ and ⇧ change event.key ("∫", "{"); the physical key still names the shortcut.
  const code = event.code;
  const physical = code.startsWith("Key") ? code.slice(3).toLowerCase()
    : code === "BracketLeft" ? "["
    : code === "BracketRight" ? "]"
    : code === "Comma" ? ","
    : code === "Tab" ? "tab"
    : event.key.toLowerCase();
  return physical === shortcut.key;
}

/** While a remote screen or a focused preview has the keys, they belong to that computer. */
export function keysBelongToContent(): boolean {
  return !!(document.fullscreenElement || document.documentElement.hasAttribute("data-remote-keys")
    || document.querySelector(".screen-focused, .port-preview-focused, .remote-screen-fullscreen"));
}
