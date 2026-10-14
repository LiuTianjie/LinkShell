import { createStore } from "zustand/vanilla";
import type { Computer } from "./engine";
import { readLocal, saveLocal } from "./storage";

export type ComputerNames = Record<string, string>;
export const COMPUTER_NAME_LIMIT = 40;

export function parseComputerNames(value: unknown): ComputerNames {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, name]) =>
        typeof name === "string" &&
        name.trim().length > 0 &&
        name.length <= COMPUTER_NAME_LIMIT,
    ),
  );
}

export function computerName(computer: Computer, names: ComputerNames): string {
  return names[computer.key] || computer.machine.name;
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
  return {
    store,
    rename(computer: Computer, value: string) {
      const name = value.trim();
      if (name.length > COMPUTER_NAME_LIMIT)
        throw new Error(`名称不能超过 ${COMPUTER_NAME_LIMIT} 个字符`);
      // Re-read so another tab's edits are retained; names never modify peer identities.
      const next = parseComputerNames(readLocal<unknown>("computer-names", {}));
      if (name) next[computer.key] = name;
      else delete next[computer.key];
      try {
        saveLocal("computer-names", next);
      } catch {
        throw new Error("名称未保存，请允许此网站使用本地存储后重试。");
      }
      store.setState(next, true);
    },
  };
}

export const computerNames = createComputerNames();
if (typeof window !== "undefined") {
  const sync = (event: StorageEvent) => {
    if (event.key === null || event.key === "linkshell.web.computer-names") {
      computerNames.store.setState(
        parseComputerNames(readLocal<unknown>("computer-names", {})),
        true,
      );
    }
  };
  window.addEventListener("storage", sync);
  if (import.meta.hot)
    import.meta.hot.dispose(() => window.removeEventListener("storage", sync));
}
