import Foundation

/// A WebKit promise may never settle after a renderer stall; quitting must still be answerable.
@MainActor enum DesktopWorkspaceSaveBarrier {
  static func wait(timeoutNanoseconds: UInt64 = 2_000_000_000, request: (@escaping (Bool) -> Void) -> Void) async -> Bool {
    await withCheckedContinuation { continuation in
      let pending = Pending(continuation)
      pending.deadline = Task {
        try? await Task.sleep(nanoseconds: timeoutNanoseconds)
        guard !Task.isCancelled else { return }
        pending.finish(false)
      }
      request { pending.finish($0) }
    }
  }

  private final class Pending {
    var deadline: Task<Void, Never>?
    private var continuation: CheckedContinuation<Bool, Never>?

    init(_ continuation: CheckedContinuation<Bool, Never>) { self.continuation = continuation }

    func finish(_ saved: Bool) {
      guard let continuation else { return }
      self.continuation = nil
      deadline?.cancel(); deadline = nil
      continuation.resume(returning: saved)
    }
  }
}
