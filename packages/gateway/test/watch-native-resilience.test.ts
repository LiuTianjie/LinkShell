import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer, request as forward, type Server } from "node:http";
import { promisify } from "node:util";
import WebSocket from "ws";
import { it, expect } from "vitest";
import { createIdentity, RelayClient, answerTunnel, checkPairingProof, codeSecret, type RelaySocket, type SecureChannel } from "@linkshell/wire";
import { startGateway } from "../src/serve.js";

// A watch's network drops whenever the wrist goes down and a gateway behind a proxy answers 502–504
// while it restarts: the relay must ride that out without losing or repeating frames, and when it
// is let go it must first deliver the tunnel's close so the host stops streaming to a dead watch.
it.skipIf(process.platform !== "darwin")("native Swift relay retries transient gateway failures and delivers a tunnel close before stopping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linkshell-watch-resilience-"));
  const gateway = await startGateway({ port: 0, host: "127.0.0.1", databasePath: join(dir, "relay.db"), log: () => {} });
  // Answers the next `failNext` poll exchanges with 503 itself, as a proxy in front of a restarting gateway would.
  let failNext = 0, failed = 0;
  const proxy: Server = createServer((incoming, outgoing) => {
    if (failNext > 0 && incoming.url?.startsWith("/v2/poll/")) {
      failNext--; failed++;
      incoming.resume();
      outgoing.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad_gateway" }));
      return;
    }
    const upstream = forward({ host: "127.0.0.1", port: gateway.port, path: incoming.url, method: incoming.method, headers: incoming.headers }, (reply) => {
      outgoing.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(outgoing);
    });
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const proxyPort = (proxy.address() as { port: number }).port;
  const identity = createIdentity();
  const host = new RelayClient({ url: `ws://127.0.0.1:${gateway.port}/v2/connect`, identity, role: "machine", name: "Resilience test", createSocket: url => new WebSocket(url) as unknown as RelaySocket });
  const channels = new Map<string, SecureChannel>();
  const closed: string[] = [];
  let calls = 0;
  try {
    host.start(); expect(await host.waitOnline(5000)).toBe(true);
    const { code } = await host.request("pair.offer", {});
    host.on("pair.request", request => {
      void host.request("pair.decide", { requestId: request.requestId, accept: checkPairingProof(codeSecret(code), request.device, request.proof) });
    });
    host.onFrame((from, _via, frame) => {
      if (frame.k === "hello") {
        // The welcome has to get through three failed exchanges.
        failNext = 3;
        const answer = answerTunnel(identity, from, frame); channels.set(frame.ch, answer.channel); host.send(from.id, answer.welcome);
      } else if (frame.k === "data") {
        const channel = channels.get(frame.ch)!;
        const message = JSON.parse(channel.open(frame.box)); calls++;
        host.send(from.id, { k: "data", ch: frame.ch, box: channel.seal(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { n: calls } })) });
      } else if (frame.k === "close") closed.push(frame.ch);
    });
    const source = join(dir, "Harness.swift"), binary = join(dir, "watch-resilience");
    writeFileSync(source, `import Foundation
@main struct Harness {
  @MainActor static func main() async throws {
    // Transient failures back off and give up after the window; fatal ones never retry.
    var retry = WatchRetry()
    let t0 = Date()
    var delays: [UInt64] = []
    for (offset, error) in [(0.0, URLError(.networkConnectionLost) as Error), (1, URLError(.notConnectedToInternet)), (3, WatchGatewayUnavailable(status: 503, code: "gateway_busy")), (6, URLError(.timedOut))] {
      guard let delay = retry.delay(after: error, now: t0.addingTimeInterval(offset)) else { fatalError("transient error not retried") }
      delays.append(delay)
    }
    precondition(delays == delays.sorted() && delays[0] < delays[3] && delays.allSatisfy { $0 <= 4_000_000_000 }, "backoff does not grow within its cap")
    precondition(retry.delay(after: URLError(.timedOut), now: t0.addingTimeInterval(WatchRetry.window + 1)) == nil, "retried past its window")
    var fatal = WatchRetry()
    precondition(fatal.delay(after: WatchLinkError("登录已过期")) == nil && fatal.delay(after: WatchPollRefused(code: "invalid_ack")) == nil, "fatal error retried")

    let identity = WatchIdentity()
    let relay = WatchRelay(url: URL(string: CommandLine.arguments[1])!, identity: identity, token: nil)
    var ready = false
    var failure: Error?
    relay.onReady = { ready = true }
    relay.onClosed = { failure = $0 }
    relay.start()
    for _ in 0..<200 { if ready || failure != nil { break }; try await Task.sleep(nanoseconds: 50_000_000) }
    if let failure { throw failure }
    let code = CommandLine.arguments[2]
    let paired = try await relay.request("pair.claim", params: ["code": code, "proof": identity.pairingProof(code)])
    let machine = try JSONDecoder().decode(WatchMachine.self, from: JSONSerialization.data(withJSONObject: paired["machine"]!))
    let opening = try WatchTunnelOpening(identity: identity, machine: machine.identity)
    var channel: WatchSecureChannel?
    var replies: [String] = []
    relay.onFrame = { _, frame in
      do {
        if frame["k"] as? String == "welcome" { channel = try opening.accept(frame) }
        else if let box = frame["box"] as? String { replies.append(try channel!.open(box)) }
      } catch { failure = error }
    }
    try relay.send(to: machine.id, frame: opening.hello)
    for _ in 0..<300 { if channel != nil || failure != nil { break }; try await Task.sleep(nanoseconds: 50_000_000) }
    if let failure { throw failure }
    guard let channel else { fatalError("no welcome through the failing gateway") }
    for n in 1...2 {
      try relay.send(to: machine.id, frame: ["k": "data", "ch": opening.channel, "box": channel.seal("{\\"jsonrpc\\":\\"2.0\\",\\"id\\":\\"r\\(n)\\",\\"method\\":\\"t\\",\\"params\\":{}}")])
      for _ in 0..<100 { if replies.count == n || failure != nil { break }; try await Task.sleep(nanoseconds: 50_000_000) }
    }
    if let failure { throw failure }
    precondition(replies.count == 2, "RPC lost after the retries")
    try relay.send(to: machine.id, frame: ["k": "close", "ch": opening.channel])
    await relay.finish()
    precondition(!relay.ready, "relay still running after finish")
    print("resilience passed channel=\\(opening.channel)")
  }
}`);
    const swift = resolve(import.meta.dirname, "../../../apps/client/plugins/watch");
    await promisify(execFile)("xcrun", ["swiftc", "-parse-as-library", join(swift, "WatchCrypto.swift"), join(swift, "WatchRelay.swift"), source, "-o", binary]);
    const { stdout } = await promisify(execFile)(binary, [`http://127.0.0.1:${proxyPort}`, code], { timeout: 40_000 });
    const channel = /resilience passed channel=(\S+)/.exec(stdout)?.[1];
    expect(channel).toBeTruthy();
    expect(failed).toBe(3);
    // Each RPC reached the host exactly once despite the retried exchanges.
    expect(calls).toBe(2);
    // finish() returned only after the close was delivered.
    await new Promise((done) => setTimeout(done, 200));
    expect(closed).toEqual([channel]);
  } finally {
    host.stop(); proxy.close(); await gateway.close(); rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
