import AppKit
import CoreVideo
import Foundation
import IOSurface
import LinkShellScreen

private final class ScreenClip: NSView {
  override var isFlipped: Bool { true }
}

/// A real NSView in Electron's window, not a floating window or Chromium video surface.
/// Only signalling/status reaches Node. Mach IPC delivers IOSurfaces directly to the Metal mailbox.
final class NativeScreen: NSObject {
  static var current: NativeScreen?
  let id: String
  private let host: NSView
  private let clip = ScreenClip()
  private let surface = DesktopScreenSurface(frame: .zero)
  private let port: DesktopFramePort
  private let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private let pipe: DesktopMediaPipe
  private let callback: Callback
  private let lock = NSLock()
  private var closed = false
  private var lastFrameToken: UInt64 = 0
  private var ready = false
  private var pending: [[String: Any]] = []
  private var rect: CGRect
  private var visible = true
  private var fullScreen = false
  private var fullScreenOverlay: DesktopFullScreenOverlay?
  private var wantedControl = false
  private var startup: DispatchWorkItem?

  init(host: NSView, helper: String, id: String, rect: CGRect, smooth: Bool = false, fullScreen: Bool = false, callback: Callback) throws {
    guard let port = DesktopFramePort(receiver: true) else {
      throw NSError(domain: "LinkShellScreen", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法创建原生画面通道"])
    }
    self.port = port
    pipe = DesktopMediaPipe(output: input.fileHandleForWriting)
    self.host = host; self.id = id; self.rect = rect; self.fullScreen = fullScreen; self.callback = callback
    super.init()
    surface.fullScreen = fullScreen
    clip.wantsLayer = true; clip.layer?.masksToBounds = true
    clip.addSubview(surface)
    host.addSubview(clip, positioned: .above, relativeTo: nil)
    surface.onInput = { [weak self] message, replaceable in
      guard let self, self.ready else { return }
      self.pipe.send(["type": "input", "message": message, "replaceable": replaceable])
    }
    surface.onFirstFrame = { [weak self] in self?.pipe.send(["type": "presented"]) }
    surface.onFailure = { [weak self] error in self?.fail(error) }
    process.executableURL = URL(fileURLWithPath: helper)
    process.arguments = ["--desktop-media"]
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.standardError
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async { self?.fail("原生画面进程已退出，请重新连接") }
    }
    do {
      try process.run()
      // Close the parent's duplicate child ends so EOF reflects actual child termination.
      try? input.fileHandleForReading.close()
      try? output.fileHandleForWriting.close()
      port.receive(child: process.processIdentifier) { [weak self, pipe] shared, token, metadata in
        guard let self else { pipe.send(["type": "release", "token": token]); return }
        self.picture(shared, token: token, metadata: metadata) { pipe.send(["type": "release", "token": token]) }
      }
      DesktopMediaPipe.read(output.fileHandleForReading, each: { [weak self] in self?.event($0) }, end: { [weak self] in
        DispatchQueue.main.async { self?.fail("原生画面连接已关闭，请重新连接") }
      })
      pipe.send(["type": "start", "port": port.name, "smooth": smooth])
    } catch { stop(); throw error }
    let timeout = DispatchWorkItem { [weak self] in self?.fail("原生画面进程未就绪，请重新连接") }
    startup = timeout; DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
    layout()
    // The rate this Mac can show, as the phone works out its own: frames beyond it would be
    // encoded and sent only to be dropped here, bits taken from every frame that is shown.
    for name in [NSWindow.didChangeScreenNotification, ProcessInfo.thermalStateDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.reportDisplayRate() })
    }
    reportDisplayRate()
  }

  private var observers: [NSObjectProtocol] = []
  private var reportedRate: Int?
  private func reportDisplayRate() {
    guard !closed else { return }
    let screen = host.window?.screen ?? NSScreen.main
    let refresh = screen?.maximumFramesPerSecond ?? 60
    let constrained = ProcessInfo.processInfo.isLowPowerModeEnabled
      || [.serious, .critical].contains(ProcessInfo.processInfo.thermalState)
    let rate = constrained ? min(refresh, 60) : refresh
    guard rate != reportedRate else { return }
    reportedRate = rate
    callback.call(["id": id, "type": "status", "status": ["displayFps": rate]])
  }

  func event(_ value: [String: Any]) {
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.closed else { return }
      switch value["type"] as? String {
      case "ready":
        self.ready = true; self.startup?.cancel(); self.startup = nil
        self.pipe.send(["type": "visible", "enabled": self.visible && !self.clip.isHidden])
        self.pipe.send(["type": "control", "enabled": self.wantedControl])
        for message in self.pending { self.pipe.send(message) }
        self.pending.removeAll()
      case "surfaceControl": self.surface.controlEnabled = value["enabled"] as? Bool == true
      case "surfaceKeys": self.surface.physicalKeys = value["enabled"] as? Bool == true
      case "cursor": if let cursor = value["message"] as? [String: Any] { self.surface.updateCursor(cursor) }
      case "error": self.fail(value["error"] as? String ?? "原生画面连接失败")
      case "signal", "status": self.callback.call(value.merging(["id": self.id]) { _, new in new })
      default: break
      }
    }
  }

  func picture(_ shared: IOSurface?, token: UInt64, metadata: Data, release: @escaping () -> Void) {
    lock.lock()
    let accepted = !closed && token > lastFrameToken
    if accepted { lastFrameToken = token }
    lock.unlock()
    // Decoder and release callbacks can send concurrently; never present an older arrival.
    guard accepted, let shared, let picture = DesktopScreenFrame.importSurface(shared, metadata: metadata, release: release) else { release(); return }
    // Thread-safe mailbox: never schedule frames on the Electron/AppKit main thread.
    surface.receive(picture)
  }

  func message(_ value: [String: Any]) {
    guard !closed, value["id"] as? String == id else { return }
    switch value["type"] as? String {
    case "stop": stop()
    case "layout": if let rect = DesktopScreenBridge.rect(value["rect"]) { self.rect = rect; layout() }
    case "fullscreen":
      if let enabled = DesktopScreenBridge.boolean(value["enabled"]) {
        fullScreen = enabled
        surface.fullScreen = enabled
        MainActor.assumeIsolated { syncFullScreenOverlay() }
      }
    case "control":
      if let enabled = DesktopScreenBridge.boolean(value["enabled"]) { wantedControl = enabled; if ready { pipe.send(["type": "control", "enabled": enabled]) } }
    case "signal":
      guard let message = value["message"] as? [String: Any], DesktopMediaIPC.data(message) != nil else { return }
      let command: [String: Any] = ["type": "signal", "message": message]
      if ready { pipe.send(command) }
      else if pending.count < 128 { pending.append(command) }
      else { fail("原生画面协商队列已满，请重新连接") }
    default: break
    }
  }

  func setVisible(_ visible: Bool) { self.visible = visible; layout() }
  private func layout() {
    let requested = CGRect(x: rect.minX, y: host.isFlipped ? rect.minY : host.bounds.height - rect.maxY, width: rect.width, height: rect.height)
    let clipped = requested.intersection(host.bounds)
    let showing = visible && !clipped.isEmpty && !clipped.isNull
    clip.isHidden = !showing
    surface.setActive(showing)
    if ready { pipe.send(["type": "visible", "enabled": showing]) }
    guard showing else {
      MainActor.assumeIsolated { syncFullScreenOverlay() }
      return
    }
    clip.frame = clipped
    surface.frame = CGRect(x: requested.minX - clipped.minX,
      y: host.isFlipped ? requested.minY - clipped.minY : clipped.maxY - requested.maxY,
      width: requested.width, height: requested.height)
    MainActor.assumeIsolated {
      syncFullScreenOverlay()
      fullScreenOverlay?.layout()
    }
  }
  @MainActor private func syncFullScreenOverlay() {
    let showing = fullScreen && visible && !clip.isHidden && !closed
    if showing {
      if fullScreenOverlay == nil {
        fullScreenOverlay = DesktopFullScreenOverlay { [weak self] in
          guard let self, !self.closed else { return }
          self.callback.call(["id": self.id, "type": "status", "status": ["exitFullScreen": true]])
        }
      }
      fullScreenOverlay?.attach(to: clip)
    } else {
      fullScreenOverlay?.detach()
      fullScreenOverlay = nil
    }
  }
  private func fail(_ error: String) {
    guard !closed else { return }
    callback.call(["id": id, "type": "error", "error": error])
    stop()
  }
  func stop() {
    lock.lock(); guard !closed else { lock.unlock(); return }; closed = true; lock.unlock()
    startup?.cancel(); startup = nil
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
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
    if NativeScreen.current === self { NativeScreen.current = nil }
  }
}
