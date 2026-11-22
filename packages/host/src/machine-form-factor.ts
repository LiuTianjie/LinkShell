import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { MachineFormFactor, MachineInfo, MacModelFamily } from "@linkshell/wire";

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

type Hardware = Pick<MachineInfo, "formFactor" | "hardwareModel">;
const macEnclosures: Record<MacModelFamily, MachineFormFactor> = {
  "MacBook Pro": "notebook", "MacBook Air": "notebook", MacBook: "notebook", "Mac mini": "mac-mini",
  "Mac Studio": "desktop", "Mac Pro": "desktop", "iMac Pro": "all-in-one", iMac: "all-in-one",
};

/** Accept only system product fields. In particular, Mac15,10 is an opaque ID, not a desktop. */
export function macHardware(product: unknown, modelId?: unknown): Hardware | undefined {
  const name = typeof product === "string" && product.length <= 100 ? product.trim() : "";
  for (const family of Object.keys(macEnclosures) as MacModelFamily[]) {
    const suffix = name.slice(family.length);
    if (name.startsWith(family) && (!suffix || /^ \([^()\r\n]+\)$/.test(suffix))) {
      return { formFactor: macEnclosures[family], hardwareModel: { family, ...(suffix ? { productName: name } : {}) } };
    }
  }
  if (typeof modelId === "string") {
    const prefix = /^([a-z]+)\d+,\d+$/i.exec(modelId)?.[1]?.toLowerCase();
    const family = (Object.keys(macEnclosures) as MacModelFamily[]).find((f) => f.toLowerCase().replaceAll(" ", "") === prefix);
    if (family) return { formFactor: macEnclosures[family], hardwareModel: { family } };
  }
  return undefined;
}

async function detect(): Promise<Hardware> {
  try {
    if (process.platform === "darwin") {
      // Apple silicon publishes the actual product name (often including display size) here.
      const tree = await run("/usr/sbin/ioreg", ["-p", "IODeviceTree", "-r", "-n", "product", "-d", "1"], opts).catch(() => undefined);
      const product = macHardware(/"product-name"\s*=\s*<"([^"\r\n]+)">/.exec(tree?.stdout ?? "")?.[1]);
      if (product) return product;
      const { stdout } = await run("/usr/sbin/system_profiler", ["-json", "SPHardwareDataType"], { ...opts, env: { ...process.env, LC_ALL: "C" } });
      const hw = JSON.parse(stdout).SPHardwareDataType?.[0];
      return macHardware(hw?.machine_name, hw?.machine_model) ?? {};
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
      return { formFactor: enclosureFormFactor(stdout.trim().split(/\s+/).map(Number)) };
    }
    if (process.platform === "linux")
      return { formFactor: enclosureFormFactor([Number((await readFile("/sys/class/dmi/id/chassis_type", "utf8")).trim())]) };
  } catch {
    /* Restricted hosts still serve every RPC without hardware artwork metadata. */
  }
  return {};
}

let cached: ReturnType<typeof detect> | undefined;
export const readMachineHardware = () => (cached ??= detect());
