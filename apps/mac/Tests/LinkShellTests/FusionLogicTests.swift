import AppKit
import XCTest
import LinkShellScreen
@testable import LinkShell

/// Fusion decisions that need no screen, no second Mac and no network.
final class FusionLogicTests: XCTestCase {
  // MARK: shortcuts (B8 / C5)

  func testOnlyWindowManagementChordsStayLocal() {
    XCTAssertEqual(FusionShortcuts.local(keyCode: 4, modifiers: [.command]), .hide)
    XCTAssertEqual(FusionShortcuts.local(keyCode: 4, modifiers: [.command, .option]), .hideOthers)
    XCTAssertEqual(FusionShortcuts.local(keyCode: 46, modifiers: [.command]), .minimize)
    XCTAssertEqual(FusionShortcuts.local(keyCode: 50, modifiers: [.command]), .cycleWindows)
    XCTAssertEqual(FusionShortcuts.local(keyCode: 50, modifiers: [.command, .shift]), .cycleWindowsBackward)
    // Device-dependent bits (left/right ⌘, caps lock) do not change the answer.
    XCTAssertEqual(FusionShortcuts.local(keyCode: 4, modifiers: [.command, .capsLock, NSEvent.ModifierFlags(rawValue: 0x8)]), .hide)
  }

  func testEditingAndAppChordsGoToTheRemoteApp() {
    // ⌘C ⌘V ⌘X ⌘Z ⌘Q ⌘W ⌘T ⌘N ⌘, ⌘F ⌘S ⌘A
    for code: UInt16 in [8, 9, 7, 6, 12, 13, 17, 45, 43, 3, 1, 0] {
      XCTAssertNil(FusionShortcuts.local(keyCode: code, modifiers: [.command]), "key \(code)")
    }
    XCTAssertNil(FusionShortcuts.local(keyCode: 4, modifiers: [.control]), "⌃H is the app's (delete back in text)")
    XCTAssertNil(FusionShortcuts.local(keyCode: 46, modifiers: [.command, .option]), "⌥⌘M is the app's")
    XCTAssertNil(FusionShortcuts.local(keyCode: 4, modifiers: [.command, .shift]))
  }

  // MARK: live resize throttle (C1)

  func testResizeThrottleSendsAtMostThirtyTimesASecondLatestWins() {
    var throttle = FusionResizeThrottle(interval: 1.0 / 30)
    let a = CGRect(x: 0, y: 0, width: 400, height: 300)
    let b = CGRect(x: 0, y: 0, width: 410, height: 300)
    let c = CGRect(x: 0, y: 0, width: 420, height: 300)
    XCTAssertEqual(throttle.offer(a, now: 10.0), a)
    XCTAssertNil(throttle.offer(b, now: 10.01))
    XCTAssertNil(throttle.offer(c, now: 10.02))
    XCTAssertEqual(throttle.pending, c)
    XCTAssertNil(throttle.flush(now: 10.03), "not yet its turn")
    XCTAssertEqual(throttle.nextDeadline!, 10.0 + 1.0 / 30, accuracy: 1e-9)
    XCTAssertEqual(throttle.flush(now: 10.04), c, "the latest size, not the first kept")
    XCTAssertNil(throttle.flush(now: 10.2), "nothing kept twice")
    XCTAssertNil(throttle.nextDeadline)
  }

  func testResizeThrottleCoalescesAFastDrag() {
    var throttle = FusionResizeThrottle(interval: 1.0 / 30)
    var sent = 0
    var t = 0.0
    for i in 0..<600 { // one second at 600 events/s
      t = Double(i) / 600
      if throttle.offer(CGRect(x: 0, y: 0, width: 300 + i, height: 200), now: t) != nil { sent += 1 }
    }
    if throttle.flush(now: t + 1) != nil { sent += 1 }
    XCTAssertLessThanOrEqual(sent, 32)
    XCTAssertGreaterThanOrEqual(sent, 29)
  }

  // MARK: clipboard guard (C3)

  func testClipboardNeverSendsBeforeAFusedWindowWasFocused() {
    var guardrail = FusionClipboardGuard()
    XCTAssertFalse(guardrail.shouldSend(changeCount: 5, types: ["public.utf8-plain-text"], bytes: 10))
    guardrail.armed = true
    XCTAssertTrue(guardrail.shouldSend(changeCount: 6, types: ["public.utf8-plain-text"], bytes: 10))
  }

  func testClipboardDoesNotBounceWhatItWrote() {
    var guardrail = FusionClipboardGuard()
    guardrail.armed = true
    guardrail.didWrite(changeCount: 42)
    XCTAssertFalse(guardrail.isUnseen(changeCount: 42))
    XCTAssertFalse(guardrail.shouldSend(changeCount: 42, types: ["public.utf8-plain-text"], bytes: 10))
    XCTAssertTrue(guardrail.shouldSend(changeCount: 43, types: ["public.utf8-plain-text"], bytes: 10))
    XCTAssertFalse(guardrail.shouldSend(changeCount: 43, types: ["public.utf8-plain-text"], bytes: 10), "each change is sent once")
  }

  func testClipboardSkipsPasswordManagerAndOversizedCopies() {
    var guardrail = FusionClipboardGuard()
    guardrail.armed = true
    XCTAssertFalse(guardrail.shouldSend(changeCount: 1, types: ["public.utf8-plain-text", "org.nspasteboard.ConcealedType"], bytes: 12))
    XCTAssertFalse(guardrail.shouldSend(changeCount: 2, types: ["org.nspasteboard.TransientType"], bytes: 12))
    XCTAssertFalse(guardrail.shouldSend(changeCount: 3, types: ["com.agilebits.onepassword"], bytes: 12))
    XCTAssertFalse(guardrail.shouldSend(changeCount: 4, types: ["public.png"], bytes: FusionClipboardGuard.maxBytes + 1))
    XCTAssertFalse(guardrail.shouldSend(changeCount: 5, types: ["public.png"], bytes: 0))
    XCTAssertTrue(guardrail.shouldSend(changeCount: 6, types: ["public.png"], bytes: FusionClipboardGuard.maxBytes))
  }

  func testClipboardItemRoundTripsAndRejectsOversizedOrEmpty() {
    let item = FusionClipboardItem(text: "héllo", rtf: Data("{\\rtf1}".utf8), png: Data([0x89, 0x50]))
    XCTAssertEqual(FusionClipboardItem(message: item.message), item)
    XCTAssertNil(FusionClipboardItem(message: ["t": "clip"]))
    let huge = String(repeating: "a", count: FusionClipboardGuard.maxBytes + 1)
    XCTAssertNil(FusionClipboardItem(message: ["t": "clip", "text": huge]))
  }

  // MARK: tombstones (B7)

  func testTombstonesForgetOldestFirst() {
    var tombs = FusionTombstones(capacity: 3)
    for id: UInt32 in [1, 2, 3, 4] { tombs.insert(id) }
    XCTAssertFalse(tombs.contains(1))
    XCTAssertTrue(tombs.contains(4))
    tombs.remove(3)
    XCTAssertFalse(tombs.contains(3), "a reopened id (wopen) is alive again")
    XCTAssertEqual(tombs.count, 2)
  }

  // MARK: window levels (C8)

  func testPalettesFloatAndOnlyMenusAreMenus() {
    XCTAssertEqual(FusionWindowLevels.local(remoteLayer: 0), .normal)
    XCTAssertEqual(FusionWindowLevels.local(remoteLayer: 3), .floating)
    XCTAssertEqual(FusionWindowLevels.local(remoteLayer: 101), .popUpMenu)
    XCTAssertNotEqual(FusionWindowLevels.local(remoteLayer: 3), .popUpMenu)
  }

  // MARK: tokens, displays, exits

  func testTokenComparisonNeedsAnExactNonEmptyMatch() {
    XCTAssertTrue(FusionRemote.tokensMatch("abc", "abc"))
    XCTAssertFalse(FusionRemote.tokensMatch("abc", "abd"))
    XCTAssertFalse(FusionRemote.tokensMatch("abc", "ab"))
    XCTAssertFalse(FusionRemote.tokensMatch("", ""))
  }

  func testSingleUseTokenOpensOnce() {
    let remote = FusionRemote(port: 0, parentSocketPath: nil)
    XCTAssertFalse(remote.consume(token: "anything"), "no token handed out yet")
  }

  func testDisplaySignatureChangesWithScaleOrArrangement() {
    let base: [[String: Any]] = [["frame": ["x": 0, "y": 0, "w": 1512, "h": 982], "visible": ["x": 0, "y": 33, "w": 1512, "h": 949], "scale": 2]]
    var rescaled = base
    rescaled[0]["scale"] = 1
    var moved = base
    moved[0]["frame"] = ["x": 1512, "y": 0, "w": 1512, "h": 982]
    let s = FusionLocal.displaysSignature(base)
    XCTAssertEqual(s, FusionLocal.displaysSignature(base))
    XCTAssertNotEqual(s, FusionLocal.displaysSignature(rescaled))
    XCTAssertNotEqual(s, FusionLocal.displaysSignature(moved))
  }

  func testCloseReasonsAreExplained() {
    XCTAssertTrue(FusionLocal.describeClose("timeout").contains("无响应"))
    XCTAssertTrue(FusionLocal.describeClose("tls").contains("凭据"))
    XCTAssertFalse(FusionLocal.describeClose("whatever").isEmpty)
  }

  // MARK: stub cleanup (B20)

  func testOnlyOurOwnStubsWhoseAppLeftAreStale() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fusion-stubs-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    func bundle(_ name: String, _ info: [String: Any]?) throws {
      let contents = dir.appendingPathComponent("\(name).app/Contents")
      try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
      if let info { (info as NSDictionary).write(to: contents.appendingPathComponent("Info.plist"), atomically: true) }
    }
    try bundle("Kept", ["LSFusionBundleID": "com.example.kept"])
    try bundle("Gone", ["LSFusionBundleID": "com.example.gone"])
    try bundle("NotOurs", ["CFBundleIdentifier": "com.someone.else"])
    try bundle("Broken", nil)
    let stale = FusionLocal.staleStubBundles(in: dir, keeping: ["com.example.kept"]).map(\.lastPathComponent)
    XCTAssertEqual(stale, ["Gone.app"])
  }

  // MARK: Dock marker (B9)

  func testDockMarkerLivesUnderTheGivenHome() {
    XCTAssertEqual(FusionDock.marker(home: "/tmp/h"), "/tmp/h/fusion-dock-hidden")
  }

  // MARK: logs

  func testLogRotatesPastItsLimit() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fusion-log-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir); Fusion.logPath = nil }
    let path = dir.appendingPathComponent("fusion-local.log").path
    Fusion.logPath = path
    let line = String(repeating: "x", count: 64 * 1024)
    for _ in 0..<40 { Fusion.log(line) } // ~2.5 MB
    XCTAssertTrue(FileManager.default.fileExists(atPath: path + ".1"))
    let size = (try FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.intValue ?? 0
    XCTAssertLessThan(size, Int(Fusion.logLimit))
  }

  // MARK: menu bar mirroring (C4)

  func testAXMenuModifiersMapToAppKit() {
    XCTAssertEqual(FusionMenuModel.modifiers(0), [.command])
    XCTAssertEqual(FusionMenuModel.modifiers(1), [.command, .shift])
    XCTAssertEqual(FusionMenuModel.modifiers(2 | 1), [.command, .shift, .option])
    XCTAssertEqual(FusionMenuModel.modifiers(4), [.command, .control])
    XCTAssertEqual(FusionMenuModel.modifiers(8 | 4), [.control], "bit 3 means no ⌘")
    XCTAssertEqual(FusionMenuModel.keyEquivalent("N"), "n")
    XCTAssertEqual(FusionMenuModel.keyEquivalent(""), "")
  }

  func testOnlyTheAppsOwnMenusAreMirrored() {
    XCTAssertFalse(FusionMenuModel.mirrorsTopLevel(index: 0), "Apple menu")
    XCTAssertFalse(FusionMenuModel.mirrorsTopLevel(index: 1), "the stub's own app menu")
    XCTAssertTrue(FusionMenuModel.mirrorsTopLevel(index: 2))
    XCTAssertEqual(FusionMenuModel.pathKey([2, 0, 3]), "2.0.3")
  }
}
