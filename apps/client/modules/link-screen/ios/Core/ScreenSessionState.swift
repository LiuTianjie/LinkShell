import CoreFoundation
import Foundation

/// The page owns request IDs. Native input waits for that exact applied target, so a late
/// resume acknowledgement cannot enable the pointer over a different or hidden display.
struct ScreenSessionState {
  private(set) var active = true
  private(set) var supportsConfiguration = false
  private(set) var supportsPause = false
  private(set) var latestRequestID: Int?
  private var awaitingConfiguration = false
  private var needsConfiguration = false
  private var requestedPaused = false
  private var requestedDisplay: Int?
  private var generation: Int?
  var allowsInput: Bool { active && !awaitingConfiguration && (!supportsConfiguration || generation != nil) }

  func acceptsInput(_ message: [String: Any]) -> Bool {
    allowsInput && (!supportsConfiguration || Self.integer(message["screenGeneration"]) == generation)
  }

  mutating func setActive(_ value: Bool) {
    guard active != value else { return }
    active = value
    if supportsConfiguration {
      awaitingConfiguration = true
      if !value { needsConfiguration = true }
    }
  }

  mutating func receive(_ session: [String: Any]) {
    switch session["t"] as? String {
    case "capabilities":
      guard Self.integer(session["version"]) == 1 else { return }
      supportsConfiguration = Self.boolean(session["configure"]) == true
      supportsPause = supportsConfiguration && Self.boolean(session["pause"]) == true
    case "configured":
      guard !needsConfiguration, let requestID = Self.integer(session["requestId"]), requestID == latestRequestID,
            let display = Self.integer(session["display"]), display == requestedDisplay,
            let generation = Self.integer(session["generation"]), generation >= 0,
            let paused = Self.boolean(session["paused"]), paused == requestedPaused else { return }
      self.generation = generation
      awaitingConfiguration = paused || !active
    default: break
    }
  }

  mutating func configuration(_ message: [String: Any], maxFps: Int) -> [String: Any]? {
    guard message["t"] as? String == "screen.configure",
          let requestID = Self.integer(message["requestId"]), requestID >= 0,
          requestID > (latestRequestID ?? -1),
          let display = Self.integer(message["display"]), display >= 0,
          let paused = Self.boolean(message["paused"]) else { return nil }
    let width: Any
    if message["width"] as? String == "native" { width = "native" }
    else if let value = Self.integer(message["width"]), (640...3840).contains(value) { width = value }
    else if let text = message["width"] as? String, let value = Int(text), (640...3840).contains(value) { width = value }
    else { return nil }
    let requestedFps = message["maxFps"] == nil ? maxFps : Self.integer(message["maxFps"])
    guard let requestedFps, [30, 60, 120].contains(requestedFps), [30, 60, 120].contains(maxFps) else { return nil }
    latestRequestID = requestID
    requestedPaused = paused
    requestedDisplay = display
    awaitingConfiguration = true
    needsConfiguration = false
    return ["t": "screen.configure", "requestId": requestID, "display": display,
            "width": width, "maxFps": min(requestedFps, maxFps), "paused": requestedPaused]
  }

  private static func integer(_ value: Any?) -> Int? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
    let number = value.doubleValue
    guard number.isFinite, number.rounded() == number, abs(number) <= 9_007_199_254_740_991 else { return nil }
    return Int(number)
  }

  private static func boolean(_ value: Any?) -> Bool? {
    guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
    return value.boolValue
  }
}
