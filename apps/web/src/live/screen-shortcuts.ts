import type { Modifier, ScreenPlatform } from "./screen-input";

/**
 * Keys a window can't pass on, because this computer's own system takes them first (⌘Tab, ⌘Space,
 * Mission Control, the screenshot keys), and keys that are a slip away from losing work: one click
 * each, by what they are for. The same set the phone's viewer offers (screen-viewer.ts QUICK).
 */
export interface RemoteShortcut { name: string; key: string; modifiers: Modifier[]; careful?: boolean }
export interface RemoteShortcutGroup { title: string; items: RemoteShortcut[] }

const item = (name: string, key: string, modifiers: string, careful = false): RemoteShortcut =>
  ({ name, key, modifiers: modifiers ? modifiers.split(" ") as Modifier[] : [], careful });

const MAC: RemoteShortcutGroup[] = [
  { title: "系统", items: [
    item("切换应用", "tab", "cmd"), item("聚焦搜索", "space", "cmd"), item("调度中心", "up", "ctrl"), item("应用窗口", "down", "ctrl"),
    item("左边桌面", "left", "ctrl"), item("右边桌面", "right", "ctrl"), item("切换输入法", "space", "ctrl"),
  ] },
  { title: "截图", items: [item("截取部分", "4", "shift cmd"), item("截图工具", "5", "shift cmd")] },
  { title: "应用", items: [
    item("同应用窗口", "`", "cmd"), item("最小化", "m", "cmd"), item("隐藏应用", "h", "cmd"),
    item("退出应用", "q", "cmd", true), item("强制退出", "escape", "alt cmd", true), item("锁定屏幕", "q", "ctrl cmd", true),
  ] },
];

const WINDOWS: RemoteShortcutGroup[] = [
  { title: "系统", items: [
    item("开始菜单", "escape", "ctrl"), item("切换应用", "tab", "alt"), item("显示桌面", "d", "cmd"), item("任务视图", "tab", "cmd"),
    item("切换输入法", "space", "cmd"), item("任务管理器", "escape", "ctrl shift"),
  ] },
  { title: "截图", items: [item("截图工具", "s", "shift cmd")] },
  { title: "应用", items: [item("关闭窗口", "f4", "alt", true), item("锁定屏幕", "l", "cmd", true)] },
];

export function remoteShortcuts(platform: ScreenPlatform): RemoteShortcutGroup[] {
  return platform === "windows" ? WINDOWS : MAC;
}

const MAC_SIGNS: Record<Modifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const WINDOWS_SIGNS: Record<Modifier, string> = { ctrl: "Ctrl+", alt: "Alt+", shift: "Shift+", cmd: "Win+" };
const KEY_SIGNS: Record<string, string> = {
  return: "↩", tab: "Tab", space: "Space", backspace: "⌫", escape: "Esc", left: "←", right: "→", up: "↑", down: "↓", delete: "⌦",
};
const ORDER: Modifier[] = ["ctrl", "alt", "shift", "cmd"];

/** How the computer's own keyboard writes a shortcut: ⌥⌘Esc on a Mac, Ctrl+Shift+Esc on Windows. */
export function shortcutSign(shortcut: Pick<RemoteShortcut, "key" | "modifiers">, platform: ScreenPlatform): string {
  const signs = platform === "windows" ? WINDOWS_SIGNS : MAC_SIGNS;
  const key = KEY_SIGNS[shortcut.key] ?? (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key.toUpperCase());
  return ORDER.filter((name) => shortcut.modifiers.includes(name)).map((name) => signs[name]).join("") + key;
}
