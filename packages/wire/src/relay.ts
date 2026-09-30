import { z } from "zod";
import {
  channelKeys,
  ephemeralKey,
  SecureChannel,
  sign,
  verifySignature,
  type Identity,
  type PublicIdentity,
} from "./crypto.js";

// Gateway v2 frames. The gateway authenticates peers by their keys, routes
// opaque frames between a device and a machine it is allowed to reach, and
// brokers pairing. Everything inside a routed frame is end-to-end encrypted:
// the gateway never sees RPC, session content or terminal output.

export const RELAY_PATH = "/v2/connect";

export const publicIdentitySchema = z.object({ id: z.string(), signKey: z.string(), boxKey: z.string() });

export const peerRoleSchema = z.enum(["machine", "device"]);
export type PeerRole = z.infer<typeof peerRoleSchema>;

/** A machine as a device sees it in the gateway's list. */
export const machineEntrySchema = publicIdentitySchema.extend({
  name: z.string(),
  platform: z.string().optional(),
  online: z.boolean(),
  /** How this device may reach it: it paired, or both belong to the same account. */
  via: z.enum(["paired", "account"]),
});
export type MachineEntry = z.infer<typeof machineEntrySchema>;

export const deviceEntrySchema = publicIdentitySchema.extend({
  name: z.string(),
  online: z.boolean(),
  pairedAt: z.number().optional(),
});
export type DeviceEntry = z.infer<typeof deviceEntrySchema>;

// ── peer → gateway ───────────────────────────────────────────────────

export const clientFrameSchema = z.discriminatedUnion("t", [
  /** Answer to the challenge: a signature over it proves the key. */
  z.object({
    t: z.literal("auth"),
    role: peerRoleSchema,
    identity: publicIdentitySchema,
    signature: z.string(),
    name: z.string().max(120),
    platform: z.string().max(40).optional(),
    /** Account access token, when signed in. */
    token: z.string().optional(),
  }),
  z.object({ t: z.literal("req"), id: z.number().int(), method: z.string(), params: z.unknown().optional() }),
  /** An encrypted frame for a peer. */
  z.object({ t: z.literal("to"), to: z.string(), d: z.string().max(40 * 1024 * 1024) }),
  z.object({ t: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

// ── gateway → peer ───────────────────────────────────────────────────

export const serverFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("challenge"), nonce: z.string() }),
  z.object({ t: z.literal("ready"), userId: z.string().optional(), email: z.string().optional() }),
  z.object({
    t: z.literal("res"),
    id: z.number().int(),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  z.object({ t: z.literal("event"), name: z.string(), data: z.unknown() }),
  /** An encrypted frame from a peer, with the keys the gateway verified it holds. */
  z.object({ t: z.literal("from"), from: publicIdentitySchema, via: z.enum(["paired", "account"]), d: z.string() }),
  /** A frame couldn't be delivered: the peer is offline or not reachable. */
  z.object({ t: z.literal("undeliverable"), to: z.string(), reason: z.string() }),
  z.object({ t: z.literal("pong") }),
  z.object({ t: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

/** Control methods and their results. */
export interface RelayMethods {
  /** Machine: open a pairing window. The QR carries `secret`; the code is for typing. */
  "pair.offer": { params: { secretHash?: string }; result: { code: string; expiresAt: number } };
  /** Machine: accept or refuse a claim it received as a `pair.request` event. */
  "pair.decide": { params: { requestId: string; accept: boolean }; result: Record<string, never> };
  /** Device: claim a pairing by code (typed) or by machine id (scanned). */
  "pair.claim": {
    params: { code?: string; machineId?: string; proof: string };
    result: { machine: MachineEntry };
  };
  "machines.list": { params: Record<string, never>; result: { machines: MachineEntry[] } };
  "machines.forget": { params: { machineId: string }; result: Record<string, never> };
  "devices.list": { params: Record<string, never>; result: { devices: DeviceEntry[] } };
  "devices.revoke": { params: { deviceId: string }; result: Record<string, never> };
}
export type RelayMethod = keyof RelayMethods;

/** Events the gateway pushes. */
export interface RelayEvents {
  /** To a machine: a device wants to pair. */
  "pair.request": { requestId: string; device: PublicIdentity & { name: string }; proof: string; code: string };
  /** To a machine: pairing finished (accepted or not). */
  "pair.done": { requestId: string; accepted: boolean; device?: DeviceEntry };
  /** A reachable peer came online or went offline. */
  presence: { id: string; online: boolean };
  /** To a device: the list of reachable machines changed (paired, revoked, account). */
  "machines.changed": Record<string, never>;
}

/**
 * What `linkshell pair` puts in the QR code, kept short so the code stays
 * scannable: the gateway, the machine's signing key (its id derives from it,
 * and every channel is checked against it), a one-time secret and the code.
 * The machine's name and box key come from the gateway; a wrong box key can't
 * break a channel's secrecy because the ephemeral keys are signed.
 */
export interface PairingLink {
  gateway: string;
  signKey: string;
  secret: string;
  code: string;
}

export const PAIRING_LINK_PREFIX = "linkshell://pair?";

export function encodePairingLink(link: PairingLink): string {
  const params = new URLSearchParams({ g: link.gateway, k: link.signKey, s: link.secret, c: link.code });
  return PAIRING_LINK_PREFIX + params.toString();
}

export function decodePairingLink(text: string): PairingLink | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PAIRING_LINK_PREFIX)) return undefined;
  const params = new URLSearchParams(trimmed.slice(PAIRING_LINK_PREFIX.length));
  const gateway = params.get("g");
  const signKey = params.get("k");
  const secret = params.get("s");
  const code = params.get("c");
  if (!gateway || !signKey || !secret || !code || !/^(wss?|https?):\/\//.test(gateway)) return undefined;
  return { gateway, signKey, secret, code };
}

// ── end-to-end channel over the relay ────────────────────────────────

/**
 * Frames inside `to` / `from`. A device opens channel `ch` with `hello`, the
 * machine answers `welcome`; both sign their ephemeral key with their
 * long-term key, so neither can be impersonated by the gateway. After that
 * every frame is `data`, sealed with the channel keys.
 */
export const tunnelFrameSchema = z.discriminatedUnion("k", [
  z.object({ k: z.literal("hello"), ch: z.string(), eph: z.string(), sig: z.string() }),
  z.object({ k: z.literal("welcome"), ch: z.string(), eph: z.string(), sig: z.string() }),
  z.object({ k: z.literal("data"), ch: z.string(), box: z.string() }),
  z.object({ k: z.literal("close"), ch: z.string(), reason: z.string().optional() }),
  z.object({ k: z.literal("refuse"), ch: z.string(), code: z.string(), message: z.string() }),
]);
export type TunnelFrame = z.infer<typeof tunnelFrameSchema>;

function helloMessage(kind: "hello" | "welcome", channel: string, from: string, to: string, eph: string): string {
  return `linkshell-tunnel-v2:${kind}:${channel}:${from}:${to}:${eph}`;
}

/** Device side: start a channel to `machine`. */
export function openTunnel(device: Identity, machine: PublicIdentity, channel: string) {
  const eph = ephemeralKey();
  const hello: TunnelFrame = {
    k: "hello",
    ch: channel,
    eph: eph.public,
    sig: sign(device, helloMessage("hello", channel, device.id, machine.id, eph.public)),
  };
  return {
    hello,
    /** Checks the machine's answer and returns the channel, or throws. */
    accept(welcome: Extract<TunnelFrame, { k: "welcome" }>): SecureChannel {
      if (!verifySignature(machine.signKey, helloMessage("welcome", channel, machine.id, device.id, welcome.eph), welcome.sig)) {
        throw new Error("the computer's key doesn't match: refusing to connect");
      }
      return new SecureChannel(
        channelKeys({ initiator: true, local: device, localEphemeral: eph.secret, remoteBoxKey: machine.boxKey, remoteEphemeral: welcome.eph }),
      );
    },
  };
}

/** Machine side: answer a device's hello. Throws when the signature is wrong. */
export function answerTunnel(machine: Identity, device: PublicIdentity, hello: Extract<TunnelFrame, { k: "hello" }>) {
  if (!verifySignature(device.signKey, helloMessage("hello", hello.ch, device.id, machine.id, hello.eph), hello.sig)) {
    throw new Error("bad hello signature");
  }
  const eph = ephemeralKey();
  const welcome: TunnelFrame = {
    k: "welcome",
    ch: hello.ch,
    eph: eph.public,
    sig: sign(machine, helloMessage("welcome", hello.ch, machine.id, device.id, eph.public)),
  };
  const channel = new SecureChannel(
    channelKeys({ initiator: false, local: machine, localEphemeral: eph.secret, remoteBoxKey: device.boxKey, remoteEphemeral: hello.eph }),
  );
  return { welcome, channel };
}
