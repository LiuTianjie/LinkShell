import { describe, expect, it } from "vitest";
import {
  channelKeys,
  checkPairingProof,
  createIdentity,
  ephemeralKey,
  fromBase64,
  idOf,
  pairingProof,
  publicIdentity,
  randomBytes,
  SecureChannel,
  sign,
  toBase64,
  verifySignature,
} from "../src/crypto.js";

function handshake() {
  const device = createIdentity();
  const machine = createIdentity();
  const de = ephemeralKey();
  const me = ephemeralKey();
  const deviceKeys = channelKeys({ initiator: true, local: device, localEphemeral: de.secret, remoteBoxKey: machine.boxKey, remoteEphemeral: me.public });
  const machineKeys = channelKeys({ initiator: false, local: machine, localEphemeral: me.secret, remoteBoxKey: device.boxKey, remoteEphemeral: de.public });
  return { device, machine, de, me, deviceKeys, machineKeys };
}

describe("crypto", () => {
  it("round-trips base64url", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33, 100]) {
      const bytes = randomBytes(length);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
  });

  it("round-trips UTF-8 like the platform does", async () => {
    const { utf8, fromUtf8 } = await import("../src/crypto.js");
    for (const text of ["", "ascii", "中文 你好", "emoji 😀👍🏽", "\u0000\u007f\u0080\u07ff\u0800\uffff", "x".repeat(50_000) + "尾"]) {
      expect(utf8(text)).toEqual(new TextEncoder().encode(text));
      expect(fromUtf8(new TextEncoder().encode(text))).toBe(text);
    }
  });

  it("binds ids to keys and verifies signatures", () => {
    const identity = createIdentity();
    expect(identity.id).toBe(idOf(identity.signKey));
    const signature = sign(identity, "challenge");
    expect(verifySignature(identity.signKey, "challenge", signature)).toBe(true);
    expect(verifySignature(identity.signKey, "other", signature)).toBe(false);
    expect(verifySignature(createIdentity().signKey, "challenge", signature)).toBe(false);
  });

  it("agrees on keys only between the two static key holders", () => {
    const { deviceKeys, machineKeys, device, de, me } = handshake();
    expect(deviceKeys.send).toEqual(machineKeys.receive);
    expect(deviceKeys.receive).toEqual(machineKeys.send);
    expect(deviceKeys.send).not.toEqual(deviceKeys.receive);
    // Someone with the device's ephemeral but not the machine's static key (a gateway posing as the machine).
    const impostor = createIdentity();
    const forged = channelKeys({ initiator: false, local: impostor, localEphemeral: me.secret, remoteBoxKey: device.boxKey, remoteEphemeral: de.public });
    expect(forged.receive).not.toEqual(deviceKeys.send);
  });

  it("encrypts in order and rejects replays and tampering", () => {
    const { deviceKeys, machineKeys } = handshake();
    const phone = new SecureChannel(deviceKeys);
    const mac = new SecureChannel(machineKeys);
    const one = phone.seal('{"method":"sessions.list"}');
    const two = phone.seal("second");
    expect(one).not.toContain("sessions.list");
    expect(mac.open(one)).toBe('{"method":"sessions.list"}');
    expect(mac.open(two)).toBe("second");
    expect(() => mac.open(one)).toThrow();
    const three = phone.seal("third");
    const tampered = three.slice(0, -2) + (three.endsWith("A") ? "BB" : "AA");
    expect(() => mac.open(tampered)).toThrow();
    expect(new SecureChannel(machineKeys).open(phone.seal("reply-direction-check"))).toBe("reply-direction-check");
  });

  it("checks pairing proofs against the QR secret", () => {
    const secret = toBase64(randomBytes(32));
    const device = publicIdentity(createIdentity());
    const proof = pairingProof(secret, device);
    expect(checkPairingProof(secret, device, proof)).toBe(true);
    expect(checkPairingProof(toBase64(randomBytes(32)), device, proof)).toBe(false);
    expect(checkPairingProof(secret, publicIdentity(createIdentity()), proof)).toBe(false);
  });
});
