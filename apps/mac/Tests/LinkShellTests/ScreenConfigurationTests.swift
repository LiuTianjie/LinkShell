import Foundation
import XCTest
@testable import LinkShell

final class ScreenConfigurationTests: XCTestCase {
  private func configuration(_ id: Int, paused: Bool = false, generation: Int? = nil) -> ScreenConfiguration {
    ScreenConfiguration(requestId: id, screen: id % 2, maxWidth: 1920, maxFps: 120, paused: paused, inputGeneration: generation)
  }

  private func event(generation: Any? = nil) throws -> InputEvent {
    var command: [String: Any] = ["t": "down", "b": "left", "i": 1]
    if let generation { command["screenGeneration"] = generation }
    return try XCTUnwrap(InputEvent(json: JSONSerialization.data(withJSONObject: command)))
  }

  func testConfigurationRequiresSafeNumbersAndABooleanPause() throws {
    let valid: [String: Any] = ["requestId": 1, "screen": 0, "maxWidth": 1920, "maxFps": 120, "paused": false, "inputGeneration": 2]
    XCTAssertEqual(ScreenConfiguration(valid, defaultMaxFps: 60)?.inputGeneration, 2)
    let invalid: [(String, Any)] = [
      ("requestId", -1), ("requestId", true), ("requestId", 9_007_199_254_740_992),
      ("screen", -1), ("screen", 0.5), ("maxWidth", 639), ("maxWidth", 3841),
      ("maxWidth", "1920"), ("maxFps", 90), ("maxFps", true), ("paused", 0),
      ("inputGeneration", -1), ("inputGeneration", true), ("inputGeneration", 0.5),
    ]
    for (key, value) in invalid {
      var message = valid
      message[key] = value
      XCTAssertNil(ScreenConfiguration(message, defaultMaxFps: 60), "\(key)=\(value)")
    }
    var older = valid
    older["maxFps"] = nil
    XCTAssertEqual(ScreenConfiguration(older, defaultMaxFps: 30)?.maxFps, 30)
  }

  func testRapidRequestsOnlyApplyTheLatestAfterTheInflightCaptureStops() throws {
    var queue = ScreenConfigurationQueue()
    queue.enqueue(configuration(1))
    let first = try XCTUnwrap(queue.begin())
    queue.enqueue(configuration(2))
    queue.enqueue(configuration(3, paused: true))
    XCTAssertNil(queue.begin(), "An in-flight start/stop retains capture ownership")
    XCTAssertFalse(queue.isCurrent(first), "An obsolete callback cannot publish or reopen input")
    queue.finish(first)
    let latest = try XCTUnwrap(queue.begin())
    XCTAssertEqual(latest.configuration.requestId, 3)
    XCTAssertTrue(latest.configuration.paused)
    queue.finish(first)
    XCTAssertTrue(queue.busy, "A duplicate old callback cannot release a newer operation")
    XCTAssertTrue(queue.isCurrent(latest))
    queue.finish(latest)
    XCTAssertNil(queue.begin())
  }

  func testCloseInvalidatesInflightAndPendingCallbacks() throws {
    var queue = ScreenConfigurationQueue()
    queue.enqueue(configuration(1))
    let first = try XCTUnwrap(queue.begin())
    queue.enqueue(configuration(2))
    queue.cancel()
    XCTAssertFalse(queue.isCurrent(first))
    queue.finish(first)
    XCTAssertNil(queue.begin())
    XCTAssertFalse(queue.busy)
  }

  func testFailedConfigurationCanBeFollowedByAValidRetry() throws {
    var queue = ScreenConfigurationQueue()
    queue.enqueue(configuration(1))
    queue.finish(try XCTUnwrap(queue.begin()))
    queue.enqueue(configuration(2))
    let retry = try XCTUnwrap(queue.begin())
    XCTAssertTrue(queue.isCurrent(retry))
  }

  func testPauseAndConfigurationBlockEvenMatchingGeneration() throws {
    var gate = ScreenInputGate()
    XCTAssertTrue(gate.accepts(try event()), "Legacy input works before negotiation")
    gate.apply(configuration(1, generation: 8))
    XCTAssertFalse(gate.accepts(try event()))
    XCTAssertFalse(gate.accepts(try event(generation: true)))
    XCTAssertTrue(gate.accepts(try event(generation: 8)))
    gate.suspended = true
    XCTAssertFalse(gate.accepts(try event(generation: 8)))
    gate.apply(configuration(2, paused: true, generation: 9))
    XCTAssertFalse(gate.accepts(try event(generation: 9)))
    gate.apply(configuration(3, generation: 10))
    XCTAssertFalse(gate.accepts(try event(generation: 8)), "A delayed old-display click is dropped")
    XCTAssertFalse(gate.accepts(try event(generation: 9)))
    XCTAssertTrue(gate.accepts(try event(generation: 10)))
    gate.apply(configuration(4))
    XCTAssertFalse(gate.accepts(try event()), "Generation checking cannot be silently downgraded")
    XCTAssertTrue(gate.accepts(try event(generation: 10)))
  }
}
