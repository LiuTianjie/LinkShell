import { EventEmitter } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Gateway, GatewaySocket } from "./relay.js";

/** Same v2 frames over HTTPS for watchOS, where non-audio WebSockets are forbidden. */
export const POLL_PATH = "/v2/poll";
const MAX_BODY = 512 * 1024;

export interface PollLimits {
  /** Queued for one transport. Room for a whole terminal replay (1 MB of output, sealed and framed twice). */
  maxQueue: number;
  /** Queued for every transport together: 256 full queues would not fit the official gateway's 768 MB. */
  maxQueuedTotal: number;
  /**
   * Bytes in one response. Over a watch's Bluetooth link a multi-MB body outlasts URLSession's
   * timeout, and its retry would ask for the same body again.
   */
  maxResponse: number;
  /** Authenticated transports. */
  maxSessions: number;
  /** Transports that haven't authenticated yet, kept apart so opening many can't fill `maxSessions`. */
  maxPending: number;
  /** A transport not polled this long is dropped. */
  idleMs: number;
  /**
   * A transport not polled this long stops taking frames: its watch left the foreground or lost
   * its link, and what is sent to it would only pile up here until `idleMs`.
   */
  staleMs: number;
  /** How long a closed transport still answers, so its client reads the last frames and why it closed. */
  lingerMs: number;
}

const DEFAULT_LIMITS: PollLimits = {
  maxQueue: 3 * 1024 * 1024,
  maxQueuedTotal: 64 * 1024 * 1024,
  maxResponse: 256 * 1024,
  maxSessions: 256,
  maxPending: 64,
  idleMs: 60_000,
  staleMs: 30_000,
  lingerMs: 10_000,
};
const MAX_RESPONSE_FRAMES = 128;
/** A closed transport keeps its frames only when they are this small; anything bigger isn't worth holding. */
const LINGER_KEEP = 64 * 1024;
const MAX_LINGERING = 256;

type QueuedFrame = { seq: number; frame: string; bytes: number };

class PollSocket extends EventEmitter implements GatewaySocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly token = randomBytes(32).toString("base64url");
  touched = Date.now();
  closedAt = 0;
  busy = false;
  private seq = 0;
  private ack = 0;
  private paused = false;
  private closedReason?: string;
  private frames: QueuedFrame[] = [];
  // Strictly ordered request numbers prevent retransmitted POSTs from repeating actions.
  private lastRequest = 0;
  private lastBody = "";

  constructor(private readonly budget: { queued: number }, private readonly limits: PollLimits) { super(); }

  send(frame: string): void {
    if (this.readyState !== 1) return;
    const bytes = Buffer.byteLength(frame);
    if (!this.busy && Date.now() - this.touched > this.limits.staleMs) return this.close(4008, "receiver gone");
    if (this.bufferedAmount + bytes > this.limits.maxQueue) return this.close(4008, "receiver too slow");
    if (this.budget.queued + bytes > this.limits.maxQueuedTotal) return this.close(4008, "gateway busy");
    this.frames.push({ seq: ++this.seq, frame, bytes });
    this.queued(bytes);
    this.emit("available");
  }
  close(_code = 1000, reason = "closed"): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closedReason = reason;
    this.closedAt = Date.now();
    if (this.bufferedAmount > LINGER_KEEP) this.discard();
    this.emit("available");
    this.emit("close");
  }
  terminate(): void { this.close(4008, "connection expired"); }
  ping(): void { if (Date.now() - this.touched < this.limits.idleMs) this.emit("pong"); }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  authenticated(): void { this.emit("authenticated"); }
  /** Lets go of everything queued; the transport stays closed. */
  discard(): void {
    this.frames = [];
    this.queued(-this.bufferedAmount);
  }
  private queued(bytes: number): void {
    this.bufferedAmount += bytes;
    this.budget.queued += bytes;
  }

  async exchange(body: { request: number; ack: number; frames: string[]; waitMs: number }, disconnected: AbortSignal) {
    const serialized = JSON.stringify(body.frames);
    if (body.request === this.lastRequest && serialized !== this.lastBody) throw new PollError(409, "request_conflict");
    if (body.request !== this.lastRequest && body.request !== this.lastRequest + 1) throw new PollError(409, "request_out_of_order");
    if (body.ack < this.ack || body.ack > this.seq) throw new PollError(409, "invalid_ack");
    if (this.paused && body.frames.length > 0) throw new PollError(429, "backpressure");
    this.touched = Date.now();
    this.emit("pong");
    this.ack = body.ack;
    const keep = this.frames.findIndex((entry) => entry.seq > this.ack);
    const acked = this.frames.splice(0, keep === -1 ? this.frames.length : keep);
    this.queued(-acked.reduce((sum, entry) => sum + entry.bytes, 0));
    if (body.request > this.lastRequest) {
      this.lastRequest = body.request;
      this.lastBody = serialized;
      for (const frame of body.frames) {
        if (this.readyState !== 1) break;
        this.emit("message", Buffer.from(frame));
      }
    }
    if (!this.frames.length && this.readyState === 1 && body.waitMs > 0 && !disconnected.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.off("available", finish);
          disconnected.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(body.waitMs, 20_000));
        this.once("available", finish);
        disconnected.addEventListener("abort", finish, { once: true });
      });
    }
    // Keep frames until the client ACKs them on its next request, including when an HTTP response is lost:
    // a retry with the same ACK gets the same frames again. At least one frame goes out, however large,
    // so a big one can't stall the transport.
    const frames: { seq: number; frame: string }[] = [];
    let bytes = 0;
    for (const entry of this.frames) {
      if (frames.length === MAX_RESPONSE_FRAMES || (frames.length > 0 && bytes + entry.bytes > this.limits.maxResponse)) break;
      frames.push({ seq: entry.seq, frame: entry.frame });
      bytes += entry.bytes;
    }
    // Said only with the last frame, so a client that stops at `closed` has read everything before it.
    const closed = this.closedReason && frames.length === this.frames.length ? { closed: this.closedReason } : {};
    return { frames, ...closed };
  }
}

class PollError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class PollRelay {
  /** Open transports, authenticated or not. */
  private readonly sessions = new Map<string, PollSocket>();
  /** Open transports that haven't authenticated yet, oldest first. */
  private readonly pending = new Set<string>();
  /** Closed transports that still answer for a while, oldest first. */
  private readonly lingering = new Map<string, PollSocket>();
  private readonly budget = { queued: 0 };
  private readonly limits: PollLimits;
  private readonly sweep = setInterval(() => {
    const now = Date.now();
    for (const socket of this.sessions.values()) if (now - socket.touched > this.limits.idleMs) socket.terminate();
    for (const [id, socket] of this.lingering) if (now - socket.closedAt > this.limits.lingerMs) this.forget(id, socket);
  }, 10_000);

  constructor(private readonly gateway: Gateway, limits: Partial<PollLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.sweep.unref();
  }

  /** What the transports hold right now. */
  get stats(): { open: number; pending: number; lingering: number; queuedBytes: number } {
    return { open: this.sessions.size, pending: this.pending.size, lingering: this.lingering.size, queuedBytes: this.budget.queued };
  }

  async handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    let socket: PollSocket | undefined;
    let acquired = false;
    try {
      if (request.method !== "POST") throw new PollError(405, "method_not_allowed");
      if (path === POLL_PATH) {
        // Read and bound even the opening body, so slow/oversized uploads can't accumulate unchecked.
        await readBody(request);
        json(response, 200, this.open());
        return;
      }
      const id = path.slice(POLL_PATH.length + 1);
      socket = this.sessions.get(id) ?? this.lingering.get(id);
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!socket || token.length !== socket.token.length || !timingSafeEqual(Buffer.from(token), Buffer.from(socket.token))) {
        throw new PollError(401, "invalid_session");
      }
      if (socket.busy) throw new PollError(409, "poll_in_progress");
      socket.busy = true;
      acquired = true;
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      if (!Number.isSafeInteger(body.request) || Number(body.request) < 1 || !Number.isSafeInteger(body.ack) || Number(body.ack) < 0 ||
          !Array.isArray(body.frames) || body.frames.length > 32 || !body.frames.every((frame) => typeof frame === "string") ||
          typeof body.waitMs !== "number" || !Number.isFinite(body.waitMs) || body.waitMs < 0 || body.waitMs > 20_000) {
        throw new PollError(400, "bad_request");
      }
      const result = await socket.exchange(body as { request: number; ack: number; frames: string[]; waitMs: number }, controller.signal);
      if (!response.destroyed) json(response, 200, result);
    } catch (error) {
      if (!response.destroyed) json(response, error instanceof PollError ? error.status : 400,
        { error: error instanceof PollError ? error.message : "bad_request" });
    } finally {
      if (socket && acquired) socket.busy = false;
    }
  }

  close(): void {
    clearInterval(this.sweep);
    for (const socket of this.sessions.values()) socket.terminate();
    for (const [id, socket] of this.lingering) this.forget(id, socket);
  }

  private open(): { id: string; token: string } {
    if (this.sessions.size - this.pending.size >= this.limits.maxSessions) throw new PollError(503, "gateway_busy");
    if (this.pending.size >= this.limits.maxPending) {
      // Opening is cheap and authenticating isn't required to hold a slot, so refusing here would let
      // whoever opens fastest lock every watch out. The oldest makes room instead: a watch authenticates
      // within a couple of polls, well before a flood within the rate limit cycles round to it.
      const oldest = this.pending.values().next().value as string;
      this.sessions.get(oldest)?.close(4008, "gateway busy");
    }
    const id = randomBytes(16).toString("hex");
    const socket = new PollSocket(this.budget, this.limits);
    this.sessions.set(id, socket);
    this.pending.add(id);
    socket.once("authenticated", () => this.pending.delete(id));
    // Its slot is free the moment it closes (auth timeout, replaced, dropped), not at the next sweep.
    socket.once("close", () => {
      this.sessions.delete(id);
      this.pending.delete(id);
      this.lingering.set(id, socket);
      if (this.lingering.size > MAX_LINGERING) {
        const [oldestId, oldest] = this.lingering.entries().next().value as [string, PollSocket];
        this.forget(oldestId, oldest);
      }
    });
    this.gateway.acceptTransport(socket);
    return { id, token: socket.token };
  }

  private forget(id: string, socket: PollSocket): void {
    this.lingering.delete(id);
    socket.discard();
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new PollError(415, "json_required");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new PollError(413, "body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
