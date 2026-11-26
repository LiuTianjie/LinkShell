import XCTest
@testable import LinkShell

/// The ceiling on what the video track may send, for the pictures a viewer can ask for.
final class TuningTests: XCTestCase {
  func testCeilingAt1920ScalesCleanlyForCrispDesktopText() {
    XCTAssertEqual(Tuning.maxBitrate(width: 1920, height: 1080, fps: 30), 10_000_000)
    XCTAssertEqual(Tuning.maxBitrate(width: 1920, height: 1080, fps: 60), 16_000_000)
  }

  func testHighRefreshRequiresBothDisplaysAndKeepsAdaptationEnabled() {
    let native = ScreenRequest(viewer: "v", ["maxFps": 120])
    XCTAssertNil(native.fps)
    XCTAssertEqual(native.maxFps, 120)
    XCTAssertEqual(ScreenRequest(viewer: "v", [:]).maxFps, 60)
    XCTAssertEqual(ScreenRequest(viewer: "v", ["maxFps": 1000]).maxFps, 60)
    XCTAssertEqual(Tuning.fullRate(viewer: 120, display: 120), 120)
    XCTAssertEqual(Tuning.fullRate(viewer: 120, display: 60), 60)
    XCTAssertEqual(Tuning.fullRate(viewer: 60, display: 144), 60)
    XCTAssertEqual(Tuning.fullRate(viewer: 30, display: 120), 30)
    XCTAssertEqual(Tuning.fullRate(viewer: 120, display: 24), 24)
    XCTAssertEqual(Tuning.maxBitrate(width: 1920, height: 1080, fps: 120), 32_000_000)
  }

  func testLargerPicturesGetMoreButLessThanInProportion() {
    let p1920 = Tuning.maxBitrate(width: 1920, height: 1080, fps: 60)
    let p2560 = Tuning.maxBitrate(width: 2560, height: 1440, fps: 60)
    let p3840 = Tuning.maxBitrate(width: 3840, height: 2160, fps: 60)
    XCTAssertGreaterThan(p2560, p1920)
    XCTAssertGreaterThan(p3840, p2560)
    // Four times the pixels, twice the bits.
    XCTAssertEqual(p3840, 32_000_000)
    XCTAssertLessThanOrEqual(Tuning.maxBitrate(width: 6016, height: 3384, fps: 60), 50_000_000)
  }

  func testSmallPicturesStayInProportionWithAFloor() {
    XCTAssertEqual(Tuning.maxBitrate(width: 1280, height: 720, fps: 30), 4_444_444)
    XCTAssertEqual(Tuning.maxBitrate(width: 320, height: 180, fps: 30), 2_000_000)
  }

  func testLowLatencyDefaultsAvoidFlexFECAndStartFast() {
    XCTAssertEqual(Tuning.startBitrate, 6_000_000)
    XCTAssertEqual(Tuning.lanFloor, 16_000_000)
    XCTAssertEqual(Tuning.lanFloorWindow, 2)
    XCTAssertEqual(Tuning.cursorRate, 120.0)
    XCTAssertEqual(Tuning.idleRepeatInterval, 0.25)
    XCTAssertEqual(Tuning.fieldTrials["WebRTC-ForceSendPlayoutDelay"], "min_ms:0,max_ms:0")
    XCTAssertNil(Tuning.fieldTrials["WebRTC-FlexFEC-03"])
  }

  func testRequestedWidthIsHeldToTheWidest() {
    XCTAssertEqual(ScreenRequest(viewer: "v", ["maxWidth": 100_000]).maxWidth, Tuning.widestPicture)
    XCTAssertEqual(ScreenRequest(viewer: "v", ["maxWidth": 2560]).maxWidth, 2560)
    XCTAssertEqual(ScreenRequest(viewer: "v", [:]).maxWidth, Tuning.defaultMaxWidth)
    XCTAssertEqual(ScreenRequest(viewer: "v", ["maxWidth": 10]).maxWidth, Tuning.narrowestPicture)
  }
}
