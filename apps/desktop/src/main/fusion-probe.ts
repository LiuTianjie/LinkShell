import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";

/**
 * The Fusion hub's socket, icon cache and stub bundle ids are keyed by the computer, not its name:
 * two computers may share a name, and a rename must not orphan anything. Must equal
 * `Fusion.slug(computerKey:)` in apps/mac (shared test vector in both suites).
 */
export function fusionSlug(computerKey: string): string {
  return createHash("sha256").update(`linkshell-fusion:${computerKey}`).digest("hex").slice(0, 12);
}

export function isFusionSlug(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{12}$/.test(value);
}


/**
 * A TLS 1.2 ClientHello offering Fusion's pre-shared-key suites (FusionWire.suites).
 * The probe never finishes the handshake, so the single-use token (spent by `hello`) stays intact.
 */
function fusionClientHello(): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    randomBytes(32),
    Buffer.from([0x00]), // no session id
    // ECDHE_PSK_CHACHA20, ECDHE_PSK_AES128_CBC, PSK_AES128_GCM, PSK_AES128_CBC, renegotiation SCSV
    Buffer.from([0x00, 0x0a, 0xcc, 0xac, 0xc0, 0x35, 0x00, 0xa8, 0x00, 0x8c, 0x00, 0xff]),
    Buffer.from([0x01, 0x00]), // null compression
  ]);
  const handshake = Buffer.concat([Buffer.from([0x01, 0x00, body.length >> 8, body.length & 0xff]), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01, handshake.length >> 8, handshake.length & 0xff]), handshake]);
}

/**
 * A proxy's TUN interface (Clash, Surge: 198.18.0.0/15) accepts every TCP connection locally and
 * only then dials out, so a bare `connect` proves nothing: an unreachable LAN address "connects" in
 * 0 ms and the real attempt dies later as a TLS failure. A candidate counts only once the far end
 * answers with a TLS record (ServerHello or alert); a proxy that could not reach it just closes.
 */
function connectSpeaksTls(host: string, port: number): Socket {
  const raw = createConnection({ host, port });
  const probe = new EventEmitter() as Socket;
  let done = false;
  const settle = (event: "connect" | "error") => {
    if (done) return;
    done = true;
    raw.destroy();
    probe.emit(event, event === "error" ? new Error("no TLS answer") : undefined);
  };
  raw.once("connect", () => raw.write(fusionClientHello()));
  raw.once("data", (chunk: Buffer) => settle(chunk[0] === 0x15 || chunk[0] === 0x16 ? "connect" : "error"));
  raw.once("end", () => settle("error"));
  raw.once("close", () => settle("error"));
  raw.once("error", () => settle("error"));
  probe.destroy = () => {
    done = true;
    raw.destroy();
    return probe;
  };
  return probe;
}

/**
 * Probes candidate direct fusion hosts in parallel while preserving preference order:
 * - Resolves immediately when candidate `i` answers and all higher-priority `0..i-1` have failed.
 * - Grants higher-priority still-pending candidates a brief `graceMs` window when a lower-priority
 *   candidate answers first, so dead subnet IPs never add `650ms * N` serial latency before tunnel setup.
 * The budget covers a TLS round trip on top of TCP's, over a WAN path such as Tailscale.
 */
export function pickDirectFusionHost(
  hosts: readonly string[],
  port: number,
  options: { timeoutMs?: number; graceMs?: number; connect?: (host: string, port: number) => Socket } = {},
): Promise<string | undefined> {
  const candidates = hosts.filter((h) => h.length > 0);
  if (candidates.length === 0) return Promise.resolve(undefined);
  const timeoutMs = options.timeoutMs ?? 1500;
  const graceMs = options.graceMs ?? 150;
  const connect = options.connect ?? connectSpeaksTls;

  return new Promise((resolve) => {
    let settled = false;
    const states: Array<"pending" | "ok" | "fail"> = candidates.map(() => "pending");
    const sockets: Socket[] = [];
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (winner?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      for (const sock of sockets) sock.destroy();
      resolve(winner);
    };

    const evaluate = (allowGraceWinner: boolean) => {
      if (settled) return;
      for (let i = 0; i < candidates.length; i++) {
        if (states[i] === "ok") {
          finish(candidates[i]);
          return;
        }
        if (states[i] === "pending" && !allowGraceWinner) {
          if (!graceTimer && states.some((s) => s === "ok")) {
            graceTimer = setTimeout(() => evaluate(true), graceMs);
          }
          return;
        }
      }
      if (allowGraceWinner || states.every((s) => s === "fail")) finish(undefined);
    };

    const hardTimer = setTimeout(() => evaluate(true), timeoutMs);

    candidates.forEach((candidate, idx) => {
      const sock = connect(candidate, port);
      sockets.push(sock);
      sock.once("connect", () => {
        if (states[idx] !== "pending") return;
        states[idx] = "ok";
        sock.destroy();
        evaluate(false);
      });
      sock.once("error", () => {
        if (states[idx] !== "pending") return;
        states[idx] = "fail";
        sock.destroy();
        evaluate(false);
      });
    });
  });
}
