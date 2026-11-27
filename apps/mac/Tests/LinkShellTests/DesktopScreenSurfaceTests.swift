import AppKit
import LinkShellScreen
import Metal
import QuartzCore
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
    // Deliberate touch in the top-center pull zone (360x22pt) reveals it, and hovering the visible bar retains it.
    XCTAssertTrue(DesktopFullScreenBar.shouldReveal(point: CGPoint(x: 756, y: 2), in: bounds, barFrame: barFrame, barShown: false))
    XCTAssertTrue(DesktopFullScreenBar.shouldReveal(point: CGPoint(x: 756, y: 18), in: bounds, barFrame: barFrame, barShown: false))
    XCTAssertFalse(DesktopFullScreenBar.shouldReveal(point: CGPoint(x: 756, y: 28), in: bounds, barFrame: barFrame, barShown: false))
    XCTAssertTrue(DesktopFullScreenBar.shouldReveal(point: CGPoint(x: 756, y: 24), in: bounds, barFrame: barFrame, barShown: true))
  }

  @MainActor
  func testFullScreenOverlayAutoRevealsAndShowsPersistentHandleWhenCollapsed() {
    let container = DesktopScreenClipView(frame: CGRect(x: 0, y: 0, width: 1512, height: 982))
    var exited = 0
    let overlay = DesktopFullScreenOverlay { exited += 1 }
    overlay.attach(to: container)
    defer { overlay.detach() }

    XCTAssertTrue(overlay.bar.isRevealed, "Auto-reveals exit bar on full-screen entry")
    XCTAssertTrue(overlay.handle.isHidden, "Persistent handle hides while exit bar is revealed")

    overlay.bar.reveal(false)
    XCTAssertFalse(overlay.bar.isRevealed)
    XCTAssertFalse(overlay.handle.isHidden, "Persistent translucent floating capsule appears when exit menu collapses")
    XCTAssertEqual(overlay.handle.alphaValue, DesktopFullScreenHandle.restingAlpha, accuracy: 0.001)
    XCTAssertEqual(overlay.handle.frame.minY, DesktopFullScreenHandle.topOffset, accuracy: 0.5)
    XCTAssertEqual(overlay.handle.frame.height, DesktopFullScreenHandle.height, accuracy: 0.5)
    XCTAssertGreaterThanOrEqual(overlay.handle.frame.width, 104)
    XCTAssertEqual(overlay.handle.frame.midX, container.bounds.midX, accuracy: 1.0)

    overlay.triggerHandle()
    XCTAssertTrue(overlay.bar.isRevealed, "Hovering or clicking the floating capsule reveals the full menu bar")
    XCTAssertTrue(overlay.handle.isHidden)
    overlay.bar.onExit?()
    XCTAssertEqual(exited, 1)
  }

  func testSurfaceAlwaysInterceptsCtrlCmdFAndWatchOnlyEscapeWithoutForwardingToRemote() throws {
    let surface = DesktopScreenSurface(frame: CGRect(x: 0, y: 0, width: 1280, height: 800))
    defer { surface.stop() }
    var forwarded: [[String: Any]] = []
    var exitCount = 0
    surface.onInput = { command, _ in forwarded.append(command) }
    surface.onExitFullScreen = { exitCount += 1 }
    surface.fullScreen = true
    surface.controlEnabled = true

    let ctrlCmdF = try XCTUnwrap(NSEvent.keyEvent(
      with: .keyDown,
      location: .zero,
      modifierFlags: [.command, .control],
      timestamp: 0,
      windowNumber: 0,
      context: nil,
      characters: "\u{06}",
      charactersIgnoringModifiers: "f",
      isARepeat: false,
      keyCode: 3
    ))
    XCTAssertTrue(surface.performKeyEquivalent(with: ctrlCmdF))
    surface.keyDown(with: ctrlCmdF)
    XCTAssertEqual(exitCount, 2, "⌃⌘F exits full screen from both performKeyEquivalent and keyDown even while controlling remote Mac")
    XCTAssertTrue(forwarded.isEmpty, "⌃⌘F must never be sent to the remote Mac")

    let escape = try XCTUnwrap(NSEvent.keyEvent(
      with: .keyDown,
      location: .zero,
      modifierFlags: [],
      timestamp: 0,
      windowNumber: 0,
      context: nil,
      characters: "\u{1b}",
      charactersIgnoringModifiers: "\u{1b}",
      isARepeat: false,
      keyCode: 53
    ))
    surface.controlEnabled = false
    XCTAssertTrue(surface.acceptsFirstResponder, "Full-screen stage stays focusable when remote control is off")
    XCTAssertTrue(surface.performKeyEquivalent(with: escape))
    surface.keyDown(with: escape)
    surface.cancelOperation(nil)
    XCTAssertEqual(exitCount, 5, "Escape exits full screen whenever remote control is disabled")
    XCTAssertTrue(forwarded.isEmpty)
  }

  @MainActor
  func testClipViewCutoutsPunchTopAlignedHolesAndPassPointerEventsToChromium() {
    final class FlippedHostView: NSView { override var isFlipped: Bool { true } }
    for host in [NSView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800)), FlippedHostView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800))] {
      let cssStage = CGRect(x: 240, y: 42, width: 960, height: 758)
      let stageInHost = CGRect(
        x: cssStage.minX,
        y: host.isFlipped ? cssStage.minY : host.bounds.height - cssStage.maxY,
        width: cssStage.width,
        height: cssStage.height
      )
      let clip = DesktopScreenClipView(frame: stageInHost)
      let surface = DesktopScreenSurface(frame: clip.bounds)
      defer { surface.stop() }
      clip.addSubview(surface)
      host.addSubview(clip)

      // Hole at CSS (700, 48, 220, 260) -> 6pt from top of stage (y = 6..266 in 758pt-tall clip).
      let holeCSS = DesktopScreenHole(rect: CGRect(x: 700, y: 48, width: 220, height: 260), radius: 12)
      clip.applyCutouts([holeCSS], in: host)
      XCTAssertEqual(clip.holesInBounds, [DesktopScreenHole(rect: CGRect(x: 460, y: 6, width: 220, height: 260), radius: 12)])
      XCTAssertNotNil(clip.layer?.mask as? CAShapeLayer)

      // Verify actual Core Animation composited pixel alpha inside a real NSWindow so vertical flip can never invert the cutout.
      let window = NSWindow(
        contentRect: host.bounds,
        styleMask: [.borderless],
        backing: .buffered,
        defer: false
      )
      window.contentView = host
      clip.layer?.backgroundColor = NSColor.white.cgColor
      host.layoutSubtreeIfNeeded()
      if let rep = clip.bitmapImageRepForCachingDisplay(in: clip.bounds) {
        clip.cacheDisplay(in: clip.bounds, to: rep)
        // NSBitmapImageRep(colorAtX:y:) addresses backing pixels (2x on Retina displays), not points.
        let scaleX = CGFloat(rep.pixelsWide) / clip.bounds.width
        let scaleY = CGFloat(rep.pixelsHigh) / clip.bounds.height
        let alphaAt = { (x: CGFloat, y: CGFloat) -> CGFloat? in
          rep.colorAt(x: Int((x * scaleX).rounded()), y: Int((y * scaleY).rounded()))?.alphaComponent
        }
        let topCutoutAlpha = alphaAt(560, 80) ?? 1
        let bottomSolidAlpha = alphaAt(560, 650) ?? 0
        XCTAssertLessThan(topCutoutAlpha, 0.05, "Top popover hole (y=80 from top) must be masked transparent (host.isFlipped=\(host.isFlipped))")
        XCTAssertGreaterThan(bottomSolidAlpha, 0.95, "Bottom stage outside hole (y=650 from top) must stay opaque (host.isFlipped=\(host.isFlipped))")
      }

      let hostPoint = { (cssX: CGFloat, cssY: CGFloat) -> CGPoint in
        CGPoint(x: cssX, y: host.isFlipped ? cssY : host.bounds.height - cssY)
      }

      // Inside cutout hole -> nil (falls through to Chromium). Outside hole -> hits DesktopScreenSurface.
      XCTAssertNil(clip.hitTest(hostPoint(800, 100)))
      XCTAssertTrue(clip.hitTest(hostPoint(400, 300)) === surface)

      // While an overlay is open, outside clicks ALSO fall through to Chromium for Popover light-dismiss.
      clip.overlayOpen = true
      XCTAssertNil(clip.hitTest(hostPoint(400, 300)))

      // Native fullscreen floating capsule/exit bar remains clickable even while overlayOpen is true.
      let overlay = DesktopFullScreenOverlay {}
      overlay.attach(to: clip)
      overlay.bar.reveal(false)
      let handlePointInHost = hostPoint(240 + 480, 42 + 18)
      XCTAssertTrue(clip.hitTest(handlePointInHost) === overlay.handle)
      overlay.detach()

      // Overlapping & nested holes (e.g. popover + an open `<select>` picker extending below it,
      // or a picker fully inside the popover) must all stay transparent without `.evenOdd` inversion.
      let pickerBelowPopoverCSS = DesktopScreenHole(rect: CGRect(x: 713, y: 298, width: 194, height: 90), radius: 10)
      let nestedPickerCSS = DesktopScreenHole(rect: CGRect(x: 713, y: 90, width: 194, height: 80), radius: 10)
      clip.applyCutouts([holeCSS, pickerBelowPopoverCSS, nestedPickerCSS], in: host)
      host.layoutSubtreeIfNeeded()
      if let rep = clip.bitmapImageRepForCachingDisplay(in: clip.bounds) {
        clip.cacheDisplay(in: clip.bounds, to: rep)
        let scaleX = CGFloat(rep.pixelsWide) / clip.bounds.width
        let scaleY = CGFloat(rep.pixelsHigh) / clip.bounds.height
        let alphaAt = { (x: CGFloat, y: CGFloat) -> CGFloat? in
          rep.colorAt(x: Int((x * scaleX).rounded()), y: Int((y * scaleY).rounded()))?.alphaComponent
        }
        // Nested hole center: CSS (810, 130) -> clip (570, 88)
        let nestedAlpha = alphaAt(570, 88) ?? 1
        // Overlap between popover (y=48..308) and picker (y=298..388): CSS (810, 303) -> clip (570, 261)
        let overlapAlpha = alphaAt(570, 261) ?? 1
        // Picker below popover: CSS (810, 360) -> clip (570, 318)
        let belowPopoverAlpha = alphaAt(570, 318) ?? 1
        // Outside all holes: CSS (810, 600) -> clip (570, 558)
        let outsideAlpha = alphaAt(570, 558) ?? 0
        XCTAssertLessThan(nestedAlpha, 0.05, "Nested cutout inside popover must stay transparent")
        XCTAssertLessThan(overlapAlpha, 0.05, "Overlap between popover and select picker must stay transparent")
        XCTAssertLessThan(belowPopoverAlpha, 0.05, "Select picker extending below popover must be cut out transparent")
        XCTAssertGreaterThan(outsideAlpha, 0.95, "Stage outside all cutouts must stay opaque")
      }

      // Clearing cutouts removes the mask cleanly.
      clip.overlayOpen = false
      clip.applyCutouts([], in: host)
      XCTAssertNil(clip.layer?.mask)
      XCTAssertTrue(clip.hitTest(hostPoint(800, 100)) === surface)
    }
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

  func testRotatedDisplayResolvesEffectivePortraitPixelSizeAndScale() {
    // 4K 3840x2160 monitor rotated 90° at 2x HiDPI: CGDisplayBounds is portrait (1080x1920)
    // while CGDisplayCopyDisplayMode still reports native panel pixels (3840x2160).
    let portraitBounds = CGRect(x: 0, y: 0, width: 1080, height: 1920)
    let rotated = Display.effectivePixelSize(
      bounds: portraitBounds,
      modePixelWidth: 3840,
      modePixelHeight: 2160,
      rotation: 90
    )
    XCTAssertEqual(rotated.width, 2160)
    XCTAssertEqual(rotated.height, 3840)

    let display = Display(id: 1, bounds: portraitBounds, pixelWidth: rotated.width, pixelHeight: rotated.height)
    XCTAssertEqual(display.scale, 2.0, accuracy: 0.001)
    let picture = display.pictureSize(maxWidth: 1080)
    XCTAssertEqual(picture.width, 1080)
    XCTAssertEqual(picture.height, 1920)

    // Already-rotated mode dimensions must not be double-swapped.
    let alreadyPortrait = Display.effectivePixelSize(
      bounds: portraitBounds,
      modePixelWidth: 2160,
      modePixelHeight: 3840,
      rotation: 270
    )
    XCTAssertEqual(alreadyPortrait.width, 2160)
    XCTAssertEqual(alreadyPortrait.height, 3840)

    // Normal landscape monitor remains untouched.
    let landscape = Display.effectivePixelSize(
      bounds: CGRect(x: 0, y: 0, width: 1920, height: 1080),
      modePixelWidth: 3840,
      modePixelHeight: 2160,
      rotation: 0
    )
    XCTAssertEqual(landscape.width, 3840)
    XCTAssertEqual(landscape.height, 2160)
  }

  func testReleaseHeldInputsClearsPendingWindowDragState() throws {
    let surface = DesktopScreenSurface(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
    defer { surface.stop() }
    var inputs: [[String: Any]] = []
    surface.onInput = { command, _ in inputs.append(command) }
    surface.controlEnabled = true
    surface.shouldDragWindow = { _ in true }

    let down = try XCTUnwrap(NSEvent.mouseEvent(
      with: .leftMouseDown,
      location: CGPoint(x: 100, y: 20),
      modifierFlags: [],
      timestamp: 0,
      windowNumber: 0,
      context: nil,
      eventNumber: 1,
      clickCount: 1,
      pressure: 1
    ))
    let up = try XCTUnwrap(NSEvent.mouseEvent(
      with: .leftMouseUp,
      location: CGPoint(x: 100, y: 20),
      modifierFlags: [],
      timestamp: 0.1,
      windowNumber: 0,
      context: nil,
      eventNumber: 2,
      clickCount: 1,
      pressure: 0
    ))

    surface.mouseDown(with: down)
    surface.releaseHeldInputs()
    surface.mouseUp(with: up)
    XCTAssertTrue(inputs.isEmpty, "Releasing input while a window drag is pending must clear downEvent so mouseUp never synthesizes a stale click")
  }

  @MainActor
  func testFullScreenOverlayDeinitCleansUpWithoutExplicitDetach() {
    let container = DesktopScreenClipView(frame: CGRect(x: 0, y: 0, width: 1280, height: 800))
    weak var weakOverlay: DesktopFullScreenOverlay?
    autoreleasepool {
      let overlay = DesktopFullScreenOverlay {}
      weakOverlay = overlay
      overlay.attach(to: container)
      overlay.bar.removeFromSuperview()
      overlay.handle.removeFromSuperview()
    }
    XCTAssertNil(weakOverlay, "Overlay must deallocate cleanly and remove its local NSEvent monitor in deinit")
  }

  func testDesktopMediaPipeSurvivesBrokenPipeDuringRapidSwitch() throws {
    let pipe = Pipe()
    let mediaPipe = DesktopMediaPipe(output: pipe.fileHandleForWriting)
    try pipe.fileHandleForReading.close()
    let group = DispatchGroup()
    for index in 0..<64 {
      group.enter()
      DispatchQueue.global(qos: .userInteractive).async {
        mediaPipe.send(["type": "release", "token": index])
        group.leave()
      }
    }
    XCTAssertEqual(group.wait(timeout: .now() + 5), .success)
    mediaPipe.close()
  }

  @MainActor
  func testSurfaceStopAndDeallocUnderConcurrentBackgroundFrameDelivery() throws {
    var pixelBuffer: CVPixelBuffer?
    let attrs: [String: Any] = [
      kCVPixelBufferIOSurfacePropertiesKey as String: [:],
      kCVPixelBufferMetalCompatibilityKey as String: true,
    ]
    let status = CVPixelBufferCreate(
      nil, 64, 64, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attrs as CFDictionary, &pixelBuffer
    )
    XCTAssertEqual(status, kCVReturnSuccess)
    let buffer = try XCTUnwrap(pixelBuffer)
    let ioSurface = try XCTUnwrap(CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue())
    let metadata = DesktopScreenFrame(
      buffer: buffer, width: 64, height: 64, rotation: 0, crop: CGRect(x: 0, y: 0, width: 64, height: 64)
    ).metadata

    for _ in 0..<8 {
      weak var weakSurface: DesktopScreenSurface?
      var sink: DesktopScreenFrameSink?
      autoreleasepool {
        let surface = DesktopScreenSurface(frame: CGRect(x: 0, y: 0, width: 320, height: 180))
        weakSurface = surface
        sink = surface.frameSink
        surface.onInput = { _, _ in }
        surface.onFirstFrame = {}
        surface.onFailure = { _ in }
        let group = DispatchGroup()
        for _ in 0..<24 {
          group.enter()
          DispatchQueue.global(qos: .userInteractive).async { [sink] in
            if let frame = DesktopScreenFrame.importSurface(ioSurface, metadata: metadata, release: {}) {
              sink?.receive(frame)
            }
            group.leave()
          }
        }
        surface.stop()
        XCTAssertEqual(group.wait(timeout: .now() + 5), .success)
      }
      // Even while a background caller still holds `frameSink`, the AppKit NSView must deallocate on main.
      XCTAssertNil(weakSurface, "DesktopScreenSurface NSView must not be retained by non-AppKit frameSink after stop()")
      sink = nil
    }
  }

  private func commandDescription(_ command: [String: Any]) -> String {
    guard let kind = command["t"] as? String else { return "missing-kind" }
    return kind + ":" + ((command[kind == "text" ? "s" : "k"] as? String) ?? "missing-value")
  }
}
