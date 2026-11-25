import { stdoutStyle } from "../utils/format.js";
import { ensureHostRunning, hostRuntimeOk, withRunningHost } from "./host.js";

// `linkshell screen`: makes this computer's screen watchable and controllable
// from the phone. On a Mac that is two permissions the system gives to an app
// by name; on Linux it reports the detected X11/Wayland capture and input backends.

export interface ScreenAccess {
  supported: boolean;
  /** Whether capture is ready: LinkShell.app on macOS, or an X11/Wayland capture backend on Linux. */
  ffmpeg: boolean;
  recording: boolean | null;
  control: boolean | null;
  app?: string;
  problem?: string;
}

export interface ScreenDescribeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function isHeadlessLinux(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform === "linux" && !env.DISPLAY?.trim() && !env.WAYLAND_DISPLAY?.trim();
}

function isWaylandLinux(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return (
    platform === "linux" &&
    (env.XDG_SESSION_TYPE?.trim().toLowerCase() === "wayland" || Boolean(env.WAYLAND_DISPLAY?.trim()))
  );
}

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

export function screenReady(access: ScreenAccess, platform: NodeJS.Platform = process.platform): boolean {
  if (!access.supported) return false;
  if (platform === "linux") return access.recording === true || access.ffmpeg === true;
  if (!access.ffmpeg) return false;
  return access.recording === true && access.control === true;
}

/** One line for `status`, `doctor` and the host's start: what works, and the command for the rest. */
export function describeScreen(
  access: ScreenAccess | "old" | undefined,
  options: ScreenDescribeOptions = {},
): string | undefined {
  if (!access) return undefined;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (access === "old") return "restart the host to check (linkshell host restart)";
  if (!access.supported) return access.problem ?? "not available on this system";

  if (platform === "win32") {
    return screenReady(access, platform)
      ? "can be watched and controlled (Windows desktop)"
      : access.problem ?? "install LinkShell for Windows and enable screen sharing";
  }

  if (platform === "linux") {
    const recording = access.recording === true || access.ffmpeg === true;
    const control = access.control === true;
    const headless = isHeadlessLinux(platform, env);
    const wayland = isWaylandLinux(platform, env);
    const serverLabel = headless ? "headless" : wayland ? "Wayland" : "X11";

    if (headless && !recording) {
      return "headless Linux (no DISPLAY/WAYLAND_DISPLAY) — screen sharing not applicable";
    }
    if (recording && control) {
      return `can be watched and controlled (${serverLabel}${access.app ? `, input: ${access.app}` : ""})`;
    }
    if (recording) {
      const inputHint = access.problem
        ? access.problem
        : wayland
          ? "remote input needs dotool, ydotool, or wtype"
          : "remote input needs xdotool or dotool";
      return `can be watched (${serverLabel}; ${inputHint})`;
    }
    if (access.problem) return access.problem;
    return wayland
      ? "Wayland capture unavailable (install wf-recorder, or gst-launch-1.0 with pipewiresrc)"
      : "X11 capture unavailable (install ffmpeg with x11grab)";
  }

  if (!access.ffmpeg) return platform === "darwin" ? MISSING_APP : access.problem ?? "screen capture unavailable";
  if (platform !== "darwin") return access.problem ?? "not available on this system";
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
const row = (out: Print, ok: boolean, label: string, detail: string) => {
  const style = stdoutStyle();
  out(`  ${ok ? style.green("✓") : style.red("✗")} ${label.padEnd(22)} ${detail}`);
};

/**
 * Gets this computer's screen ready for the phone, as far as it can be, saying
 * what it finds. On a Mac the two permissions are LinkShell.app's; on Linux it
 * inspects X11/Wayland capture and input backends (treating headless servers as N/A during setup).
 */
export async function setUpScreen(
  out: Print,
  interactive: boolean,
  options: { optionalHeadless?: boolean } = {},
): Promise<boolean> {
  const style = stdoutStyle();

  if (options.optionalHeadless && isHeadlessLinux(process.platform, process.env)) {
    out(`  ${style.dim("–")} ${"Screen sharing".padEnd(22)} ${style.dim("headless Linux (no DISPLAY/WAYLAND_DISPLAY) — N/A")}`);
    return true;
  }

  let access = await screenAccess();
  if (!access) {
    row(out, false, "Host", "not running — start it with: linkshell host --daemon");
    return false;
  }
  if (access === "old") {
    row(out, false, "Host", "is older than this CLI — restart it (stops running agent turns):");
    out("      linkshell host restart");
    return false;
  }
  if (!access.supported) {
    row(out, false, "Screen", access.problem ?? "not available on this system");
    return false;
  }
  if (process.platform === "win32") {
    row(out, screenReady(access), "Windows screen", describeScreen(access) ?? "unavailable");
    return screenReady(access);
  }
  if (process.platform === "linux") {
    const headless = isHeadlessLinux(process.platform, process.env);
    const wayland = isWaylandLinux(process.platform, process.env);
    const recording = access.recording === true || access.ffmpeg === true;
    const control = access.control === true;

    if (headless && !recording) {
      if (options.optionalHeadless) {
        out(`  ${style.dim("–")} ${"Screen sharing".padEnd(22)} ${style.dim("headless Linux (no DISPLAY/WAYLAND_DISPLAY) — N/A")}`);
        return true;
      }
      row(out, false, "Display server", "no DISPLAY or WAYLAND_DISPLAY found (headless Linux server)");
      return false;
    }

    const captureHint =
      access.problem ??
      (wayland
        ? "install wf-recorder, or gst-launch-1.0 + pipewiresrc"
        : "install ffmpeg (with x11grab) via your package manager");
    const inputHint =
      access.problem ??
      (wayland
        ? "install dotool, ydotool (with ydotoold), or wtype"
        : "install xdotool or dotool via your package manager");

    row(out, recording, PERMISSIONS.recording, recording ? `ready (${wayland ? "Wayland" : "X11"})` : captureHint);
    row(out, control, PERMISSIONS.control, control ? `ready (${access.app ?? "input backend"})` : inputHint);
    if (recording && !control) {
      out(style.dim("    Screen viewing works now; install an input tool above to enable remote mouse/keyboard control."));
    }
    return recording;
  }
  if (process.platform !== "darwin") {
    row(out, false, "Screen", access.problem ?? "not available on this system");
    return false;
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
  out(style.dim("  Waiting… (Ctrl+C to stop; `linkshell screen` picks up where this left off)"));
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
  const style = stdoutStyle();
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
    out(
      process.platform === "darwin" || process.platform === "linux"
        ? `\n  ${style.green("Ready.")} In the app: 电脑 › 屏幕. To take the pointer and keyboard, pick 触控板 or 点按 in the viewer's toolbar.\n`
        : "",
    );
  } else {
    out(`\n  Not ready yet${interactive ? "" : "; run `linkshell screen` in a terminal to set it up"}.\n`);
    process.exitCode = 1;
  }
}
