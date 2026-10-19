export const SCREEN_SESSION_RETAIN_MS = 120_000;
export const SCREEN_SESSION_PAUSE_TIMEOUT_MS = 2_000;

/** Retention is safe only after the host confirms that capture has paused. */
export class ScreenSessionPauseWatchdog {
  private pending: { generation: number; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly onTimeout: (generation: number) => void) {}

  wait(generation: number): void {
    this.clear();
    const pending = {
      generation,
      timer: setTimeout(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        this.onTimeout(generation);
      }, SCREEN_SESSION_PAUSE_TIMEOUT_MS),
    };
    this.pending = pending;
  }

  acknowledge(generation: number): void {
    if (this.pending?.generation === generation) this.clear();
  }

  clear(): void {
    if (this.pending !== null) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}

export interface ScreenSessionLeaseSnapshot<T> {
  readonly generation: number;
  readonly active: boolean;
  readonly resource: T | null;
  readonly reusable: boolean;
}

/** Keeps a supported screen connection through short trips away from its route. */
export class ScreenSessionLease<T> {
  private snapshot: ScreenSessionLeaseSnapshot<T> = {
    generation: 0,
    active: false,
    resource: null,
    reusable: false,
  };
  private owner: object | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryToken: object | null = null;

  constructor(
    private readonly disposeResource: (resource: T) => void,
    private readonly notify: () => void,
  ) {}

  getSnapshot = (): ScreenSessionLeaseSnapshot<T> => this.snapshot;

  activate(owner: object): void {
    this.clearExpiry();
    this.owner = owner;
    if (this.snapshot.active) return;
    this.snapshot = { ...this.snapshot, active: true };
    this.notify();
  }

  deactivate(owner: object): void {
    if (this.owner !== owner) return;
    this.owner = null;
    if (!this.snapshot.reusable || this.snapshot.resource === null) {
      this.resetState(false);
      return;
    }

    const generation = this.snapshot.generation;
    const token = {};
    this.expiryToken = token;
    this.expiryTimer = setTimeout(() => {
      // A canceled callback may still arrive after another leave/return cycle.
      if (this.expiryToken !== token || this.owner !== null || !this.isCurrent(generation)) return;
      this.resetState(false);
    }, SCREEN_SESSION_RETAIN_MS);
    this.snapshot = { ...this.snapshot, active: false };
    this.notify();
  }

  reset(): void {
    this.resetState(this.snapshot.active);
  }

  /** Screen sockets can close independently of an otherwise healthy HostLink. */
  close(generation: number): boolean | null {
    if (!this.isCurrent(generation) || this.snapshot.resource === null) return null;
    const wasActive = this.snapshot.active;
    this.resetState(wasActive);
    return wasActive;
  }

  install(generation: number, resource: T): boolean {
    if (!this.isCurrent(generation) || !this.snapshot.active) {
      this.disposeResource(resource);
      return false;
    }
    const previous = this.snapshot.resource;
    if (previous === resource) return true;
    this.snapshot = { ...this.snapshot, resource };
    if (previous !== null) this.disposeResource(previous);
    this.notify();
    return true;
  }

  setReusable(generation: number, reusable: boolean): void {
    if (!this.isCurrent(generation) || this.snapshot.reusable === reusable) return;
    if (!reusable && !this.snapshot.active) {
      this.resetState(false);
      return;
    }
    this.snapshot = { ...this.snapshot, reusable };
    this.notify();
  }

  isCurrent(generation: number): boolean {
    return generation === this.snapshot.generation;
  }

  dispose(): void {
    this.owner = null;
    this.resetState(false);
  }

  private clearExpiry(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.expiryToken = null;
  }

  private resetState(active: boolean): void {
    this.clearExpiry();
    const resource = this.snapshot.resource;
    this.snapshot = {
      generation: this.snapshot.generation + 1,
      active,
      resource: null,
      reusable: false,
    };
    if (resource !== null) this.disposeResource(resource);
    this.notify();
  }
}
