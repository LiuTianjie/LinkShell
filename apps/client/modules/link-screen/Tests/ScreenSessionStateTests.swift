import XCTest
@testable import ScreenTiming

final class ScreenSessionStateTests: XCTestCase {
  private let capability: [String: Any] = ["t": "capabilities", "version": 1, "configure": true, "pause": true]
  private func configuration(_ id: Int, paused: Bool = false) -> [String: Any] {
    ["t": "screen.configure", "requestId": id, "display": 0, "width": "1920", "maxFps": 120, "paused": paused]
  }
  private func applied(_ id: Int, paused: Bool = false) -> [String: Any] {
    ["t": "configured", "requestId": id, "display": 0, "paused": paused, "generation": id]
  }

  func testLegacyRequiresNoConfigurationButDoesNotRetain() {
    var state = ScreenSessionState()
    XCTAssertTrue(state.allowsInput)
    XCTAssertFalse(state.supportsPause)
    state.receive(["t": "capabilities", "version": 2, "configure": true, "pause": true])
    XCTAssertFalse(state.supportsConfiguration)
    state.setActive(false)
    XCTAssertFalse(state.allowsInput)
  }

  func testOnlyLatestAppliedTargetEnablesInput() {
    var state = ScreenSessionState()
    state.receive(capability)
    XCTAssertTrue(state.supportsPause)
    XCTAssertNotNil(state.configuration(configuration(1), maxFps: 120))
    XCTAssertNotNil(state.configuration(configuration(2), maxFps: 120))
    state.receive(applied(1))
    XCTAssertFalse(state.allowsInput)
    state.receive(applied(2))
    XCTAssertTrue(state.allowsInput)
    XCTAssertTrue(state.acceptsInput(["screenGeneration": 2]))
    XCTAssertFalse(state.acceptsInput(["screenGeneration": 1]))
    XCTAssertFalse(state.acceptsInput([:]))
    XCTAssertNil(state.configuration(configuration(1), maxFps: 120))
    XCTAssertNil(state.configuration(configuration(2), maxFps: 120))
  }

  func testPauseAndResumeRejectAcksFromBeforeVisibilityChange() {
    var state = ScreenSessionState()
    state.receive(capability)
    _ = state.configuration(configuration(1), maxFps: 120)
    state.receive(applied(1))
    state.setActive(false)
    XCTAssertFalse(state.allowsInput)
    state.setActive(true)
    state.receive(applied(1))
    XCTAssertFalse(state.allowsInput)
    _ = state.configuration(configuration(2), maxFps: 120)
    state.receive(applied(2))
    XCTAssertTrue(state.allowsInput)
  }

  func testPageResumeQueuedBeforeNativeVisibilityKeepsItsRequest() {
    var state = ScreenSessionState()
    state.receive(capability)
    state.setActive(false)
    let sent = state.configuration(configuration(1), maxFps: 60)
    XCTAssertEqual(sent?["paused"] as? Bool, false)
    XCTAssertEqual(sent?["maxFps"] as? Int, 60)
    XCTAssertFalse(state.allowsInput)
    state.setActive(true)
    state.receive(applied(1))
    XCTAssertTrue(state.allowsInput)
  }

  func testMalformedConfigurationDoesNotChangePendingRequest() {
    var state = ScreenSessionState()
    state.receive(capability)
    _ = state.configuration(configuration(1), maxFps: 120)
    for (key, value) in [("requestId", true as Any), ("requestId", 1.5), ("display", -1),
                         ("width", "600"), ("width", "3841"), ("maxFps", 90), ("paused", 0)] {
      var invalid = configuration(2)
      invalid[key] = value
      XCTAssertNil(state.configuration(invalid, maxFps: 120), key)
    }
    state.receive(["t": "configured", "paused": false])
    XCTAssertFalse(state.allowsInput)
    state.receive(applied(1))
    XCTAssertTrue(state.allowsInput)
  }
}
