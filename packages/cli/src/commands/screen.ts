import { ensureHostRunning, hostRuntimeOk, withRunningHost } from "./host.js";

// `linkshell screen`: makes this computer's screen watchable and controllable
// from the phone. On a Mac that is two permissions the system gives to an app
// by name, and nobody finds the two switches on their own: this checks what is
// there, has the system ask for what is missing, and waits for each switch.

export interface ScreenAccess {
  supported: boolean;
  /** Whether what captures the screen is there: LinkShell.app on a Mac (installed with the CLI), ffmpeg on Linux. */
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
  if (!access.supported) return process.platform === "darwin" ? "needs a Mac with Apple silicon" : "not available on this system";
  if (!access.ffmpeg) return process.platform === "darwin" ? MISSING_APP : "needs ffmpeg (install it with your package manager)";
  if (process.platform !== "darwin") return "can be watched (controlling it needs macOS)";
  if (access.recording === null || access.control === null) return `can't tell${access.problem ? `: ${access.problem}` : ""}`;
  if (access.recording && access.control) return "can be watched and controlled from the phone";
  const missing = [!access.recording && "watching", !access.control && "controlling"].filter(Boolean).join(" and ");
  return `${missing} isn't allowed yet — set it up with: linkshell screen`;
}

/** A Mac without LinkShell.app: the optional package that carries it wasn't installed (npm run with --omit=optional, or a failed download). */
const MISSING_APP = "LinkShell.app is missing — reinstall with: npm install -g linkshell-cli";

const PERMISSIONS = {
  recording: "Watching the screen",
  control: "Controlling it",
} as const;

type Print = (line?: string) => void;
const row = (out: Print, ok: boolean, label: string, detail: string) => out(`  ${ok ? green("✓") : red("✗")} ${label.padEnd(22)} ${detail}`);

/**
 * Gets this computer's screen ready for the phone, as far as it can be, saying
 * what it finds. On a Mac the two permissions are LinkShell.app's: its own
 * window comes up on this computer, takes the user to each switch and ticks
 * them off, and this waits beside it. True when everything is in place.
 */
export async function setUpScreen(out: Print, interactive: boolean): Promise<boolean> {
  let access = await screenAccess();
  if (!access) {
    row(out, false, "Host", "not running — start it with: linkshell host --daemon");
    return false;
  }
  if (access === "old") {
    row(out, false, "Host", "is older than this CLI — restart it (stops running agent turns):");
    out("      linkshell host stop && linkshell host --daemon");
    return false;
  }
  if (!access.supported) {
    row(out, false, "Screen", process.platform === "darwin" ? "needs a Mac with Apple silicon" : "not available on this system");
    return false;
  }
  if (process.platform !== "darwin") {
    row(out, access.ffmpeg, "ffmpeg", access.ffmpeg ? "found" : "not installed — install it with your package manager, then run this again");
    if (access.ffmpeg) out(dim("    The screen can be watched from the phone; controlling it needs macOS."));
    return access.ffmpeg;
  }
  if (!access.ffmpeg) {
    row(out, false, "LinkShell.app", "missing from this installation — reinstall with: npm install -g linkshell-cli");
    return false;
  }
  if (access.recording === null || access.control === null) {
    row(out, false, "Permissions", access.problem ?? "could not be checked");
    return false;
  }

  const kinds = ["recording", "control"] as const;
  const said = new Set<string>();
  const tell = (now: ScreenAccess) => {
    for (const kind of kinds) {
      if (now[kind] && !said.has(kind)) {
        said.add(kind);
        row(out, true, PERMISSIONS[kind], "allowed");
      }
    }
  };
  tell(access);
  if (screenReady(access)) return true;
  if (!interactive) {
    for (const kind of kinds) if (!access[kind]) row(out, false, PERMISSIONS[kind], "not allowed yet");
    return false;
  }

  // The app's own window: it has the system ask, opens the settings at each switch, and shows what is done.
  await screenAccess(true);
  const missing = kinds.filter((kind) => !(access as ScreenAccess)[kind]).length;
  out(`  A LinkShell window has opened on this Mac: turn on the ${missing === 2 ? "two switches" : "switch"} it shows.`);
  out(dim("  Waiting… (Ctrl+C to stop; `linkshell screen` picks up where this left off)"));
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const now = await screenAccess().catch(() => undefined);
    if (!now || now === "old") continue;
    access = now;
    tell(now);
    if (screenReady(now)) return true;
  }
  for (const kind of kinds) if (!access[kind]) row(out, false, PERMISSIONS[kind], "still not allowed");
  return false;
}

export async function runScreenSetup(options: { check?: boolean }): Promise<void> {
  const out: Print = (line = "") => process.stdout.write(`${line}\n`);
  out("\n  LinkShell screen\n");
  if (!hostRuntimeOk()) {
    row(out, false, "Host", `needs Node.js 22.13 or newer (this is ${process.version})`);
    process.exitCode = 1;
    return;
  }
  if (!options.check) await ensureHostRunning();
  const interactive = !options.check && process.stdin.isTTY === true;
  if (await setUpScreen(out, interactive)) {
    out(process.platform === "darwin" ? `\n  ${green("Ready.")} In the app: 电脑 › 屏幕. To take the pointer and keyboard, pick 触控板 or 点按 in the viewer's toolbar.\n` : "");
  } else {
    out(`\n  Not ready yet${interactive ? "" : "; run `linkshell screen` in a terminal to set it up"}.\n`);
    process.exitCode = 1;
  }
}
