import XCTest
@testable import LinkShell

/// The ceiling on what the video track may send, for the pictures a viewer can ask for.
final class TuningTests: XCTestCase {
  func testCeilingAt1920IsUnchanged() {
    XCTAssertEqual(Tuning.maxBitrate(width: 1920, height: 1080, fps: 30), 8_000_000)
    XCTAssertEqual(Tuning.maxBitrate(width: 1920, height: 1080, fps: 60), 12_000_000)
  }

  func testLargerPicturesGetMoreButLessThanInProportion() {
    let p1920 = Tuning.maxBitrate(width: 1920, height: 1080, fps: 60)
    let p2560 = Tuning.maxBitrate(width: 2560, height: 1440, fps: 60)
    let p3840 = Tuning.maxBitrate(width: 3840, height: 2160, fps: 60)
    XCTAssertGreaterThan(p2560, p1920)
    XCTAssertGreaterThan(p3840, p2560)
    // Four times the pixels, twice the bits.
    XCTAssertEqual(p3840, 24_000_000)
    XCTAssertLessThanOrEqual(Tuning.maxBitrate(width: 6016, height: 3384, fps: 60), 30_000_000)
  }

  func testSmallPicturesStayInProportionWithAFloor() {
    XCTAssertEqual(Tuning.maxBitrate(width: 1280, height: 720, fps: 30), 3_555_555)
    XCTAssertEqual(Tuning.maxBitrate(width: 320, height: 180, fps: 30), 2_000_000)
  }

  func testRequestedWidthIsHeldToTheWidest() {
    XCTAssertEqual(ScreenRequest(viewer: "v", ["maxWidth": 100_000]).maxWidth, Tuning.widestPicture)
    XCTAssertEqual(ScreenRequest(viewer: "v", ["maxWidth": 2560]).maxWidth, 2560)
    XCTAssertEqual(ScreenRequest(viewer: "v", [:]).maxWidth, Tuning.defaultMaxWidth)
    XCTAssertEqual(ScreenRequest(viewer: "v", ["maxWidth": 10]).maxWidth, Tuning.narrowestPicture)
  }
}
