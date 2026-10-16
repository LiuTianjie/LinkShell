import Storage from "expo-sqlite/kv-store";
import { create } from "zustand";
import type { Computer } from "./computers";

const KEY = "computers.names.v1";
export const COMPUTER_NAME_LIMIT = 40;
export type ComputerNames = Record<string, string>;

function load(): ComputerNames {
  try {
    const value: unknown = JSON.parse(Storage.getItemSync(KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, name]) =>
      typeof name === "string" && name.trim().length > 0 && name.length <= COMPUTER_NAME_LIMIT));
  } catch { return {}; }
}

export const useComputerNames = create<{ names: ComputerNames }>(() => ({ names: load() }));

export function computerDisplayName(computer: Computer, names: ComputerNames): string {
  return names[computer.key] || (computer.kind === "relay" ? computer.machine.name : computer.name).replace(/\.local$/, "") || "电脑";
}

/** Phone-local aliases never change a peer identity or restart its connection. */
export function renameComputer(key: string, value: string): void {
  const name = value.trim();
  if (name.length > COMPUTER_NAME_LIMIT) throw new Error(`名称不能超过 ${COMPUTER_NAME_LIMIT} 个字符`);
  const names = { ...useComputerNames.getState().names };
  if (name) names[key] = name;
  else delete names[key];
  try { Storage.setItemSync(KEY, JSON.stringify(names)); }
  catch { throw new Error("名称未保存，请稍后重试。"); }
  useComputerNames.setState({ names });
}
