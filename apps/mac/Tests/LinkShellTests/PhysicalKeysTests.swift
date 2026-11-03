import CoreGraphics
import XCTest
@testable import LinkShell

/// Held keys between a Mac viewer and a Mac host (`PhysicalKeys`, `keydown` / `keyup`).
final class PhysicalKeysTests: XCTestCase {
  func testEveryCodeMapsToOneMacKeyAndBack() {
    XCTAssertEqual(PhysicalKeys.macKeys.count, PhysicalKeys.codes.count, "No two codes share a key")
    for (code, key) in PhysicalKeys.macKeys { XCTAssertEqual(PhysicalKeys.codes[key], code) }
    XCTAssertEqual(PhysicalKeys.macKeys["KeyA"], 0)
    XCTAssertEqual(PhysicalKeys.macKeys["KeyC"], 8)
    XCTAssertEqual(PhysicalKeys.macKeys["Space"], 49)
    XCTAssertEqual(PhysicalKeys.macKeys["ArrowUp"], 126)
    XCTAssertNil(PhysicalKeys.macKeys["CapsLock"], "Posted events don't change Caps Lock's state")
  }

  func testAModifierFlagStaysWhileEitherSideIsHeld() {
    XCTAssertEqual(PhysicalKeys.flags(of: [56, 60]), .maskShift)
    XCTAssertEqual(PhysicalKeys.flags(of: [60]), .maskShift)
    XCTAssertEqual(PhysicalKeys.flags(of: [55, 58]), [.maskCommand, .maskAlternate])
    XCTAssertEqual(PhysicalKeys.flags(of: [0, 49]), [], "Ordinary keys make no flags")
    XCTAssertNil(PhysicalKeys.modifier(0))
    XCTAssertEqual(PhysicalKeys.modifier(62), .maskControl)
  }

  func testTheAppTakesHeldKeysAndTheMiddleButtonAndNothingLooser() {
    func event(_ object: [String: Any]) -> InputEvent? { InputEvent(json: try! JSONSerialization.data(withJSONObject: object)) }
    XCTAssertNotNil(event(["t": "keydown", "c": "ShiftLeft"]))
    XCTAssertNotNil(event(["t": "keydown", "c": "ArrowLeft", "r": true]))
    XCTAssertNotNil(event(["t": "keyup", "c": "KeyC"]))
    XCTAssertNotNil(event(["t": "down", "b": "middle"]))
    XCTAssertNil(event(["t": "keydown"]), "A key needs its code")
    XCTAssertNil(event(["t": "keydown", "c": ""]))
    XCTAssertNil(event(["t": "keydown", "c": String(repeating: "K", count: 33)]))
    XCTAssertNil(event(["t": "keydown", "c": "KeyA", "r": 1]), "The repeat is a boolean")
    XCTAssertNil(event(["t": "down", "b": "back"]))
  }
}
