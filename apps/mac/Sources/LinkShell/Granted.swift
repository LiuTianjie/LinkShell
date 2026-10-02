import Foundation

/// Which of the two permissions LinkShell has.
struct Granted: Equatable {
  var recording = false
  var control = false

  subscript(permission: Permission) -> Bool {
    switch permission {
    case .recording: return recording
    case .control: return control
    }
  }

  var all: Bool { recording && control }

  /// The first still missing: the one the setup window puts forward.
  var next: Permission? {
    Permission.allCases.first { !self[$0] }
  }

  /// Those `earlier` did not have: what has just been turned on.
  func gained(since earlier: Granted) -> [Permission] {
    Permission.allCases.filter { self[$0] && !earlier[$0] }
  }
}

/// What the setup window is told to believe instead of asking the system (`--pretend <state>`),
/// and what it is to believe later (`--pretend-after <seconds> <state>`, any number of times):
/// the window can then be seen, and its rows seen to tick, on a Mac where nobody is turning the
/// switches. A state is `none`, `recording`, `control` or `both`.
struct Pretend {
  struct Unreadable: Error, Equatable {
    let argument: String
  }

  private let first: Granted
  private let changes: [(after: TimeInterval, granted: Granted)]

  /// Nil when nothing is pretended. A state or a time that can't be read is an error, not the
  /// real thing: a mistyped test must never reach the system's permissions.
  init?(arguments: [String]) throws {
    var first: Granted?
    var changes: [(after: TimeInterval, granted: Granted)] = []
    var index = 0
    while index < arguments.count {
      switch arguments[index] {
      case "--pretend":
        first = try Pretend.state(arguments, index + 1)
        index += 2
      case "--pretend-after":
        guard index + 1 < arguments.count, let seconds = TimeInterval(arguments[index + 1]), seconds >= 0 else { throw Unreadable(argument: "--pretend-after") }
        changes.append((seconds, try Pretend.state(arguments, index + 2)))
        index += 3
      default:
        index += 1
      }
    }
    guard let first else {
      if changes.isEmpty { return nil }
      throw Unreadable(argument: "--pretend-after")
    }
    self.first = first
    self.changes = changes.sorted { $0.after < $1.after }
  }

  private static func state(_ arguments: [String], _ index: Int) throws -> Granted {
    switch index < arguments.count ? arguments[index] : "" {
    case "none": return Granted()
    case "recording": return Granted(recording: true)
    case "control": return Granted(control: true)
    case "both": return Granted(recording: true, control: true)
    default: throw Unreadable(argument: arguments[index - 1])
    }
  }

  /// What is believed `elapsed` seconds after the window opened.
  func granted(after elapsed: TimeInterval) -> Granted {
    changes.last { $0.after <= elapsed }?.granted ?? first
  }
}
