// Keeping a viewer close to live. The picture goes down pipes that deliver
// everything, in order (the gateway's relay, a data channel, a socket): when
// the network can't carry the stream, nothing is lost, it queues, and the
// phone ends up watching the past. So the viewer says which frame it has shown,
// and the host, knowing how far behind that is, stops adding to the queue
// (frames are dropped here, before anything relays them), resumes at a
// keyframe once the path has caught up, and moves to a lighter picture when
// that keeps happening.

/** How the picture is sent, best first (rates in bits a second). A gateway carries messages rather than video: relayed, it starts lower. */
export const LADDER = [
  { fps: 20, width: 1600, bitrate: 3_000_000, ceiling: 4_000_000 },
  { fps: 15, width: 1440, bitrate: 1_500_000, ceiling: 2_000_000 },
  { fps: 12, width: 1280, bitrate: 900_000, ceiling: 1_300_000 },
  { fps: 10, width: 1024, bitrate: 500_000, ceiling: 700_000 },
  { fps: 8, width: 854, bitrate: 260_000, ceiling: 380_000 },
] as const;
export type Rung = (typeof LADDER)[number];

/** The rung for a level, whatever number is asked for. */
export const rung = (level: number): Rung => LADDER[Math.min(Math.max(Math.trunc(level) || 0, 0), LADDER.length - 1)]!;

/** The level a relayed stream starts at, and never goes above. */
export const RELAY_LEVEL = 2;

/** Behind by this much more than the path's own delay: stop sending. */
const BEHIND_MS = 450;
/** Caught up to within this of the path's own delay: resume (at a keyframe). */
const CAUGHT_UP_MS = 150;
/** Stuck behind for this long, or behind twice within TROUBLE_WINDOW_MS: a lighter picture. */
const STUCK_MS = 2500;
const TROUBLE_WINDOW_MS = 10_000;
/** Smooth for this long: try a better picture. Doubles each time the better one didn't hold. */
const CALM_MS = 30_000;
const CALM_MAX_MS = 240_000;
/** A viewer that never says what it has shown is not paced at all. */
const SILENT_MS = 5000;
/** After a change of picture, what was already on its way gets this long to arrive before more is concluded. */
const SETTLE_MS = 4000;
/** No path's own delay is taken to be longer than this: a stream that began on a choked path would look normal. */
const FLOOR_MAX_MS = 800;
/** Behind, and nothing heard for this long: a keyframe goes anyway. Whatever went wrong, the next answer ends it. */
const PROBE_MS = 8000;

export class Pacer {
  private seq = 0;
  private shown = 0;
  private readonly sentAt = new Map<number, number>();
  /** The path's own delay: the least a frame has taken to come back as shown. */
  private floor = Infinity;
  private behindSince?: number;
  private troubles: number[] = [];
  private calmSince: number;
  private calmFor = CALM_MS;
  private raisedAt?: number;
  private firstSent?: number;
  private heard = false;
  private settledAt = 0;
  private lastSent = 0;

  constructor(now: number) {
    this.calmSince = now;
  }

  /** Whether frames are being dropped for the viewer to catch up. */
  get dropping(): boolean {
    return this.behindSince !== undefined;
  }

  /**
   * Dropping, and a keyframe now would be sent: the viewer has caught up, or nothing has been heard
   * for so long that one goes anyway. A capture that makes keyframes when asked is asked now, rather
   * than the viewer waiting for the next one due.
   */
  needsKey(now: number): boolean {
    if (this.behindSince === undefined) return false;
    const own = Number.isFinite(this.floor) ? Math.min(this.floor, FLOOR_MAX_MS) : 0;
    return this.sentAt.size === 0 || this.lag(now) <= own + CAUGHT_UP_MS || now - this.lastSent >= PROBE_MS;
  }

  /** How long ago the oldest frame not yet shown was sent. */
  private lag(now: number): number {
    const oldest = this.sentAt.get(this.shown + 1);
    return oldest === undefined ? 0 : now - oldest;
  }

  /** The number to send this frame under, or undefined to drop it. */
  next(key: boolean, now: number): number | undefined {
    this.firstSent ??= now;
    const paced = this.heard || now - this.firstSent < SILENT_MS;
    if (paced) {
      const own = Number.isFinite(this.floor) ? Math.min(this.floor, FLOOR_MAX_MS) : 0;
      const lag = this.lag(now);
      if (this.behindSince === undefined && lag > own + BEHIND_MS) {
        this.behindSince = now;
        this.troubles.push(now);
        this.calmSince = now;
      }
      if (this.behindSince !== undefined) {
        // Back in at a keyframe, once what was sent has been shown (or nearly).
        const caughtUp = this.sentAt.size === 0 || lag <= own + CAUGHT_UP_MS;
        if (!key || (!caughtUp && now - this.lastSent < PROBE_MS)) return undefined;
        if (caughtUp) {
          this.behindSince = undefined;
          this.calmSince = now;
        }
      }
    }
    const seq = ++this.seq;
    this.sentAt.set(seq, now);
    this.lastSent = now;
    // A viewer that says nothing must not make this grow for ever.
    if (this.sentAt.size > 600) this.sentAt.delete(this.sentAt.keys().next().value!);
    return seq;
  }

  /** The viewer has shown everything up to `seq`. */
  ack(seq: number, now: number): void {
    if (!Number.isInteger(seq) || seq <= this.shown || seq > this.seq) return;
    this.heard = true;
    const sent = this.sentAt.get(seq);
    if (sent !== undefined) this.floor = Math.min(this.floor, now - sent);
    for (const key of this.sentAt.keys()) {
      if (key > seq) break;
      this.sentAt.delete(key);
    }
    this.shown = seq;
  }

  /** Whether to move to a lighter picture ("down") or try a better one ("up"); asked after each frame. */
  advice(now: number, canGoUp: boolean, canGoDown: boolean): "up" | "down" | undefined {
    if (now < this.settledAt) return undefined;
    this.troubles = this.troubles.filter((at) => at >= this.settledAt && now - at < TROUBLE_WINDOW_MS);
    const stuck = this.behindSince !== undefined && now - Math.max(this.behindSince, this.settledAt) > STUCK_MS;
    if (canGoDown && (stuck || this.troubles.length >= 2)) {
      // The better picture just tried didn't hold: wait longer before trying it again.
      if (this.raisedAt !== undefined && now - this.raisedAt < TROUBLE_WINDOW_MS * 2) this.calmFor = Math.min(this.calmFor * 2, CALM_MAX_MS);
      this.raisedAt = undefined;
      return "down";
    }
    if (canGoUp && this.behindSince === undefined && now - this.calmSince > this.calmFor) {
      this.raisedAt = now;
      return "up";
    }
    return undefined;
  }

  /**
   * The picture changed level without the stream stopping: what is on its way still arrives and is
   * still answered for. The new level is judged afresh, once it has had time to show.
   */
  changed(now: number): void {
    this.troubles = [];
    this.calmSince = now;
    this.settledAt = now + SETTLE_MS;
  }

  /**
   * The capture was started again (another level). The viewer drops what it had of the old stream
   * without showing it, so none of that will ever be answered for: the new stream starts clean, with
   * its keyframe, and is judged on its own frames once what was on the way has had time to arrive.
   */
  restarted(now: number): void {
    this.sentAt.clear();
    this.shown = this.seq;
    this.behindSince = undefined;
    this.troubles = [];
    this.calmSince = now;
    this.settledAt = now + SETTLE_MS;
  }
}
