import type { PowerSaveBlocker } from "electron";

/** A hold on idle system sleep, without keeping the display lit or changing power settings. */
export class KeepAwake {
  private hold?: number;

  constructor(private readonly blocker: Pick<PowerSaveBlocker, "start" | "stop" | "isStarted">) {}

  set(enabled: boolean): void {
    if (enabled) {
      if (this.hold === undefined || !this.blocker.isStarted(this.hold)) {
        this.hold = this.blocker.start("prevent-app-suspension");
      }
    } else if (this.hold !== undefined) {
      this.blocker.stop(this.hold);
      this.hold = undefined;
    }
  }
}
