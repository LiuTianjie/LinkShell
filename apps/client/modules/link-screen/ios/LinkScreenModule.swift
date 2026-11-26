import ExpoModulesCore
import UIKit

public class LinkScreenModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LinkScreen")
    View(LinkScreenView.self) {
      Events("onState")
      Prop("url") { (view: LinkScreenView, value: String) in view.setURL(value) }
      Prop("maxFps") { (view: LinkScreenView, value: Int) in view.setMaxFps(value) }
      Prop("active", true) { (view: LinkScreenView, value: Bool) in view.setActive(value) }
      Prop("audio", false) { (view: LinkScreenView, value: Bool) in view.setAudio(value) }
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
  private var audio = false
  private var audioAvailable = false
  private var lastPictureSize: CGSize?
  private var applicationActive = true
  private var supportsConfiguration = false
  private var supportsPause = false
  private var controlsReady = false
  private var pendingMessages: [[String: Any]] = []
  private var latestStats: [String: Any]?
  private var pictureRect: CGRect?
  private var attachment: DispatchWorkItem?
  private var attachmentStarted = 0.0
  private var observers: [NSObjectProtocol] = []
  private lazy var controls = ScreenControlsBridge { [weak self] message in self?.control(message) }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    applicationActive = UIApplication.shared.applicationState == .active
    clipsToBounds = true
    backgroundColor = .black
    let center = NotificationCenter.default
    // Transient inactive transitions (Control Center, Face ID, Duo fold) only pause capture/rendering;
    // only moving to background tears down the WebRTC session.
    observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.applicationActive = false
      self?.pauseForInactive()
    })
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      self?.applicationActive = false
      self?.disconnect()
    })
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.applicationActive = true
      self?.resumeFromActive()
    })
    for name in [ProcessInfo.thermalStateDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        guard let self, let renderer = self.renderer, renderer.requestedFps != self.receiverRate else { return }
        self.updateReceiverRate()
      })
    }
  }

  deinit {
    attachment?.cancel()
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    controls.detach()
    connection?.stop()
    renderer?.stop()
  }

  func setURL(_ value: String) {
    guard url != value else { return }
    disconnect()
    controls.detach()
    url = value
    controls.expectedURL = URL(string: value)
    controlsReady = false
    pendingMessages.removeAll()
    latestStats = nil
    pictureRect = nil
    audioAvailable = false
    lastPictureSize = nil
    attachmentStarted = CACurrentMediaTime()
    attachControls()
    // Start native WebRTC signaling & ICE immediately in parallel with WebView HTML/JS load.
    connect()
  }

  func setAudio(_ value: Bool) {
    guard audio != value else { return }
    audio = value
    connection?.setAudio(value)
  }

  func setMaxFps(_ value: Int) {
    guard [60, 120].contains(value), maxFps != value else { return }
    maxFps = value
    updateReceiverRate()
  }

  func setActive(_ value: Bool) {
    guard active != value else { return }
    active = value
    if !value {
      guard supportsPause else { disconnect(); return }
      connection?.setActive(false)
      renderer?.pause()
      controls.session(["active": false, "maxFps": receiverRate])
    } else if let connection, applicationActive, window != nil {
      connection.setActive(true)
      renderer?.start(fps: receiverRate)
      controls.session(["active": true, "maxFps": receiverRate])
    } else {
      disconnect()
      connect()
    }
  }

  private func pauseForInactive() {
    connection?.setActive(false)
    renderer?.pause()
    if supportsPause {
      controls.session(["active": false, "maxFps": receiverRate])
    }
  }

  private func resumeFromActive() {
    guard active, window != nil else { return }
    if let connection {
      connection.setActive(true)
      renderer?.start(fps: receiverRate)
      if supportsPause {
        controls.session(["active": true, "maxFps": receiverRate])
      }
    } else {
      connect()
    }
  }

  private func updateReceiverRate() {
    guard connection != nil, supportsConfiguration else { disconnect(); connect(); return }
    if active && applicationActive { renderer?.start(fps: receiverRate) }
    controls.session(["maxFps": receiverRate])
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      attachment?.cancel(); attachment = nil
      controls.detach()
      if !active && supportsPause && applicationActive { renderer?.pause() }
      else { disconnect() }
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
      if active { onState(["state": "failed", "message": "屏幕控制界面未能加载"]) }
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
    guard active, applicationActive, window != nil, connection == nil, !url.isEmpty else { return }
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
    guard let connection = ScreenConnection(url: url, maxFps: receiverRate, renderer: renderer, metrics: metrics, audio: audio) else {
      renderer.removeFromSuperview(); self.renderer = nil
      onState(["state": "failed", "message": "屏幕地址无效，请重新连接"])
      return
    }
    self.connection = connection
    connection.onReceiving = { [weak self, weak connection] in
      DispatchQueue.main.async {
        guard let self, let connection, self.connection === connection, self.active, self.lastPictureSize == nil else { return }
        self.onState(["state": "receiving", "maxFps": self.receiverRate])
      }
    }
    connection.onAudioAvailable = { [weak self, weak connection] available in
      DispatchQueue.main.async {
        guard let self, let connection, self.connection === connection, self.audioAvailable != available else { return }
        self.audioAvailable = available
        if self.active, let size = self.lastPictureSize {
          self.onState([
            "state": "ready",
            "width": size.width,
            "height": size.height,
            "maxFps": self.receiverRate,
            "audioAvailable": available,
          ])
        }
      }
    }
    renderer.onPicture = { [weak self, weak connection] size in
      guard let self, let connection, self.connection === connection else { return }
      connection.pictureArrived()
      self.lastPictureSize = size
      if self.controlsReady {
        self.controls.call("picture", ["width": size.width, "height": size.height])
      }
      if self.active {
        self.onState([
          "state": "ready",
          "width": size.width,
          "height": size.height,
          "maxFps": self.receiverRate,
          "audioAvailable": self.audioAvailable,
        ])
      }
    }
    renderer.onFailure = { [weak self, weak connection] message in
      guard let self, let connection, self.connection === connection else { return }
      self.disconnect()
      if self.active { self.onState(["state": "failed", "message": message]) }
    }
    connection.onFailure = { [weak self, weak connection] message in
      DispatchQueue.main.async {
        guard let self, let connection, self.connection === connection else { return }
        self.disconnect()
        if self.active { self.onState(["state": "failed", "message": message]) }
      }
    }
    connection.onMessage = { [weak self, weak connection] message in
      DispatchQueue.main.async {
        guard let self, let connection, self.connection === connection else { return }
        if let session = message["session"] as? [String: Any], session["t"] as? String == "capabilities", session["version"] as? Int == 1 {
          self.supportsConfiguration = session["configure"] as? Bool == true
          self.supportsPause = self.supportsConfiguration && session["pause"] as? Bool == true
        }
        if self.controlsReady {
          self.controls.call("message", message)
        } else if self.pendingMessages.count < 128 {
          self.pendingMessages.append(message)
        }
      }
    }
    connection.onStats = { [weak self, weak connection] stats in
      DispatchQueue.main.async {
        guard let self, let connection, self.connection === connection else { return }
        self.latestStats = stats
        if self.controlsReady {
          self.controls.call("stats", stats)
        }
      }
    }
    renderer.start(fps: receiverRate)
    onState(["state": "connecting", "maxFps": receiverRate])
    connection.start()
    if controlsReady {
      controls.call("connecting", [:])
      controls.session(["active": active, "maxFps": receiverRate])
    }
  }

  private func disconnect() {
    connection?.stop(); connection = nil
    supportsConfiguration = false; supportsPause = false
    audioAvailable = false; lastPictureSize = nil
    pendingMessages.removeAll(); latestStats = nil
    renderer?.stop(); renderer?.removeFromSuperview(); renderer = nil
  }

  private func control(_ message: [String: Any]) {
    switch message["kind"] as? String {
    case "ready":
      guard message["version"] as? Int == 1 else { return }
      controlsReady = true
      attachment?.cancel(); attachment = nil
      if connection == nil {
        connect()
      } else {
        // Replay any early capabilities/control/cursor/picture events received while WebView booted.
        if lastPictureSize == nil {
          controls.call("connecting", [:])
        }
        controls.session(["active": active, "maxFps": receiverRate])
        let buffered = pendingMessages
        pendingMessages.removeAll()
        for item in buffered { controls.call("message", item) }
        if let size = lastPictureSize {
          controls.call("picture", ["width": size.width, "height": size.height])
        }
        if let stats = latestStats {
          controls.call("stats", stats)
        }
      }
    case "frame":
      guard let rect = message["rect"] as? [String: Double],
            let x = rect["x"], let y = rect["y"], let width = rect["w"], let height = rect["h"],
            [x, y, width, height].allSatisfy({ $0.isFinite && abs($0) < 100_000 }), width > 0, height > 0 else { return }
      pictureRect = CGRect(x: x, y: y, width: width, height: height)
      renderer?.externalContentRect = pictureRect
    case "input":
      guard active, applicationActive, let input = message["message"] as? [String: Any],
            let kind = input["t"] as? String,
            ["move", "scroll", "down", "up", "key", "text", "prompt"].contains(kind) else { return }
      connection?.input(input, replaceable: message["replaceable"] as? Bool == true && ["move", "scroll"].contains(kind))
    case "signal":
      guard let signal = message["message"] as? [String: Any] else { return }
      switch signal["t"] as? String {
      case "screen.configure": connection?.configure(signal, maxFps: receiverRate)
      case "audio": if let enabled = signal["enabled"] as? Bool { setAudio(enabled) }
      case "control": if active && applicationActive { connection?.requestControl(signal) }
      case "prompt": if active && applicationActive { connection?.input(signal) }
      case "activity": if active && applicationActive { connection?.activity() }
      default: break
      }
    case "stats": connection?.requestStats()
    default: break
    }
  }
}
