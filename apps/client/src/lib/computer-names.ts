import Storage from "expo-sqlite/kv-store";
import { create } from "zustand";
import type { HostLink } from "@linkshell/client-core";
import type { MachineInfo } from "@linkshell/wire";
import { updateComputerName, useComputers, type Computer } from "./computers";

const KEY = "computers.names.v1";
export const COMPUTER_NAME_LIMIT = 40;
export type ComputerNames = Record<string, string>;
const sharedKey = (key: string) => `@shared:${key}`;

function load(): ComputerNames {
  try {
    const value: unknown = JSON.parse(Storage.getItemSync(KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, name]) =>
      typeof name === "string" && name.trim().length > 0 && name.length <= (key.startsWith("@shared:") ? 120 : COMPUTER_NAME_LIMIT)));
  } catch { return {}; }
}

export const useComputerNames = create<{ names: ComputerNames }>(() => ({ names: load() }));

export function computerDisplayName(computer: Computer, names: ComputerNames): string {
  const shared = computer.kind === "relay" && computer.machine.namingConfigured ? computer.machine.name : names[sharedKey(computer.key)];
  return shared || names[computer.key] || (computer.kind === "relay" ? computer.machine.name : computer.name).replace(/\.local$/, "") || "电脑";
}

function rememberSharedName(key: string, name: string): void {
  const current = useComputerNames.getState().names;
  if (current[sharedKey(key)] === name && !current[key]) return;
  const names = { ...current, [sharedKey(key)]: name };
  delete names[key];
  try { Storage.setItemSync(KEY, JSON.stringify(names)); } catch { /* The host remains authoritative. */ }
  useComputerNames.setState({ names });
}

export function syncComputerName(computer: Computer, machine: MachineInfo): void {
  if (!machine.naming) return;
  if (machine.naming.configured) rememberSharedName(computer.key, machine.hostname);
  updateComputerName(computer, machine.hostname, machine.naming.configured);
}

export async function renameComputer(computer: Computer, value: string, link: Pick<HostLink, "call">): Promise<MachineInfo> {
  const name = value.trim();
  if (name.length > COMPUTER_NAME_LIMIT) throw new Error(`名称不能超过 ${COMPUTER_NAME_LIMIT} 个字符`);
  const machine = await link.call("machine.rename", { name });
  syncComputerName(computer, machine);
  return machine;
}

// Learn shared names even for a computer whose conversation is not currently open.
useComputers.subscribe((state, previous) => {
  if (state.live === previous.live) return;
  for (const [gateway, machines] of Object.entries(state.live)) {
    for (const machine of machines) if (machine.namingConfigured) rememberSharedName(`${gateway}#${machine.id}`, machine.name);
  }
});
