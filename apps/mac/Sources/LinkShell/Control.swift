import CoreGraphics
import Foundation

/// LinkShell's hands on this Mac for one viewer of one display: posts the mouse or keyboard
/// event each of the viewer's commands describes. Positions are fractions of that display.
/// In a dry run the events are reported (`posted`), not posted.
final class Control {
  /// Events from here must not hold back the real mouse and keyboard.
  private static let source: CGEventSource? = {
    let source = CGEventSource(stateID: .hidSystemState)
    source?.localEventsSuppressionInterval = 0
    return source
  }()

  let id: String?
  private let link: Link
  private let boundsNow: () -> CGRect
  private let everyPosition: ((Double, Double) -> Void)?
  private var bounds: CGRect
  private var position: CGPoint
  private var held: [String: Bool] = [:]
  /// The modifiers held down with each button that is down (shift-click, command-drag).
  private var holding: [String: [String]] = [:]
  private var lastMove = Date.distantPast
  private var lastReported = CGPoint(x: -1, y: -1)

  /// `bounds`: where the display is among the displays now (it can be moved, or change its
  /// size, while it is watched).
  ///
  /// `everyPosition`: for a viewer that draws the pointer itself (a video track has none in its
  /// picture) — it is given every place the pointer is. Without it the viewer's picture shows
  /// the pointer, and the host is told (`cursor`) only where someone else moved it to.
  init(id: String?, link: Link, bounds: @escaping () -> CGRect, everyPosition: ((Double, Double) -> Void)? = nil) {
    self.id = id
    self.link = link
    boundsNow = bounds
    self.everyPosition = everyPosition
    self.bounds = bounds()
    position = CGEvent(source: nil)?.location ?? CGPoint(x: self.bounds.midX, y: self.bounds.midY)
  }

  /// The display a `screen` number means (see `Display.at`); the main one when there is no such.
  convenience init(id: String?, link: Link, screen: Int) {
    self.init(id: id, link: link, bounds: { (Display.at(screen) ?? Display.main).bounds })
  }

  private func tell(_ object: [String: Any]) {
    var message = object
    if let id { message["v"] = id }
    link.emit(message)
  }

  private func post(_ event: CGEvent?, _ what: [String: Any]) {
    if Launch.dryRun {
      tell(what.merging(["t": "posted"]) { current, _ in current })
      return
    }
    event?.post(tap: .cghidEventTap)
  }

  private func point(_ command: [String: Any]) -> CGPoint? {
    guard let x = command["x"] as? Double, let y = command["y"] as? Double else { return nil }
    // Just inside the far edges: a point on the edge itself belongs to the next display.
    return CGPoint(
      x: bounds.minX + min(max(x, 0), 1) * (bounds.width - 1),
      y: bounds.minY + min(max(y, 0), 1) * (bounds.height - 1)
    )
  }

  private func move(to target: CGPoint) {
    let kind: CGEventType = held["left"] == true ? .leftMouseDragged : held["right"] == true ? .rightMouseDragged : .mouseMoved
    let event = CGEvent(mouseEventSource: Control.source, mouseType: kind, mouseCursorPosition: target, mouseButton: held["right"] == true ? .right : .left)
    event?.setIntegerValueField(.mouseEventDeltaX, value: Int64(target.x - position.x))
    event?.setIntegerValueField(.mouseEventDeltaY, value: Int64(target.y - position.y))
    event?.flags = []
    position = target
    lastMove = Date()
    post(event, ["kind": kind == .mouseMoved ? "move" : "drag", "x": Double(target.x), "y": Double(target.y)])
  }

  /// Presses (or lets go of) modifier keys; the flags held once it has.
  private func modifiers(_ names: [String], down: Bool, over base: CGEventFlags = []) -> CGEventFlags {
    var flags = base
    let keys = Keys.modifiers.filter { names.contains($0.name) }
    for key in down ? keys : keys.reversed() {
      if down { flags.insert(key.flag) } else { flags.remove(key.flag) }
      let event = CGEvent(keyboardEventSource: Control.source, virtualKey: key.code, keyDown: down)
      event?.type = .flagsChanged
      event?.flags = flags
      post(event, ["kind": down ? "moddown" : "modup", "k": key.name])
    }
    return flags
  }

  private func button(_ name: String, down: Bool, clicks: Int64, with names: [String]) {
    if held[name] == down { return }
    held[name] = down
    // Shift-click, command-drag: the keys go down before the button and stay until it is up.
    // A key the other button is already holding is not pressed again, nor let go under it.
    let flags: CGEventFlags
    if down {
      let already = Set(holding.values.joined())
      holding[name] = names
      flags = modifiers(names.filter { !already.contains($0) }, down: true, over: Keys.flags(Array(already)))
    } else {
      flags = Keys.flags(Array(holding.values.joined()))
    }
    let right = name == "right"
    let kind: CGEventType = right ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .leftMouseDown : .leftMouseUp)
    let event = CGEvent(mouseEventSource: Control.source, mouseType: kind, mouseCursorPosition: position, mouseButton: right ? .right : .left)
    event?.setIntegerValueField(.mouseEventClickState, value: clicks)
    event?.flags = flags
    lastMove = Date()
    post(event, ["kind": down ? "down" : "up", "b": name, "n": clicks, "x": Double(position.x), "y": Double(position.y), "flags": flags.rawValue])
    if !down {
      let own = holding.removeValue(forKey: name) ?? []
      let others = Set(holding.values.joined())
      _ = modifiers(own.filter { !others.contains($0) }, down: false, over: flags)
    }
  }

  private func key(_ code: CGKeyCode, with names: [String], name: String) {
    let modifiers = self.modifiers(names, down: true)
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: Control.source, virtualKey: code, keyDown: down)
      event?.flags = modifiers
      post(event, ["kind": down ? "keydown" : "keyup", "k": name, "code": Int(code), "flags": modifiers.rawValue])
    }
    _ = self.modifiers(names, down: false, over: modifiers)
  }

  private func type(_ text: String) {
    InputSource.plainWhileTyping()
    // A string a key event: whatever the keyboard layout or input method, the characters arrive as written.
    let units = Array(text.utf16)
    var index = 0
    while index < units.count {
      var end = min(index + 20, units.count)
      // Not between the halves of a surrogate pair.
      if end < units.count, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
      let chunk = Array(units[index..<end])
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: Control.source, virtualKey: 0, keyDown: down)
        event?.flags = []
        event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        post(event, ["kind": down ? "textdown" : "textup", "s": String(utf16CodeUnits: chunk, count: chunk.count)])
      }
      index = end
    }
  }

  /// The viewer left: nothing stays pressed.
  func releaseAll() {
    // What was pressed was pressed with the permission. Should it have been taken away since,
    // nothing is posted: an event posted without it has the system ask for it.
    guard Permissions.trusted() else { return }
    for (name, down) in held where down { button(name, down: false, clicks: 1, with: []) }
  }

  func handle(_ command: [String: Any]) {
    guard let kind = command["t"] as? String else { return }
    // The viewer asked to be allowed to control this Mac: the window where the user allows it.
    if kind == "prompt" { return Setup.open() }
    guard Permissions.trusted() else { return }
    switch kind {
    case "move":
      if let target = point(command) { move(to: target) }
    case "down", "up":
      let name = (command["b"] as? String) == "right" ? "right" : "left"
      let clicks = Int64(min(max((command["n"] as? Int) ?? 1, 1), 3))
      button(name, down: kind == "down", clicks: clicks, with: (command["m"] as? [String]) ?? [])
    case "scroll":
      let dx = Int32(max(min((command["dx"] as? Double) ?? 0, 2000), -2000))
      let dy = Int32(max(min((command["dy"] as? Double) ?? 0, 2000), -2000))
      let event = CGEvent(scrollWheelEvent2Source: Control.source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
      event?.flags = Keys.flags(command["m"])
      post(event, ["kind": "scroll", "dx": Int(dx), "dy": Int(dy)])
    case "key":
      guard let name = command["k"] as? String, let code = Keys.code(name) else { return }
      key(code, with: (command["m"] as? [String]) ?? [], name: name)
    case "text":
      if let text = command["s"] as? String { type(text) }
    default:
      break
    }
  }

  /// Says where the pointer is, when it is somewhere new on this display.
  ///
  /// One rule for both kinds of viewer. The pointer is this viewer's own for a moment (0.3 s)
  /// after each of its events; once that has passed, wherever the pointer is — someone at the
  /// Mac moved it, or another program did — is taken as where this viewer's next event starts
  /// from. A viewer whose picture shows the pointer is told only then; one that draws the
  /// pointer itself is told always.
  func report() {
    let own = Date().timeIntervalSince(lastMove) <= 0.3
    guard !own || everyPosition != nil, let location = CGEvent(source: nil)?.location else { return }
    bounds = boundsNow()
    if abs(location.x - lastReported.x) < 0.5, abs(location.y - lastReported.y) < 0.5 { return }
    lastReported = location
    if !own { position = location }
    guard bounds.contains(location) else { return }
    let x = Double((location.x - bounds.minX) / max(bounds.width - 1, 1))
    let y = Double((location.y - bounds.minY) / max(bounds.height - 1, 1))
    if let everyPosition {
      everyPosition(x, y)
    } else {
      tell(["t": "cursor", "x": x, "y": y])
    }
  }

  /// The next report says where the pointer is even if it hasn't moved: for a viewer that has
  /// only now begun to listen.
  func reportAfresh() {
    lastReported = CGPoint(x: -1, y: -1)
  }

  func ready() {
    tell(["t": "ready", "trusted": Permissions.trusted(), "w": Double(bounds.width), "h": Double(bounds.height), "app": Permissions.responsibleApp()])
  }
}

/// Every quarter of a second: the host hears when the permission to control this Mac is given
/// or taken away, and each viewer where the pointer went.
final class Watch {
  private let timer = DispatchSource.makeTimerSource(queue: .main)
  private var wasTrusted = Permissions.trusted()

  init(link: Link, controls: @escaping () -> [Control]) {
    timer.schedule(deadline: .now(), repeating: .milliseconds(250))
    timer.setEventHandler { [unowned self] in
      let now = Permissions.trusted()
      if now != wasTrusted {
        wasTrusted = now
        link.emit(["t": "trusted", "on": now])
      }
      for control in controls() { control.report() }
    }
    timer.resume()
  }

  func cancel() {
    timer.cancel()
  }
}
