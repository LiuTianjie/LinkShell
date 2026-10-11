import XCTest
@testable import LinkShell

/// The rule that chooses between the frame rates, a second at a time, with no screen and no
/// network: what ends the full rate, what doesn't, and how long the way back takes.
final class FrameRateTests: XCTestCase {
  private func rate() -> FrameRate {
    FrameRate(full: 60, reduced: 30)
  }

  /// A busy screen, carried whole at `fps`.
  private func carried(_ fps: Double, available: Double = 20_000_000) -> FrameRate.Second {
    .init(captured: fps + 1, encoded: fps, sentShare: 1, limitation: "none", available: available, sendDelayMs: 0)
  }

  /// libwebrtc's first step down from 1920×1080: 1280×720.
  private func shrunk(_ fps: Double, because limitation: String = "bandwidth", available: Double = 1_500_000) -> FrameRate.Second {
    .init(captured: fps + 1, encoded: fps, sentShare: 4.0 / 9, limitation: limitation, available: available, sendDelayMs: 0)
  }

  /// The same second again and again, until the rate changes: how many it took and what was
  /// said, or nil when `limit` seconds went by without a change.
  private func seconds(of second: FrameRate.Second, to rate: inout FrameRate, limit: Int = 1000) -> (count: Int, verdict: FrameRate.Verdict)? {
    for count in 1...limit {
      let verdict = rate.judge(second)
      if verdict != .keep { return (count, verdict) }
    }
    return nil
  }

  private func settle(_ rate: inout FrameRate, at fps: Double) {
    for _ in 0..<Tuning.frameRateSettle { XCTAssertEqual(rate.judge(carried(fps)), .keep) }
  }

  // MARK: Staying at the full rate

  func testACarriedSessionKeepsTheFullRate() {
    var rate = rate()
    XCTAssertNil(seconds(of: carried(60), to: &rate))
    XCTAssertEqual(rate.current, 60)
  }

  func testHighRefreshFallsBackInStagesAndRecoversInStages() {
    var rate = FrameRate(full: 120, reduced: 60, lowest: 30)
    XCTAssertEqual(rate.current, 120)
    XCTAssertNotNil(seconds(of: shrunk(120), to: &rate))
    XCTAssertEqual(rate.current, 60)
    XCTAssertNotNil(seconds(of: shrunk(60), to: &rate))
    XCTAssertEqual(rate.current, 30)
    XCTAssertNil(seconds(of: shrunk(30), to: &rate, limit: 30))
    XCTAssertNotNil(seconds(of: carried(30), to: &rate))
    XCTAssertEqual(rate.current, 60)
    XCTAssertNotNil(seconds(of: carried(60), to: &rate))
    XCTAssertEqual(rate.current, 120)
  }

  func testHighRefreshCanRecoverAtFiveMegabitsWhenThePictureIsHealthy() {
    var rate = FrameRate(full: 120, reduced: 60, lowest: 30)
    XCTAssertNotNil(seconds(of: shrunk(120), to: &rate))
    XCTAssertEqual(rate.current, 60)
    XCTAssertNotNil(seconds(of: carried(60, available: 5_000_000), to: &rate))
    XCTAssertEqual(rate.current, 120)
    XCTAssertNil(seconds(of: carried(120, available: 5_000_000), to: &rate))
  }

  func testAStillScreenSaysNothingAgainstTheFullRate() {
    var rate = rate()
    let still = FrameRate.Second(captured: 0, encoded: 2, sentShare: 1, limitation: "none", available: 100_000, sendDelayMs: 200)
    XCTAssertNil(seconds(of: still, to: &rate))
  }

  func testAScreenThatGivesFewerFramesIsNotFramesBeingLost() {
    var rate = rate()
    // A film at 30 frames on the screen: all of it is sent.
    XCTAssertNil(seconds(of: carried(30), to: &rate))
  }

  func testWhatIsNotKnownIsNotHeldAgainstTheRate() {
    var rate = rate()
    let unknown = FrameRate.Second(captured: 61, encoded: nil, sentShare: nil, limitation: nil, available: nil)
    XCTAssertNil(seconds(of: unknown, to: &rate))
  }

  func testALowEstimateDoesNotEndTheFullRateWhenThePictureIsCarried() {
    var rate = rate()
    settle(&rate, at: 60)
    XCTAssertNil(seconds(of: carried(60, available: 800_000), to: &rate))
    XCTAssertEqual(rate.current, 60)
  }

  func testAnEncoderThatCropsARowHasNotShrunkThePicture() {
    var rate = rate()
    var second = carried(60)
    second.sentShare = Double(1728 * 1116) / Double(1728 * 1117)
    XCTAssertNil(seconds(of: second, to: &rate))
  }

  // MARK: Down

  func testAPictureShrunkForThreeSecondsEndsTheFullRate() {
    var rate = rate()
    settle(&rate, at: 60)
    let change = seconds(of: shrunk(60, available: 6_000_000), to: &rate)
    XCTAssertEqual(change?.count, Tuning.frameRateDownAfter)
    XCTAssertEqual(change?.verdict, .down("the picture was being shrunk for 3 s (bandwidth)"))
    XCTAssertEqual(rate.current, 30)
  }

  func testThePictureShrunkForTheProcessorIsSaidSo() {
    var rate = rate()
    settle(&rate, at: 60)
    XCTAssertEqual(seconds(of: shrunk(60, because: "cpu", available: 6_000_000), to: &rate)?.verdict, .down("the picture was being shrunk for 3 s (cpu)"))
  }

  func testNothingIsConcludedWhileTheSessionSettles() {
    var rate = rate()
    XCTAssertEqual(seconds(of: shrunk(60), to: &rate)?.count, Tuning.frameRateSettle + Tuning.frameRateDownAfter)
  }

  func testTroubleThatPassesStartsTheCountAgain() {
    var rate = rate()
    settle(&rate, at: 60)
    for _ in 0..<20 {
      for _ in 0..<(Tuning.frameRateDownAfter - 1) { XCTAssertEqual(rate.judge(shrunk(60)), .keep) }
      XCTAssertEqual(rate.judge(carried(60)), .keep)
    }
    XCTAssertEqual(rate.current, 60)
  }

  func testFramesThatDoNotComeOutEndTheFullRate() {
    var rate = rate()
    settle(&rate, at: 60)
    let lost = FrameRate.Second(captured: 61, encoded: 40, sentShare: 1, limitation: "none", available: 20_000_000)
    let change = seconds(of: lost, to: &rate)
    XCTAssertEqual(change?.count, Tuning.frameRateDownAfter)
    XCTAssertEqual(change?.verdict, .down("only 40 of 60 frames a second were sent for 3 s"))
  }

  func testPersistentPacketWaitingEndsTheFullRateBeforeFramesAreLost() {
    var rate = rate()
    settle(&rate, at: 60)
    var queued = carried(60)
    queued.sendDelayMs = 120
    let change = seconds(of: queued, to: &rate)
    XCTAssertEqual(change?.count, Tuning.frameRateDownAfter)
    XCTAssertEqual(change?.verdict, .down("packets waited 120 ms before being sent for 3 s"))
    XCTAssertEqual(rate.current, 30)
  }

  func testASingleQueueSpikeDoesNotChangeTheRate() {
    var rate = rate()
    settle(&rate, at: 60)
    var queued = carried(60)
    queued.sendDelayMs = 1200
    for _ in 0..<20 {
      XCTAssertEqual(rate.judge(queued), .keep)
      XCTAssertEqual(rate.judge(carried(60)), .keep)
    }
    XCTAssertEqual(rate.current, 60)
  }

  func testQueueDeadbandKeepsTheCurrentRate() {
    var rate = rate()
    var delayed = carried(60)
    delayed.sendDelayMs = (Tuning.frameRateQueueSlowMs + Tuning.frameRateQueueCalmMs) / 2
    XCTAssertNil(seconds(of: delayed, to: &rate))
    var lower = reduced()
    delayed = carried(30)
    delayed.sendDelayMs = Tuning.frameRateQueueCalmMs + 1
    XCTAssertNil(seconds(of: delayed, to: &lower))
  }

  // MARK: Up

  private func reduced() -> FrameRate {
    var rate = rate()
    settle(&rate, at: 60)
    _ = seconds(of: shrunk(60), to: &rate)
    XCTAssertEqual(rate.current, 30)
    return rate
  }

  func testHealthyDeliveryForAWhileProbesTheFullRate() {
    var rate = reduced()
    let change = seconds(of: carried(30), to: &rate)
    XCTAssertEqual(change?.count, Tuning.frameRateSettle + Tuning.frameRateCalm)
    XCTAssertEqual(change?.verdict, .up("the whole picture and a drained send queue held for 10 s; trying the next frame rate"))
    XCTAssertEqual(rate.current, 60)
  }

  func testNoProbeWithoutPositiveDeliveryEvidence() {
    var unknown = reduced()
    var second = carried(30)
    second.sendDelayMs = nil
    XCTAssertNil(seconds(of: second, to: &unknown))

    var small = reduced()
    XCTAssertNil(seconds(of: shrunk(30), to: &small))

    var limited = reduced()
    second = carried(30)
    second.limitation = "cpu"
    XCTAssertNil(seconds(of: second, to: &limited))

    var losing = reduced()
    second = carried(30)
    second.encoded = 20
    XCTAssertNil(seconds(of: second, to: &losing))

    let invalidDelays: [Double?] = [nil, .nan, .infinity, -1]
    for invalid in invalidDelays {
      var invalidQueue = reduced()
      second = carried(30)
      second.sendDelayMs = invalid
      XCTAssertNil(seconds(of: second, to: &invalidQueue))
    }

    var noFrames = reduced()
    second = carried(30)
    second.encoded = nil
    XCTAssertNil(seconds(of: second, to: &noFrames))
  }

  func testMissingBandwidthEstimateDoesNotBlockAHealthyProbe() {
    var rate = reduced()
    var second = carried(30)
    second.available = nil
    XCTAssertNotNil(seconds(of: second, to: &rate))
  }

  func testASecondWithAQueueStartsTheRecoveryWaitAgain() {
    var rate = reduced()
    settle(&rate, at: 30)
    for _ in 0..<(Tuning.frameRateCalm - 1) { XCTAssertEqual(rate.judge(carried(30)), .keep) }
    var queued = carried(30)
    queued.sendDelayMs = Tuning.frameRateQueueCalmMs + 1
    XCTAssertEqual(rate.judge(queued), .keep)
    XCTAssertEqual(seconds(of: carried(30), to: &rate)?.count, Tuning.frameRateCalm)
  }

  func testTheWaitDoublesEachTimeTheFullRateIsLostAgainAtOnce() {
    var rate = reduced()
    var waits: [Int] = []
    for _ in 0..<7 {
      waits.append((seconds(of: carried(30), to: &rate)?.count ?? 0) - Tuning.frameRateSettle)
      XCTAssertEqual(rate.current, 60)
      XCTAssertEqual(seconds(of: shrunk(60), to: &rate)?.count, Tuning.frameRateSettle + Tuning.frameRateDownAfter)
    }
    XCTAssertEqual(waits, [10, 20, 40, 80, 160, 160, 160])
  }

  func testTheWaitStaysWhenTheFullRateHeld() {
    var rate = reduced()
    for _ in 0..<3 {
      XCTAssertEqual(seconds(of: carried(30), to: &rate)?.count, Tuning.frameRateSettle + Tuning.frameRateCalm)
      for _ in 0..<Tuning.frameRateHeld { XCTAssertEqual(rate.judge(carried(60)), .keep) }
      XCTAssertNotNil(seconds(of: shrunk(60), to: &rate))
    }
  }
}
