import { execFile } from "node:child_process";

// AWDL can share the radio with Wi-Fi. A channel alone cannot diagnose periodic stutter;
// offer a comparison the user can make rather than claiming a particular channel fixes it.

const AWDL_CHANNELS = new Set([149, 44]);

export interface WifiCheck {
  ok: boolean;
  detail: string;
}

/** The verdict for `system_profiler SPAirPortDataType -json`; undefined when no Wi-Fi network is joined. */
export function judgeWifi(report: unknown): WifiCheck | undefined {
  const interfaces = (report as { SPAirPortDataType?: { spairport_airport_interfaces?: unknown[] }[] })
    ?.SPAirPortDataType?.[0]?.spairport_airport_interfaces;
  if (!Array.isArray(interfaces)) return undefined;
  for (const entry of interfaces) {
    const channel = (entry as { spairport_current_network_information?: { spairport_network_channel?: unknown } })
      ?.spairport_current_network_information?.spairport_network_channel;
    if (typeof channel !== "string") continue;
    const number = Number.parseInt(channel, 10);
    if (!Number.isFinite(number)) continue;
    if (/6\s*GHz/i.test(channel)) return { ok: true, detail: `channel ${channel}` };
    const band = /2\.4\s*GHz/i.test(channel) || number <= 14 ? "2.4" : "5";
    if (band === "5" && AWDL_CHANNELS.has(number)) return { ok: true, detail: `channel ${channel}` };
    const advice = band === "2.4"
      ? "if the screen stutters periodically, compare Ethernet or a 5 GHz network on channel 149 where available"
      : "if the screen stutters periodically, compare Ethernet or the router's 5 GHz channel 149 where available";
    // A warning, not a failure: everything works, only the screen's smoothness suffers.
    return { ok: true, detail: `channel ${channel} — ${advice}` };
  }
  return undefined;
}

/** This Mac's Wi-Fi, for `doctor`; undefined off a Mac, without Wi-Fi, or when it can't be read. */
export function checkWifi(): Promise<WifiCheck | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile("/usr/sbin/system_profiler", ["SPAirPortDataType", "-json"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(undefined);
      try { resolve(judgeWifi(JSON.parse(stdout))); } catch { resolve(undefined); }
    });
  });
}
