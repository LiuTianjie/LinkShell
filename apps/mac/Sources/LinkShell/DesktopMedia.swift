import AppKit
import CoreVideo
import Foundation
import LinkShellScreen
import WebRTC

/// Only this child loads WebRTC.framework, away from Chromium's conflicting ObjC classes.
final class DesktopMedia {
  private var receiver: DesktopScreenReceiver?
  private var output: DesktopMediaOutput?
  private let pipe = DesktopMediaPipe(output: .standardOutput)

  static func run() -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let service = DesktopMedia()
    DesktopMediaPipe.read(.standardInput, each: { message in
      DispatchQueue.main.async { service.receive(message) }
    }, end: { exit(0) })
    app.run()
    exit(0)
  }
  private func receive(_ message: [String: Any]) {
    switch message["type"] as? String {
    case "start":
      guard receiver == nil, let name = message["port"] as? String, name.hasPrefix("com.bd.linkshell.frame."),
            let port = DesktopFramePort(name: name, receiver: false) else { exit(1) }
      let output = DesktopMediaOutput(port: port, pipe: pipe)
      self.output = output
      receiver = DesktopScreenReceiver(surface: output, smooth: message["smooth"] as? Bool == true, onSignal: { output.emit(["type": "signal", "message": $0]) },
        onStatus: { output.emit(["type": "status", "status": $0]) }, onFailure: { output.emit(["type": "error", "error": $0]) })
      output.emit(["type": "ready"])
    case "signal": if let value = message["message"] as? [String: Any] { receiver?.receive(value) }
    case "input":
      if let value = message["message"] as? [String: Any], let data = DesktopMediaIPC.data(value), InputEvent(json: data) != nil {
        output?.onInput?(value, message["replaceable"] as? Bool == true)
      }
    case "control": receiver?.setControl(message["enabled"] as? Bool == true)
    case "pacing": receiver?.setSmooth(message["smooth"] as? Bool == true)
    case "visible":
      let visible = message["enabled"] as? Bool == true
      output?.setVisible(visible); receiver?.setPresentationVisible(visible)
    case "presented": output?.onFirstFrame?()
    case "release": if let token = DesktopScreenBridge.integer(message["token"]), token >= 0 { output?.released(UInt64(token)) }
    case "stop": receiver?.stop(); output?.stop(); exit(0)
    default: break
    }
  }
}

/// Three surfaces in transit/current/GPU, plus one newest decoded frame. A frame is retained
/// until the importing view AND GPU release it. Slow presentation cannot grow a frame queue.
private final class DesktopMediaOutput: NSObject, DesktopScreenOutput {
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
    if outstanding.count >= 3 { pending = frame; lock.unlock(); return }
    serial += 1; let token = serial; outstanding[token] = frame
    lock.unlock()
    send(frame, token: token)
  }
  private func send(_ frame: RTCVideoFrame, token: UInt64) {
    guard let picture = desktopPicture(frame), let surface = CVPixelBufferGetIOSurface(picture.buffer)?.takeUnretainedValue(),
          port.send(surface, token: token, metadata: picture.metadata) else {
      released(token); onFailure?("硬件解码画面无法共享，请重新连接"); return
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
