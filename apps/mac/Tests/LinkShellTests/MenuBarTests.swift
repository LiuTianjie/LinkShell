import AppKit
import XCTest
@testable import LinkShell

final class MenuBarTests: XCTestCase {
  @MainActor func testMenuIsWhatTheWindowSentAndSkipsWhatItCannotShow() {
    let target = NSObject()
    let menu = MenuBar.menu([
      ["id": "open", "label": "打开 LinkShell"],
      ["id": "manage"],
      ["separator": true],
      ["label": "no id"],
      ["id": "quit", "label": "退出 LinkShell 界面"],
    ], target: target)
    XCTAssertEqual(menu.items.map(\.title), ["打开 LinkShell", "", "退出 LinkShell 界面"])
    XCTAssertTrue(menu.items[1].isSeparatorItem)
    XCTAssertEqual(menu.items[0].representedObject as? String, "open")
    XCTAssertEqual(menu.items[2].representedObject as? String, "quit")
    XCTAssertTrue(menu.items[0].target === target)
  }
}
