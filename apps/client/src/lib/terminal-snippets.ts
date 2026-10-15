import Storage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";

export interface TerminalSnippet {
  id: string;
  label: string;
  command: string;
  /** When true, appends `\r` so the shell executes the command immediately. */
  autoEnter: boolean;
}

export const DEFAULT_TERMINAL_SNIPPETS: TerminalSnippet[] = [
  { id: "git-status", label: "git status", command: "git status", autoEnter: true },
  { id: "git-diff", label: "git diff", command: "git diff", autoEnter: true },
  { id: "tmux", label: "tmux", command: "tmux attach || tmux", autoEnter: true },
  { id: "pnpm-test", label: "pnpm test", command: "pnpm test", autoEnter: true },
  { id: "yes", label: "y ↵", command: "y", autoEnter: true },
  { id: "clear", label: "清屏 ^L", command: "\x0c", autoEnter: false },
  { id: "eof", label: "^D", command: "\x04", autoEnter: false },
  { id: "suspend", label: "^Z", command: "\x1a", autoEnter: false },
];

const SNIPPETS_KEY = "terminal.snippets.v1";
const SNIPPETS_OPEN_KEY = "terminal.snippets-open.v1";
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function parseSnippets(raw: string | null): TerminalSnippet[] {
  if (!raw) return DEFAULT_TERMINAL_SNIPPETS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_TERMINAL_SNIPPETS;
    const valid = parsed.filter(
      (item): item is TerminalSnippet =>
        item &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        typeof item.label === "string" &&
        typeof item.command === "string" &&
        typeof item.autoEnter === "boolean",
    );
    return valid.length > 0 ? valid : DEFAULT_TERMINAL_SNIPPETS;
  } catch {
    return DEFAULT_TERMINAL_SNIPPETS;
  }
}

let currentSnippets: TerminalSnippet[] = DEFAULT_TERMINAL_SNIPPETS;
let currentOpen = true;

try {
  currentSnippets = parseSnippets(Storage.getItemSync(SNIPPETS_KEY));
  const storedOpen = Storage.getItemSync(SNIPPETS_OPEN_KEY);
  if (storedOpen !== null) currentOpen = storedOpen === "1";
} catch {
  // Missing storage must never block opening a terminal.
}

function persistSnippets(next: TerminalSnippet[]) {
  currentSnippets = next;
  try {
    Storage.setItemSync(SNIPPETS_KEY, JSON.stringify(next));
  } catch {
    // Keep in memory for this run.
  }
  notify();
}

export function addTerminalSnippet(input: { label?: string; command: string; autoEnter?: boolean }): TerminalSnippet {
  const command = input.command.trim();
  const label = (input.label?.trim() || command).slice(0, 24);
  const entry: TerminalSnippet = {
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label,
    command,
    autoEnter: input.autoEnter ?? true,
  };
  persistSnippets([...currentSnippets, entry]);
  return entry;
}

export function removeTerminalSnippet(id: string): void {
  const next = currentSnippets.filter((item) => item.id !== id);
  persistSnippets(next.length > 0 ? next : DEFAULT_TERMINAL_SNIPPETS);
}

export function resetTerminalSnippets(): void {
  persistSnippets(DEFAULT_TERMINAL_SNIPPETS);
}

export function setTerminalSnippetsOpen(open: boolean): void {
  if (currentOpen === open) return;
  currentOpen = open;
  try {
    Storage.setItemSync(SNIPPETS_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Keep in memory for this run.
  }
  notify();
}

export function toggleTerminalSnippetsOpen(): void {
  setTerminalSnippetsOpen(!currentOpen);
}

/** Step count for a swipe gesture delta along an axis (1 key per `stepPx`). */
export function swipeKeySteps(deltaPx: number, stepPx = 18): number {
  if (!Number.isFinite(deltaPx) || stepPx <= 0) return 0;
  return Math.trunc(deltaPx / stepPx);
}

const getSnippetsSnapshot = () => currentSnippets;
const getOpenSnapshot = () => currentOpen;

export function useTerminalSnippets(): TerminalSnippet[] {
  return useSyncExternalStore(subscribe, getSnippetsSnapshot, getSnippetsSnapshot);
}

export function useTerminalSnippetsOpen(): boolean {
  return useSyncExternalStore(subscribe, getOpenSnapshot, getOpenSnapshot);
}
