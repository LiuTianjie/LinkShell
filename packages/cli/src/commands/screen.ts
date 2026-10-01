import { ensureHostRunning, hostRuntimeOk, withRunningHost } from "./host.js";

// `linkshell screen`: makes this computer's screen watchable and controllable
// from the phone. On a Mac that is two permissions the system gives to an app
// by name, and nobody finds the two switches on their own: this checks what is
// there, has the system ask for what is missing, and waits for each switch.

export interface ScreenAccess {
  supported: boolean;
  ffmpeg: boolean;
  recording: boolean | null;
  control: boolean | null;
  app?: string;
  problem?: string;
}

const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

/** What the running host says; "old" for a host from before it could say, undefined for none. */
export async function screenAccess(ask = false): Promise<ScreenAccess | "old" | undefined> {
  return withRunningHost(async (client) => {
    try {
      return await client.call("screen.access", { ask }, 30_000);
    } catch (error) {
      if (/method not found|unknown method|screen\.access/i.test((error as Error).message)) return "old" as const;
      throw error;
    }
  });
}

export function screenReady(access: ScreenAccess): boolean {
  if (!access.supported || !access.ffmpeg) return false;
  return process.platform !== "darwin" || (access.recording === true && access.control === true);
}

/** One line for `status`, `doctor` and the host's start: what works, and the command for the rest. */
export function describeScreen(access: ScreenAccess | "old" | undefined): string | undefined {
  if (!access) return undefined;
  if (access === "old") return "restart the host to check (linkshell host stop && linkshell host --daemon)";
  if (!access.supported) return "not available on this system";
  if (!access.ffmpeg) return `needs ffmpeg (${process.platform === "darwin" ? "brew install ffmpeg" : "install it with your package manager"})`;
  if (process.platform !== "darwin") return "can be watched (controlling it needs macOS)";
  if (access.recording === null || access.control === null) return `can't tell${access.problem ? `: ${access.problem}` : ""}`;
  if (access.recording && access.control) return "can be watched and controlled from the phone";
  const missing = [!access.recording && "watching", !access.control && "controlling"].filter(Boolean).join(" and ");
  return `${missing} isn't allowed yet — set it up with: linkshell screen`;
}

const PERMISSIONS = {
  recording: {
    label: "Watching the screen",
    where: "Screen & System Audio Recording (录屏与系统录音)",
  },
  control: {
    label: "Controlling it",
    where: "Accessibility (辅助功能)",
  },
} as const;

export async function runScreenSetup(options: { check?: boolean }): Promise<void> {
  const out = (line = "") => process.stdout.write(`${line}\n`);
  const row = (ok: boolean, label: string, detail: string) => out(`  ${ok ? green("✓") : red("✗")} ${label.padEnd(22)} ${detail}`);
  out("\n  LinkShell screen\n");
  if (!hostRuntimeOk()) {
    row(false, "Host", `needs Node.js 22.13 or newer (this is ${process.version})`);
    process.exitCode = 1;
    return;
  }
  if (!options.check) await ensureHostRunning();
  let access = await screenAccess();
  if (!access) {
    row(false, "Host", "not running — start it with: linkshell host --daemon");
    process.exitCode = 1;
    return;
  }
  if (access === "old") {
    row(false, "Host", "is older than this CLI — restart it (stops running agent turns):");
    out("      linkshell host stop && linkshell host --daemon\n");
    process.exitCode = 1;
    return;
  }
  if (!access.supported) {
    row(false, "Screen", "not available on this system");
    process.exitCode = 1;
    return;
  }
  row(access.ffmpeg, "ffmpeg", access.ffmpeg ? "found" : `not installed — ${process.platform === "darwin" ? "brew install ffmpeg" : "install it with your package manager"}, then run this again`);
  if (process.platform !== "darwin") {
    out(`\n  ${access.ffmpeg ? "The screen can be watched from the phone." : ""} Controlling it needs macOS.\n`);
    if (!access.ffmpeg) process.exitCode = 1;
    return;
  }
  if (access.recording === null || access.control === null) {
    row(false, "Permissions", access.problem ?? "could not be checked");
    process.exitCode = 1;
    return;
  }

  const app = access.app || "LinkShell";
  const interactive = !options.check && process.stdin.isTTY === true;
  for (const kind of ["recording", "control"] as const) {
    const permission = PERMISSIONS[kind];
    if (access[kind]) {
      row(true, permission.label, "allowed");
      continue;
    }
    if (!interactive) {
      row(false, permission.label, "not allowed yet");
      continue;
    }
    // The system's own question comes up on this computer, and its settings open at the switch.
    await screenAccess(true);
    out(`  ${red("✗")} ${permission.label.padEnd(22)} not allowed yet`);
    out(`      System Settings has opened at Privacy & Security › ${permission.where}.`);
    out(`      Turn on the switch for "${app}" there.${kind === "recording" ? " If macOS offers to quit and reopen it, later is fine." : ""}`);
    out(dim("      Waiting for the switch… (Ctrl+C to stop; run this again any time)"));
    const deadline = Date.now() + 10 * 60_000;
    let allowed = false;
    while (!allowed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const now = await screenAccess().catch(() => undefined);
      if (now && now !== "old") {
        access = now;
        allowed = now[kind] === true;
      }
    }
    if (!allowed) {
      out(`\n  Still not allowed. Run ${"`linkshell screen`"} again when you are at the switch.\n`);
      process.exitCode = 1;
      return;
    }
    row(true, permission.label, "allowed");
  }

  if (screenReady(access)) {
    out(`\n  ${green("Ready.")} In the app: 电脑 › 屏幕. To take the pointer and keyboard, pick 触控板 or 点按 in the viewer's toolbar.\n`);
  } else {
    out(`\n  Not ready yet${access.ffmpeg ? "" : ": install ffmpeg"}${interactive ? "" : "; run `linkshell screen` in a terminal to set it up"}.\n`);
    process.exitCode = 1;
  }
}
