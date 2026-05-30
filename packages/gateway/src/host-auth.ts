import { randomUUID, timingSafeEqual } from "node:crypto";

const CLEANUP_INTERVAL = 5 * 60_000;
const HOST_TOKEN_TTL = 7 * 24 * 60 * 60_000; // 7 days

interface HostBinding {
  sessionId: string;
  hostToken: string;
  lastUsedAt: number;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Binds a session to the secret host token issued when its pairing was created,
 * so only the original host (the CLI that created the pairing) can connect as
 * `role=host`. Without this, anyone who learns a sessionId could connect as host
 * and capture every controller keystroke or inject terminal output.
 *
 * Kept separate from PairingManager because a host connection long outlives the
 * pairing code's 10-minute TTL (and reconnects days later), so the binding needs
 * its own longer lifetime.
 */
export class HostAuthManager {
  private bindings = new Map<string, HostBinding>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
    this.cleanupTimer.unref?.();
  }

  /** Mint a fresh host token to hand to the CLI at pairing creation.
   *
   *  Deliberately does NOT create a binding yet: the binding is established
   *  trust-on-first-use when the host first connects WITH this token (see
   *  `adopt`). This keeps the gateway backward-compatible with older CLIs that
   *  don't send a host token at all — they simply never create a binding and
   *  are allowed as legacy hosts, instead of being locked out by an eager
   *  binding they can't satisfy. The legitimate host connects milliseconds
   *  after pairing, so the trust-on-first-use window is negligible. */
  issue(_sessionId: string): string {
    return randomUUID();
  }

  /** Trust-on-first-use: register a host-provided token when no binding exists
   *  yet (e.g. after a gateway restart lost the in-memory binding). */
  adopt(sessionId: string, hostToken: string): void {
    this.bindings.set(sessionId, { sessionId, hostToken, lastUsedAt: Date.now() });
  }

  has(sessionId: string): boolean {
    const binding = this.bindings.get(sessionId);
    if (!binding) return false;
    if (Date.now() - binding.lastUsedAt > HOST_TOKEN_TTL) {
      this.bindings.delete(sessionId);
      return false;
    }
    return true;
  }

  verify(sessionId: string, hostToken: string | undefined): boolean {
    if (!hostToken) return false;
    const binding = this.bindings.get(sessionId);
    if (!binding) return false;
    if (!safeEqual(binding.hostToken, hostToken)) return false;
    binding.lastUsedAt = Date.now();
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [sessionId, binding] of this.bindings) {
      if (now - binding.lastUsedAt > HOST_TOKEN_TTL) {
        this.bindings.delete(sessionId);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
