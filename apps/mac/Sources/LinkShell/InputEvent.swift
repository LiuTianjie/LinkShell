import Foundation

/// One event from a viewer that reached the app directly (a data channel), checked as the host
/// checks the ones it passes on (`inputEvent` in packages/host/src/input.ts): what is not one of
/// these, exactly, is dropped. Keys it doesn't know are ignored, as the host's check strips them.
struct InputEvent {
  let kind: String
  let command: [String: Any]
  /// "i": the viewer's own count of its events, when it numbers them (see `ScreenSession`).
  let number: Int?

  private static let modifierNames: Set<String> = ["cmd", "shift", "alt", "ctrl"]

  init?(json data: Data) {
    guard data.count <= Tuning.maxEventBytes,
          let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let kind = command["t"] as? String
    else { return nil }
    let number = InputEvent.number
    switch kind {
    case "move":
      guard let x = number(command["x"]), let y = number(command["y"]), (0...1).contains(x), (0...1).contains(y) else { return nil }
    case "down", "up":
      guard let button = command["b"] as? String, button == "left" || button == "right" else { return nil }
      if let clicks = command["n"] {
        guard let count = number(clicks), count == count.rounded(), (1...3).contains(count) else { return nil }
      }
      guard InputEvent.modifiers(command["m"]) else { return nil }
    case "scroll":
      guard number(command["dx"]) != nil, number(command["dy"]) != nil, InputEvent.modifiers(command["m"]) else { return nil }
    case "key":
      guard let key = command["k"] as? String, (1...16).contains(key.utf16.count), InputEvent.modifiers(command["m"]) else { return nil }
    case "text":
      guard let text = command["s"] as? String, (1...4000).contains(text.utf16.count) else { return nil }
    case "prompt":
      break
    default:
      return nil
    }
    self.kind = kind
    self.command = command
    self.number = number(command["i"]).flatMap { $0 >= 0 && $0 == $0.rounded() && $0 < 9e15 ? Int($0) : nil }
  }

  /// A JSON number (always finite), and not `true` or `false`, which Foundation reads as numbers too.
  private static func number(_ value: Any?) -> Double? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
    return value.doubleValue
  }

  /// Absent, or up to four of the names.
  private static func modifiers(_ value: Any?) -> Bool {
    guard let value else { return true }
    guard let names = value as? [String] else { return false }
    return names.count <= 4 && names.allSatisfy(modifierNames.contains)
  }
}
