import CoreGraphics
import Foundation

/// Physical keys between a Mac viewer and a Mac host, named by the W3C `KeyboardEvent.code`
/// ("KeyA", "ShiftLeft"): a position on the keyboard, not the character it types, so the host's
/// own layout and input method decide what a key means there, as with a keyboard plugged into it.
///
/// Caps Lock, fn and the media keys are left out: posted key events don't change their state.
public enum PhysicalKeys {
  /// W3C code → macOS virtual key code (ANSI positions; ISO and JIS extras where they exist).
  public static let macKeys: [String: UInt16] = [
    "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9,
    "IntlBackslash": 10, "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17,
    "Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24, "Digit9": 25,
    "Digit7": 26, "Minus": 27, "Digit8": 28, "Digit0": 29, "BracketRight": 30, "KeyO": 31, "KeyU": 32,
    "BracketLeft": 33, "KeyI": 34, "KeyP": 35, "Enter": 36, "KeyL": 37, "KeyJ": 38, "Quote": 39, "KeyK": 40,
    "Semicolon": 41, "Backslash": 42, "Comma": 43, "Slash": 44, "KeyN": 45, "KeyM": 46, "Period": 47,
    "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51, "Escape": 53,
    "MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56, "AltLeft": 58, "ControlLeft": 59,
    "ShiftRight": 60, "AltRight": 61, "ControlRight": 62,
    "F17": 64, "NumpadDecimal": 65, "NumpadMultiply": 67, "NumpadAdd": 69, "NumLock": 71,
    "NumpadDivide": 75, "NumpadEnter": 76, "NumpadSubtract": 78, "F18": 79, "F19": 80, "NumpadEqual": 81,
    "Numpad0": 82, "Numpad1": 83, "Numpad2": 84, "Numpad3": 85, "Numpad4": 86, "Numpad5": 87, "Numpad6": 88,
    "Numpad7": 89, "F20": 90, "Numpad8": 91, "Numpad9": 92, "IntlYen": 93, "IntlRo": 94, "NumpadComma": 95,
    "F5": 96, "F6": 97, "F7": 98, "F3": 99, "F8": 100, "F9": 101, "Lang2": 102, "F11": 103, "Lang1": 104,
    "F13": 105, "F16": 106, "F14": 107, "F10": 109, "ContextMenu": 110, "F12": 111, "F15": 113, "Help": 114,
    "Home": 115, "PageUp": 116, "Delete": 117, "F4": 118, "End": 119, "F2": 120, "PageDown": 121, "F1": 122,
    "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
  ]

  /// macOS virtual key code → W3C code: what a viewer sends for the key it was given.
  public static let codes: [UInt16: String] = Dictionary(uniqueKeysWithValues: macKeys.map { ($0.value, $0.key) })

  /// The modifier a key is, if it is one.
  public static func modifier(_ key: UInt16) -> CGEventFlags? {
    switch key {
    case 54, 55: return .maskCommand
    case 56, 60: return .maskShift
    case 58, 61: return .maskAlternate
    case 59, 62: return .maskControl
    default: return nil
    }
  }

  /// The flags that the modifier keys held make: a flag stays while either side's key is down.
  public static func flags(of held: Set<UInt16>) -> CGEventFlags {
    held.reduce(into: CGEventFlags()) { flags, key in if let flag = modifier(key) { flags.insert(flag) } }
  }
}
