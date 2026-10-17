import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { answerTunnel, channelKeys, createIdentity, ephemeralKey, gatewayChallengeMessage, pairingProof, codeSecret, publicIdentity, SecureChannel, sign, toBase64, verifySignature } from "@linkshell/wire";

describe.skipIf(process.platform !== "darwin")("Native Watch crypto interoperates with existing hosts", () => {
  it("matches identity, Ed25519, pairing proof, Noise keys and XChaCha framing; rejects replay and tampering", () => {
    const dir = mkdtempSync(join(tmpdir(), "linkshell-watch-crypto-"));
    try {
      const device = createIdentity(), machine = createIdentity(), eph = ephemeralKey();
      const hello = { k: "hello" as const, ch: "native-test", eph: eph.public, sig: sign(device, `linkshell-tunnel-v2:hello:native-test:${device.id}:${machine.id}:${eph.public}`) };
      const remote = answerTunnel(machine, publicIdentity(device), hello);
      const local = new SecureChannel(channelKeys({ initiator: true, local: device, localEphemeral: eph.secret, remoteBoxKey: machine.boxKey, remoteEphemeral: remote.welcome.eph }));
      const plaintext = "中文审批与终端输出 👋\nline two";
      const fixture = { device, machine: publicIdentity(machine), eph: toBase64(eph.secret), welcome: remote.welcome, encrypted: remote.channel.seal(plaintext), plaintext };
      const fixturePath = join(dir, "fixture.json");
      writeFileSync(fixturePath, JSON.stringify(fixture));
      const harness = join(dir, "main.swift");
      writeFileSync(harness, `import Foundation
import CryptoKit
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let f = try JSONSerialization.jsonObject(with: data) as! [String: Any]
let d = f["device"] as! [String: String]
let identity = WatchIdentity(signSecret: try Data(watchBase64: d["signSecret"]!), boxSecret: try Data(watchBase64: d["boxSecret"]!))
let machine = try JSONDecoder().decode(WatchPeerIdentity.self, from: JSONSerialization.data(withJSONObject: f["machine"]!))
let opening = try WatchTunnelOpening(identity: identity, machine: machine, channel: "native-test", ephemeral: Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(watchBase64: f["eph"] as! String)))
let channel = try opening.accept(f["welcome"] as! [String: Any])
let encrypted = f["encrypted"] as! String
let plain = try channel.open(encrypted)
var rejected = 0
do { _ = try channel.open(encrypted) } catch { rejected += 1 }
var welcome = f["welcome"] as! [String: Any]; welcome["sig"] = Data(repeating: 0, count: 64).watchBase64
do { _ = try opening.accept(welcome) } catch { rejected += 1 }
let fresh = try opening.accept(f["welcome"] as! [String: Any])
var tampered = try Data(watchBase64: String(encrypted.split(separator: ".")[1])); tampered[0] ^= 1
do { _ = try fresh.open("1." + tampered.watchBase64) } catch { rejected += 1 }
let result: [String: Any] = ["peer": try JSONSerialization.jsonObject(with: JSONEncoder().encode(identity.peer)), "hello": try opening.hello, "signature": try identity.sign("linkshell-gateway-v2:nonce"), "proof": try identity.pairingProof("123456"), "plain": plain, "encrypted": try channel.seal(f["plaintext"] as! String), "rejected": rejected]
print(String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self))
`);
      const binary = join(dir, "crypto-test");
      execFileSync("xcrun", ["swiftc", resolve(import.meta.dirname, "../plugins/watch/WatchCrypto.swift"), harness, "-o", binary], { stdio: "pipe" });
      const result = JSON.parse(execFileSync(binary, [fixturePath], { encoding: "utf8" }));
      expect(result.peer).toEqual(publicIdentity(device));
      expect({ ...result.hello, sig: hello.sig }).toEqual(hello);
      expect(verifySignature(device.signKey, `linkshell-tunnel-v2:hello:native-test:${device.id}:${machine.id}:${eph.public}`, result.hello.sig)).toBe(true);
      expect(verifySignature(device.signKey, gatewayChallengeMessage("nonce"), result.signature)).toBe(true);
      expect(result.proof).toBe(pairingProof(codeSecret("123456"), publicIdentity(device)));
      expect(result.plain).toBe(plaintext);
      expect(result.encrypted).toBe(local.seal(plaintext));
      expect(remote.channel.open(result.encrypted)).toBe(plaintext);
      expect(result.rejected).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
