import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

public enum SystemShortcutEventType: Equatable {
  case keyDown
  case keyUp
  case flagsChanged
  case tapDisabled
}

public struct SystemShortcutKeyEvent: Equatable {
  public let type: SystemShortcutEventType
  public let keyCode: UInt16
  public let flags: CGEventFlags
  public let isRepeat: Bool
  public let charactersIgnoringModifiers: String?

  public init(
    type: SystemShortcutEventType,
    keyCode: UInt16,
    flags: CGEventFlags = [],
    isRepeat: Bool = false,
    charactersIgnoringModifiers: String? = nil
  ) {
    self.type = type
    self.keyCode = keyCode
    self.flags = flags
    self.isRepeat = isRepeat
    self.charactersIgnoringModifiers = charactersIgnoringModifiers
  }
}

public protocol SystemShortcutTapHandle: AnyObject {
  func setEnabled(_ enabled: Bool)
  func invalidate()
}

private final class SystemShortcutTapWeakBox {
  weak var capture: SystemShortcutCapture?
  weak var handle: SystemShortcutCGEventTap?

  init(capture: SystemShortcutCapture) {
    self.capture = capture
  }
}

public final class SystemShortcutCGEventTap: SystemShortcutTapHandle {
  private let port: CFMachPort
  private let source: CFRunLoopSource
  private let box: SystemShortcutTapWeakBox
  private var invalidated = false

  fileprivate init?(capture: SystemShortcutCapture) {
    let box = SystemShortcutTapWeakBox(capture: capture)
    self.box = box
    let mask = (1 << CGEventType.keyDown.rawValue)
      | (1 << CGEventType.keyUp.rawValue)
      | (1 << CGEventType.flagsChanged.rawValue)
    let refcon = Unmanaged.passUnretained(box).toOpaque()
    guard let port = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .defaultTap,
      eventsOfInterest: CGEventMask(mask),
      callback: { _, type, cgEvent, refcon -> Unmanaged<CGEvent>? in
        guard let refcon else { return Unmanaged.passUnretained(cgEvent) }
        let box = Unmanaged<SystemShortcutTapWeakBox>.fromOpaque(refcon).takeUnretainedValue()
        guard let capture = box.capture else { return Unmanaged.passUnretained(cgEvent) }

        let mappedType: SystemShortcutEventType
        switch type {
        case .keyDown: mappedType = .keyDown
        case .keyUp: mappedType = .keyUp
        case .flagsChanged: mappedType = .flagsChanged
        case .tapDisabledByTimeout, .tapDisabledByUserInput: mappedType = .tapDisabled
        default: return Unmanaged.passUnretained(cgEvent)
        }

        let keyCode = UInt16(clamping: cgEvent.getIntegerValueField(.keyboardEventKeycode))
        let isRepeat = cgEvent.getIntegerValueField(.keyboardEventAutorepeat) != 0
        let characters = (mappedType == .keyDown) ? NSEvent(cgEvent: cgEvent)?.charactersIgnoringModifiers : nil
        let event = SystemShortcutKeyEvent(
          type: mappedType,
          keyCode: keyCode,
          flags: cgEvent.flags,
          isRepeat: isRepeat,
          charactersIgnoringModifiers: characters
        )
        let suppress = capture.process(event)
        return suppress ? nil : Unmanaged.passUnretained(cgEvent)
      },
      userInfo: refcon
    ) else {
      return nil
    }
    guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else {
      CFMachPortInvalidate(port)
      return nil
    }
    self.port = port
    self.source = source
    box.handle = self
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: port, enable: true)
  }

  deinit {
    invalidate()
  }

  public func setEnabled(_ enabled: Bool) {
    guard !invalidated else { return }
    CGEvent.tapEnable(tap: port, enable: enabled)
  }

  public func invalidate() {
    guard !invalidated else { return }
    invalidated = true
    box.capture = nil
    CGEvent.tapEnable(tap: port, enable: false)
    CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
    CFMachPortInvalidate(port)
  }
}

/// Captures macOS system shortcuts (⌘Tab, ⌘Space, ⌘H, ⌘Q, ⌘W, Spaces/Mission Control, etc.)
/// via a session `CGEventTap` ONLY while enabled, trusted, key-window focused, and actively
/// controlling the remote desktop surface. Always lets `⌃⌘F` and `⌃⌥⌘Esc` pass through locally
/// after releasing any held remote inputs, and immediately tears down + releases on blur/disconnect.
public final class SystemShortcutCapture {
  public typealias TapFactory = (SystemShortcutCapture) -> SystemShortcutTapHandle?

  private static let ansiKeyCodeF: UInt16 = 3
  private static let keyCodeEscape: UInt16 = 53
  private static let functionKeyCodes: Set<UInt16> = [
    122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, // F1..F12
    105, 107, 113, 106, 64, 79, 80, 90,                      // F13..F20
  ]

  public var onInput: (([String: Any]) -> Void)?
  public var onReleaseAll: (() -> Void)?
  public var physicalKeys = false
  public var forwardsModifiers = false

  public private(set) var enabled = false
  public private(set) var windowIsKey = false
  public private(set) var appIsActive = false
  public private(set) var surfaceActive = false
  public private(set) var surfaceFocused = false
  public private(set) var isTapActive = false
  public private(set) var capturedKeys: Set<UInt16> = []
  public private(set) var trackedModifiers: Set<UInt16> = []

  private let isTrusted: () -> Bool
  private let makeTap: TapFactory
  private var tap: SystemShortcutTapHandle?

  public var canCapture: Bool {
    enabled && isTrusted() && windowIsKey && appIsActive && surfaceActive && surfaceFocused
  }

  public init(
    physicalKeys: Bool = false,
    forwardsModifiers: Bool = false,
    isTrusted: @escaping () -> Bool = { AXIsProcessTrusted() },
    makeTap: TapFactory? = nil
  ) {
    self.physicalKeys = physicalKeys
    self.forwardsModifiers = forwardsModifiers
    self.isTrusted = isTrusted
    self.makeTap = makeTap ?? { capture in SystemShortcutCGEventTap(capture: capture) }
  }

  deinit {
    enabled = false
    windowIsKey = false
    appIsActive = false
    surfaceActive = false
    surfaceFocused = false
    teardownTap(releaseHeld: isTapActive || !capturedKeys.isEmpty || !trackedModifiers.isEmpty)
  }

  @discardableResult
  public func setEnabled(_ value: Bool) -> Bool {
    updateState(enabled: value)
  }

  @discardableResult
  public func updateState(
    enabled: Bool? = nil,
    windowIsKey: Bool? = nil,
    appIsActive: Bool? = nil,
    surfaceActive: Bool? = nil,
    surfaceFocused: Bool? = nil
  ) -> Bool {
    let wasTapActive = isTapActive
    let wasEnabled = self.enabled

    if let enabled { self.enabled = enabled }
    if let windowIsKey { self.windowIsKey = windowIsKey }
    if let appIsActive { self.appIsActive = appIsActive }
    if let surfaceActive { self.surfaceActive = surfaceActive }
    if let surfaceFocused { self.surfaceFocused = surfaceFocused }

    if canCapture {
      installTapIfNeeded()
      return isTapActive
    }

    let shouldRelease = wasTapActive || (wasEnabled && !self.enabled) || !capturedKeys.isEmpty || !trackedModifiers.isEmpty
    teardownTap(releaseHeld: shouldRelease)
    return false
  }

  public func handleWindowResignKey() {
    _ = updateState(windowIsKey: false)
  }

  public func handleAppDeactivateOrHide() {
    _ = updateState(appIsActive: false)
  }

  public func handleStreamDisconnect() {
    _ = updateState(surfaceActive: false)
  }

  public func teardown() {
    let shouldRelease = isTapActive || enabled || !capturedKeys.isEmpty || !trackedModifiers.isEmpty
    enabled = false
    windowIsKey = false
    appIsActive = false
    surfaceActive = false
    surfaceFocused = false
    teardownTap(releaseHeld: shouldRelease)
  }

  public func releaseAll() {
    if !capturedKeys.isEmpty {
      for keyCode in capturedKeys.sorted() {
        if physicalKeys, let code = PhysicalKeys.codes[keyCode] {
          onInput?(["t": "keyup", "c": code])
        }
      }
      capturedKeys.removeAll()
    }
    if !trackedModifiers.isEmpty {
      if forwardsModifiers && physicalKeys {
        for keyCode in trackedModifiers.sorted() {
          if let code = PhysicalKeys.codes[keyCode] {
            onInput?(["t": "keyup", "c": code])
          }
        }
      }
      trackedModifiers.removeAll()
    }
    onReleaseAll?()
  }

  /// Processes one event from `CGEventTap`. Returns `true` to suppress local OS handling.
  public func process(_ event: SystemShortcutKeyEvent) -> Bool {
    if event.type == .tapDisabled {
      if canCapture {
        tap?.setEnabled(true)
      } else {
        teardownTap(releaseHeld: true)
      }
      return false
    }

    guard canCapture else {
      teardownTap(releaseHeld: isTapActive || !capturedKeys.isEmpty || !trackedModifiers.isEmpty)
      return false
    }

    if Self.isLocalEscapeShortcut(keyCode: event.keyCode, flags: event.flags, characters: event.charactersIgnoringModifiers) {
      if event.type == .keyDown {
        releaseAll()
      }
      return false
    }

    switch event.type {
    case .tapDisabled:
      return false

    case .flagsChanged:
      if let flag = PhysicalKeys.modifier(event.keyCode) {
        let down = event.flags.contains(flag) && !trackedModifiers.contains(event.keyCode)
        if down {
          trackedModifiers.insert(event.keyCode)
          if forwardsModifiers, physicalKeys, let code = PhysicalKeys.codes[event.keyCode] {
            onInput?(["t": "keydown", "c": code])
          }
        } else if trackedModifiers.remove(event.keyCode) != nil {
          if forwardsModifiers, physicalKeys, let code = PhysicalKeys.codes[event.keyCode] {
            onInput?(["t": "keyup", "c": code])
          }
        }
      }
      // Always let flagsChanged reach AppKit so IME shift toggles and surface modifier state stay accurate.
      return false

    case .keyUp:
      guard capturedKeys.remove(event.keyCode) != nil else { return false }
      if physicalKeys, let code = PhysicalKeys.codes[event.keyCode] {
        onInput?(["t": "keyup", "c": code])
      }
      return true

    case .keyDown:
      guard Self.shouldCaptureShortcut(keyCode: event.keyCode, flags: event.flags) else {
        return false
      }
      if physicalKeys {
        guard PhysicalKeys.modifier(event.keyCode) == nil, let code = PhysicalKeys.codes[event.keyCode] else {
          return false
        }
        onInput?(["t": "keydown", "c": code, "r": event.isRepeat])
        capturedKeys.insert(event.keyCode)
        return true
      } else {
        guard let key = DesktopScreenInput.key(code: event.keyCode, characters: event.charactersIgnoringModifiers) else {
          return false
        }
        let mods = Self.modifierNames(from: event.flags)
        onInput?(["t": "key", "k": key, "m": mods])
        capturedKeys.insert(event.keyCode)
        return true
      }
    }
  }

  public static func isExitFullScreenShortcut(keyCode: UInt16, flags: CGEventFlags, characters: String? = nil) -> Bool {
    guard flags.contains([.maskControl, .maskCommand]), !flags.contains(.maskAlternate) else { return false }
    return keyCode == ansiKeyCodeF || characters?.lowercased() == "f"
  }

  public static func isForceQuitShortcut(keyCode: UInt16, flags: CGEventFlags) -> Bool {
    flags.contains([.maskControl, .maskAlternate, .maskCommand]) && keyCode == keyCodeEscape
  }

  public static func isLocalEscapeShortcut(keyCode: UInt16, flags: CGEventFlags, characters: String? = nil) -> Bool {
    isExitFullScreenShortcut(keyCode: keyCode, flags: flags, characters: characters)
      || isForceQuitShortcut(keyCode: keyCode, flags: flags)
  }

  public static func shouldCaptureShortcut(keyCode: UInt16, flags: CGEventFlags) -> Bool {
    if isLocalEscapeShortcut(keyCode: keyCode, flags: flags) {
      return false
    }
    return flags.contains(.maskCommand)
      || flags.contains(.maskControl)
      || functionKeyCodes.contains(keyCode)
  }

  private static func modifierNames(from flags: CGEventFlags) -> [String] {
    var names: [String] = []
    if flags.contains(.maskCommand) { names.append("cmd") }
    if flags.contains(.maskShift) { names.append("shift") }
    if flags.contains(.maskAlternate) { names.append("alt") }
    if flags.contains(.maskControl) { names.append("ctrl") }
    return names
  }

  private func installTapIfNeeded() {
    guard tap == nil else {
      tap?.setEnabled(true)
      isTapActive = true
      return
    }
    guard let created = makeTap(self) else {
      isTapActive = false
      return
    }
    tap = created
    isTapActive = true
  }

  private func teardownTap(releaseHeld: Bool) {
    if let tap {
      tap.invalidate()
      self.tap = nil
    }
    isTapActive = false
    if releaseHeld {
      releaseAll()
    }
  }
}
