import Foundation

/// `--frame-trace` (loopback diagnostics only): timestamps of captured and decoded frames and of
/// each statistics read, on one clock, so a periodic hitch can be lined up with what causes it.
/// Per-second maxima can't show that: every second contains one statistics read.
enum FrameTrace {
  static let enabled = Launch.has("--frame-trace")
  private static let lock = NSLock()
  private static var events: [(String, Double)] = []

  static func mark(_ kind: String) {
    guard enabled else { return }
    let now = HostClock.seconds()
    lock.lock()
    if events.count < 20_000 { events.append((kind, now)) }
    lock.unlock()
  }

  static func take() -> [[Any]] {
    lock.lock()
    defer { lock.unlock() }
    let taken = events.map { [$0.0, ($0.1 * 1e6).rounded() / 1e6] }
    events.removeAll(keepingCapacity: true)
    return taken
  }
}
