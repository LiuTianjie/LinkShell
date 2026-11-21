import { createHmac } from "node:crypto";
import { connect, type TLSSocket } from "node:tls";

/**
 * Fusion's control connection, as `FusionWire.swift` speaks it (docs/v2/fusion.md §4.1): TLS 1.2
 * with a pre-shared key derived from the single-use token, frames of [u32 BE length][JSON].
 * packages/host/src/fusion-wire.ts is the same code for the Windows remote's side.
 */
export const FUSION_PSK_IDENTITY = "linkshell-fusion-v1";
export const FUSION_PSK_LABEL = "linkshell-fusion-psk-v1";
export const FUSION_MAX_FRAME = 16 << 20;
export const FUSION_MAX_FILE_CLIPBOARD = 50 << 20;
export const FUSION_FILE_CLIPBOARD_CHUNK_BYTES = 512 << 10;
export const FUSION_MAX_FILE_CLIPBOARD_FILES = 256;
/**
 * Pre-shared-key suites, best first. Electron's BoringSSL (the desktop app on Windows) has no
 * PSK-AES-GCM, so the ones every end has lead; the ECDHE ones add forward secrecy. Checked on
 * 2026-11-15: Network.framework, OpenSSL 3.5 and Electron 44 each negotiate every pair here.
 */
export const FUSION_CIPHER = "ECDHE-PSK-CHACHA20-POLY1305:ECDHE-PSK-AES128-CBC-SHA:PSK-AES128-GCM-SHA256:PSK-AES128-CBC-SHA";

export type FusionMessage = Record<string, unknown> & { t?: string };

export function fusionPsk(token: string): Buffer {
  return createHmac("sha256", token).update(FUSION_PSK_LABEL).digest();
}

/** Splits a byte stream into frames; a frame too large closes the connection (`protocol`). */
export class FusionFramer {
  private buffer: Buffer = Buffer.alloc(0);
  push(chunk: Buffer, emit: (message: FusionMessage) => void): string | undefined {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length <= 0 || length >= FUSION_MAX_FRAME) return "protocol";
      if (this.buffer.length < 4 + length) return undefined;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        const message = JSON.parse(body.toString("utf8")) as unknown;
        if (message && typeof message === "object" && !Array.isArray(message)) emit(message as FusionMessage);
      } catch {
        // Not JSON: dropped, as the Swift side drops it.
      }
    }
    return undefined;
  }
}

export function fusionFrame(message: FusionMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** One framed connection over a TLS socket, either side. */
export class FusionConnection {
  onMessage?: (message: FusionMessage) => void;
  onReady?: () => void;
  /** A short word, as FusionWire's: `tls`, `timeout`, `closed`, `protocol`, `unreachable`, … */
  onClose?: (reason: string) => void;
  private readonly framer = new FusionFramer();
  private closed = false;
  private lastHeard = Date.now();
  private watchdog?: ReturnType<typeof setInterval>;

  constructor(readonly socket: TLSSocket, ready = false) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5_000);
    socket.on("data", (chunk: Buffer) => {
      this.lastHeard = Date.now();
      const problem = this.framer.push(chunk, (message) => this.onMessage?.(message));
      if (problem) this.close(problem);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code ?? "";
      this.close(/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(code) ? "unreachable" : /SSL|TLS|ERR_SSL/.test(code + error.message) ? "tls" : "failed");
    });
    socket.on("close", () => this.close("closed"));
    if (ready) queueMicrotask(() => this.onReady?.());
    else socket.once("secureConnect", () => this.onReady?.());
  }

  send(message: FusionMessage): void {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(fusionFrame(message));
  }

  /** Closes the connection when nothing has been heard for `timeoutMs` (the local side pings). */
  startWatchdog(timeoutMs: number): void {
    this.lastHeard = Date.now();
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastHeard > timeoutMs) this.close("timeout");
    }, 1_000);
    this.watchdog.unref?.();
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    this.socket.destroy();
    this.onClose?.(reason);
  }

  get isClosed(): boolean { return this.closed; }
}

/** The local side: dials the remote's listener (directly, or the tunnel's local end). */
export function connectFusion(host: string, port: number, token: string, options: { waitingTimeoutMs?: number } = {}): FusionConnection {
  const psk = fusionPsk(token);
  const socket = connect({
    host,
    port,
    ciphers: FUSION_CIPHER,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    pskCallback: () => ({ psk, identity: FUSION_PSK_IDENTITY }),
    // No certificate: the key is the authentication (a peer without the token can't finish).
    checkServerIdentity: () => undefined,
  });
  const connection = new FusionConnection(socket);
  // As FusionWire's `.waiting`: a route that never answers is given up.
  let secured = false;
  const timer = setTimeout(() => { if (!secured) connection.close("unreachable"); }, options.waitingTimeoutMs ?? 6_000);
  timer.unref?.();
  socket.once("secureConnect", () => { secured = true; clearTimeout(timer); });
  return connection;
}
