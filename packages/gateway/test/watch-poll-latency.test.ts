import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { it, expect } from "vitest";
import { createIdentity, RelayClient, answerTunnel, checkPairingProof, codeSecret, type RelaySocket, type SecureChannel } from "@linkshell/wire";
import { startGateway } from "../src/serve.js";

// A watch RPC that follows another (refresh, then act) must not wait out the long poll that was
// parked when it was queued. Before, each chained call could add up to the 1 s poll wait.
it.skipIf(process.platform !== "darwin")("native Swift relay sends chained requests without waiting out a parked poll", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linkshell-poll-latency-"));
  const gateway = await startGateway({ port: 0, host: "127.0.0.1", databasePath: join(dir, "relay.db"), log: () => {} });
  const identity = createIdentity();
  const host = new RelayClient({ url: `ws://127.0.0.1:${gateway.port}/v2/connect`, identity, role: "machine", name: "Latency test", createSocket: url => new WebSocket(url) as unknown as RelaySocket });
  const channels = new Map<string, SecureChannel>();
  try {
    host.start(); expect(await host.waitOnline(5000)).toBe(true);
    const { code } = await host.request("pair.offer", {});
    host.on("pair.request", request => {
      void host.request("pair.decide", { requestId: request.requestId, accept: checkPairingProof(codeSecret(code), request.device, request.proof) });
    });
    host.onFrame((from, _via, frame) => {
      if (frame.k === "hello") {
        const answer = answerTunnel(identity, from, frame); channels.set(frame.ch, answer.channel); host.send(from.id, answer.welcome);
      } else if (frame.k === "data") {
        const channel = channels.get(frame.ch)!;
        const message = JSON.parse(channel.open(frame.box));
        host.send(from.id, { k: "data", ch: frame.ch, box: channel.seal(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { n: message.params.n } })) });
      }
    });
    const source = join(dir, "Harness.swift"), binary = join(dir, "watch-latency");
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
    let code = CommandLine.arguments[2]
    let paired = try await relay.request("pair.claim", params: ["code": code, "proof": identity.pairingProof(code)])
    let machine = try JSONDecoder().decode(WatchMachine.self, from: JSONSerialization.data(withJSONObject: paired["machine"]!))
    let opening = try WatchTunnelOpening(identity: identity, machine: machine.identity)
    var channel: WatchSecureChannel?
    var replies: [Int: CheckedContinuation<Void, Never>] = [:]
    relay.onFrame = { _, frame in
      do {
        if frame["k"] as? String == "welcome" { channel = try opening.accept(frame) }
        else if let box = frame["box"] as? String {
          let text = try channel!.open(box)
          let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
          let n = (object["result"] as! [String: Any])["n"] as! Int
          replies.removeValue(forKey: n)?.resume()
        }
      } catch { failure = error }
    }
    try relay.send(to: machine.id, frame: opening.hello)
    for _ in 0..<200 { if channel != nil || failure != nil { break }; try await Task.sleep(nanoseconds: 50_000_000) }
    guard let channel else { fatalError("no tunnel") }
    // Let the loop settle into a parked empty poll before timing.
    try await Task.sleep(nanoseconds: 1_300_000_000)
    func call(_ n: Int) async throws {
      await withCheckedContinuation { continuation in
        replies[n] = continuation
        try? relay.send(to: machine.id, frame: ["k": "data", "ch": opening.channel, "box": channel.seal("{\\"jsonrpc\\":\\"2.0\\",\\"id\\":\\"c\\(n)\\",\\"method\\":\\"t\\",\\"params\\":{\\"n\\":\\(n)}}")])
      }
    }
    var worst = 0.0
    for round in 0..<3 {
      let start = Date()
      for step in 0..<5 { try await call(round * 10 + step) }
      worst = max(worst, Date().timeIntervalSince(start))
      try await Task.sleep(nanoseconds: 1_300_000_000)
    }
    if let failure { throw failure }
    print("chained5_worst_ms=\\(Int(worst * 1000))")
  }
}`);
    const swift = resolve(import.meta.dirname, "../../../apps/client/plugins/watch");
    await promisify(execFile)("xcrun", ["swiftc", "-parse-as-library", join(swift, "WatchCrypto.swift"), join(swift, "WatchRelay.swift"), source, "-o", binary]);
    const { stdout } = await promisify(execFile)(binary, [`http://127.0.0.1:${gateway.port}`, code], { timeout: 40_000 });
    const worst = Number(/chained5_worst_ms=(\d+)/.exec(stdout)?.[1]);
    // Five calls in a row on loopback: well under one parked poll each. The old relay took ~1 s per call.
    expect(worst).toBeLessThan(1500);
  } finally { host.stop(); await gateway.close(); rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
