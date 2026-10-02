import Carbon
import CoreGraphics
import Foundation

/// Which key a name is, on this Mac's keyboard.
enum Keys {
  /// Keys that are where they are on every layout.
  private static let fixed: [String: CGKeyCode] = [
    "return": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53,
    "left": 123, "right": 124, "down": 125, "up": 126, "delete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  ]

  /// The American layout, for a Mac whose own can't be read.
  private static let american: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
    ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "backspace": 51, "escape": 53,
    "left": 123, "right": 124, "down": 125, "up": 126, "delete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  ]

  /// The keys a modifier is, pressed and let go around what it modifies as a hand does: some
  /// programs look at the keyboard's state, not at the event's flags.
  static let modifiers: [(name: String, code: CGKeyCode, flag: CGEventFlags)] = [
    ("ctrl", 59, .maskControl), ("alt", 58, .maskAlternate), ("shift", 56, .maskShift), ("cmd", 55, .maskCommand),
  ]

  // Where each character is on this Mac's own layout: a shortcut's letter is the key that types
  // it here, not the key it is on an American keyboard.
  private static var layoutID = ""
  private static var layout: [String: CGKeyCode] = [:]

  private static func readLayout() {
    guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue() else { return }
    let id: String = InputSource.property(source, kTISPropertyInputSourceID) ?? ""
    if id == layoutID, !layout.isEmpty { return }
    guard let data: NSData = InputSource.property(source, kTISPropertyUnicodeKeyLayoutData) else { return }
    layoutID = id
    layout = [:]
    let table = data.bytes.assumingMemoryBound(to: UCKeyboardLayout.self)
    for code in 0..<127 {
      var dead: UInt32 = 0
      var length = 0
      var characters = [UniChar](repeating: 0, count: 4)
      let status = UCKeyTranslate(table, UInt16(code), UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 4, &length, &characters)
      guard status == noErr, length == 1 else { continue }
      let character = String(utf16CodeUnits: characters, count: 1).lowercased()
      // The main keys come before the number pad's.
      if layout[character] == nil { layout[character] = CGKeyCode(code) }
    }
  }

  static func code(_ name: String) -> CGKeyCode? {
    if let code = fixed[name] { return code }
    readLayout()
    return layout[name] ?? american[name]
  }

  static func flags(_ names: Any?) -> CGEventFlags {
    var result: CGEventFlags = []
    for name in (names as? [String]) ?? [] {
      switch name {
      case "cmd": result.insert(.maskCommand)
      case "shift": result.insert(.maskShift)
      case "alt": result.insert(.maskAlternate)
      case "ctrl": result.insert(.maskControl)
      default: break
      }
    }
    return result
  }
}

/// The way this Mac turns keys into text: a keyboard layout, or an input method (pinyin, say).
enum InputSource {
  static func property<T>(_ source: TISInputSource, _ key: CFString) -> T? {
    guard let pointer = TISGetInputSourceProperty(source, key) else { return nil }
    return Unmanaged<AnyObject>.fromOpaque(pointer).takeUnretainedValue() as? T
  }

  /// The input source the user had, while the plain layout stands in for it.
  private static var own: TISInputSource?
  private static var restore: DispatchWorkItem?

  /// Text from the phone is already what it should be. An input method on this Mac would take
  /// its letters and compose with them again, so while text is coming the Mac types with its
  /// plain layout; a moment after the last of it, the input source the user had is back.
  static func plainWhileTyping() {
    if Launch.dryRun { return }
    if let current = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() {
      let plain: Bool = property(current, kTISPropertyInputSourceIsASCIICapable) ?? true
      if !plain, let layout = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue() {
        if own == nil { own = current }
        TISSelectInputSource(layout)
        // The program in front takes a moment to follow.
        usleep(150_000)
      }
    }
    guard own != nil else { return }
    restore?.cancel()
    let work = DispatchWorkItem { restoreNow() }
    restore = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: work)
  }

  /// The input source the user had is back at once: the app is about to go, and would
  /// otherwise leave the Mac typing with the plain layout.
  static func restoreNow() {
    restore?.cancel()
    restore = nil
    if let source = own { TISSelectInputSource(source) }
    own = nil
  }
}
