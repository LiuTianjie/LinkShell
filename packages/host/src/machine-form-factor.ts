import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { MachineFormFactor } from "@linkshell/wire";

const run = promisify(execFile);
const opts = { timeout: 2_500, maxBuffer: 128 * 1024, windowsHide: true, encoding: "utf8" as const };

/** SMBIOS enclosure types. Not every PC is a tower; a tablet, dock or unknown code proves nothing. */
export function enclosureFormFactor(values: readonly number[]): MachineFormFactor | undefined {
  if (values.some((n) => [8, 9, 10, 14, 31, 32].includes(n))) return "notebook";
  if (values.includes(13)) return "all-in-one";
  if (values.some((n) => n === 6 || n === 7)) return "tower";
  if (values.some((n) => [3, 4, 5, 15, 16, 24, 35, 36].includes(n))) return "desktop";
  return undefined;
}

export function macFormFactor(model: string): MachineFormFactor | undefined {
  if (/^MacBook/i.test(model)) return "notebook";
  if (/^Mac mini/i.test(model)) return "mac-mini";
  if (/^iMac/i.test(model)) return "all-in-one";
  if (/^Mac (Studio|Pro)/i.test(model)) return "desktop";
  return undefined;
}

async function detect(): Promise<MachineFormFactor | undefined> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await run("/usr/sbin/system_profiler", ["-json", "SPHardwareDataType"], opts);
      const model: unknown = JSON.parse(stdout).SPHardwareDataType?.[0]?.machine_name;
      return typeof model === "string" ? macFormFactor(model) : undefined;
    }
    if (process.platform === "win32") {
      const { stdout } = await run(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_SystemEnclosure -Property ChassisTypes | Select-Object -ExpandProperty ChassisTypes",
        ],
        opts,
      );
      return enclosureFormFactor(stdout.trim().split(/\s+/).map(Number));
    }
    if (process.platform === "linux")
      return enclosureFormFactor([Number((await readFile("/sys/class/dmi/id/chassis_type", "utf8")).trim())]);
  } catch {
    /* Restricted hosts still serve every RPC without hardware artwork metadata. */
  }
  return undefined;
}

let cached: ReturnType<typeof detect> | undefined;
export const readMachineFormFactor = () => (cached ??= detect());
