import { EventEmitter } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Gateway, GatewaySocket } from "./relay.js";

/** Same v2 frames over HTTPS for watchOS, where non-audio WebSockets are forbidden. */
export const POLL_PATH = "/v2/poll";
const MAX_BODY = 512 * 1024;
const MAX_QUEUE = 4 * 1024 * 1024;
const MAX_SESSIONS = 256;
const IDLE_MS = 60_000;

type QueuedFrame = { seq: number; frame: string };

class PollSocket extends EventEmitter implements GatewaySocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly token = randomBytes(32).toString("base64url");
  touched = Date.now();
  busy = false;
  private seq = 0;
  private ack = 0;
  private paused = false;
  private closedReason?: string;
  private frames: QueuedFrame[] = [];
  // Strictly ordered request numbers prevent retransmitted POSTs from repeating actions.
  private lastRequest = 0;
  private lastBody = "";

  send(frame: string): void {
    if (this.readyState !== 1) return;
    const bytes = Buffer.byteLength(frame);
    if (this.bufferedAmount + bytes > MAX_QUEUE) return this.close(4008, "receiver too slow");
    this.frames.push({ seq: ++this.seq, frame });
    this.bufferedAmount += bytes;
    this.emit("available");
  }
  close(_code = 1000, reason = "closed"): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closedReason = reason;
    this.emit("available");
    this.emit("close");
  }
  terminate(): void { this.close(4008, "connection expired"); }
  ping(): void { if (Date.now() - this.touched < IDLE_MS) this.emit("pong"); }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }

  async exchange(body: { request: number; ack: number; frames: string[]; waitMs: number }, disconnected: AbortSignal) {
    const serialized = JSON.stringify(body.frames);
    if (body.request === this.lastRequest && serialized !== this.lastBody) throw new PollError(409, "request_conflict");
    if (body.request !== this.lastRequest && body.request !== this.lastRequest + 1) throw new PollError(409, "request_out_of_order");
    if (body.ack < this.ack || body.ack > this.seq) throw new PollError(409, "invalid_ack");
    if (this.paused && body.frames.length > 0) throw new PollError(429, "backpressure");
    this.touched = Date.now();
    this.emit("pong");
    this.ack = body.ack;
    this.frames = this.frames.filter((entry) => entry.seq > this.ack);
    this.bufferedAmount = this.frames.reduce((sum, entry) => sum + Buffer.byteLength(entry.frame), 0);
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
    // Keep frames until the client ACKs them on its next request, including when an HTTP response is lost.
    return { frames: this.frames.slice(0, 128), ...(this.closedReason ? { closed: this.closedReason } : {}) };
  }
}

class PollError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class PollRelay {
  private readonly sessions = new Map<string, PollSocket>();
  private readonly sweep = setInterval(() => {
    for (const [id, socket] of this.sessions) {
      if (Date.now() - socket.touched > IDLE_MS) {
        socket.terminate();
        this.sessions.delete(id);
      }
    }
  }, 10_000);

  constructor(private readonly gateway: Gateway) { this.sweep.unref(); }

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
        if (this.sessions.size >= MAX_SESSIONS) throw new PollError(503, "gateway_busy");
        const id = randomBytes(16).toString("hex");
        socket = new PollSocket();
        this.sessions.set(id, socket);
        this.gateway.acceptTransport(socket);
        json(response, 200, { id, token: socket.token });
        return;
      }
      socket = this.sessions.get(path.slice(POLL_PATH.length + 1));
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
    this.sessions.clear();
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
