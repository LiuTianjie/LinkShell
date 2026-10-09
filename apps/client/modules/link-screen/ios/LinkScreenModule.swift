import ExpoModulesCore
import UIKit

public class LinkScreenModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LinkScreen")
    View(LinkScreenView.self) {
      Events("onState", "onMetrics")
      Prop("url") { (view: LinkScreenView, value: String) in view.setURL(value) }
      Prop("mode") { (view: LinkScreenView, value: String) in view.setMode(value) }
      Prop("diagnostics") { (view: LinkScreenView, value: Bool) in view.setDiagnostics(value) }
      AsyncFunction("fit") { (view: LinkScreenView) in view.fit() }.runOnQueue(.main)
      AsyncFunction("sendText") { (view: LinkScreenView, text: String) in try view.sendText(text) }.runOnQueue(.main)
      AsyncFunction("sendKey") { (view: LinkScreenView, key: String, modifiers: [String]) in view.sendKey(key, modifiers: modifiers) }.runOnQueue(.main)
      AsyncFunction("requestPermission") { (view: LinkScreenView) in view.requestPermission() }.runOnQueue(.main)
    }
  }
}

final class LinkScreenView: ExpoView, UIGestureRecognizerDelegate {
  let onState = EventDispatcher()
  let onMetrics = EventDispatcher()
  private var renderer: ScreenMetalView?
  private var connection: ScreenConnection?
  private var url = ""
  private var mode = "view"
  private var diagnostics = false
  private var active = true
  private var trusted = false
  private var dragging = false
  private var lastMoved = 0.0
  private var cursorNumber = -1
  private var cursorTrail: [(CGPoint, Double)] = []
  private var shapes: [String: (UIImage, CGSize, CGPoint)] = [:]
  private var lastTap = 0.0
  private var lastTapPoint = CGPoint.zero
  private var observers: [NSObjectProtocol] = []
  private lazy var pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    isMultipleTouchEnabled = true
    let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
    pan.maximumNumberOfTouches = 1
    let two = UIPanGestureRecognizer(target: self, action: #selector(scrolled(_:)))
    two.minimumNumberOfTouches = 2; two.maximumNumberOfTouches = 2
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    let right = UITapGestureRecognizer(target: self, action: #selector(rightTapped(_:)))
    right.numberOfTouchesRequired = 2
    let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
    hold.minimumPressDuration = 0.4
    for gesture in [pan, two, tap, right, hold, pinch] {
      gesture.delegate = self
      addGestureRecognizer(gesture)
    }
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.active = false; self?.disconnect()
    })
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.active = true; self?.connect()
    })
    // Cap the next negotiated stream when the system reduces the receiver's sustained budget.
    for name in [ProcessInfo.thermalStateDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        guard let self, let renderer = self.renderer, renderer.requestedFps != self.receiverRate else { return }
        self.disconnect(); self.connect()
      })
    }
  }

  deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    connection?.stop()
  }

  func setURL(_ value: String) {
    guard url != value else { return }
    disconnect(); url = value; connect()
  }

  func setDiagnostics(_ value: Bool) {
    guard diagnostics != value else { return }
    disconnect(); diagnostics = value; connect()
  }

  func setMode(_ value: String) {
    guard ["view", "trackpad", "touch"].contains(value) else { return }
    releasePointer()
    mode = value
    if value != "view" { connection?.requestControl() }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { disconnect() } else { connect() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    renderer?.frame = bounds
    constrainPan()
  }

  private var receiverRate: Int {
    let screen = window?.screen ?? UIScreen.main
    let constrained = ProcessInfo.processInfo.isLowPowerModeEnabled || ProcessInfo.processInfo.thermalState == .serious || ProcessInfo.processInfo.thermalState == .critical
    return !constrained && screen.maximumFramesPerSecond >= 120 ? 120 : 60
  }

  private func connect() {
    guard active, window != nil, connection == nil, !url.isEmpty else { return }
    trusted = false; cursorNumber = -1; cursorTrail.removeAll(); shapes.removeAll()
    let metrics = ScreenMetrics(enabled: diagnostics)
    let renderer = ScreenMetalView(metrics: metrics)
    self.renderer = renderer
    renderer.frame = bounds
    addSubview(renderer)
    guard let connection = ScreenConnection(url: url, maxFps: receiverRate, renderer: renderer, metrics: metrics) else {
      renderer.removeFromSuperview(); self.renderer = nil
      onState(["state": "failed", "message": "屏幕地址无效，请重新连接"])
      return
    }
    self.connection = connection
    renderer.onPicture = { [weak self, weak connection] size in
      guard let self, let connection, self.connection === connection else { return }
      connection.pictureArrived()
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
        self.message(message)
      }
    }
    connection.onStats = { [weak self, weak connection] stats in
      DispatchQueue.main.async {
        guard let self, let connection, self.connection === connection else { return }
        self.onMetrics(stats)
      }
    }
    renderer.start(fps: receiverRate)
    onState(["state": "connecting", "maxFps": receiverRate])
    connection.start()
    if mode != "view" { connection.requestControl() }
  }

  private func disconnect() {
    releasePointer()
    connection?.stop(); connection = nil
    renderer?.stop(); renderer?.removeFromSuperview(); renderer = nil
    trusted = false
  }

  private func message(_ message: [String: Any]) {
    if let control = message["control"] as? [String: Any] {
      trusted = control["available"] as? Bool == true && control["trusted"] as? Bool == true
      if !trusted { releasePointer() }
      onState(["state": "control", "trusted": trusted, "message": control["reason"] as? String ?? "请在电脑上允许 LinkShell 的辅助功能权限"])
    }
    guard let renderer else { return }
    if message["t"] as? String == "cursor", let x = message["x"] as? Double, let y = message["y"] as? Double,
       x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) {
      let number = (message["i"] as? Int) ?? 0
      guard number > cursorNumber else { return }
      cursorNumber = number
      let now = CACurrentMediaTime(), point = CGPoint(x: x, y: y)
      cursorTrail.removeAll { now - $0.1 > 1 }
      guard now - lastMoved > 0.25, !cursorTrail.contains(where: { abs($0.0.x - point.x) < 0.001 && abs($0.0.y - point.y) < 0.001 }) else { return }
      renderer.pointer = point
    } else if message["t"] as? String == "shape", let id = message["id"] as? String {
      if let png = message["png"] as? String, png.utf8.count < 128_000, let data = Data(base64Encoded: png), let image = UIImage(data: data),
         let width = message["w"] as? Double, let height = message["h"] as? Double,
         width > 0, height > 0, width <= 256, height <= 256 {
        if shapes.count >= 64 { shapes.removeAll() }
        // The host already expresses geometry in points; `scale` describes PNG density.
        shapes[id] = (image, CGSize(width: width, height: height), CGPoint(x: (message["hotX"] as? Double) ?? 0, y: (message["hotY"] as? Double) ?? 0))
      }
      if let shape = shapes[id] { renderer.setCursor(shape.0, size: shape.1, hotspot: shape.2) }
    }
  }

  func fit() { renderer?.zoom = 1; renderer?.pan = .zero }
  func requestPermission() { connection?.input(["t": "prompt"]) }
  func sendKey(_ key: String, modifiers: [String]) {
    guard mode != "view", trusted, !key.isEmpty, key.utf16.count <= 16 else { return }
    let allowed = modifiers.filter { ["cmd", "ctrl", "alt", "shift"].contains($0) }
    connection?.input(["t": "key", "k": key, "m": Array(Set(allowed))])
  }
  func sendText(_ text: String) throws {
    guard mode != "view", trusted, connection != nil else {
      throw NSError(domain: "LinkScreen", code: 1, userInfo: [NSLocalizedDescriptionKey: "控制连接尚未就绪，文字已保留"])
    }
    // Preserve scalar boundaries; the host limits each message to 4000 UTF-16 units.
    var chunk = ""
    var units = 0
    var total = 0
    for scalar in text.unicodeScalars {
      let count = scalar.value > 0xffff ? 2 : 1
      if total + count > 20_000 { break }
      if units + count > 4000 {
        connection?.input(["t": "text", "s": chunk]); chunk = ""; units = 0
      }
      chunk.unicodeScalars.append(scalar)
      units += count; total += count
    }
    if !chunk.isEmpty { connection?.input(["t": "text", "s": chunk]) }
  }

  private var controlling: Bool { mode != "view" && trusted }
  private func move(_ point: CGPoint, reliable: Bool = false) {
    guard let renderer, controlling else { return }
    let point = CGPoint(x: min(1, max(0, point.x)), y: min(1, max(0, point.y)))
    renderer.pointer = point
    lastMoved = CACurrentMediaTime()
    cursorTrail.append((point, lastMoved))
    if cursorTrail.count > 240 { cursorTrail.removeFirst(cursorTrail.count - 240) }
    connection?.input(["t": "move", "x": point.x, "y": point.y], replaceable: !reliable && !dragging)
  }
  private func absolute(_ point: CGPoint) -> CGPoint {
    guard let renderer else { return .zero }
    let rect = renderer.contentRect
    return CGPoint(x: (point.x - rect.minX) / max(1, rect.width), y: (point.y - rect.minY) / max(1, rect.height))
  }
  private func button(_ down: Bool, right: Bool = false, clicks: Int = 1) {
    connection?.input(["t": down ? "down" : "up", "b": right ? "right" : "left", "n": clicks])
  }
  private func releasePointer() {
    if dragging { button(false); dragging = false }
  }
  private func constrainPan() {
    guard let renderer else { return }
    let rect = renderer.contentRect
    let x = max(0, (rect.width - bounds.width) / 2), y = max(0, (rect.height - bounds.height) / 2)
    renderer.pan = CGPoint(x: min(x, max(-x, renderer.pan.x)), y: min(y, max(-y, renderer.pan.y)))
  }
  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    guard controlling, let renderer else { return }
    let point = gesture.location(in: self)
    if mode == "touch", !renderer.contentRect.contains(point) { return }
    move(mode == "touch" ? absolute(point) : renderer.pointer, reliable: true)
    let now = CACurrentMediaTime()
    let double = now - lastTap < 0.35 && hypot(point.x - lastTapPoint.x, point.y - lastTapPoint.y) < 24
    button(true, clicks: double ? 2 : 1); button(false, clicks: double ? 2 : 1)
    lastTap = double ? 0 : now; lastTapPoint = point
  }
  @objc private func rightTapped(_ gesture: UITapGestureRecognizer) {
    guard controlling, let renderer else { return }
    move(mode == "touch" ? absolute(gesture.location(in: self)) : renderer.pointer, reliable: true)
    button(true, right: true); button(false, right: true)
  }
  @objc private func panned(_ gesture: UIPanGestureRecognizer) {
    guard let renderer else { return }
    let change = gesture.translation(in: self)
    gesture.setTranslation(.zero, in: self)
    if mode == "view" { renderer.pan.x += change.x; renderer.pan.y += change.y; constrainPan(); return }
    guard controlling else { return }
    if mode == "touch" {
      if gesture.state == .began {
        let point = gesture.location(in: self)
        move(absolute(CGPoint(x: point.x - change.x, y: point.y - change.y)), reliable: true)
        button(true); dragging = true
        move(absolute(point), reliable: true)
      } else if gesture.state == .changed { move(absolute(gesture.location(in: self)), reliable: true) }
      else if [.ended, .cancelled, .failed].contains(gesture.state) { releasePointer() }
    } else {
      let rect = renderer.contentRect
      move(CGPoint(x: renderer.pointer.x + change.x / max(rect.width, 1), y: renderer.pointer.y + change.y / max(rect.height, 1)))
      if [.ended, .cancelled, .failed].contains(gesture.state) { releasePointer() }
    }
  }
  @objc private func scrolled(_ gesture: UIPanGestureRecognizer) {
    let delta = gesture.translation(in: self)
    gesture.setTranslation(.zero, in: self)
    if mode == "view" { renderer?.pan.x += delta.x; renderer?.pan.y += delta.y; constrainPan() }
    else if controlling, pinch.state != .began, pinch.state != .changed {
      connection?.input(["t": "scroll", "dx": -delta.x * 2, "dy": delta.y * 2])
    }
  }
  @objc private func pinched(_ gesture: UIPinchGestureRecognizer) {
    guard let renderer else { return }
    releasePointer()
    renderer.zoom = min(4, max(1, renderer.zoom * gesture.scale))
    gesture.scale = 1
    constrainPan()
  }
  @objc private func held(_ gesture: UILongPressGestureRecognizer) {
    guard controlling, let renderer else { return }
    if gesture.state == .began {
      move(mode == "touch" ? absolute(gesture.location(in: self)) : renderer.pointer, reliable: true)
      button(true); dragging = true
    } else if gesture.state == .changed, mode == "touch" { move(absolute(gesture.location(in: self)), reliable: true) }
    else if [.ended, .cancelled, .failed].contains(gesture.state) { releasePointer() }
  }
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    (gestureRecognizer is UILongPressGestureRecognizer && otherGestureRecognizer is UIPanGestureRecognizer)
      || (otherGestureRecognizer is UILongPressGestureRecognizer && gestureRecognizer is UIPanGestureRecognizer)
      || (gestureRecognizer is UIPinchGestureRecognizer && otherGestureRecognizer is UIPanGestureRecognizer)
      || (otherGestureRecognizer is UIPinchGestureRecognizer && gestureRecognizer is UIPanGestureRecognizer)
  }
}
