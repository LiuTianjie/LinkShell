import CoreFoundation
import Foundation
import XCTest
@testable import LinkShell

final class DesktopScreenReceiverTests: XCTestCase {
  func testOnlyCanonicalSizedUUIDsIdentifyAScreenMount() {
    let value = UUID().uuidString
    XCTAssertEqual(DesktopScreenBridge.identifier(value), value)
    XCTAssertNil(DesktopScreenBridge.identifier(value + " "))
    XCTAssertNil(DesktopScreenBridge.identifier("not-a-screen"))
    XCTAssertNil(DesktopScreenBridge.identifier(123))
  }

  func testBridgeRejectsNonJSONAndOversizedPayloads() {
    XCTAssertTrue(DesktopScreenBridge.validMessage(["rtc": ["t": "offer", "sdp": "v=0"]]))
    XCTAssertFalse(DesktopScreenBridge.validMessage(["sdp": String(repeating: "x", count: 262_144)]))
    XCTAssertFalse(DesktopScreenBridge.validMessage(["value": Double.nan]))
    XCTAssertFalse(DesktopScreenBridge.validMessage(["value": Date()]))
  }

  func testCoordinatesMustBeFiniteBoundedNumbers() throws {
    let frame: [String: Any] = ["x": -20, "y": 56, "width": 800, "height": 480]
    XCTAssertEqual(try XCTUnwrap(DesktopScreenBridge.rect(frame)), CGRect(x: -20, y: 56, width: 800, height: 480))
    for (key, value) in [("x", Double.infinity), ("y", Double.nan), ("width", -1.0), ("height", 16_385.0)] {
      var malformed = frame
      malformed[key] = value
      XCTAssertNil(DesktopScreenBridge.rect(malformed), key)
    }
    var boolean = frame
    boolean["x"] = true
    XCTAssertNil(DesktopScreenBridge.rect(boolean))
  }

  func testRequestIDsCannotBeBooleansFractionsOrUnsafeJSONIntegers() {
    XCTAssertEqual(DesktopScreenBridge.integer(9_007_199_254_740_991 as Int64), 9_007_199_254_740_991)
    for invalid: Any in [true, false, 1.25, Double.nan, Double.infinity, 9_007_199_254_740_992.0, "1"] {
      XCTAssertNil(DesktopScreenBridge.integer(invalid))
    }
  }

  func testPausesRequireRealJSONBooleans() {
    XCTAssertEqual(DesktopScreenBridge.boolean(true), true)
    XCTAssertEqual(DesktopScreenBridge.boolean(false), false)
    for invalid: Any in [0, 1, "true", NSNull()] { XCTAssertNil(DesktopScreenBridge.boolean(invalid)) }
    var state = configuredState()
    XCTAssertFalse(state.configure(request(2, paused: 1)))
    XCTAssertTrue(state.allowsInput, "A malformed request must not change the accepted display")
  }

  func testConfigurationCapableHostBlocksInputUntilItsMatchingAcknowledgment() {
    var state = DesktopScreenInputState()
    state.receive(capabilities)
    XCTAssertFalse(state.allowsInput)
    XCTAssertTrue(state.configure(request(1)))
    state.receive(ack(1, generation: 4))
    XCTAssertTrue(state.allowsInput)
    XCTAssertEqual(state.generation, 4)
  }

  func testRapidDisplayChangesRejectOldOrMismatchedAcknowledgments() {
    var state = configuredState()
    XCTAssertTrue(state.configure(request(2, display: 1)))
    XCTAssertTrue(state.configure(request(3, display: 2)))
    for response in [ack(2, display: 1, generation: 5), ack(3, display: 1, generation: 6), ack(3, display: 2, generation: -1)] {
      state.receive(response)
      XCTAssertFalse(state.allowsInput)
      XCTAssertEqual(state.generation, 4, "An unaccepted acknowledgment must not change the input generation")
    }
    state.receive(ack(3, display: 2, generation: 6))
    XCTAssertTrue(state.allowsInput)
    XCTAssertEqual(state.generation, 6)
  }

  func testPauseCannotBeUndoneByAnOldResumeAcknowledgment() {
    var state = configuredState()
    XCTAssertTrue(state.configure(request(2, paused: true)))
    state.receive(ack(2, paused: true, generation: 5))
    XCTAssertFalse(state.allowsInput)
    state.receive(ack(1, generation: 4))
    XCTAssertFalse(state.allowsInput)
    XCTAssertEqual(state.generation, 5)
    XCTAssertTrue(state.configure(request(3)))
    state.receive(ack(3, paused: true, generation: 6))
    XCTAssertFalse(state.allowsInput)
    state.receive(ack(3, generation: 6))
    XCTAssertTrue(state.allowsInput)
  }

  func testErrorsLeaveInputSuspendedUntilANewConfigurationSucceeds() {
    var state = configuredState()
    XCTAssertTrue(state.configure(request(2, display: 1)))
    state.receive(["t": "error", "requestId": 2, "message": "display was unplugged"])
    XCTAssertFalse(state.allowsInput)
    XCTAssertTrue(state.configure(request(3)))
    state.receive(ack(3, generation: 6))
    XCTAssertTrue(state.allowsInput)
  }

  func testOldRequestCannotReplaceTheNewestPendingConfiguration() {
    var state = configuredState()
    XCTAssertTrue(state.configure(request(3, display: 1)))
    XCTAssertFalse(state.configure(request(2)))
    XCTAssertFalse(state.configure(request(3)))
    state.receive(ack(2, generation: 5))
    XCTAssertFalse(state.allowsInput)
    state.receive(ack(3, display: 1, generation: 6))
    XCTAssertTrue(state.allowsInput)
  }

  private var capabilities: [String: Any] { ["t": "capabilities", "version": 1, "configure": true, "pause": true] }

  private func configuredState() -> DesktopScreenInputState {
    var state = DesktopScreenInputState()
    state.receive(capabilities)
    XCTAssertTrue(state.configure(request(1)))
    state.receive(ack(1, generation: 4))
    return state
  }

  private func request(_ id: Int, display: Int = 0, paused: Any = false) -> [String: Any] {
    ["t": "screen.configure", "requestId": id, "display": display, "paused": paused, "width": "1920", "maxFps": 60]
  }

  private func ack(_ id: Int, display: Int = 0, paused: Bool = false, generation: Int) -> [String: Any] {
    ["t": "configured", "requestId": id, "display": display, "paused": paused, "generation": generation]
  }
}
