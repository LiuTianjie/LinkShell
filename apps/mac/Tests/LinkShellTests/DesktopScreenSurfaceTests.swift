import AppKit
import XCTest
@testable import LinkShell

final class DesktopScreenSurfaceTests: XCTestCase {
  func testAspectFitPreservesLetterboxingInOffsetBounds() {
    let bounds = CGRect(x: 30, y: 70, width: 800, height: 600)
    let fitted = DesktopScreenGeometry.fittedRect(picture: CGSize(width: 1920, height: 1080), in: bounds)
    XCTAssertEqual(fitted, CGRect(x: 30, y: 145, width: 800, height: 450))
  }

  func testPortraitPictureFitsWithSideBars() {
    let fitted = DesktopScreenGeometry.fittedRect(
      picture: CGSize(width: 1080, height: 1920),
      in: CGRect(x: 10, y: 20, width: 800, height: 600)
    )
    XCTAssertEqual(fitted, CGRect(x: 241.25, y: 20, width: 337.5, height: 600))
  }

  func testPointerMapsToPictureRatherThanWholeView() throws {
    let picture = CGSize(width: 1920, height: 1080)
    let bounds = CGRect(x: 30, y: 70, width: 800, height: 600)
    let point = try XCTUnwrap(DesktopScreenGeometry.normalizedPoint(
      CGPoint(x: 230, y: 482.5), picture: picture, bounds: bounds
    ))
    XCTAssertEqual(point.x, 0.25, accuracy: 0.000_001)
    XCTAssertEqual(point.y, 0.75, accuracy: 0.000_001)
    XCTAssertEqual(DesktopScreenGeometry.normalizedPoint(CGPoint(x: 30, y: 145), picture: picture, bounds: bounds), .zero)
    XCTAssertEqual(DesktopScreenGeometry.normalizedPoint(CGPoint(x: 830, y: 595), picture: picture, bounds: bounds), CGPoint(x: 1, y: 1))
    XCTAssertNil(DesktopScreenGeometry.normalizedPoint(CGPoint(x: 430, y: 100), picture: picture, bounds: bounds))
    XCTAssertNil(DesktopScreenGeometry.normalizedPoint(CGPoint(x: 430, y: 650), picture: picture, bounds: bounds))
  }

  func testDraggingOutsidePictureClampsToNearestEdge() throws {
    let picture = CGSize(width: 1080, height: 1920)
    let bounds = CGRect(x: 10, y: 20, width: 800, height: 600)
    let upperLeft = try XCTUnwrap(DesktopScreenGeometry.normalizedPoint(
      CGPoint(x: 10, y: -40), picture: picture, bounds: bounds, clamp: true
    ))
    let lowerRight = try XCTUnwrap(DesktopScreenGeometry.normalizedPoint(
      CGPoint(x: 900, y: 700), picture: picture, bounds: bounds, clamp: true
    ))
    XCTAssertEqual(upperLeft, .zero)
    XCTAssertEqual(lowerRight, CGPoint(x: 1, y: 1))
    XCTAssertNil(DesktopScreenGeometry.normalizedPoint(CGPoint(x: 10, y: 320), picture: picture, bounds: bounds))
  }

  func testMissingPictureOrLayoutCannotProduceRemoteCoordinates() {
    let bounds = CGRect(x: 0, y: 0, width: 800, height: 600)
    for picture in [CGSize.zero, CGSize(width: 1920, height: 0), CGSize(width: -1, height: 1080)] {
      XCTAssertEqual(DesktopScreenGeometry.fittedRect(picture: picture, in: bounds), .zero)
      XCTAssertNil(DesktopScreenGeometry.normalizedPoint(CGPoint(x: 40, y: 40), picture: picture, bounds: bounds, clamp: true))
    }
    XCTAssertNil(DesktopScreenGeometry.normalizedPoint(
      .zero, picture: CGSize(width: 1920, height: 1080), bounds: .zero, clamp: true
    ))
  }

  func testFixedKeysDoNotDependOnCharactersOrKeyboardLayout() {
    let keys: [(UInt16, String)] = [
      (36, "return"), (76, "return"), (48, "tab"), (49, "space"), (51, "backspace"), (53, "escape"),
      (123, "left"), (124, "right"), (125, "down"), (126, "up"),
      (117, "delete"), (115, "home"), (119, "end"), (116, "pageup"), (121, "pagedown"),
      (122, "f1"), (120, "f2"), (99, "f3"), (118, "f4"), (96, "f5"), (97, "f6"),
      (98, "f7"), (100, "f8"), (101, "f9"), (109, "f10"), (103, "f11"), (111, "f12"),
    ]
    for (code, expected) in keys {
      XCTAssertEqual(DesktopScreenInput.key(code: code, characters: nil), expected, "key code \(code)")
      XCTAssertEqual(DesktopScreenInput.key(code: code, characters: "x"), expected, "fixed code \(code) overrides characters")
    }
  }

  func testCharacterShortcutsUseTheActiveKeyboardLayout() {
    XCTAssertEqual(DesktopScreenInput.key(code: 0, characters: "Q"), "q")
    XCTAssertEqual(DesktopScreenInput.key(code: 24, characters: "+"), "+")
    XCTAssertNil(DesktopScreenInput.key(code: UInt16.max, characters: nil))
    XCTAssertNil(DesktopScreenInput.key(code: UInt16.max, characters: ""))
  }

  func testOnlyProtocolModifiersAreForwarded() {
    XCTAssertEqual(Set(DesktopScreenInput.modifiers([.command, .shift, .option, .control])), Set(["cmd", "shift", "alt", "ctrl"]))
    XCTAssertEqual(DesktopScreenInput.modifiers([.capsLock, .function, .numericPad]), [])
    XCTAssertEqual(DesktopScreenInput.modifiers([.command, .capsLock, .function]), ["cmd"])
  }

  func testPastedLineEndingsAndTabsBecomeOrderedKeyCommands() {
    let commands = DesktopScreenInput.textCommands("第一行\r\n\tsecond\n\rthird\t")
    XCTAssertEqual(commands.map(commandDescription), [
      "text:第一行", "key:return", "key:tab", "text:second", "key:return", "key:return", "text:third", "key:tab",
    ])
    XCTAssertTrue(DesktopScreenInput.textCommands("").isEmpty)
    XCTAssertEqual(DesktopScreenInput.textCommands("\n\n").map(commandDescription), ["key:return", "key:return"])
  }

  func testUnicodeTextIsSplitAtTheWireUTF16LimitWithoutLosingScalars() throws {
    let text = String(repeating: "中", count: 3999) + "😀" + String(repeating: "👩🏽‍💻", count: 550)
    let commands = DesktopScreenInput.textCommands(text)
    XCTAssertGreaterThan(commands.count, 1)
    let pieces = try commands.map { command -> String in
      XCTAssertEqual(command["t"] as? String, "text")
      let piece = try XCTUnwrap(command["s"] as? String)
      XCTAssertTrue((1...4000).contains(piece.utf16.count))
      XCTAssertNotNil(InputEvent(json: try JSONSerialization.data(withJSONObject: command)))
      return piece
    }
    XCTAssertEqual(pieces.joined(), text)
    XCTAssertFalse(pieces.contains { $0.contains("\u{FFFD}") }, "A surrogate pair must never be split into replacement characters")
  }

  func testExactTextLimitDoesNotEmitAnEmptyTrailingCommand() {
    let text = String(repeating: "😀", count: 2000)
    XCTAssertEqual(DesktopScreenInput.textCommands(text).map(commandDescription), ["text:" + text])
  }

  func testSingleLargeGraphemeStillRespectsTheTextCommandLimit() throws {
    let text = "a" + String(repeating: "\u{0301}", count: 8000)
    XCTAssertEqual(text.count, 1, "An extended grapheme can exceed the entire wire payload limit")
    let commands = DesktopScreenInput.textCommands(text)
    let pieces = try commands.map { command -> String in
      let piece = try XCTUnwrap(command["s"] as? String)
      XCTAssertTrue((1...4000).contains(piece.utf16.count))
      XCTAssertNotNil(InputEvent(json: try JSONSerialization.data(withJSONObject: command)))
      return piece
    }
    XCTAssertGreaterThan(pieces.count, 1)
    XCTAssertEqual(pieces.joined(), text)
  }

  func testFullScreenTopEdgeSnapReachesRemoteMenuBarAcrossNarrowLetterbox() throws {
    // 16:9 remote Mac (1920x1080) inside a 14" MacBook Pro full-screen stage (1512x982 -> top letterbox ~65.8pt).
    let picture = CGSize(width: 1920, height: 1080)
    let bounds = CGRect(x: 0, y: 0, width: 1512, height: 982)
    XCTAssertNil(DesktopScreenGeometry.stagePoint(CGPoint(x: 1380, y: 0), picture: picture, bounds: bounds))
    let snapped = try XCTUnwrap(DesktopScreenGeometry.stagePoint(
      CGPoint(x: 1380, y: 0), picture: picture, bounds: bounds, topEdgeSnap: true
    ))
    XCTAssertEqual(snapped.x, 1380 / 1512, accuracy: 0.000_01)
    XCTAssertEqual(snapped.y, 0)

    // Large vertical letterboxing (> 96pt, e.g. square/portrait container) does not snap distant blank space.
    let tallBounds = CGRect(x: 0, y: 0, width: 1000, height: 1000)
    XCTAssertNil(DesktopScreenGeometry.stagePoint(CGPoint(x: 500, y: 10), picture: picture, bounds: tallBounds, topEdgeSnap: true))
  }

  func testFullScreenExitBarLeavesMacMenuAndStatusBarClear() {
    let bounds = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let barFrame = CGRect(x: 696, y: 10, width: 120, height: 34)
    // Left Apple/App menus and right NSStatusBar items at y = 0..24 never reveal the exit bar.
    XCTAssertFalse(DesktopFullScreenBar.shouldReveal(point: CGPoint(x: 24, y: 0), in: bounds, barFrame: barFrame, barShown: false))
    XCTAssertFalse(DesktopFullScreenBar.shouldReveal(point: CGPoint(x: 220, y: 12), in: bounds, barFrame: barFrame, barShown: false))
    XCTAssertFalse(DesktopFullScreenBar.shouldReveal(point: CGPoint(x: 1360, y: 0), in: bounds, barFrame: barFrame, barShown: false))
    XCTAssertFalse(DesktopFullScreenBar.shouldReveal(point: CGPoint(x: 1480, y: 14), in: bounds, barFrame: barFrame, barShown: false))
    // Deliberate touch in the narrow top-center pull zone reveals it, and hovering the visible bar retains it.
    XCTAssertTrue(DesktopFullScreenBar.shouldReveal(point: CGPoint(x: 756, y: 2), in: bounds, barFrame: barFrame, barShown: false))
    XCTAssertFalse(DesktopFullScreenBar.shouldReveal(point: CGPoint(x: 756, y: 18), in: bounds, barFrame: barFrame, barShown: false))
    XCTAssertTrue(DesktopFullScreenBar.shouldReveal(point: CGPoint(x: 756, y: 24), in: bounds, barFrame: barFrame, barShown: true))
  }

  func testControlMouseDeltaPreservesTopEdgeUpwardPressure() {
    let bounds = CGRect(x: 0, y: 0, width: 1920, height: 1080)
    // Sliding along or arriving at y = 0 carries negative dy so remote full-screen Mac menu bars reveal.
    let topSlide = Control.mouseDelta(from: CGPoint(x: 1300, y: 0), to: CGPoint(x: 1360, y: 0), bounds: bounds, dragging: false)
    XCTAssertEqual(topSlide.dx, 60)
    XCTAssertEqual(topSlide.dy, -1)

    let subPixelArrival = Control.mouseDelta(from: CGPoint(x: 40, y: 0.4), to: CGPoint(x: 40, y: 0), bounds: bounds, dragging: false)
    XCTAssertEqual(subPixelArrival.dy, -1)

    // Dragging at the top edge keeps geometric delta without inventing upward pressure.
    let dragTop = Control.mouseDelta(from: CGPoint(x: 200, y: 0), to: CGPoint(x: 240, y: 0), bounds: bounds, dragging: true)
    XCTAssertEqual(dragTop.dx, 40)
    XCTAssertEqual(dragTop.dy, 0)
  }

  private func commandDescription(_ command: [String: Any]) -> String {
    guard let kind = command["t"] as? String else { return "missing-kind" }
    return kind + ":" + ((command[kind == "text" ? "s" : "k"] as? String) ?? "missing-value")
  }
}
