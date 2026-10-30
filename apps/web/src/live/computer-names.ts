import { createStore } from "zustand/vanilla";
import type { HostLink } from "@linkshell/client-core";
import type { MachineInfo } from "@linkshell/wire";
import type { Computer } from "./engine";
import { readLocal, saveLocal } from "./storage";

export type ComputerNames = Record<string, string>;
export const COMPUTER_NAME_LIMIT = 40;
const sharedKey = (key: string) => `@shared:${key}`;

export function parseComputerNames(value: unknown): ComputerNames {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, name]) =>
        typeof name === "string" &&
        name.trim().length > 0 &&
        name.length <= (key.startsWith("@shared:") ? 120 : COMPUTER_NAME_LIMIT),
    ),
  );
}

export function computerName(computer: Computer, names: ComputerNames): string {
  // Keep old aliases until somebody explicitly names (or resets) the host. Once
  // shared, a missing capability flag from an older gateway must not revive an alias.
  return (computer.machine.namingConfigured ? computer.machine.name : names[sharedKey(computer.key)]) ||
    names[computer.key] || computer.machine.name || "电脑";
}

export function computerIdentity(computer: Computer): string {
  const platform = (
    { darwin: "macOS", linux: "Linux", win32: "Windows" } as Record<
      string,
      string
    >
  )[computer.machine.platform ?? ""];
  return `${platform || computer.machine.platform || "电脑"} · ${computer.machine.id.slice(0, 8)}`;
}

export function computerOption(
  computer: Computer,
  names: ComputerNames,
): string {
  return `${computerName(computer, names)} · ${computer.machine.id.slice(0, 8)} · ${computer.machine.online ? "在线" : "离线"}`;
}

export function createComputerNames() {
  const store = createStore<ComputerNames>(() =>
    parseComputerNames(readLocal<unknown>("computer-names", {})),
  );
  const pending = new Map<string, { name: string; saved?: string }>();
  const readNames = () => {
    const saved = parseComputerNames(readLocal<unknown>("computer-names", {}));
    const next = { ...saved };
    for (const [key, entry] of pending) {
      const current = saved[sharedKey(key)];
      // Retain a host-confirmed name while storage fails, but let a different
      // shared value written by another tab supersede that unsaved cache.
      if (current !== entry.saved) {
        pending.delete(key);
        continue;
      }
      next[sharedKey(key)] = entry.name;
      delete next[key];
    }
    return { saved, next };
  };
  const remember = (computer: Computer, name: string) => {
    const { saved, next } = readNames();
    if (next[sharedKey(computer.key)] === name && !next[computer.key] && !pending.size) {
      store.setState(next, true);
      return;
    }
    delete next[computer.key];
    next[sharedKey(computer.key)] = name;
    pending.set(computer.key, { name, saved: saved[sharedKey(computer.key)] });
    try {
      saveLocal("computer-names", next);
      pending.clear();
    } catch { /* Keep the confirmed names in memory until a later cache write succeeds. */ }
    store.setState(next, true);
  };
  return {
    store,
    refresh() { store.setState(readNames().next, true); },
    remember(computer: Computer) {
      if (computer.machine.namingConfigured) remember(computer, computer.machine.name);
    },
    sync(computer: Computer, machine: MachineInfo) {
      if (machine.naming?.configured) remember(computer, machine.hostname);
    },
    async rename(computer: Computer, value: string, link: Pick<HostLink, "call">) {
      const name = value.trim();
      if (name.length > COMPUTER_NAME_LIMIT)
        throw new Error(`名称不能超过 ${COMPUTER_NAME_LIMIT} 个字符`);
      const machine = await link.call("machine.rename", { name });
      remember(computer, machine.hostname);
      return machine;
    },
  };
}

export const computerNames = createComputerNames();
if (typeof window !== "undefined") {
  const sync = (event: StorageEvent) => {
    if (event.key === null || event.key === "linkshell.web.computer-names") {
      computerNames.refresh();
    }
  };
  window.addEventListener("storage", sync);
  if (import.meta.hot)
    import.meta.hot.dispose(() => window.removeEventListener("storage", sync));
}
