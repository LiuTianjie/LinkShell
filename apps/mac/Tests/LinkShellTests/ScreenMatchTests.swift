import CoreGraphics
import XCTest
@testable import LinkShell

final class ScreenMatchTests: XCTestCase {
  private let mac = CGSize(width: 1920, height: 1080)

  func testASurfaceGetsItsOwnShapeAtTwiceThePixels() {
    // 1920 × 1280 pixels at 150 %: 1280 × 853 points there.
    let wanted = ScreenMatch.Wanted(width: 1280, height: 853, scale: 1.5)
    XCTAssertEqual(ScreenMatch.size(for: wanted, watching: mac), ScreenMatch.Size(width: 1280, height: 854, scale: 2))
  }

  func testAPlainMonitorGetsOnePixelToAPoint() {
    let wanted = ScreenMatch.Wanted(width: 2560, height: 1600, scale: 1)
    XCTAssertEqual(ScreenMatch.size(for: wanted, watching: mac), ScreenMatch.Size(width: 2560, height: 1600, scale: 1))
  }

  func testNothingIsMadeForTheSizeTheDisplayAlreadyHas() {
    XCTAssertNil(ScreenMatch.size(for: ScreenMatch.Wanted(width: 1920, height: 1080, scale: 2), watching: mac))
  }

  func testAnUprightOrTinyScreenIsLeftAlone() {
    XCTAssertNil(ScreenMatch.size(for: ScreenMatch.Wanted(width: 853, height: 1280, scale: 1.5), watching: mac))
    XCTAssertNil(ScreenMatch.size(for: ScreenMatch.Wanted(width: 640, height: 480, scale: 1), watching: mac))
  }

  func testAVeryLargeScreenKeepsItsShape() {
    let size = ScreenMatch.size(for: ScreenMatch.Wanted(width: 7680, height: 4320, scale: 1), watching: mac)
    XCTAssertEqual(size, ScreenMatch.Size(width: 3840, height: 2160, scale: 1))
  }

  func testWhatTheViewerSaidIsReadFromTheRequest() {
    XCTAssertEqual(ScreenMatch.Wanted(["w": 1280, "h": 853, "scale": 1.5]), ScreenMatch.Wanted(width: 1280, height: 853, scale: 1.5))
    XCTAssertNil(ScreenMatch.Wanted(["w": "1280", "h": 853]))
    XCTAssertNil(ScreenMatch.Wanted(nil))
    XCTAssertNil(ScreenRequest(viewer: "v", [:]).match)
    XCTAssertEqual(ScreenRequest(viewer: "v", ["match": ["w": 1512, "h": 982, "scale": 2]]).match?.width, 1512)
  }
}
