import type { MachineInfo } from "@linkshell/wire";
import type { Computer, ComputerProfile, SavedComputerProfile } from "./computers";
import type { Locale } from "@linkshell/client-core";

export function reportedComputerProfile(machine: MachineInfo): ComputerProfile {
  return { platform: machine.platform, formFactor: machine.formFactor, hardwareModel: machine.platform === "darwin" ? machine.hardwareModel : undefined };
}

export function computerProfile(computer: Computer, cached?: SavedComputerProfile, machine?: MachineInfo | null): ComputerProfile {
  const peer = computer.kind === "relay" ? computer.machine : undefined;
  const peerId = computer.machine?.id;
  const retained = peerId && cached?.peerId === peerId ? cached : undefined;
  const platform = machine?.platform ?? peer?.platform ?? retained?.platform ?? "";
  if (machine?.locked || (!machine && peer?.locked)) return { platform };
  // Never fill holes in a live report from the previous occupant of a LAN address.
  if (machine) return reportedComputerProfile(machine);
  // Old app versions cached guesses based on names. Only new entries bound to a peer are evidence.
  const verified = retained?.platform === platform ? retained : undefined;
  const formFactor = peer?.formFactor ?? verified?.formFactor;
  return { platform, formFactor, hardwareModel: verified?.formFactor === formFactor ? verified?.hardwareModel : undefined };
}

export function platformLabel(platform: string) {
  return (
    ({ darwin: "macOS", win32: "Windows", linux: "Linux", freebsd: "FreeBSD" } as Record<string, string>)[platform] ??
    platform
  );
}

const chassis = {
  notebook: { zh: "笔记本", en: "Notebook", ja: "ノート" },
  "mac-mini": { zh: "Mac mini", en: "Mac mini", ja: "Mac mini" },
  tower: { zh: "塔式台式机", en: "Tower", ja: "タワー" },
  desktop: { zh: "台式机", en: "Desktop", ja: "デスクトップ" },
  "all-in-one": { zh: "一体机", en: "All-in-one", ja: "一体型" },
};
export function computerDescription(profile: ComputerProfile, locale: Locale, detailed = false): string {
  const model = (detailed ? profile.hardwareModel?.productName : undefined) ?? profile.hardwareModel?.family;
  return [platformLabel(profile.platform), model ?? (profile.formFactor && chassis[profile.formFactor]?.[locale])]
    .filter(Boolean)
    .join(" · ");
}
