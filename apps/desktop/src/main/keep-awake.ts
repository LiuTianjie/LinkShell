import type { PowerSaveBlocker } from "electron";

export type KeepAwakeMode = "smart" | "always" | "off";

export function normalizeKeepAwakeMode(value: unknown): KeepAwakeMode {
  if (value === "always" || value === true) return "always";
  if (value === "off" || value === false) return "off";
  return "smart";
}

/**
 * A hold on idle system sleep, without keeping the display lit or changing power settings.
 * In "smart" mode (the default), the Host daemon manages idle sleep assertions dynamically
 * whenever sessions, terminals, or remote tunnels are active; Electron holds its own
 * assertion unconditionally only in "always" mode (or when explicitly told activity is running).
 */
export class KeepAwake {
  private hold?: number;
  private currentMode: KeepAwakeMode = "smart";

  constructor(private readonly blocker: Pick<PowerSaveBlocker, "start" | "stop" | "isStarted">) {}

  get mode(): KeepAwakeMode {
    return this.currentMode;
  }

  get active(): boolean {
    return this.hold !== undefined && this.blocker.isStarted(this.hold);
  }

  set(input: boolean | KeepAwakeMode, hostActive = false): KeepAwakeMode {
    this.currentMode = normalizeKeepAwakeMode(input);
    const shouldHold = this.currentMode === "always" || (this.currentMode === "smart" && hostActive);
    if (shouldHold) {
      if (this.hold === undefined || !this.blocker.isStarted(this.hold)) {
        this.hold = this.blocker.start("prevent-app-suspension");
      }
    } else if (this.hold !== undefined) {
      this.blocker.stop(this.hold);
      this.hold = undefined;
    }
    return this.currentMode;
  }
}
