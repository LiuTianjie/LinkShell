import AppKit
import CoreGraphics
import Foundation

/// Remote screen privacy controls on macOS:
/// - `curtain`: blanks physical displays locally with click-through, non-shared black windows so
///   bystanders see a dark screen while ScreenCaptureKit continues streaming the real desktop.
/// - `lockOnDisconnect`: locks the session (`⌃⌘Q`) and sleeps displays (`pmset displaysleepnow`)
///   as soon as the last remote viewer disconnects.
final class ScreenPrivacy {
  static let shared = ScreenPrivacy()

  private let lock = NSLock()
  private(set) var curtain = false
  private(set) var lockOnDisconnect = false
  private var windowIDs: Set<CGWindowID> = []
  private var windows: [NSWindow] = []
  private var screenObserver: NSObjectProtocol?

  private let applyCurtainHandler: (Bool) -> Set<CGWindowID>
  private let lockHostHandler: () -> Void

  init(
    applyCurtain: ((Bool) -> Set<CGWindowID>)? = nil,
    lockHost: (() -> Void)? = nil
  ) {
    var ownedSelf: ScreenPrivacy?
    self.applyCurtainHandler = applyCurtain ?? { enabled in
      guard !Launch.dryRun else { return [] }
      return ownedSelf?.syncCurtainWindows(enabled: enabled) ?? []
    }
    self.lockHostHandler = lockHost ?? {
      guard !Launch.dryRun else { return }
      Self.performSystemLockAndDisplaySleep()
    }
    ownedSelf = self
  }

  func currentState() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return [
      "curtain": curtain,
      "lockOnDisconnect": lockOnDisconnect,
      "supported": true,
    ]
  }

  func curtainWindowIDs() -> Set<CGWindowID> {
    lock.lock()
    defer { lock.unlock() }
    return windowIDs
  }

  @discardableResult
  func apply(curtain nextCurtain: Bool? = nil, lockOnDisconnect nextLock: Bool? = nil) -> [String: Any] {
    var shouldUpdateCurtain: Bool?
    lock.lock()
    if let nextCurtain, nextCurtain != curtain {
      curtain = nextCurtain
      shouldUpdateCurtain = nextCurtain
    }
    if let nextLock {
      lockOnDisconnect = nextLock
    }
    let snapshot: [String: Any] = [
      "curtain": curtain,
      "lockOnDisconnect": lockOnDisconnect,
      "supported": true,
    ]
    lock.unlock()

    if let enabled = shouldUpdateCurtain {
      let ids = applyCurtainHandler(enabled)
      lock.lock()
      windowIDs = ids
      lock.unlock()
    }
    return snapshot
  }

  /// Called whenever a viewer session or socket ends. When no viewers remain, any active curtain
  /// is lifted and, if armed, the Mac locks and sleeps its displays.
  @discardableResult
  func viewerDisconnected(remainingViewers: Int) -> Bool {
    guard remainingViewers <= 0 else { return false }
    var hadCurtain = false
    var shouldLock = false
    lock.lock()
    hadCurtain = curtain
    shouldLock = lockOnDisconnect
    curtain = false
    lockOnDisconnect = false
    windowIDs = []
    lock.unlock()

    if hadCurtain {
      _ = applyCurtainHandler(false)
    }
    if shouldLock {
      lockHostHandler()
    }
    return shouldLock
  }

  private func syncCurtainWindows(enabled: Bool) -> Set<CGWindowID> {
    let work = { [self] () -> Set<CGWindowID> in
      for window in self.windows {
        window.orderOut(nil)
        window.close()
      }
      self.windows.removeAll()
      if let observer = self.screenObserver {
        NotificationCenter.default.removeObserver(observer)
        self.screenObserver = nil
      }
      guard enabled else { return [] }

      var ids: Set<CGWindowID> = []
      for screen in NSScreen.screens {
        let window = NSWindow(
          contentRect: screen.frame,
          styleMask: [.borderless],
          backing: .buffered,
          defer: false
        )
        window.setFrame(screen.frame, display: true)
        window.isReleasedWhenClosed = false
        window.backgroundColor = .black
        window.isOpaque = true
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.sharingType = .none
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        window.orderFrontRegardless()
        self.windows.append(window)
        if window.windowNumber > 0 {
          ids.insert(CGWindowID(window.windowNumber))
        }
      }
      self.screenObserver = NotificationCenter.default.addObserver(
        forName: NSApplication.didChangeScreenParametersNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        guard let self else { return }
        self.lock.lock()
        let active = self.curtain
        self.lock.unlock()
        guard active else { return }
        let refreshed = self.syncCurtainWindows(enabled: true)
        self.lock.lock()
        self.windowIDs = refreshed
        self.lock.unlock()
      }
      return ids
    }
    if Thread.isMainThread { return work() }
    return DispatchQueue.main.sync(execute: work)
  }

  private static func performSystemLockAndDisplaySleep() {
    // Post ⌃⌘Q (kVK_ANSI_Q = 0x0C) to trigger macOS immediate screen lock when Accessibility is granted.
    if let source = CGEventSource(stateID: .hidSystemState) {
      let flags: CGEventFlags = [.maskControl, .maskCommand]
      if let down = CGEvent(keyboardEventSource: source, virtualKey: 0x0C, keyDown: true),
         let up = CGEvent(keyboardEventSource: source, virtualKey: 0x0C, keyDown: false) {
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
      }
    }
    let sleepTask = Process()
    sleepTask.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
    sleepTask.arguments = ["displaysleepnow"]
    sleepTask.standardOutput = FileHandle.nullDevice
    sleepTask.standardError = FileHandle.nullDevice
    try? sleepTask.run()
  }
}
