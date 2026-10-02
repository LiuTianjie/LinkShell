import XCTest
@testable import LinkShell

/// The rule that chooses between the two frame rates, a second at a time, with no screen and no
/// network: what ends the full rate, what doesn't, and how long the way back takes.
final class FrameRateTests: XCTestCase {
  /// 1920×1080's ceiling at the full rate; the estimate has to reach `Tuning.frameRateRoom` of it.
  private let ceiling = 12_000_000
  private var room: Double { Double(ceiling) * Tuning.frameRateRoom }

  private func rate() -> FrameRate {
    FrameRate(full: 60, reduced: 30, ceiling: ceiling)
  }

  /// A busy screen, carried whole at `fps`.
  private func carried(_ fps: Double, available: Double = 20_000_000) -> FrameRate.Second {
    .init(captured: fps + 1, encoded: fps, sentShare: 1, limitation: "none", available: available)
  }

  /// libwebrtc's first step down from 1920×1080: 1280×720.
  private func shrunk(_ fps: Double, because limitation: String = "bandwidth") -> FrameRate.Second {
    .init(captured: fps + 1, encoded: fps, sentShare: 4.0 / 9, limitation: limitation, available: 1_500_000)
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

  func testAStillScreenSaysNothingAgainstTheFullRate() {
    var rate = rate()
    let still = FrameRate.Second(captured: 0, encoded: 2, sentShare: 1, limitation: "none", available: 3_000_000)
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

  func testALowEstimateAloneKeepsTheFullRate() {
    var rate = rate()
    // The picture is whole: what is on the screen fits in what there is.
    XCTAssertNil(seconds(of: carried(60, available: 800_000), to: &rate))
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
    let change = seconds(of: shrunk(60), to: &rate)
    XCTAssertEqual(change?.count, Tuning.frameRateDownAfter)
    XCTAssertEqual(change?.verdict, .down("the picture was being shrunk for 3 s (bandwidth)"))
    XCTAssertEqual(rate.current, 30)
  }

  func testThePictureShrunkForTheProcessorIsSaidSo() {
    var rate = rate()
    settle(&rate, at: 60)
    XCTAssertEqual(seconds(of: shrunk(60, because: "cpu"), to: &rate)?.verdict, .down("the picture was being shrunk for 3 s (cpu)"))
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

  // MARK: Up

  private func reduced() -> FrameRate {
    var rate = rate()
    settle(&rate, at: 60)
    _ = seconds(of: shrunk(60), to: &rate)
    XCTAssertEqual(rate.current, 30)
    return rate
  }

  func testRoomForAWhileBringsTheFullRateBack() {
    var rate = reduced()
    let change = seconds(of: carried(30), to: &rate)
    XCTAssertEqual(change?.count, Tuning.frameRateSettle + Tuning.frameRateCalm)
    XCTAssertEqual(change?.verdict, .up("nothing limited the picture for 10 s, and the network is estimated at 20.0 Mbit/s"))
    XCTAssertEqual(rate.current, 60)
  }

  func testNoWayBackWithoutRoom() {
    var short = reduced()
    XCTAssertNil(seconds(of: carried(30, available: room - 1), to: &short))

    var unknown = reduced()
    var second = carried(30)
    second.available = nil
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
  }

  func testTheEstimateJustReachingTheRoomIsEnough() {
    var rate = reduced()
    XCTAssertNotNil(seconds(of: carried(30, available: room), to: &rate))
  }

  func testASecondWithoutRoomStartsTheWaitAgain() {
    var rate = reduced()
    settle(&rate, at: 30)
    for _ in 0..<(Tuning.frameRateCalm - 1) { XCTAssertEqual(rate.judge(carried(30)), .keep) }
    XCTAssertEqual(rate.judge(carried(30, available: room / 2)), .keep)
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
