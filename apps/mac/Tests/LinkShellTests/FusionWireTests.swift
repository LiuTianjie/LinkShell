import Network
import XCTest
@testable import LinkShell

/// The Fusion control channel over loopback: only a peer holding the session token can finish
/// the TLS-PSK handshake and exchange frames.
final class FusionWireTests: XCTestCase {
  private func listen(token: String, accepted: @escaping (FusionWire) -> Void) throws -> (NWListener, UInt16) {
    let listener = try NWListener(using: FusionWire.parameters(token: token), on: .any)
    let ready = expectation(description: "listening")
    listener.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
    listener.newConnectionHandler = { connection in
      let wire = FusionWire(connection)
      accepted(wire)
      wire.start()
    }
    listener.start(queue: .main)
    wait(for: [ready], timeout: 5)
    return (listener, listener.port!.rawValue)
  }

  private func dial(port: UInt16, token: String) -> FusionWire {
    let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: FusionWire.parameters(token: token))
    return FusionWire(connection)
  }

  func testSameTokenExchangesFramedMessagesBothWays() throws {
    let token = "tok-\(UUID().uuidString)"
    let serverHeard = expectation(description: "server heard hello")
    let clientHeard = expectation(description: "client heard reply")
    var serverWires: [FusionWire] = []
    let (listener, port) = try listen(token: token) { wire in
      serverWires.append(wire)
      wire.onMessage = { message in
        XCTAssertEqual(message["t"] as? String, "hello")
        XCTAssertEqual(message["n"] as? Int, 42)
        serverHeard.fulfill()
        wire.send(["t": "apps", "apps": [["bundle": "com.example.App"]]])
      }
    }
    defer { listener.cancel() }
    let client = dial(port: port, token: token)
    client.onReady = { client.send(["t": "hello", "n": 42]) }
    client.onMessage = { message in
      XCTAssertEqual(message["t"] as? String, "apps")
      clientHeard.fulfill()
    }
    client.start()
    wait(for: [serverHeard, clientHeard], timeout: 10)
    client.close()
    serverWires.forEach { $0.close() }
  }

  func testWrongTokenNeverDeliversAMessage() throws {
    let serverHeard = expectation(description: "server must hear nothing")
    serverHeard.isInverted = true
    let clientClosed = expectation(description: "client gives up")
    var serverWires: [FusionWire] = []
    let (listener, port) = try listen(token: "right-token") { wire in
      serverWires.append(wire)
      wire.onMessage = { _ in serverHeard.fulfill() }
    }
    defer { listener.cancel() }
    let client = dial(port: port, token: "wrong-token")
    client.waitingTimeout = 2
    var readied = false
    client.onReady = { readied = true; client.send(["t": "hello"]) }
    client.onClose = { _ in clientClosed.fulfill() }
    client.start()
    wait(for: [clientClosed], timeout: 10)
    wait(for: [serverHeard], timeout: 1)
    XCTAssertFalse(readied, "a handshake with the wrong key must not complete")
    serverWires.forEach { $0.close() }
  }

  /// Rotating the token recreates the listener; the session already accepted must survive that.
  func testAcceptedConnectionOutlivesItsListener() throws {
    let token = "tok-\(UUID().uuidString)"
    let accepted = expectation(description: "accepted")
    let second = expectation(description: "message after the listener is gone")
    var serverWires: [FusionWire] = []
    var count = 0
    let (listener, port) = try listen(token: token) { wire in
      serverWires.append(wire)
      wire.onMessage = { _ in
        count += 1
        if count == 1 { accepted.fulfill() } else { second.fulfill() }
      }
    }
    let client = dial(port: port, token: token)
    client.onReady = { client.send(["t": "one"]) }
    client.start()
    wait(for: [accepted], timeout: 10)
    listener.cancel()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { client.send(["t": "two"]) }
    wait(for: [second], timeout: 5)
    client.close()
    serverWires.forEach { $0.close() }
  }

  func testWatchdogClosesASilentPeer() throws {
    let token = "tok-\(UUID().uuidString)"
    let closed = expectation(description: "watchdog closed the server side")
    var serverWires: [FusionWire] = []
    let (listener, port) = try listen(token: token) { wire in
      serverWires.append(wire)
      wire.onClose = { reason in
        XCTAssertEqual(reason, "timeout")
        closed.fulfill()
      }
      wire.startWatchdog(timeout: 1.5)
    }
    defer { listener.cancel() }
    let client = dial(port: port, token: token)
    client.start()
    wait(for: [closed], timeout: 8)
    client.close()
  }

  func testSlugIsStableAndSharedWithTheDesktopMain() {
    // Same vector as apps/desktop/test/fusion-probe.test.mjs (`fusionSlug`).
    XCTAssertEqual(Fusion.slug(computerKey: "wss://gateway.example#machine-1"), Fusion.slug(computerKey: "wss://gateway.example#machine-1"))
    XCTAssertEqual(Fusion.slug(computerKey: "wss://gateway.example#machine-1").count, 12)
    XCTAssertNotEqual(Fusion.slug(computerKey: "a"), Fusion.slug(computerKey: "b"))
    XCTAssertEqual(Fusion.slug(computerKey: "wss://gateway.example#machine-1"), FusionWireTests.sharedVector)
  }

  static let sharedVector = "25b8b967c6e4"
}
