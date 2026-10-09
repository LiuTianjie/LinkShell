import Foundation

/// Only undecoded capture candidates or already-decoded output may use this mailbox.
/// Compressed reference frames must stay in the media engine's dependency-aware queue.
final class ScreenMailbox<Value> {
  private let lock = NSLock()
  private var value: Value?
  private var replaced = 0

  func put(_ next: Value) {
    lock.lock()
    defer { lock.unlock() }
    if value != nil { replaced += 1 }
    value = next
  }

  func take() -> Value? {
    lock.lock()
    defer { lock.unlock() }
    let result = value
    value = nil
    return result
  }

  func takeReplacements() -> Int {
    lock.lock()
    defer { lock.unlock() }
    defer { replaced = 0 }
    return replaced
  }
}

enum ScreenTiming {
  static func percentile(_ values: [Double], _ fraction: Double) -> Double? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    return sorted[min(sorted.count - 1, max(0, Int(ceil(Double(sorted.count) * fraction)) - 1))]
  }

  /// Enough room for the renderer's measured work, with a bounded safety margin. A slow GPU
  /// should reduce the offered work, not keep moving an old frame's deadline into the future.
  static func canSubmit(now: Double, deadline: Double, gpuSeconds: Double) -> Bool {
    deadline > now && deadline - now >= max(0.0005, gpuSeconds * 1.25)
  }
}
