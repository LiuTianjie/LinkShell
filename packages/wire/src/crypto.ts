import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

// End-to-end encryption between a device and a machine, through a gateway
// that only ever sees ciphertext.
//
// Identity: every machine and device has an Ed25519 key (proves who it is to
// the gateway) and an X25519 key (agrees on channel keys). Its id is derived
// from the Ed25519 key, so an id can't be claimed without the key.
//
// Channel: the device opens with a fresh ephemeral key, the machine answers
// with one; both mix ee, es, se and ss Diffie-Hellman results (Noise-KK
// style), so only the two holders of the static keys agree on the keys, and a
// stolen static key doesn't decrypt past channels. Each direction has its own
// XChaCha20-Poly1305 key and a counter nonce that must strictly increase.

// UTF-8 by hand: not every JS engine LinkShell runs on has TextDecoder.
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}

export function fromUtf8(bytes: Uint8Array): string {
  let out = "";
  let chunk: number[] = [];
  const flush = () => {
    out += String.fromCharCode(...chunk);
    chunk = [];
  };
  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i]!;
    let code: number;
    if (byte < 0x80) {
      code = byte;
      i += 1;
    } else if (byte >= 0xf0) {
      code = ((byte & 7) << 18) | ((bytes[i + 1]! & 63) << 12) | ((bytes[i + 2]! & 63) << 6) | (bytes[i + 3]! & 63);
      i += 4;
    } else if (byte >= 0xe0) {
      code = ((byte & 15) << 12) | ((bytes[i + 1]! & 63) << 6) | (bytes[i + 2]! & 63);
      i += 3;
    } else {
      code = ((byte & 31) << 6) | (bytes[i + 1]! & 63);
      i += 2;
    }
    if (code > 0xffff) {
      code -= 0x10000;
      chunk.push(0xd800 + (code >> 10), 0xdc00 + (code & 1023));
    } else chunk.push(code);
    if (chunk.length > 8000) flush();
  }
  flush();
  return out;
}

const encoder = { encode: utf8 };

// ── encoding (no Buffer / atob in every runtime) ─────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Map([...B64].map((ch, i) => [ch, i]));

/** Unpadded base64url. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of clean) {
    const digit = B64_INDEX.get(ch);
    if (digit === undefined) throw new Error("invalid base64");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

// ── identity ─────────────────────────────────────────────────────────

/** The public half, as shared with the gateway and peers. */
export interface PublicIdentity {
  id: string;
  /** Ed25519, base64url. */
  signKey: string;
  /** X25519, base64url. */
  boxKey: string;
}

/** Full identity, secrets included. Stored 0600 on machines, in the keychain on devices. */
export interface Identity extends PublicIdentity {
  signSecret: string;
  boxSecret: string;
}

/** An id is the first 16 bytes of SHA-256 of the Ed25519 key: bound to the key, short enough to show. */
export function idOf(signKey: string): string {
  return toBase64(sha256(fromBase64(signKey)).subarray(0, 16));
}

export function createIdentity(): Identity {
  const signSecret = randomBytes(32);
  const boxSecret = randomBytes(32);
  const signKey = toBase64(ed25519.getPublicKey(signSecret));
  return {
    id: idOf(signKey),
    signKey,
    boxKey: toBase64(x25519.getPublicKey(boxSecret)),
    signSecret: toBase64(signSecret),
    boxSecret: toBase64(boxSecret),
  };
}

export function publicIdentity(identity: Identity): PublicIdentity {
  return { id: identity.id, signKey: identity.signKey, boxKey: identity.boxKey };
}

export function sign(identity: Identity, message: string): string {
  return toBase64(ed25519.sign(encoder.encode(message), fromBase64(identity.signSecret)));
}

export function verifySignature(signKey: string, message: string, signature: string): boolean {
  try {
    return ed25519.verify(fromBase64(signature), encoder.encode(message), fromBase64(signKey));
  } catch {
    return false;
  }
}

/** What an identity signs to log in to a gateway: its challenge, bound to purpose. */
export function gatewayChallengeMessage(nonce: string): string {
  return `linkshell-gateway-v2:${nonce}`;
}

// ── pairing ──────────────────────────────────────────────────────────

/** Proves to a machine that the claiming device saw its pairing code (the QR's secret). */
export function pairingProof(secret: string, device: PublicIdentity): string {
  return toBase64(hmac(sha256, fromBase64(secret), encoder.encode(`${device.id}.${device.boxKey}`)));
}

/** The pairing secret behind a typed code, for devices that didn't scan the QR. */
export function codeSecret(code: string): string {
  return toBase64(sha256(encoder.encode(`linkshell-pair-code:${code}`)));
}

export function checkPairingProof(secret: string, device: PublicIdentity, proof: string): boolean {
  try {
    return equal(fromBase64(pairingProof(secret, device)), fromBase64(proof));
  } catch {
    return false;
  }
}

// ── channel ──────────────────────────────────────────────────────────

export interface ChannelKeys {
  send: Uint8Array;
  receive: Uint8Array;
}

/** A fresh ephemeral X25519 key pair for one channel. */
export function ephemeralKey(): { secret: Uint8Array; public: string } {
  const secret = randomBytes(32);
  return { secret, public: toBase64(x25519.getPublicKey(secret)) };
}

/**
 * Derives both directions' keys. `initiator` is the device. Both sides pass
 * their own statics and ephemeral secrets and the peer's public halves; the
 * mix is symmetric so they arrive at the same pair of keys.
 */
export function channelKeys(input: {
  initiator: boolean;
  local: Identity;
  localEphemeral: Uint8Array;
  remoteBoxKey: string;
  remoteEphemeral: string;
}): ChannelKeys {
  const localStatic = fromBase64(input.local.boxSecret);
  const remoteStatic = fromBase64(input.remoteBoxKey);
  const remoteEphemeral = fromBase64(input.remoteEphemeral);
  const ee = x25519.getSharedSecret(input.localEphemeral, remoteEphemeral);
  const ss = x25519.getSharedSecret(localStatic, remoteStatic);
  // "es" is initiator-ephemeral × responder-static; "se" the other way round.
  const localEphRemoteStatic = x25519.getSharedSecret(input.localEphemeral, remoteStatic);
  const localStaticRemoteEph = x25519.getSharedSecret(localStatic, remoteEphemeral);
  const es = input.initiator ? localEphRemoteStatic : localStaticRemoteEph;
  const se = input.initiator ? localStaticRemoteEph : localEphRemoteStatic;

  const localEphPublic = x25519.getPublicKey(input.localEphemeral);
  const [ie, re] = input.initiator ? [localEphPublic, remoteEphemeral] : [remoteEphemeral, localEphPublic];
  const [is, rs] = input.initiator
    ? [fromBase64(input.local.boxKey), remoteStatic]
    : [remoteStatic, fromBase64(input.local.boxKey)];
  const transcript = concat(encoder.encode("linkshell/v2/channel"), ie, re, is, rs);
  const okm = hkdf(sha256, concat(ee, es, se, ss), sha256(transcript), encoder.encode("linkshell/v2/keys"), 64);
  const toResponder = okm.subarray(0, 32);
  const toInitiator = okm.subarray(32, 64);
  return input.initiator ? { send: toResponder, receive: toInitiator } : { send: toInitiator, receive: toResponder };
}

function nonceFor(counter: number): Uint8Array {
  const nonce = new Uint8Array(24);
  const view = new DataView(nonce.buffer);
  view.setUint32(16, Math.floor(counter / 2 ** 32));
  view.setUint32(20, counter >>> 0);
  return nonce;
}

/**
 * One direction-keyed, ordered, encrypted stream of text frames. Frames that
 * fail to authenticate or arrive out of order are rejected.
 */
export class SecureChannel {
  private sent = 0;
  private received = 0;

  constructor(private readonly keys: ChannelKeys) {}

  seal(text: string): string {
    const counter = ++this.sent;
    const box = xchacha20poly1305(this.keys.send, nonceFor(counter)).encrypt(encoder.encode(text));
    return `${counter}.${toBase64(box)}`;
  }

  open(frame: string): string {
    const dot = frame.indexOf(".");
    const counter = Number(frame.slice(0, dot));
    if (!Number.isSafeInteger(counter) || counter <= this.received) throw new Error("replayed or out-of-order frame");
    const plain = xchacha20poly1305(this.keys.receive, nonceFor(counter)).decrypt(fromBase64(frame.slice(dot + 1)));
    this.received = counter;
    return fromUtf8(plain);
  }
}
