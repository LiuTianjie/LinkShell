import IOKit.pwr_mgt
import XCTest
@testable import LinkShell

/// The hold on the display, as the system itself sees it: there while anyone is watching, gone
/// with the last of them.
final class AwakeTests: XCTestCase {
  /// The types of the power assertions this process holds.
  private func held() -> [String] {
    var all: Unmanaged<CFDictionary>?
    guard IOPMCopyAssertionsByProcess(&all) == kIOReturnSuccess, let byProcess = all?.takeRetainedValue() as? [NSNumber: [[String: Any]]] else { return [] }
    let own = byProcess[NSNumber(value: getpid())] ?? []
    return own.compactMap { $0[kIOPMAssertionTypeKey] as? String }
  }

  func testTheDisplayIsHeldAwakeFromTheFirstViewerToTheLast() {
    XCTAssertEqual(held(), [])
    var first: Awake? = Awake()
    // Kept from sleeping, and woken as a touch of the keyboard wakes it.
    XCTAssertEqual(Set(held()), [kIOPMAssertionTypePreventUserIdleDisplaySleep, "UserIsActive"])
    var second: Awake? = Awake()
    XCTAssertEqual(held().count, 2, "a second viewer adds nothing")
    first = nil
    XCTAssertEqual(held().count, 2, "one viewer is still watching")
    second = nil
    XCTAssertEqual(held(), [])
    _ = (first, second)
  }
}
