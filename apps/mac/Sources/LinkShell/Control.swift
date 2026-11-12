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
  /// Physical keys the viewer holds down (`keydown` / `keyup`), and the modifier keys among them:
  /// their flags go with every event posted while they are down, as a keyboard's would.
  private var keysDown: Set<CGKeyCode> = []
  private var modifiersDown: Set<CGKeyCode> = []
  private var heldFlags: CGEventFlags { PhysicalKeys.flags(of: modifiersDown) }
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

  static func mouseDelta(from origin: CGPoint, to target: CGPoint, bounds: CGRect, dragging: Bool) -> (dx: Int64, dy: Int64) {
    let dx = Int64((target.x - origin.x).rounded())
    var dy = Int64((target.y - origin.y).rounded())
    // On a remote Mac with an auto-hidden full-screen menu bar, WindowServer reveals the bar only
    // when top-edge pointer motion carries upward (negative) deltaY.
    if !dragging, bounds.height > 0, target.y <= bounds.minY + 0.5 {
      dy = min(dy, -1)
    }
    return (dx, dy)
  }

  private func move(to target: CGPoint) {
    let kind: CGEventType = held["left"] == true ? .leftMouseDragged : held["right"] == true ? .rightMouseDragged : held["middle"] == true ? .otherMouseDragged : .mouseMoved
    let pressed: CGMouseButton = held["left"] == true ? .left : held["right"] == true ? .right : held["middle"] == true ? .center : .left
    let event = CGEvent(mouseEventSource: Control.source, mouseType: kind, mouseCursorPosition: target, mouseButton: pressed)
    let delta = Control.mouseDelta(from: position, to: target, bounds: bounds, dragging: kind != .mouseMoved)
    event?.setIntegerValueField(.mouseEventDeltaX, value: delta.dx)
    event?.setIntegerValueField(.mouseEventDeltaY, value: delta.dy)
    event?.flags = heldFlags
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
    var flags: CGEventFlags
    // Modifier keys the viewer holds physically are down already: only the others are pressed here.
    let names = names.filter { name in !heldFlags.contains(Keys.flags([name])) }
    if down {
      let already = Set(holding.values.joined())
      holding[name] = names
      flags = modifiers(names.filter { !already.contains($0) }, down: true, over: Keys.flags(Array(already)).union(heldFlags))
    } else {
      flags = Keys.flags(Array(holding.values.joined()))
    }
    flags.formUnion(heldFlags)
    let kind: CGEventType
    let pressed: CGMouseButton
    switch name {
    case "right": kind = down ? .rightMouseDown : .rightMouseUp; pressed = .right
    case "middle": kind = down ? .otherMouseDown : .otherMouseUp; pressed = .center
    default: kind = down ? .leftMouseDown : .leftMouseUp; pressed = .left
    }
    let event = CGEvent(mouseEventSource: Control.source, mouseType: kind, mouseCursorPosition: position, mouseButton: pressed)
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

  /// A physical key held (`down`) or let go, by its W3C code. A modifier key changes the flags of
  /// everything after it until it is let go; any other key is posted with the flags held, and a
  /// repeat (`again`) says so, as the keyboard's own repeat does. Unknown codes are ignored.
  private func physical(_ code: String, down: Bool, again: Bool) {
    guard let key = PhysicalKeys.macKeys[code] else { return }
    if PhysicalKeys.modifier(key) != nil {
      guard down ? modifiersDown.insert(key).inserted : modifiersDown.remove(key) != nil else { return }
      let event = CGEvent(keyboardEventSource: Control.source, virtualKey: key, keyDown: down)
      event?.type = .flagsChanged
      event?.flags = heldFlags
      return post(event, ["kind": down ? "moddown" : "modup", "c": code, "flags": heldFlags.rawValue])
    }
    if down { keysDown.insert(key) } else if keysDown.remove(key) == nil { return }
    let event = CGEvent(keyboardEventSource: Control.source, virtualKey: key, keyDown: down)
    event?.flags = heldFlags
    if down, again { event?.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
    post(event, ["kind": down ? "keydown" : "keyup", "c": code, "code": Int(key), "repeat": down && again, "flags": heldFlags.rawValue])
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
    for key in keysDown { if let code = PhysicalKeys.codes[key] { physical(code, down: false, again: false) } }
    for key in modifiersDown { if let code = PhysicalKeys.codes[key] { physical(code, down: false, again: false) } }
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
      let name = ["right", "middle"].contains(command["b"] as? String ?? "") ? command["b"] as! String : "left"
      let clicks = Int64(min(max((command["n"] as? Int) ?? 1, 1), 3))
      button(name, down: kind == "down", clicks: clicks, with: (command["m"] as? [String]) ?? [])
    case "scroll":
      let dx = Int32(max(min((command["dx"] as? Double) ?? 0, 2000), -2000))
      let dy = Int32(max(min((command["dy"] as? Double) ?? 0, 2000), -2000))
      let event = CGEvent(scrollWheelEvent2Source: Control.source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
      event?.flags = Keys.flags(command["m"]).union(heldFlags)
      post(event, ["kind": "scroll", "dx": Int(dx), "dy": Int(dy)])
    case "key":
      guard let name = command["k"] as? String, let code = Keys.code(name) else { return }
      key(code, with: (command["m"] as? [String]) ?? [], name: name)
    case "text":
      if let text = command["s"] as? String { type(text) }
    case "keydown", "keyup":
      if let code = command["c"] as? String { physical(code, down: kind == "keydown", again: command["r"] as? Bool == true) }
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
