import XCTest
@testable import LinkShell

/// What the setup window goes by, with no window: which permission is next, what a pretended
/// state is at each moment, which language is spoken, and where the window steps aside to.
final class SetupTests: XCTestCase {
  // MARK: Which permission is next

  func testTheFirstMissingPermissionIsNext() {
    XCTAssertEqual(Granted().next, .recording)
    XCTAssertEqual(Granted(recording: true).next, .control)
    XCTAssertEqual(Granted(control: true).next, .recording)
    XCTAssertNil(Granted(recording: true, control: true).next)
  }

  func testAllOnlyWithBoth() {
    XCTAssertFalse(Granted().all)
    XCTAssertFalse(Granted(recording: true).all)
    XCTAssertFalse(Granted(control: true).all)
    XCTAssertTrue(Granted(recording: true, control: true).all)
  }

  func testGainedIsWhatWasTurnedOnAndNotWhatWasTurnedOff() {
    XCTAssertEqual(Granted(recording: true).gained(since: Granted()), [.recording])
    XCTAssertEqual(Granted(recording: true, control: true).gained(since: Granted()), [.recording, .control])
    XCTAssertEqual(Granted(recording: true, control: true).gained(since: Granted(recording: true)), [.control])
    XCTAssertEqual(Granted().gained(since: Granted(recording: true)), [])
    XCTAssertEqual(Granted(control: true).gained(since: Granted(recording: true)), [.control])
  }

  // MARK: Pretending

  func testNothingPretendedWithoutTheFlag() throws {
    XCTAssertNil(try Pretend(arguments: ["--setup", "--quiet-if-done"]))
  }

  func testEachPretendedState() throws {
    let states = ["none": Granted(), "recording": Granted(recording: true), "control": Granted(control: true), "both": Granted(recording: true, control: true)]
    for (name, granted) in states {
      XCTAssertEqual(try Pretend(arguments: ["--setup", "--pretend", name])?.granted(after: 0), granted, name)
    }
  }

  func testAPretendedStateChangesWhenItsTimeComes() throws {
    // Given out of order: the times decide.
    let pretend = try XCTUnwrap(Pretend(arguments: ["--setup", "--pretend", "none", "--pretend-after", "4", "both", "--pretend-after", "1.5", "recording"]))
    XCTAssertEqual(pretend.granted(after: 0), Granted())
    XCTAssertEqual(pretend.granted(after: 1.4), Granted())
    XCTAssertEqual(pretend.granted(after: 1.5), Granted(recording: true))
    XCTAssertEqual(pretend.granted(after: 3.9), Granted(recording: true))
    XCTAssertEqual(pretend.granted(after: 4), Granted(recording: true, control: true))
    XCTAssertEqual(pretend.granted(after: 1000), Granted(recording: true, control: true))
  }

  /// A test that was mistyped must not become the real window, whose buttons ask the system.
  func testWhatCannotBeReadIsAnErrorAndNotTheRealThing() {
    let unreadable: [[String]] = [
      ["--pretend"],
      ["--pretend", "all"],
      ["--pretend", "none", "--pretend-after", "soon", "both"],
      ["--pretend", "none", "--pretend-after", "-1", "both"],
      ["--pretend", "none", "--pretend-after", "2"],
      ["--pretend", "none", "--pretend-after", "2", "everything"],
      ["--pretend-after", "2", "both"],
    ]
    for arguments in unreadable {
      XCTAssertThrowsError(try Pretend(arguments: arguments), arguments.joined(separator: " "))
    }
  }

  // MARK: The language

  func testChineseForAChineseSystemAndEnglishForAnyOther() {
    XCTAssertEqual(SetupText.preferred(["zh-Hans-CN", "en-CN"]), .chinese)
    XCTAssertEqual(SetupText.preferred(["zh-Hant-TW"]), .chinese)
    XCTAssertEqual(SetupText.preferred(["zh"]), .chinese)
    XCTAssertEqual(SetupText.preferred(["en-CN", "zh-Hans-CN"]), .english)
    XCTAssertEqual(SetupText.preferred(["ja-JP", "zh-Hans-CN"]), .english)
    XCTAssertEqual(SetupText.preferred([]), .english)
  }

  func testNothingIsLeftUnsaidInEitherLanguage() {
    for text in [SetupText.chinese, .english] {
      for child in Mirror(reflecting: text).children {
        XCTAssertFalse((child.value as? String ?? "").isEmpty, child.label ?? "")
      }
      for permission in Permission.allCases {
        XCTAssertFalse(text.name(permission).isEmpty)
        XCTAssertFalse(text.purpose(permission).isEmpty)
      }
    }
    XCTAssertNotEqual(SetupText.chinese.name(.recording), SetupText.chinese.name(.control))
  }

  // MARK: Out of System Settings' way

  /// A 1440×900 display with a menu bar and a Dock.
  private let visible = CGRect(x: 0, y: 70, width: 1440, height: 805)
  private let size = CGSize(width: 540, height: 360)

  private func frame(other: CGRect?, visible: CGRect? = nil) -> CGRect {
    CGRect(origin: Beside.origin(size: size, other: other, visible: visible ?? self.visible), size: size)
  }

  func testBesideSettingsOnTheSideWithMoreRoomTopsLevel() {
    // Settings towards the left: the room is on its right.
    let left = CGRect(x: 100, y: 150, width: 715, height: 650)
    XCTAssertEqual(frame(other: left), CGRect(x: 815 + Beside.gap, y: 800 - 360, width: 540, height: 360))
    // Settings towards the right: the room is on its left.
    let right = CGRect(x: 700, y: 150, width: 715, height: 650)
    XCTAssertEqual(frame(other: right), CGRect(x: 700 - Beside.gap - 540, y: 800 - 360, width: 540, height: 360))
    for other in [left, right] {
      XCTAssertFalse(frame(other: other).intersects(other))
      XCTAssertTrue(visible.contains(frame(other: other)))
    }
  }

  func testWithNoRoomBesideSettingsItTakesTheEdgeFartherFromItsMiddle() {
    // In the middle of a small display, a little to the left: neither side has 540 to spare.
    let small = CGRect(x: 0, y: 70, width: 1280, height: 700)
    let other = CGRect(x: 250, y: 100, width: 715, height: 650)
    let placed = frame(other: other, visible: small)
    XCTAssertEqual(placed.maxX, small.maxX - Beside.gap)
    XCTAssertTrue(small.contains(placed))
    // And mirrored.
    let mirrored = frame(other: CGRect(x: 315, y: 100, width: 715, height: 650), visible: small)
    XCTAssertEqual(mirrored.minX, small.minX + Beside.gap)
  }

  func testItStaysOnTheScreenWhateverSettingsDoes() {
    // Settings hanging off the top, and off the bottom.
    for other in [CGRect(x: 100, y: 600, width: 715, height: 650), CGRect(x: 100, y: -300, width: 715, height: 500)] {
      XCTAssertTrue(visible.contains(frame(other: other)), "\(other)")
    }
    // A display to the left of the main one and below it: its coordinates are negative.
    let second = CGRect(x: -1800, y: -1169, width: 1800, height: 1131)
    let placed = frame(other: CGRect(x: -1700, y: -1000, width: 715, height: 650), visible: second)
    XCTAssertTrue(second.contains(placed))
    XCTAssertEqual(placed.minX, -1700 + 715 + Beside.gap)
  }

  func testWithoutSettingsItGoesToTheRightEdgeHalfWayUp() {
    XCTAssertEqual(frame(other: nil), CGRect(x: 1440 - Beside.gap - 540, y: 70 + (805 - 360) / 2, width: 540, height: 360))
  }
}
