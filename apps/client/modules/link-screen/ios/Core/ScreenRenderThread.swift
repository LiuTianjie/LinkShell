import CoreFoundation
import Foundation

/// A run loop owned by the renderer. UI work never has to run in order for this thread to
/// make progress. Teardown runs behind already-submitted work on the same thread.
final class ScreenRenderThread {
  private let state = State()
  private let thread: Thread

  init() {
    let state = state
    thread = Thread { state.run() }
    thread.name = "com.bd.linkshell.screen-render"
    thread.qualityOfService = .userInteractive
    thread.start()
  }

  @discardableResult func perform(_ operation: @escaping () -> Void) -> Bool { state.perform(operation) }
  func stop(_ cleanup: @escaping () -> Void = {}) { state.stop(cleanup) }
  func waitUntilStopped(seconds: Double) -> Bool {
    guard state.finished.wait(timeout: .now() + seconds) == .success else { return false }
    state.finished.signal()
    return true
  }
  deinit { state.stop({}) }

  private final class State {
    let finished = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var loop: CFRunLoop?
    private var pending: [() -> Void] = []
    private var stopping = false
    private var exiting = false

    func perform(_ operation: @escaping () -> Void) -> Bool {
      lock.lock(); defer { lock.unlock() }
      guard !stopping else { return false }
      enqueue(operation)
      return true
    }

    func stop(_ cleanup: @escaping () -> Void) {
      lock.lock(); defer { lock.unlock() }
      guard !stopping else { return }
      stopping = true
      enqueue { [self] in
        cleanup()
        lock.lock(); exiting = true; let loop = self.loop; lock.unlock()
        if let loop { CFRunLoopStop(loop) }
      }
    }

    private func enqueue(_ operation: @escaping () -> Void) {
      if let loop {
        CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue, operation)
        CFRunLoopWakeUp(loop)
      } else { pending.append(operation) }
    }

    func run() {
      let loop = CFRunLoopGetCurrent()!
      var context = CFRunLoopSourceContext(version: 0, info: nil, retain: nil, release: nil,
        copyDescription: nil, equal: nil, hash: nil, schedule: nil, cancel: nil, perform: { _ in })
      let keepAlive = CFRunLoopSourceCreate(nil, 0, &context)!
      CFRunLoopAddSource(loop, keepAlive, .defaultMode)
      lock.lock(); self.loop = loop; let initial = pending; pending.removeAll(); lock.unlock()
      initial.forEach { $0() }
      while true {
        lock.lock(); let done = exiting; lock.unlock()
        if done { break }
        // Drain transient Metal/Core Video objects after each run-loop event, not only when
        // a long-lived render thread eventually exits.
        autoreleasepool { _ = CFRunLoopRunInMode(.defaultMode, 60, true) }
      }
      CFRunLoopRemoveSource(loop, keepAlive, .defaultMode)
      lock.lock(); self.loop = nil; lock.unlock()
      finished.signal()
    }
  }
}

/// Small immutable snapshots cross the UI/render boundary; UIKit objects never do.
final class ScreenShared<Value> {
  private let lock = NSLock()
  private var value: Value
  init(_ value: Value) { self.value = value }
  func read() -> Value { lock.lock(); defer { lock.unlock() }; return value }
  @discardableResult func update<Result>(_ body: (inout Value) -> Result) -> Result {
    lock.lock(); defer { lock.unlock() }; return body(&value)
  }
}
