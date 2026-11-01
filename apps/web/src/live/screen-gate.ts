/**
 * The viewer's side of a screen session's configuration (packages/host/src/screen.ts `stream`):
 * which picture is asked for, and whether input may go yet. Once a configuration has been asked
 * for, the host takes input only with the generation its acknowledgement named; until then, and
 * while paused, nothing is sent. A host from before configurations says nothing of them, and
 * takes input as it comes.
 */
export interface ScreenTarget { display: number; width: number; maxFps: number; paused: boolean }
export interface ScreenConfigureMessage extends ScreenTarget { t: "screen.configure"; requestId: number }

export class ScreenGate {
  private known = false;
  private configurable = false;
  private pausable = false;
  private requestId = 0;
  private pending?: { requestId: number; display: number; paused: boolean };
  private last?: { requestId: number; display: number; paused: boolean };
  private applied?: ScreenTarget;
  /** The generation input carries, from the last acknowledgement. */
  generation?: number;

  /**
   * The host said what it can do. True when it takes configurations: one should be sent now. It
   * says so again when the picture moves from the video track to its socket, with a new input
   * generation to come: what was acknowledged before no longer opens input.
   */
  capabilities(message: Record<string, unknown>): boolean {
    if (message.version !== 1) return false;
    this.known = true;
    this.configurable = message.configure === true;
    this.pausable = this.configurable && message.pause === true;
    this.generation = undefined;
    // The host applies the last configuration it was sent again, under its id, with the new
    // generation: that acknowledgement is the one awaited, and nothing needs sending.
    if (this.configurable && this.last) { this.pending = { ...this.last }; return false; }
    this.pending = undefined;
    return this.configurable;
  }

  /** No word of capabilities in time: a host from before them. */
  assumeLegacy(): void {
    if (this.known) return;
    this.known = true;
    this.configurable = false;
  }

  get canConfigure(): boolean { return this.configurable; }
  get canPause(): boolean { return this.pausable; }
  get capabilitiesKnown(): boolean { return this.known; }
  /** What the host last confirmed. */
  get current(): ScreenTarget | undefined { return this.applied; }

  /** The message for a new target; input waits for its acknowledgement. */
  request(target: ScreenTarget): ScreenConfigureMessage {
    const requestId = ++this.requestId;
    this.pending = { requestId, display: target.display, paused: target.paused };
    this.last = { ...this.pending };
    return { t: "screen.configure", requestId, ...target };
  }

  /** An acknowledgement; true when it is the one awaited (an older one changes nothing). */
  configured(message: Record<string, unknown>): boolean {
    const pending = this.pending;
    if (!pending || message.requestId !== pending.requestId || message.display !== pending.display || message.paused !== pending.paused) return false;
    const generation = message.generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return false;
    this.pending = undefined;
    this.generation = generation;
    this.applied = {
      display: pending.display,
      width: typeof message.width === "number" ? message.width : 0,
      maxFps: typeof message.maxFps === "number" ? message.maxFps : 0,
      paused: pending.paused,
    };
    return true;
  }

  /** A configuration the host could not apply: the reason, when it is the awaited one's (or has no id). */
  failed(message: Record<string, unknown>): string | undefined {
    if (message.requestId !== undefined && message.requestId !== this.pending?.requestId) return undefined;
    this.pending = undefined;
    return typeof message.message === "string" ? message.message.slice(0, 500) : "屏幕设置未能应用，请重新连接";
  }

  get allowsInput(): boolean {
    if (!this.known || this.pending) return false;
    if (!this.configurable) return true;
    return this.generation !== undefined && this.applied?.paused === false;
  }

  /** What input carries for the host to check, once it checks. */
  stamp<T extends object>(event: T): T & { screenGeneration?: number } {
    return this.configurable && this.generation !== undefined ? { ...event, screenGeneration: this.generation } : event;
  }
}
