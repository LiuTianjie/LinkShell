import Foundation

/// How the app was started.
enum Launch {
  static let arguments = Array(CommandLine.arguments.dropFirst())

  /// Events are reported (`posted`), not posted to the system.
  static let dryRun = has("--dry-run")

  /// Encoders ask for the low-latency rate control; without (`--no-low-latency`) they are what
  /// they are on a Mac that has none.
  static let lowLatency = !has("--no-low-latency")

  static func has(_ flag: String) -> Bool {
    arguments.contains(flag)
  }

  /// The value after each place a flag is given.
  static func values(after flag: String) -> [String] {
    arguments.indices.filter { arguments[$0] == flag && $0 + 1 < arguments.count }.map { arguments[$0 + 1] }
  }

  static func value(after flag: String) -> String? {
    guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
  }
}
