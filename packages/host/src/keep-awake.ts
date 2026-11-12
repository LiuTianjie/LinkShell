import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type KeepAwakeMode = "smart" | "always" | "off";

export interface KeepAwakeStatus {
  mode: KeepAwakeMode;
  active: boolean;
  reason?: string;
}

export interface KeepAwakeSignals {
  sessionActive?: boolean;
  goalActive?: boolean;
  screenActive?: boolean;
  remoteConnected?: boolean;
}

export interface KeepAwakeAssertion {
  release(): void;
  readonly alive: boolean;
}

export type SpawnAssertion = (
  platform: NodeJS.Platform,
  pid: number,
  onUnexpectedExit: () => void,
  log: (message: string) => void,
) => KeepAwakeAssertion | undefined;

// ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001), intentionally omitting
// ES_DISPLAY_REQUIRED so the physical monitor still dims and sleeps normally.
export const WINDOWS_KEEP_AWAKE_SCRIPT = [
  "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);' -Name Power -Namespace LinkShell;",
  "[LinkShell.Power]::SetThreadExecutionState(0x80000001) | Out-Null;",
  "try { [Console]::In.ReadLine() | Out-Null } finally { [LinkShell.Power]::SetThreadExecutionState(0x80000000) | Out-Null }",
].join(" ");

export function isKeepAwakeMode(value: unknown): value is KeepAwakeMode {
  return value === "smart" || value === "always" || value === "off";
}

export function readKeepAwakeMode(home: string): KeepAwakeMode {
  try {
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { keepAwake?: unknown };
    if (isKeepAwakeMode(raw.keepAwake)) return raw.keepAwake;
  } catch {
    // Missing or unreadable config defaults to smart on-demand keep-awake.
  }
  return "smart";
}

export function writeKeepAwakeMode(home: string, mode: KeepAwakeMode): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = join(home, "config.json");
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Start a fresh config object when none exists yet.
  }
  const next = { ...existing, keepAwake: mode };
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Windows ignores POSIX mode bits.
  }
  renameSync(temporary, target);
}

export function keepAwakeCommand(platform: NodeJS.Platform, pid = process.pid): {
  command: string;
  args: string[];
  stdinPipe?: boolean;
} | undefined {
  if (platform === "darwin") {
    return { command: "/usr/bin/caffeinate", args: ["-i", "-w", String(pid)] };
  }
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: ["--what=idle", "--who=LinkShell", "--why=Active coding session or remote connection", "--mode=block", "sleep", "infinity"],
    };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_KEEP_AWAKE_SCRIPT],
      stdinPipe: true,
    };
  }
  return undefined;
}

export const defaultSpawnAssertion: SpawnAssertion = (platform, pid, onUnexpectedExit, log) => {
  const spec = keepAwakeCommand(platform, pid);
  if (!spec) return undefined;
  let child: ChildProcess;
  try {
    child = spawn(spec.command, spec.args, {
      stdio: spec.stdinPipe ? ["pipe", "ignore", "ignore"] : "ignore",
      windowsHide: true,
    });
  } catch (error) {
    log(`[keep-awake] failed to spawn ${spec.command}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  child.unref();
  let released = false;
  let alive = true;
  const markGone = () => {
    if (!alive) return;
    alive = false;
    if (!released) onUnexpectedExit();
  };
  child.once("error", (error) => {
    log(`[keep-awake] ${spec.command} unavailable: ${error.message}`);
    markGone();
  });
  child.once("exit", markGone);
  return {
    get alive() {
      return alive;
    },
    release() {
      if (released) return;
      released = true;
      alive = false;
      try {
        if (spec.stdinPipe && child.stdin && !child.stdin.destroyed) {
          child.stdin.end("\n");
        }
      } catch {
        // Ignore broken pipe on teardown.
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
    },
  };
};

export function demandReason(mode: KeepAwakeMode, signals: KeepAwakeSignals): string | undefined {
  if (mode === "off") return undefined;
  if (mode === "always") return "always";
  if (signals.sessionActive) return "session_active";
  if (signals.goalActive) return "goal_active";
  if (signals.screenActive) return "screen_active";
  if (signals.remoteConnected) return "remote_connected";
  return undefined;
}

export interface KeepAwakeManagerOptions {
  home: string;
  signals: () => KeepAwakeSignals;
  platform?: NodeJS.Platform;
  pid?: number;
  spawnAssertion?: SpawnAssertion;
  onChange?: (status: KeepAwakeStatus) => void;
  log?: (message: string) => void;
}

/**
 * Holds an OS idle-sleep assertion on demand ("smart", default) or continuously
 * ("always"), allowing the physical display to sleep while keeping agents and
 * remote tunnels reachable.
 */
export class KeepAwakeManager {
  private mode: KeepAwakeMode;
  private assertion?: KeepAwakeAssertion;
  private currentReason?: string;
  private stopped = false;
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly spawnAssertion: SpawnAssertion;
  private readonly log: (message: string) => void;

  constructor(private readonly options: KeepAwakeManagerOptions) {
    this.mode = readKeepAwakeMode(options.home);
    this.platform = options.platform ?? process.platform;
    this.pid = options.pid ?? process.pid;
    this.spawnAssertion = options.spawnAssertion ?? defaultSpawnAssertion;
    this.log = options.log ?? (() => {});
  }

  start(): void {
    this.stopped = false;
    this.reconcile();
  }

  setMode(mode?: KeepAwakeMode): KeepAwakeStatus {
    if (mode !== undefined && mode !== this.mode) {
      this.mode = mode;
      writeKeepAwakeMode(this.options.home, mode);
    }
    if (mode !== undefined) {
      // Persist explicit choice even when matching the default so config.json reflects it.
      writeKeepAwakeMode(this.options.home, this.mode);
    }
    this.reconcile();
    return this.status();
  }

  reconcile(): void {
    if (this.stopped) return;
    const before = this.status();
    const reason = demandReason(this.mode, this.options.signals());
    this.currentReason = reason;
    if (reason) {
      if (!this.assertion?.alive) {
        this.assertion?.release();
        this.assertion = this.spawnAssertion(
          this.platform,
          this.pid,
          () => {
            this.assertion = undefined;
            this.options.onChange?.(this.status());
          },
          this.log,
        );
      }
    } else if (this.assertion) {
      this.assertion.release();
      this.assertion = undefined;
    }
    const after = this.status();
    if (before.mode !== after.mode || before.active !== after.active || before.reason !== after.reason) {
      this.options.onChange?.(after);
    }
  }

  status(): KeepAwakeStatus {
    const active = Boolean(this.assertion?.alive && this.currentReason);
    return {
      mode: this.mode,
      active,
      ...(this.currentReason ? { reason: this.currentReason } : {}),
    };
  }

  stop(): void {
    this.stopped = true;
    this.currentReason = undefined;
    if (this.assertion) {
      this.assertion.release();
      this.assertion = undefined;
    }
  }
}
