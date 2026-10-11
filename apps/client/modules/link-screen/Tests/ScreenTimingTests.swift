import XCTest
@testable import ScreenTiming

final class ScreenTimingTests: XCTestCase {
  func testCumulativeCountersMeasureOnlyTheCurrentInterval() {
    var average = ScreenCounterAverage()
    XCTAssertNil(average.milliseconds(seconds: 10, count: 100))
    XCTAssertEqual(average.milliseconds(seconds: 10.06, count: 120)!, 3, accuracy: 0.000001)
    XCTAssertNil(average.milliseconds(seconds: 10.06, count: 120))
    XCTAssertEqual(average.milliseconds(seconds: 10.08, count: 130)!, 2, accuracy: 0.000001)
  }

  func testMissingOrResetCountersCannotInventAQueueSpike() {
    var average = ScreenCounterAverage()
    XCTAssertNil(average.milliseconds(seconds: 20, count: 200))
    XCTAssertNil(average.milliseconds(seconds: nil, count: 220))
    XCTAssertNil(average.milliseconds(seconds: 20.5, count: 230))
    XCTAssertEqual(average.milliseconds(seconds: 20.52, count: 240)!, 2, accuracy: 0.000001)
    XCTAssertNil(average.milliseconds(seconds: 0.02, count: 10))
    XCTAssertEqual(average.milliseconds(seconds: 0.04, count: 20)!, 2, accuracy: 0.000001)
    XCTAssertNil(average.milliseconds(seconds: .nan, count: 30))
  }

  func testOnlyTheNewestDecodedFrameSurvivesABusyGPU() {
    let mailbox = ScreenMailbox<Int>()
    for frame in 0..<120 { mailbox.put(frame) }
    XCTAssertEqual(mailbox.take(), 119)
    XCTAssertNil(mailbox.take())
    XCTAssertEqual(mailbox.takeReplacements(), 119)
    XCTAssertEqual(mailbox.takeReplacements(), 0)
    mailbox.put(120)
    XCTAssertEqual(mailbox.take(), 120)
    XCTAssertEqual(mailbox.takeReplacements(), 0)
  }

  func testAFrameThatCannotMeetTheDisplayDeadlineIsNotQueued() {
    XCTAssertFalse(ScreenTiming.canSubmit(now: 10, deadline: 10, gpuSeconds: 0))
    XCTAssertFalse(ScreenTiming.canSubmit(now: 10, deadline: 10.0001, gpuSeconds: 0))
    XCTAssertFalse(ScreenTiming.canSubmit(now: 10, deadline: 10.001, gpuSeconds: 0.002))
    XCTAssertTrue(ScreenTiming.canSubmit(now: 10, deadline: 10.0083, gpuSeconds: 0.002))
  }

  func testTailLatencyDoesNotBecomeAnAverage() {
    XCTAssertNil(ScreenTiming.percentile([], 0.95))
    XCTAssertEqual(ScreenTiming.percentile([1, 1, 1, 1, 20], 0.95), 20)
    XCTAssertEqual(ScreenTiming.percentile([1, 1, 1, 1, 20], 0.5), 1)
  }
}
