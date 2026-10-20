import CoreFoundation
import Foundation

/// A complete desired capture state. Transport and codec belong to the existing connection.
struct ScreenConfiguration: Equatable {
  let requestId: Int
  let screen: Int
  let maxWidth: Int
  let maxFps: Int
  let paused: Bool
  let inputGeneration: Int?

  init(requestId: Int, screen: Int, maxWidth: Int, maxFps: Int, paused: Bool, inputGeneration: Int? = nil) {
    self.requestId = requestId
    self.screen = screen
    self.maxWidth = maxWidth
    self.maxFps = maxFps
    self.paused = paused
    self.inputGeneration = inputGeneration
  }

  init?(_ message: [String: Any], defaultMaxFps: Int) {
    guard let requestId = Self.integer(message["requestId"]), requestId >= 0,
          let screen = Self.integer(message["screen"]), screen >= 0,
          let width = Self.integer(message["maxWidth"]), (640...Tuning.widestPicture).contains(width),
          let pausedNumber = message["paused"] as? NSNumber,
          CFGetTypeID(pausedNumber) == CFBooleanGetTypeID() else { return nil }
    let maxFps = message["maxFps"] == nil ? defaultMaxFps : Self.integer(message["maxFps"])
    guard let maxFps, [30, 60, 120].contains(maxFps) else { return nil }
    let generation = Self.integer(message["inputGeneration"])
    if message["inputGeneration"] != nil, generation == nil || generation! < 0 { return nil }
    self.init(requestId: requestId, screen: screen, maxWidth: width, maxFps: maxFps, paused: pausedNumber.boolValue, inputGeneration: generation)
  }

  func sameCapture(as other: ScreenConfiguration) -> Bool {
    screen == other.screen && maxWidth == other.maxWidth && maxFps == other.maxFps && paused == other.paused
  }

  private static func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let value = number.doubleValue
    guard value.isFinite, abs(value) <= 9_007_199_254_740_991, value.rounded() == value else { return nil }
    return Int(value)
  }
}

/// Old pages remain compatible until a configuration explicitly enables generation checking.
struct ScreenInputGate {
  var suspended = false
  private(set) var generation: Int?

  mutating func apply(_ configuration: ScreenConfiguration) {
    if let generation = configuration.inputGeneration { self.generation = generation }
    suspended = configuration.paused
  }

  func accepts(_ event: InputEvent) -> Bool {
    !suspended && (generation == nil || event.screenGeneration == generation)
  }
}

/// Capture starts/stops finish asynchronously. Only the latest desired state may reopen input.
struct ScreenConfigurationQueue {
  struct Work {
    let revision: Int
    let configuration: ScreenConfiguration
  }

  private var revision = 0
  private var pending: ScreenConfiguration?
  private var applying: Int?

  var busy: Bool { applying != nil }

  mutating func enqueue(_ configuration: ScreenConfiguration) {
    revision += 1
    pending = configuration
  }

  mutating func begin() -> Work? {
    guard applying == nil, let configuration = pending else { return nil }
    pending = nil
    applying = revision
    return Work(revision: revision, configuration: configuration)
  }

  func isCurrent(_ work: Work) -> Bool {
    applying == work.revision && revision == work.revision
  }

  mutating func finish(_ work: Work) {
    if applying == work.revision { applying = nil }
  }

  mutating func cancel() {
    revision += 1
    pending = nil
    applying = nil
  }
}
