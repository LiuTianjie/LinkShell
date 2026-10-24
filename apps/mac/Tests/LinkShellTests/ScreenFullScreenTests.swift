import XCTest
@testable import LinkShell

/// The window's full screen follows the page's last wish, whenever AppKit lets it move.
final class ScreenFullScreenTests: XCTestCase {
  /// A window as AppKit runs it: a toggle starts an animation; requests during it are ignored by AppKit.
  private struct Window {
    var machine = ScreenFullScreen()
    var isFull = false
    var animating = false
    var reports: [Bool] = []
    var ignoredToggles = 0

    mutating func apply(_ actions: [ScreenFullScreen.Action]) {
      for action in actions {
        switch action {
        case .toggle:
          if animating { ignoredToggles += 1; continue }
          animating = true
          machine.willMove()
        case .report(let value): reports.append(value)
        }
      }
    }
    mutating func page(_ enabled: Bool, visible: Bool = true) { apply(machine.request(enabled, isFull: isFull, visible: visible)) }
    /// The running animation ends.
    mutating func finish(visible: Bool = true) {
      guard animating else { return }
      animating = false
      isFull.toggle()
      apply(isFull ? machine.entered(visible: visible) : machine.exited(visible: visible))
    }
    /// The user's green button or ⌃⌘F.
    mutating func user() {
      guard !animating else { return }
      animating = true
      machine.willMove()
    }
  }

  func testEnteringAndLeavingReportsEachSettledState() {
    var window = Window()
    window.page(true)
    XCTAssertTrue(window.animating)
    XCTAssertEqual(window.reports, [])
    window.finish()
    XCTAssertEqual(window.reports, [true])
    window.page(false)
    window.finish()
    XCTAssertFalse(window.isFull)
    XCTAssertEqual(window.reports, [true, false])
    XCTAssertEqual(window.ignoredToggles, 0)
  }

  /// Esc while the window is still going full screen: it comes straight back out.
  func testLeavingDuringTheAnimationInIsAppliedWhenItEnds() {
    var window = Window()
    window.page(true)
    window.page(false)
    window.finish()
    XCTAssertTrue(window.animating, "goes back out as soon as it is in")
    window.finish()
    XCTAssertFalse(window.isFull)
    XCTAssertEqual(window.reports, [false])
    XCTAssertEqual(window.ignoredToggles, 0)
  }

  /// 全屏 clicked again while the window is still leaving: it goes back in instead of losing the click.
  func testEnteringDuringTheAnimationOutIsAppliedWhenItEnds() {
    var window = Window()
    window.page(true); window.finish()
    window.page(false)
    window.page(true)
    window.finish()
    XCTAssertTrue(window.animating)
    window.finish()
    XCTAssertTrue(window.isFull)
    XCTAssertEqual(window.reports, [true, true])
    XCTAssertEqual(window.ignoredToggles, 0)
  }

  func testTheGreenButtonEndsThePictureToo() {
    var window = Window()
    window.page(true); window.finish()
    window.user(); window.finish()
    XCTAssertFalse(window.isFull)
    XCTAssertEqual(window.reports, [true, false])
    // A later wish starts from there.
    window.page(true); window.finish()
    XCTAssertEqual(window.reports, [true, false, true])
  }

  /// The user's own full screen is left as it is when the picture stops.
  func testAWindowTheUserMadeFullScreenStaysFullScreen() {
    var window = Window()
    window.user(); window.finish()
    XCTAssertEqual(window.reports, [false])
    window.page(true)
    XCTAssertEqual(window.reports, [false, true])
    window.page(false)
    XCTAssertTrue(window.isFull)
    XCTAssertFalse(window.animating)
    XCTAssertEqual(window.reports, [false, true, false])
  }

  func testAHiddenPageNeverGoesFullScreen() {
    var window = Window()
    window.page(true, visible: false)
    XCTAssertFalse(window.animating)
    XCTAssertEqual(window.reports, [false])
    XCTAssertFalse(window.machine.wanted)
  }

  func testRepeatedClicksMakeOneAnimation() {
    var window = Window()
    window.page(true); window.page(true); window.page(true)
    window.finish()
    XCTAssertEqual(window.reports, [true])
    XCTAssertEqual(window.ignoredToggles, 0)
  }

  /// AppKit drops a toggle made as an animation ends: it is made again.
  func testAToggleAppKitDroppedIsMadeAgain() {
    var machine = ScreenFullScreen()
    XCTAssertEqual(machine.request(true, isFull: false, visible: true), [.toggle])
    machine.willMove()
    XCTAssertEqual(machine.request(false, isFull: true, visible: true), [])
    XCTAssertEqual(machine.entered(visible: true), [.toggle])
    // No animation followed: the same toggle again.
    XCTAssertEqual(machine.toggleUnanswered(isFull: true, visible: true), [.toggle])
    machine.willMove()
    XCTAssertEqual(machine.exited(visible: true), [.report(false)])
    XCTAssertFalse(machine.moving)
  }

  /// A window that never answers doesn't keep every later click waiting.
  func testAWindowThatNeverAnswersIsTakenAsItIs() {
    var machine = ScreenFullScreen()
    XCTAssertEqual(machine.request(true, isFull: false, visible: true), [.toggle])
    XCTAssertEqual(machine.toggleUnanswered(isFull: false, visible: true), [.toggle])
    XCTAssertEqual(machine.toggleUnanswered(isFull: false, visible: true), [.toggle])
    XCTAssertEqual(machine.toggleUnanswered(isFull: false, visible: true), [.report(false)])
    XCTAssertFalse(machine.moving)
    XCTAssertEqual(machine.request(true, isFull: false, visible: true), [.toggle])
    // A late answer for an animation that did start is not taken for a dropped one.
    machine.willMove()
    XCTAssertEqual(machine.toggleUnanswered(isFull: false, visible: true), [])
    XCTAssertTrue(machine.moving)
  }

  func testAFailedAnimationTakesTheWindowAsItIs() {
    var machine = ScreenFullScreen()
    XCTAssertEqual(machine.request(true, isFull: false, visible: true), [.toggle])
    machine.willMove()
    XCTAssertEqual(machine.failed(isFull: false), [.report(false)])
    XCTAssertFalse(machine.moving)
    XCTAssertFalse(machine.wanted)
    XCTAssertEqual(machine.request(true, isFull: false, visible: true), [.toggle])
  }
}
