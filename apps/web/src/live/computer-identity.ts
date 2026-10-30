import type { Computer } from "./engine";

/** The local RPC machine UUID and the gateway's signing identity are different namespaces. */
export function computerAtKey(computers: Computer[], key: string, knownLocal?: Computer): Computer | undefined {
  const exact = computers.find((computer) => computer.key === key);
  if (exact) return exact;
  const local = knownLocal ?? computers.find((computer) => computer.key === "desktop:local");
  if (!local?.relayId || (key !== local.key && !key.endsWith(`#${local.relayId}`))) return undefined;
  return computers.find((computer) => computer.key === local.key || computer.machine.id === local.relayId);
}

export function deduplicateLocalComputer(computers: Computer[]): Computer[] {
  const local = computers.find((computer) => computer.key === "desktop:local");
  if (!local?.relayId) return computers;
  const preferred = local.machine.online ? local : computers.find((computer) => computer !== local && computer.machine.id === local.relayId && computer.machine.online) ?? local;
  return computers.filter((computer) => computer === preferred || (computer !== local && computer.machine.id !== local.relayId));
}
