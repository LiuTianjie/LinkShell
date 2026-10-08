import Storage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";

export const TERMINAL_FONT_MIN = 6;
export const TERMINAL_FONT_MAX = 32;
export const TERMINAL_FONT_DEFAULT = 9;
const FONT_KEY = "terminal.font-size";
const listeners = new Set<() => void>();
export function terminalFontSize(value: number): number {
  return Number.isFinite(value) ? Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(value))) : TERMINAL_FONT_DEFAULT;
}
let current = TERMINAL_FONT_DEFAULT;
try {
  const stored = Storage.getItemSync(FONT_KEY);
  if (stored !== null) current = terminalFontSize(Number(stored));
} catch { /* A missing preference must not prevent opening a terminal. */ }

export function setTerminalFontSize(value: number): void {
  const size = terminalFontSize(value);
  if (size === current) return;
  current = size;
  try { Storage.setItemSync(FONT_KEY, String(size)); } catch { /* Keep the selection for this app run. */ }
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => current;
export function useTerminalFontSize(): number { return useSyncExternalStore(subscribe, snapshot, snapshot); }
