import { useSyncExternalStore, type HTMLAttributes, type ReactNode } from "react";
import {
  desktopPlatform,
  getActiveDesktopPlatform,
  subscribeDesktopPlatform,
} from "../bridge/desktop-bridge";
import { cn } from "./utils";

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /**
   * Optional platform-agnostic shortcut string (e.g. "Mod+K", "Mod+Shift+M", "Ctrl+`").
   * Automatically formats compact symbols on macOS (`⌘K`) and explicit keycaps on Windows (`Ctrl+K`).
   */
  shortcut?: string;
  children?: ReactNode;
}

export function formatPlatformShortcut(
  shortcut: string,
  platform: "macos" | "windows" | "linux" = getActiveDesktopPlatform(),
): string {
  const parts = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1 && !shortcut.includes("Mod")) {
    return shortcut;
  }

  if (platform === "macos") {
    return parts
      .map((token) => {
        const lower = token.toLowerCase();
        if (lower === "ctrl" || lower === "control") return "⌃";
        if (lower === "alt" || lower === "opt" || lower === "option") return "⌥";
        if (lower === "shift") return "⇧";
        if (lower === "mod" || lower === "cmd" || lower === "meta") return "⌘";
        if (lower === "enter" || lower === "return") return "↵";
        if (lower === "escape" || lower === "esc") return "Esc";
        if (lower === "backspace") return "⌫";
        return token.length === 1 ? token.toUpperCase() : token;
      })
      .join("");
  }

  return parts
    .map((token) => {
      const lower = token.toLowerCase();
      if (lower === "mod" || lower === "cmd" || lower === "ctrl" || lower === "control") {
        return "Ctrl";
      }
      if (lower === "alt" || lower === "opt" || lower === "option") return "Alt";
      if (lower === "shift") return "Shift";
      if (lower === "enter" || lower === "return") return "Enter";
      if (lower === "escape" || lower === "esc") return "Esc";
      return token.length === 1 ? token.toUpperCase() : token;
    })
    .join("+");
}

export function Kbd({ shortcut, children, className, ...props }: KbdProps) {
  const activePlatform = useSyncExternalStore(
    subscribeDesktopPlatform,
    getActiveDesktopPlatform,
    () => desktopPlatform,
  );
  const rendered = shortcut
    ? formatPlatformShortcut(shortcut, activePlatform)
    : children;
  return (
    <kbd className={cn("ls-kbd", className)} {...props}>
      {rendered}
    </kbd>
  );
}
