import XCTest
@testable import LinkShell

final class MediaDeadlineTests: XCTestCase {
  func testPacingCatchesUpAfterTimerJitterWithoutAnUnboundedBurst() {
    var pacing = MediaPacing()
    let rate = 24_000_000.0
    var burst = 0
    while pacing.ready(at: 1) {
      pacing.sent(bytes: 1200, at: 1, bitrate: rate); burst += 1
      XCTAssertLessThan(burst, 10)
    }
    XCTAssertGreaterThan(burst, 1)
    let next = pacing.next
    pacing.sent(bytes: 1200, at: next + 0.0002, bitrate: rate)
    XCTAssertEqual(pacing.next, next + 0.0004, accuracy: 0.000001)
    burst = 0
    while pacing.ready(at: 100) {
      pacing.sent(bytes: 1200, at: 100, bitrate: rate); burst += 1
      XCTAssertLessThan(burst, 10)
    }
  }
  func testAnExpiredFrameAbandonsItsDependentChain() {
    var sender = MediaDeadline()
    XCTAssertTrue(sender.enqueue(frame(1, at: 1, flags: 1), at: 1.01))
    sender.decoded(1, at: 1.02)
    XCTAssertTrue(sender.enqueue(frame(2, at: 1.03), at: 1.04))
    XCTAssertTrue(sender.enqueue(frame(3, at: 1.04), at: 1.05))
    XCTAssertNil(sender.nextPacket(at: 1.2))
    XCTAssertTrue(sender.needsRefresh)
    XCTAssertFalse(sender.enqueue(frame(4, at: 1.21), at: 1.22))
    XCTAssertTrue(sender.enqueue(frame(5, at: 1.23, flags: 2), at: 1.24))
    XCTAssertFalse(sender.needsRefresh)
    XCTAssertNotNil(sender.nextPacket(at: 1.25))
  }

  func testARefreshInTheEncoderDoesNotProduceAKeyframeStorm() {
    var sender = MediaDeadline()
    XCTAssertTrue(sender.admitRaw(at: 1, bitrate: 2_000_000, pending: 0))
    XCTAssertFalse(sender.admitRaw(at: 1.01, bitrate: 2_000_000, pending: 1))
  }

  func testOnlyRealDecodedProgressCanAcknowledgeAnInFlightRefresh() {
    var sender = MediaDeadline()
    _ = sender.enqueue(frame(1, at: 1, flags: 1), at: 1.01)
    sender.decoded(100, at: 1.02)
    XCTAssertFalse(sender.hasDecoded)
    sender.expire(at: 2)
    XCTAssertTrue(sender.needsRefresh)
    _ = sender.enqueue(frame(2, at: 2.01, flags: 1), at: 2.02)
    sender.decoded(2, at: 2.03)
    XCTAssertTrue(sender.hasDecoded)
    sender.decoded(1, at: 2.04)
    XCTAssertEqual(sender.lastDecoded, 2)
  }

  func testPacketPacingCannotGrowAnUnboundedRawFrameQueue() {
    var sender = MediaDeadline()
    _ = sender.enqueue(frame(1, at: 1, flags: 1, bytes: 80_000), at: 1.01)
    XCTAssertFalse(sender.admitRaw(at: 1.02, bitrate: 700_000, pending: 0))
    XCTAssertEqual(sender.skippedRaw, 1)
  }

  func testCongestionUsesDeliveryFeedbackAndBacksOffOnSilence() {
    var rate = MediaRate(maximum: 20_000_000)
    rate.feedback(bytes: 1000, receivedAt: 1, echoedSend: 0.99, now: 1.01)
    rate.feedback(bytes: 10_000, receivedAt: 1.2, echoedSend: 1.10, now: 1.22)
    XCTAssertLessThan(rate.bitrate, 700_000)
    let slow = rate.bitrate
    rate.tick(at: 1.8, outstanding: true)
    XCTAssertLessThan(rate.bitrate, slow)
    XCTAssertGreaterThanOrEqual(rate.bitrate, 80_000)
  }

  func testAnApplicationLimitedEncoderIsNotMistakenForNetworkFailure() {
    var rate = MediaRate(maximum: 20_000_000)
    rate.feedback(bytes: 1000, receivedAt: 1, echoedSend: 0.99, now: 1.01)
    let before = rate.bitrate
    rate.tick(at: 4, outstanding: false)
    XCTAssertEqual(rate.bitrate, before)
  }

  func testARecoveryFrameGetsItsBoundedBudgetWithoutSpeculativeDeltasExpiringIt() {
    var sender = MediaDeadline()
    _ = sender.enqueue(frame(1, at: 1, flags: 1), at: 1.01); sender.decoded(1, at: 1.02)
    _ = sender.enqueue(frame(2, at: 2, flags: 2, bytes: 40_000), at: 2.01)
    XCTAssertFalse(sender.admitRaw(at: 2.1, bitrate: 700_000, pending: 0))
    sender.expire(at: 2.4)
    XCTAssertFalse(sender.needsRefresh)
    XCTAssertNotNil(sender.nextPacket(at: 2.4))
    sender.expire(at: 2.9)
    XCTAssertTrue(sender.needsRefresh)
  }

  private func frame(_ id: UInt32, at time: Double, flags: UInt8 = 0, bytes: Int = 10) -> MediaFrame {
    MediaFrame(id: id, previous: id - 1, capturedNs: UInt64(time * 1e9), flags: flags, data: Data(repeating: 42, count: bytes))
  }
}
