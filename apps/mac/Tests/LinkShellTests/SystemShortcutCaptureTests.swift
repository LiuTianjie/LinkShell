import CoreGraphics
import Foundation
import XCTest
import LinkShellScreen

private final class MockShortcutTapHandle: SystemShortcutTapHandle {
  var enabled = true
  var invalidated = false
  var onInvalidate: (() -> Void)?

  func setEnabled(_ enabled: Bool) {
    self.enabled = enabled
  }

  func invalidate() {
    guard !invalidated else { return }
    invalidated = true
    enabled = false
    onInvalidate?()
  }
}

final class SystemShortcutCaptureTests: XCTestCase {
  private func makeHarness(
    trusted: @escaping () -> Bool = { true },
    physicalKeys: Bool = true,
    forwardsModifiers: Bool = true
  ) -> (
    capture: SystemShortcutCapture,
    installs: () -> Int,
    invalidations: () -> Int,
    inputs: () -> [[String: Any]],
    releases: () -> Int,
    clearEvents: () -> Void
  ) {
    var installCount = 0
    var invalidationCount = 0
    var recordedInputs: [[String: Any]] = []
    var releaseCount = 0

    let capture = SystemShortcutCapture(
      physicalKeys: physicalKeys,
      forwardsModifiers: forwardsModifiers,
      isTrusted: trusted,
      makeTap: { _ in
        installCount += 1
        let handle = MockShortcutTapHandle()
        handle.onInvalidate = { invalidationCount += 1 }
        return handle
      }
    )
    capture.onInput = { recordedInputs.append($0) }
    capture.onReleaseAll = { releaseCount += 1 }

    return (
      capture,
      { installCount },
      { invalidationCount },
      { recordedInputs },
      { releaseCount },
      {
        recordedInputs.removeAll()
        releaseCount = 0
      }
    )
  }

  func testTapOnlyInstallsWhenEnabledTrustedKeyActiveAndFocused() {
    var trusted = false
    let h = makeHarness(trusted: { trusted })

    // Missing trusted & focus
    XCTAssertFalse(h.capture.updateState(enabled: true, windowIsKey: true, appIsActive: true, surfaceActive: true, surfaceFocused: true))
    XCTAssertEqual(h.installs(), 0)
    XCTAssertFalse(h.capture.isTapActive)

    // Trusted, but window not key
    trusted = true
    XCTAssertFalse(h.capture.updateState(windowIsKey: false))
    XCTAssertEqual(h.installs(), 0)

    // All preconditions met -> installs tap
    XCTAssertTrue(h.capture.updateState(windowIsKey: true))
    XCTAssertEqual(h.installs(), 1)
    XCTAssertTrue(h.capture.isTapActive)

    // Unfocused surface -> immediate teardown + release
    XCTAssertFalse(h.capture.updateState(surfaceFocused: false))
    XCTAssertEqual(h.invalidations(), 1)
    XCTAssertEqual(h.releases(), 1)
    XCTAssertFalse(h.capture.isTapActive)
  }

  func testSafetyEscapeShortcutsNeverCapturedOrSuppressedAndReleaseHeldInputs() {
    let h = makeHarness(physicalKeys: true, forwardsModifiers: true)
    XCTAssertTrue(h.capture.updateState(enabled: true, windowIsKey: true, appIsActive: true, surfaceActive: true, surfaceFocused: true))

    // Hold Command + Control + Tab first
    _ = h.capture.process(.init(type: .flagsChanged, keyCode: 55, flags: [.maskCommand]))
    _ = h.capture.process(.init(type: .flagsChanged, keyCode: 59, flags: [.maskCommand, .maskControl]))
    XCTAssertTrue(h.capture.process(.init(type: .keyDown, keyCode: 48, flags: [.maskCommand, .maskControl])))
    XCTAssertEqual(h.capture.capturedKeys, [48])
    h.clearEvents()

    // ⌃⌘F MUST pass through locally (returns false), never forward to onInput, and call releaseAll()
    let suppressedFullScreen = h.capture.process(.init(type: .keyDown, keyCode: 3, flags: [.maskControl, .maskCommand], charactersIgnoringModifiers: "f"))
    XCTAssertFalse(suppressedFullScreen)
    XCTAssertEqual(h.releases(), 1)
    let keyUpCodes = h.inputs().compactMap { ($0["t"] as? String) == "keyup" ? ($0["c"] as? String) : nil }
    XCTAssertTrue(keyUpCodes.contains("Tab"))
    XCTAssertTrue(keyUpCodes.contains("MetaLeft"))
    XCTAssertTrue(keyUpCodes.contains("ControlLeft"))
    XCTAssertFalse(h.inputs().contains { ($0["c"] as? String) == "KeyF" })
    XCTAssertTrue(h.capture.capturedKeys.isEmpty)
    h.clearEvents()

    // ⌃⌥⌘Esc MUST pass through locally (returns false), never forward to onInput, and call releaseAll()
    _ = h.capture.process(.init(type: .flagsChanged, keyCode: 55, flags: [.maskCommand]))
    let suppressedForceQuit = h.capture.process(.init(type: .keyDown, keyCode: 53, flags: [.maskControl, .maskAlternate, .maskCommand]))
    XCTAssertFalse(suppressedForceQuit)
    XCTAssertEqual(h.releases(), 1)
    XCTAssertFalse(h.inputs().contains { ($0["c"] as? String) == "Escape" })
    XCTAssertTrue(h.capture.trackedModifiers.isEmpty)
  }

  func testCapturesSystemShortcutsAndLeavesNormalTypingAlone() {
    let h = makeHarness(physicalKeys: true, forwardsModifiers: false)
    XCTAssertTrue(h.capture.updateState(enabled: true, windowIsKey: true, appIsActive: true, surfaceActive: true, surfaceFocused: true))

    // Normal letter typing passes through cleanly for NSTextInputClient / Pinyin IME
    XCTAssertFalse(h.capture.process(.init(type: .keyDown, keyCode: 0, flags: [], charactersIgnoringModifiers: "a")))
    XCTAssertFalse(h.capture.process(.init(type: .keyUp, keyCode: 0, flags: [])))
    XCTAssertTrue(h.inputs().isEmpty)

    // System shortcuts (⌘Tab, ⌘Space, ⌘H, ⌘Q, ⌘W, ⌃↑, F11) are suppressed & forwarded
    let shortcuts: [(UInt16, CGEventFlags, String)] = [
      (48, [.maskCommand], "Tab"),
      (49, [.maskCommand], "Space"),
      (4, [.maskCommand], "KeyH"),
      (12, [.maskCommand], "KeyQ"),
      (13, [.maskCommand], "KeyW"),
      (126, [.maskControl], "ArrowUp"),
      (103, [], "F11"),
    ]
    for (code, flags, w3c) in shortcuts {
      XCTAssertTrue(h.capture.process(.init(type: .keyDown, keyCode: code, flags: flags)), "Expected keyCode \(code) captured")
      // Even if Command is released before keyUp, matching keyUp is still captured & released!
      XCTAssertTrue(h.capture.process(.init(type: .keyUp, keyCode: code, flags: [])))
      let sent = h.inputs()
      XCTAssertEqual(sent.count, 2)
      XCTAssertEqual(sent[0]["t"] as? String, "keydown")
      XCTAssertEqual(sent[0]["c"] as? String, w3c)
      XCTAssertEqual(sent[1]["t"] as? String, "keyup")
      XCTAssertEqual(sent[1]["c"] as? String, w3c)
      h.clearEvents()
    }
  }

  func testBlurDeactivateDisconnectToggleAndDeinitReleaseAndTeardownTap() {
    // 1. Window resignKey
    do {
      let h = makeHarness(physicalKeys: true)
      XCTAssertTrue(h.capture.updateState(enabled: true, windowIsKey: true, appIsActive: true, surfaceActive: true, surfaceFocused: true))
      _ = h.capture.process(.init(type: .keyDown, keyCode: 48, flags: [.maskCommand]))
      h.capture.handleWindowResignKey()
      XCTAssertFalse(h.capture.isTapActive)
      XCTAssertEqual(h.invalidations(), 1)
      XCTAssertEqual(h.releases(), 1)
      XCTAssertEqual(h.inputs().last?["t"] as? String, "keyup")
      XCTAssertEqual(h.inputs().last?["c"] as? String, "Tab")
    }

    // 2. App deactivate / hide
    do {
      let h = makeHarness(physicalKeys: true)
      XCTAssertTrue(h.capture.updateState(enabled: true, windowIsKey: true, appIsActive: true, surfaceActive: true, surfaceFocused: true))
      _ = h.capture.process(.init(type: .keyDown, keyCode: 49, flags: [.maskCommand]))
      h.capture.handleAppDeactivateOrHide()
      XCTAssertFalse(h.capture.isTapActive)
      XCTAssertEqual(h.invalidations(), 1)
      XCTAssertEqual(h.releases(), 1)
    }

    // 3. Stream disconnect
    do {
      let h = makeHarness(physicalKeys: true)
      XCTAssertTrue(h.capture.updateState(enabled: true, windowIsKey: true, appIsActive: true, surfaceActive: true, surfaceFocused: true))
      h.capture.handleStreamDisconnect()
      XCTAssertFalse(h.capture.isTapActive)
      XCTAssertEqual(h.invalidations(), 1)
      XCTAssertEqual(h.releases(), 1)
    }

    // 4. Toggle off
    do {
      let h = makeHarness(physicalKeys: true)
      XCTAssertTrue(h.capture.updateState(enabled: true, windowIsKey: true, appIsActive: true, surfaceActive: true, surfaceFocused: true))
      XCTAssertFalse(h.capture.setEnabled(false))
      XCTAssertFalse(h.capture.isTapActive)
      XCTAssertEqual(h.invalidations(), 1)
      XCTAssertEqual(h.releases(), 1)
    }

    // 5. deinit
    var deinitInvalidations = 0
    var deinitReleases = 0
    do {
      let capture = SystemShortcutCapture(
        physicalKeys: true,
        forwardsModifiers: false,
        isTrusted: { true },
        makeTap: { _ in
          let handle = MockShortcutTapHandle()
          handle.onInvalidate = { deinitInvalidations += 1 }
          return handle
        }
      )
      capture.onReleaseAll = { deinitReleases += 1 }
      XCTAssertTrue(capture.updateState(enabled: true, windowIsKey: true, appIsActive: true, surfaceActive: true, surfaceFocused: true))
      _ = capture.process(.init(type: .keyDown, keyCode: 48, flags: [.maskCommand]))
      _ = capture
    }
    XCTAssertEqual(deinitInvalidations, 1)
    XCTAssertEqual(deinitReleases, 1)
  }
}
