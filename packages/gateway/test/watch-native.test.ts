import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { it, expect } from "vitest";
import { createIdentity, RelayClient, answerTunnel, checkPairingProof, codeSecret, type RelaySocket, type SecureChannel } from "@linkshell/wire";
import { startGateway } from "../src/serve.js";

it.skipIf(process.platform !== "darwin")("native Swift pairs over HTTPS polling and exchanges authenticated encrypted RPC with a WebSocket host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linkshell-native-poll-"));
  const gateway = await startGateway({ port: 0, host: "127.0.0.1", databasePath: join(dir, "relay.db"), log: () => {} });
  const identity = createIdentity();
  const host = new RelayClient({ url: `ws://127.0.0.1:${gateway.port}/v2/connect`, identity, role: "machine", name: "Isolated test computer", createSocket: url => new WebSocket(url) as unknown as RelaySocket });
  let proofVerified = false, calls = 0;
  const channels = new Map<string, SecureChannel>();
  try {
    host.start(); expect(await host.waitOnline(5000)).toBe(true);
    const { code } = await host.request("pair.offer", {});
    host.on("pair.request", request => {
      proofVerified = checkPairingProof(codeSecret(code), request.device, request.proof);
      void host.request("pair.decide", { requestId: request.requestId, accept: proofVerified });
    });
    host.onFrame((from, _via, frame) => {
      if (frame.k === "hello") {
        const answer = answerTunnel(identity, from, frame); channels.set(frame.ch, answer.channel); host.send(from.id, answer.welcome);
      } else if (frame.k === "data") {
        const channel = channels.get(frame.ch)!;
        const message = JSON.parse(channel.open(frame.box)); calls++;
        host.send(from.id, { k: "data", ch: frame.ch, box: channel.seal(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { name: "Isolated test computer" } })) });
      }
    });
    const source = join(dir, "Harness.swift"), binary = join(dir, "watch-relay");
    writeFileSync(source, `import Foundation
@main struct Harness {
  @MainActor static func main() async throws {
    let identity = WatchIdentity()
    let relay = WatchRelay(url: URL(string: CommandLine.arguments[1])!, identity: identity, token: nil)
    var ready = false
    var failure: Error?
    relay.onReady = { ready = true }
    relay.onClosed = { failure = $0 }
    relay.start()
    defer { relay.stop() }
    for _ in 0..<200 { if ready || failure != nil { break }; try await Task.sleep(nanoseconds: 50_000_000) }
    if let failure { throw failure }
    guard ready else { fatalError("authentication timeout") }
    let code = CommandLine.arguments[2]
    let paired = try await relay.request("pair.claim", params: ["code": code, "proof": identity.pairingProof(code)])
    let machine = try JSONDecoder().decode(WatchMachine.self, from: JSONSerialization.data(withJSONObject: paired["machine"]!))
    let listed = try await relay.request("machines.list")
    guard (listed["machines"] as? [[String: Any]])?.count == 1 else { fatalError("pairing not persisted") }
    let opening = try WatchTunnelOpening(identity: identity, machine: machine.identity)
    var channel: WatchSecureChannel?
    var result = ""
    relay.onFrame = { peer, frame in
      do {
        guard peer == machine.identity else { fatalError("wrong peer") }
        if frame["k"] as? String == "welcome" {
          channel = try opening.accept(frame)
          try relay.send(to: machine.id, frame: ["k": "data", "ch": opening.channel, "box": channel!.seal("{\\"jsonrpc\\":\\"2.0\\",\\"id\\":\\"native-check\\",\\"method\\":\\"machine.info\\",\\"params\\":{}}")])
        } else if let box = frame["box"] as? String { result = try channel!.open(box) }
      } catch { failure = error }
    }
    try relay.send(to: machine.id, frame: opening.hello)
    for _ in 0..<200 { if !result.isEmpty || failure != nil { break }; try await Task.sleep(nanoseconds: 50_000_000) }
    if let failure { throw failure }
    guard result.contains("Isolated test computer") else { fatalError("encrypted RPC timeout") }
    print("native encrypted pairing RPC passed")
  }
}`);
    const swift = resolve(import.meta.dirname, "../../../apps/client/plugins/watch");
    await promisify(execFile)("xcrun", ["swiftc", "-parse-as-library", join(swift, "WatchCrypto.swift"), join(swift, "WatchRelay.swift"), source, "-o", binary]);
    const { stdout } = await promisify(execFile)(binary, [`http://127.0.0.1:${gateway.port}`, code], { timeout: 25_000 });
    expect(stdout).toContain("native encrypted pairing RPC passed");
    expect(proofVerified).toBe(true); expect(calls).toBe(1);
  } finally { host.stop(); await gateway.close(); rmSync(dir, { recursive: true, force: true }); }
}, 45_000);
