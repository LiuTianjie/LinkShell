import AppKit
import CoreVideo
import Foundation
import IOSurface
import LinkShellScreen

/// Non-AppKit relay for background Mach/pipe/process callbacks so `NativeScreen` and its
/// `NSView` hierarchy are never retained or deallocated off the main thread during rapid switching.
private final class NativeScreenRelay {
  private let lock = NSLock()
  private var closed = false
  private var lastFrameToken: UInt64 = 0
  private var wantedSmooth: Bool
  private var frameSink: DesktopScreenFrameSink?
  private weak var screen: NativeScreen?

  init(screen: NativeScreen, frameSink: DesktopScreenFrameSink, smooth: Bool) {
    self.screen = screen
    self.frameSink = frameSink
    self.wantedSmooth = smooth
  }

  func setSmooth(_ value: Bool) {
    lock.lock()
    wantedSmooth = value
    lock.unlock()
  }

  func close() {
    lock.lock()
    closed = true
    frameSink = nil
    screen = nil
    lock.unlock()
  }

  func receiveFrame(_ shared: IOSurface?, token: UInt64, metadata: Data, release: @escaping () -> Void) {
    lock.lock()
    let accepted = !closed && token > lastFrameToken
    if accepted { lastFrameToken = token }
    let smooth = wantedSmooth
    let sink = accepted ? frameSink : nil
    lock.unlock()
    // Decoder and release callbacks can send concurrently; never present an older arrival.
    guard accepted, let sink, let shared,
          let picture = DesktopScreenFrame.importSurface(shared, metadata: metadata, release: release) else {
      release()
      return
    }
    // Thread-safe mailbox: never schedule frames on the Electron/AppKit main thread.
    // On macOS 14+, CAMetalDisplayLink drives tear-free 120 Hz ProMotion VSync at 1-frame latency.
    // On macOS 13 (legacy 60 Hz CVDisplayLink), draw immediately in low-latency mode to avoid 16.7ms stalls.
    if #available(macOS 14.0, *) {
      sink.receive(picture)
    } else if !smooth {
      sink.receiveImmediate(picture)
    } else {
      sink.receive(picture)
    }
  }

  func dispatchEvent(_ value: [String: Any]) {
    lock.lock()
    let isClosed = closed
    lock.unlock()
    guard !isClosed else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let target = self.closed ? nil : self.screen
      self.lock.unlock()
      target?.handleMainEvent(value)
    }
  }

  func dispatchFailure(_ message: String) {
    lock.lock()
    let isClosed = closed
    lock.unlock()
    guard !isClosed else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let target = self.closed ? nil : self.screen
      self.lock.unlock()
      target?.fail(message)
    }
  }
}

/// A real NSView in Electron's window, not a floating window or Chromium video surface.
/// Only signalling/status reaches Node. Mach IPC delivers IOSurfaces directly to the Metal mailbox.
final class NativeScreen: NSObject {
  static var current: NativeScreen?
  static var desiredSystemShortcutCapture = false
  let id: String
  private weak var host: NSView?
  private let clip = DesktopScreenClipView(frame: .zero)
  private let surface = DesktopScreenSurface(frame: .zero)
  private let shortcutCapture = SystemShortcutCapture(physicalKeys: false, forwardsModifiers: false)
  private let port: DesktopFramePort
  private let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private let pipe: DesktopMediaPipe
  private let callback: Callback
  private var relay: NativeScreenRelay!
  private var closed = false
  private var ready = false
  private var pending: [[String: Any]] = []
  private var rect: CGRect
  private var holes: [DesktopScreenHole]
  private var overlayOpen: Bool
  private var visible = true
  private var lastSentVisible: Bool?
  private var fullScreen = false
  private var fullScreenOverlay: DesktopFullScreenOverlay?
  private var wantedControl = false
  private var wantedAudioMuted = true
  private var wantedSmooth: Bool
  private var systemShortcutCaptureEnabled: Bool
  private var startup: DispatchWorkItem?

  init(
    host: NSView,
    helper: String,
    id: String,
    rect: CGRect,
    holes: [DesktopScreenHole] = [],
    overlayOpen: Bool = false,
    smooth: Bool = false,
    preferH264: Bool = false,
    fullScreen: Bool = false,
    audioMuted: Bool = false,
    systemShortcutCapture: Bool = NativeScreen.desiredSystemShortcutCapture,
    callback: Callback
  ) throws {
    guard let port = DesktopFramePort(receiver: true) else {
      throw NSError(domain: "LinkShellScreen", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法创建原生画面通道"])
    }
    self.port = port
    pipe = DesktopMediaPipe(output: input.fileHandleForWriting)
    self.host = host
    self.id = id
    self.rect = rect
    self.holes = holes
    self.overlayOpen = overlayOpen
    self.wantedSmooth = smooth
    self.wantedAudioMuted = audioMuted
    self.fullScreen = fullScreen
    self.systemShortcutCaptureEnabled = systemShortcutCapture
    self.callback = callback
    super.init()
    let relay = NativeScreenRelay(screen: self, frameSink: surface.frameSink, smooth: smooth)
    self.relay = relay
    surface.fullScreen = fullScreen
    clip.overlayOpen = overlayOpen
    clip.addSubview(surface)
    host.addSubview(clip, positioned: .above, relativeTo: nil)
    surface.onInput = { [weak self] message, replaceable in
      guard let self, self.ready else { return }
      self.pipe.send(["type": "input", "message": message, "replaceable": replaceable])
    }
    surface.onFirstFrame = { [weak self] in self?.pipe.send(["type": "presented"]) }
    surface.onFailure = { [weak self] error in self?.fail(error) }
    surface.onExitFullScreen = { [weak self] in
      guard let self, !self.closed else { return }
      self.callback.call(["id": self.id, "type": "status", "status": ["exitFullScreen": true]])
    }
    surface.onFocusChanged = { [weak self] _ in
      self?.syncSystemShortcutCapture()
    }
    shortcutCapture.onInput = { [weak self] message in
      guard let self, self.ready, !self.closed else { return }
      self.pipe.send(["type": "input", "message": message, "replaceable": false])
    }
    shortcutCapture.onReleaseAll = { [weak self] in
      guard let self, !self.closed else { return }
      self.surface.releaseHeldInputs()
    }
    process.executableURL = URL(fileURLWithPath: helper)
    process.arguments = ["--desktop-media"]
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.standardError
    process.terminationHandler = { [weak relay] _ in
      relay?.dispatchFailure("原生画面进程已退出，请重新连接")
    }
    do {
      try process.run()
      // Close the parent's duplicate child ends so EOF reflects actual child termination.
      try? input.fileHandleForReading.close()
      try? output.fileHandleForWriting.close()
      port.receive(child: process.processIdentifier) { [weak relay, pipe] shared, token, metadata in
        guard let relay else { pipe.send(["type": "release", "token": token]); return }
        relay.receiveFrame(shared, token: token, metadata: metadata) { pipe.send(["type": "release", "token": token]) }
      }
      DesktopMediaPipe.read(output.fileHandleForReading, each: { [weak relay] in relay?.dispatchEvent($0) }, end: { [weak relay] in
        relay?.dispatchFailure("原生画面连接已关闭，请重新连接")
      })
      pipe.send(["type": "start", "port": port.name, "smooth": smooth, "preferH264": preferH264, "audioMuted": audioMuted])
    } catch { stop(); throw error }
    let timeout = DispatchWorkItem { [weak self] in self?.fail("原生画面进程未就绪，请重新连接") }
    startup = timeout; DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
    layout()
    // The rate this Mac can show, as the phone works out its own: frames beyond it would be
    // encoded and sent only to be dropped here, bits taken from every frame that is shown.
    for name in [NSWindow.didChangeScreenNotification, ProcessInfo.thermalStateDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.reportDisplayRate() })
    }
    for name in [
      NSApplication.didBecomeActiveNotification,
      NSApplication.didResignActiveNotification,
      NSApplication.didHideNotification,
      NSApplication.didUnhideNotification,
      NSWindow.didBecomeKeyNotification,
      NSWindow.didResignKeyNotification,
    ] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        self?.syncSystemShortcutCapture()
      })
    }
    reportDisplayRate()
    syncSystemShortcutCapture()
  }

  deinit {
    relay?.close()
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
    shortcutCapture.teardown()
  }

  private var observers: [NSObjectProtocol] = []
  private var reportedRate: Int?
  private func reportDisplayRate() {
    guard !closed else { return }
    let screen = host?.window?.screen ?? NSScreen.main
    let refresh = screen?.maximumFramesPerSecond ?? 60
    let constrained = ProcessInfo.processInfo.isLowPowerModeEnabled
      || [.serious, .critical].contains(ProcessInfo.processInfo.thermalState)
    let rate = constrained ? min(refresh, 60) : refresh
    guard rate != reportedRate else { return }
    reportedRate = rate
    callback.call(["id": id, "type": "status", "status": ["displayFps": rate]])
  }

  fileprivate func handleMainEvent(_ value: [String: Any]) {
    guard !closed else { return }
    switch value["type"] as? String {
    case "ready":
      ready = true; startup?.cancel(); startup = nil
      let showing = visible && !clip.isHidden
      lastSentVisible = showing
      pipe.send(["type": "visible", "enabled": showing])
      pipe.send(["type": "control", "enabled": wantedControl])
      pipe.send(["type": "pacing", "smooth": wantedSmooth])
      for message in pending { pipe.send(message) }
      pending.removeAll()
    case "surfaceControl":
      surface.controlEnabled = value["enabled"] as? Bool == true
      syncSystemShortcutCapture()
    case "surfaceKeys":
      surface.physicalKeys = value["enabled"] as? Bool == true
      shortcutCapture.physicalKeys = surface.physicalKeys
    case "cursor": if let cursor = value["message"] as? [String: Any] { surface.updateCursor(cursor) }
    case "error": fail(value["error"] as? String ?? "原生画面连接失败")
    case "signal", "status": callback.call(value.merging(["id": id]) { _, new in new })
    default: break
    }
  }

  func message(_ value: [String: Any]) {
    guard !closed, value["id"] as? String == id else { return }
    switch value["type"] as? String {
    case "stop": stop()
    case "layout":
      var changed = false
      if let rect = DesktopScreenBridge.rect(value["rect"]) {
        self.rect = rect
        changed = true
      }
      if let holes = DesktopScreenBridge.holes(value["holes"]) {
        self.holes = holes
        changed = true
      }
      if let open = DesktopScreenBridge.boolean(value["overlayOpen"]) {
        if !self.overlayOpen && open {
          surface.releaseHeldInputs()
        }
        self.overlayOpen = open
        clip.overlayOpen = open
        changed = true
      }
      if changed { layout() }
    case "fullscreen":
      if let enabled = DesktopScreenBridge.boolean(value["enabled"]) {
        fullScreen = enabled
        surface.fullScreen = enabled
        MainActor.assumeIsolated { syncFullScreenOverlay() }
      }
    case "control":
      if let enabled = DesktopScreenBridge.boolean(value["enabled"]) {
        wantedControl = enabled
        MainActor.assumeIsolated { fullScreenOverlay?.updateState(control: wantedControl, audioMuted: wantedAudioMuted) }
        if ready { pipe.send(["type": "control", "enabled": enabled]) }
      }
    case "pacing":
      if let smooth = DesktopScreenBridge.boolean(value["smooth"]) {
        wantedSmooth = smooth
        relay.setSmooth(smooth)
        if ready { pipe.send(["type": "pacing", "smooth": smooth]) }
      }
    case "systemShortcutCapture":
      if let enabled = DesktopScreenBridge.boolean(value["enabled"]) {
        NativeScreen.desiredSystemShortcutCapture = enabled
        _ = setSystemShortcutCapture(enabled)
      }
    case "mute", "audio":
      if let muted = DesktopScreenBridge.boolean(value["muted"]) {
        wantedAudioMuted = muted
      } else if let enabled = DesktopScreenBridge.boolean(value["enabled"]) {
        wantedAudioMuted = !enabled
      }
      MainActor.assumeIsolated { fullScreenOverlay?.updateState(control: wantedControl, audioMuted: wantedAudioMuted) }
      if ready { pipe.send(value) }
      else if pending.count < 128 { pending.append(value) }
    case "signal":
      guard let message = value["message"] as? [String: Any], DesktopMediaIPC.data(message) != nil else { return }
      let command: [String: Any] = ["type": "signal", "message": message]
      if ready { pipe.send(command) }
      else if pending.count < 128 { pending.append(command) }
      else { fail("原生画面协商队列已满，请重新连接") }
    default: break
    }
  }

  @discardableResult
  func setSystemShortcutCapture(_ enabled: Bool) -> Bool {
    guard !closed else { return false }
    systemShortcutCaptureEnabled = enabled
    return syncSystemShortcutCapture()
  }

  @discardableResult
  private func syncSystemShortcutCapture() -> Bool {
    guard !closed else {
      shortcutCapture.teardown()
      return false
    }
    shortcutCapture.physicalKeys = surface.physicalKeys
    let windowIsKey = host?.window?.isKeyWindow == true
    let appIsActive = NSApp.map { $0.isActive && !$0.isHidden } ?? false
    let surfaceActive = visible && !clip.isHidden && !overlayOpen && surface.controlEnabled && !closed
    let surfaceFocused = surface.hasControlFocus
    return shortcutCapture.updateState(
      enabled: systemShortcutCaptureEnabled,
      windowIsKey: windowIsKey,
      appIsActive: appIsActive,
      surfaceActive: surfaceActive,
      surfaceFocused: surfaceFocused
    )
  }

  func setVisible(_ visible: Bool) { self.visible = visible; layout() }
  private func layout() {
    guard !closed, let host else { return }
    let requested = CGRect(x: rect.minX, y: host.isFlipped ? rect.minY : host.bounds.height - rect.maxY, width: rect.width, height: rect.height)
    let clipped = requested.intersection(host.bounds)
    let showing = visible && !clipped.isEmpty && !clipped.isNull
    clip.isHidden = !showing
    surface.setActive(showing)
    if ready, lastSentVisible != showing {
      lastSentVisible = showing
      pipe.send(["type": "visible", "enabled": showing])
    }
    guard showing else {
      clip.applyCutouts([], in: host)
      MainActor.assumeIsolated { syncFullScreenOverlay() }
      syncSystemShortcutCapture()
      return
    }
    clip.frame = clipped
    clip.overlayOpen = overlayOpen
    clip.applyCutouts(holes, in: host)
    surface.frame = CGRect(x: requested.minX - clipped.minX,
      y: host.isFlipped ? requested.minY - clipped.minY : clipped.maxY - requested.maxY,
      width: requested.width, height: requested.height)
    MainActor.assumeIsolated {
      syncFullScreenOverlay()
      fullScreenOverlay?.layout()
    }
    syncSystemShortcutCapture()
  }
  @MainActor private func syncFullScreenOverlay() {
    let showing = fullScreen && visible && !clip.isHidden && !closed
    if showing {
      if fullScreenOverlay == nil {
        fullScreenOverlay = DesktopFullScreenOverlay(
          onExit: { [weak self] in
            guard let self, !self.closed else { return }
            self.callback.call(["id": self.id, "type": "status", "status": ["exitFullScreen": true]])
          },
          onAction: { [weak self] action in
            guard let self, !self.closed else { return }
            self.callback.call(["id": self.id, "type": "status", "status": ["hudAction": action]])
          }
        )
      }
      fullScreenOverlay?.updateState(control: wantedControl, audioMuted: wantedAudioMuted)
      fullScreenOverlay?.attach(to: clip)
    } else {
      fullScreenOverlay?.detach()
      fullScreenOverlay = nil
    }
  }
  fileprivate func fail(_ error: String) {
    guard !closed else { return }
    callback.call(["id": id, "type": "error", "error": error])
    stop()
  }
  func stop() {
    guard !closed else { return }
    closed = true
    relay.close()
    startup?.cancel(); startup = nil
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
    shortcutCapture.teardown()
    shortcutCapture.onInput = nil
    shortcutCapture.onReleaseAll = nil
    MainActor.assumeIsolated {
      fullScreenOverlay?.detach()
      fullScreenOverlay = nil
    }
    surface.stop(); clip.removeFromSuperview()
    pending.removeAll(); ready = false
    pipe.send(["type": "stop"]); pipe.close()
    port.stop()
    process.terminationHandler = nil
    if process.isRunning { process.terminate() }
    callback.release()
    if NativeScreen.current === self { NativeScreen.current = nil }
  }
}
