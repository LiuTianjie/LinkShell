import type { MachineInfo } from "@linkshell/wire";
import type { Computer, ComputerProfile } from "./computers";
import type { Locale } from "@linkshell/client-core";

function legacyMacHint(platform: string, defaultName?: string) {
  if (platform !== "darwin" || !defaultName) return undefined;
  if (/mac[\s_-]*mini/i.test(defaultName)) return "mac-mini" as const;
  if (/macbook/i.test(defaultName)) return "notebook" as const;
  return undefined;
}

export function reportedComputerProfile(machine: MachineInfo): ComputerProfile {
  return {
    platform: machine.platform,
    formFactor: machine.formFactor ?? legacyMacHint(machine.platform, machine.naming?.defaultName),
  };
}

export function computerProfile(
  computer: Computer,
  cached?: ComputerProfile,
  machine?: MachineInfo | null,
): ComputerProfile {
  const peer = computer.kind === "relay" ? computer.machine : undefined;
  const platform = machine?.platform ?? peer?.platform ?? cached?.platform ?? "";
  // A live host wins over data cached for a LAN address another machine may have inherited.
  const known =
    machine && !machine.locked
      ? reportedComputerProfile(machine).formFactor
      : cached?.platform === platform
        ? cached.formFactor
        : undefined;
  return {
    platform,
    formFactor:
      machine?.formFactor ??
      peer?.formFactor ??
      known ??
      legacyMacHint(platform, peer?.namingConfigured === false ? peer.name : undefined),
  };
}

export function platformLabel(platform: string) {
  return (
    ({ darwin: "macOS", win32: "Windows", linux: "Linux", freebsd: "FreeBSD" } as Record<string, string>)[platform] ??
    platform
  );
}

const chassis = {
  notebook: { zh: "笔记本", en: "Notebook", ja: "ノート" },
  "mac-mini": { zh: "迷你主机", en: "Mac mini", ja: "ミニデスクトップ" },
  tower: { zh: "塔式台式机", en: "Tower", ja: "タワー" },
  desktop: { zh: "台式机", en: "Desktop", ja: "デスクトップ" },
  "all-in-one": { zh: "一体机", en: "All-in-one", ja: "一体型" },
};
export function computerDescription(profile: ComputerProfile, locale: Locale): string {
  return [platformLabel(profile.platform), profile.formFactor && chassis[profile.formFactor]?.[locale]]
    .filter(Boolean)
    .join(" · ");
}
