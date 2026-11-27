import AppKit
import CoreVideo
import Foundation
import LinkShellScreen
import WebRTC

/// Only this child loads WebRTC.framework, away from Chromium's conflicting ObjC classes.
final class DesktopMedia {
  private let stateLock = NSLock()
  private var receiver: DesktopScreenReceiver?
  private var output: DesktopMediaOutput?
  private let pipe = DesktopMediaPipe(output: .standardOutput)

  static func run() -> Never {
    // Ignore SIGPIPE so a parent closing the pipe during rapid computer switching never aborts the helper.
    signal(SIGPIPE, SIG_IGN)
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let service = DesktopMedia()
    // Handle high-frequency 120 Hz frame releases and pointer inputs directly on the
    // user-interactive pipe reader thread so AppKit main-thread scheduling never stalls frames.
    DesktopMediaPipe.read(.standardInput, each: { message in
      switch message["type"] as? String {
      case "release":
        service.handleRelease(message)
      case "input":
        service.handleInput(message)
      default:
        DispatchQueue.main.async { service.receive(message) }
      }
    }, end: { exit(0) })
    app.run()
    exit(0)
  }

  private func currentOutput() -> DesktopMediaOutput? {
    stateLock.lock()
    defer { stateLock.unlock() }
    return output
  }

  private func handleRelease(_ message: [String: Any]) {
    guard let token = DesktopScreenBridge.integer(message["token"]), token >= 0 else { return }
    currentOutput()?.released(UInt64(token))
  }

  private func handleInput(_ message: [String: Any]) {
    guard let value = message["message"] as? [String: Any], InputEvent(command: value) != nil else { return }
    currentOutput()?.onInput?(value, message["replaceable"] as? Bool == true)
  }

  private func receive(_ message: [String: Any]) {
    switch message["type"] as? String {
    case "start":
      guard receiver == nil, let name = message["port"] as? String, name.hasPrefix("com.bd.linkshell.frame."),
            let port = DesktopFramePort(name: name, receiver: false) else { exit(1) }
      let output = DesktopMediaOutput(port: port, pipe: pipe)
      let audioMuted = (DesktopScreenBridge.boolean(message["audioMuted"]))
        ?? (DesktopScreenBridge.boolean(message["audio"]).map { !$0 })
        ?? false
      let preferH264 = DesktopScreenBridge.boolean(message["preferH264"]) == true
      receiver = DesktopScreenReceiver(surface: output, smooth: message["smooth"] as? Bool == true, preferH264: preferH264, audioMuted: audioMuted, onSignal: { output.emit(["type": "signal", "message": $0]) },
        onStatus: { output.emit(["type": "status", "status": $0]) }, onFailure: { output.emit(["type": "error", "error": $0]) })
      stateLock.lock()
      self.output = output
      stateLock.unlock()
      output.emit(["type": "ready"])
    case "signal": if let value = message["message"] as? [String: Any] { receiver?.receive(value) }
    case "input": handleInput(message)
    case "control": receiver?.setControl(message["enabled"] as? Bool == true)
    case "pacing": receiver?.setSmooth(message["smooth"] as? Bool == true)
    case "mute":
      if let muted = DesktopScreenBridge.boolean(message["muted"]) ?? DesktopScreenBridge.boolean(message["enabled"]) {
        receiver?.setAudioMuted(muted)
      }
    case "audio":
      if let muted = DesktopScreenBridge.boolean(message["muted"]) {
        receiver?.setAudioMuted(muted)
      } else if let enabled = DesktopScreenBridge.boolean(message["enabled"]) {
        receiver?.setAudioMuted(!enabled)
      }
    case "visible":
      let visible = message["enabled"] as? Bool == true
      output?.setVisible(visible); receiver?.setPresentationVisible(visible)
    case "presented": output?.onFirstFrame?()
    case "release": handleRelease(message)
    case "stop": receiver?.stop(); output?.stop(); exit(0)
    default: break
    }
  }
}

/// Bounded in-flight IOSurface tokens (transit + current + GPU + 1 newest decoded frame).
/// Eight slots give 120 fps presentation headroom so GPU completion + pipe release never starves
/// VideoToolbox's surface pool, while single-slot `pending` replacement prevents any queue buildup.
private final class DesktopMediaOutput: NSObject, DesktopScreenOutput {
  private static let maxOutstanding = 8
  var onInput: (([String: Any], Bool) -> Void)?
  var onFirstFrame: (() -> Void)?
  var onFailure: ((String) -> Void)?
  var controlEnabled = false { didSet { emit(["type": "surfaceControl", "enabled": controlEnabled]) } }
  var physicalKeys = false { didSet { emit(["type": "surfaceKeys", "enabled": physicalKeys]) } }
  private let port: DesktopFramePort
  private let pipe: DesktopMediaPipe
  private let lock = NSLock()
  private var pending: RTCVideoFrame?
  private var outstanding: [UInt64: RTCVideoFrame] = [:]
  private var serial: UInt64 = 0
  private var stopped = false
  private var visible = true

  init(port: DesktopFramePort, pipe: DesktopMediaPipe) { self.port = port; self.pipe = pipe }
  func emit(_ message: [String: Any]) { pipe.send(message) }
  func updateCursor(_ message: [String: Any]) { emit(["type": "cursor", "message": message]) }
  func setSize(_ size: CGSize) {}
  func renderFrame(_ frame: RTCVideoFrame?) {
    guard let frame else { return }
    lock.lock()
    guard !stopped, visible else { lock.unlock(); return }
    if outstanding.count >= Self.maxOutstanding { pending = frame; lock.unlock(); return }
    serial += 1; let token = serial; outstanding[token] = frame
    lock.unlock()
    send(frame, token: token)
  }
  private func send(_ frame: RTCVideoFrame, token: UInt64) {
    let sent = autoreleasepool { () -> Bool in
      guard let picture = desktopPicture(frame),
            let surface = CVPixelBufferGetIOSurface(picture.buffer)?.takeUnretainedValue() else { return false }
      return port.send(surface, token: token, metadata: picture.metadata)
    }
    if !sent {
      released(token); onFailure?("硬件解码画面无法共享，请重新连接")
    }
  }
  func released(_ token: UInt64) {
    lock.lock()
    guard outstanding.removeValue(forKey: token) != nil else { lock.unlock(); return }
    let next = stopped || !visible ? nil : pending
    pending = nil
    if let next { serial += 1; outstanding[serial] = next }
    let nextToken = serial
    lock.unlock()
    if let next { send(next, token: nextToken) }
  }
  func setVisible(_ value: Bool) { lock.lock(); visible = value; if !value { pending = nil }; lock.unlock() }
  func stop() { lock.lock(); stopped = true; pending = nil; outstanding.removeAll(); lock.unlock(); port.stop() }
}
