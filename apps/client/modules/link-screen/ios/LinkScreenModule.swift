import ExpoModulesCore
import UIKit

public class LinkScreenModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LinkScreen")
    View(LinkScreenView.self) {
      Events("onState")
      Prop("url") { (view: LinkScreenView, value: String) in view.setURL(value) }
      Prop("maxFps") { (view: LinkScreenView, value: Int) in view.setMaxFps(value) }
    }
  }
}

/// React Native mounts the existing viewer WebView as our child. WebKit sends control
/// messages straight to this receiver; React Native never transports frames or pointer moves.
final class LinkScreenView: ExpoView {
  let onState = EventDispatcher()
  private var renderer: ScreenMetalView?
  private var connection: ScreenConnection?
  private var url = ""
  private var maxFps = 120
  private var active = true
  private var controlsReady = false
  private var pictureRect: CGRect?
  private var attachment: DispatchWorkItem?
  private var attachmentStarted = 0.0
  private var observers: [NSObjectProtocol] = []
  private lazy var controls = ScreenControlsBridge { [weak self] message in self?.control(message) }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.active = false; self?.disconnect()
    })
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.active = true; self?.connect()
    })
    for name in [ProcessInfo.thermalStateDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        guard let self, let renderer = self.renderer, renderer.requestedFps != self.receiverRate else { return }
        self.disconnect(); self.connect()
      })
    }
  }

  deinit {
    attachment?.cancel()
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    connection?.stop()
  }

  func setURL(_ value: String) {
    guard url != value else { return }
    disconnect()
    url = value
    controls.expectedURL = URL(string: value)
    controlsReady = false
    pictureRect = nil
    attachmentStarted = CACurrentMediaTime()
    attachControls()
  }

  func setMaxFps(_ value: Int) {
    guard [60, 120].contains(value), maxFps != value else { return }
    disconnect(); maxFps = value; connect()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      attachment?.cancel(); attachment = nil
      disconnect()
    } else {
      attachmentStarted = CACurrentMediaTime()
      attachControls()
      connect()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if let renderer {
      renderer.frame = bounds
      sendSubviewToBack(renderer)
    }
    attachControls()
  }

  private func attachControls() {
    guard window != nil, !url.isEmpty else { return }
    if controls.attach(in: self), controlsReady {
      attachment?.cancel(); attachment = nil
      return
    }
    guard attachment == nil else { return }
    if CACurrentMediaTime() - attachmentStarted > 5 {
      onState(["state": "failed", "message": "屏幕控制界面未能加载"])
      return
    }
    let next = DispatchWorkItem { [weak self] in
      self?.attachment = nil
      self?.attachControls()
    }
    attachment = next
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: next)
  }

  private var receiverRate: Int {
    let screen = window?.screen ?? UIScreen.main
    let constrained = ProcessInfo.processInfo.isLowPowerModeEnabled || ProcessInfo.processInfo.thermalState == .serious || ProcessInfo.processInfo.thermalState == .critical
    return min(maxFps, !constrained && screen.maximumFramesPerSecond >= 120 ? 120 : 60)
  }

  private func connect() {
    guard active, window != nil, controlsReady, connection == nil, !url.isEmpty else { return }
    // Connection info can ask for lightweight WebRTC stats; normal playback still has
    // neither decoder instrumentation nor drawable presentation callbacks.
    let diagnostics = URLComponents(string: url)?.queryItems?.contains { $0.name == "diagnostics" && $0.value == "1" } == true
    let metrics = ScreenMetrics(enabled: diagnostics)
    let renderer = ScreenMetalView(metrics: metrics)
    self.renderer = renderer
    renderer.frame = bounds
    renderer.externalContentRect = pictureRect
    renderer.showsPointer = false
    insertSubview(renderer, at: 0)
    guard let connection = ScreenConnection(url: url, maxFps: receiverRate, renderer: renderer, metrics: metrics) else {
      renderer.removeFromSuperview(); self.renderer = nil
      onState(["state": "failed", "message": "屏幕地址无效，请重新连接"])
      return
    }
    self.connection = connection
    renderer.onPicture = { [weak self, weak connection] size in
      guard let self, let connection, self.connection === connection else { return }
      connection.pictureArrived()
      self.controls.call("picture", ["width": size.width, "height": size.height])
      self.onState(["state": "ready", "width": size.width, "height": size.height, "maxFps": self.receiverRate])
    }
    renderer.onFailure = { [weak self, weak connection] message in
      guard let self, let connection, self.connection === connection else { return }
      self.disconnect()
      self.onState(["state": "failed", "message": message])
    }
    connection.onFailure = { [weak self, weak connection] message in
      DispatchQueue.main.async {
        guard let self, let connection, self.connection === connection else { return }
        self.disconnect()
        self.onState(["state": "failed", "message": message])
      }
    }
    connection.onMessage = { [weak self, weak connection] message in
      DispatchQueue.main.async {
        guard let self, let connection, self.connection === connection else { return }
        self.controls.call("message", message)
      }
    }
    connection.onStats = { [weak self, weak connection] stats in
      DispatchQueue.main.async {
        guard let self, let connection, self.connection === connection else { return }
        self.controls.call("stats", stats)
      }
    }
    renderer.start(fps: receiverRate)
    onState(["state": "connecting", "maxFps": receiverRate])
    connection.start()
    controls.call("connecting", [:])
  }

  private func disconnect() {
    connection?.stop(); connection = nil
    renderer?.stop(); renderer?.removeFromSuperview(); renderer = nil
  }

  private func control(_ message: [String: Any]) {
    switch message["kind"] as? String {
    case "ready":
      guard message["version"] as? Int == 1 else { return }
      controlsReady = true
      attachment?.cancel(); attachment = nil
      connect()
    case "frame":
      guard let rect = message["rect"] as? [String: Double],
            let x = rect["x"], let y = rect["y"], let width = rect["w"], let height = rect["h"],
            [x, y, width, height].allSatisfy({ $0.isFinite && abs($0) < 100_000 }), width > 0, height > 0 else { return }
      pictureRect = CGRect(x: x, y: y, width: width, height: height)
      renderer?.externalContentRect = pictureRect
    case "input":
      guard let input = message["message"] as? [String: Any],
            let kind = input["t"] as? String,
            ["move", "scroll", "down", "up", "key", "text", "prompt"].contains(kind) else { return }
      connection?.input(input, replaceable: message["replaceable"] as? Bool == true && ["move", "scroll"].contains(kind))
    case "signal":
      guard let signal = message["message"] as? [String: Any] else { return }
      switch signal["t"] as? String {
      case "control": connection?.requestControl()
      case "prompt": connection?.input(["t": "prompt"])
      default: break
      }
    case "stats": connection?.requestStats()
    default: break
    }
  }
}
