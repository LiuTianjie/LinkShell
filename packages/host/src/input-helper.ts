// The source of the helper that moves this Mac's pointer and presses its keys
// (see `input.ts`). It is kept here as text and compiled on the computer the
// first time someone asks to control the screen: a Swift file needs no step in
// the package's build and no binary in it, and the compiler comes with the
// command line tools a machine running coding agents already has.

export const INPUT_HELPER_SOURCE = String.raw`import ApplicationServices
import CoreGraphics
import Foundation

// LinkShell's hands on this Mac: reads one JSON command a line on stdin and
// posts the mouse or keyboard event it describes. Positions are fractions of
// the display being watched. With --dry-run the events are printed, not posted.

let arguments = CommandLine.arguments
let dryRun = arguments.contains("--dry-run")
let screenNumber = arguments.dropFirst().compactMap { Int($0) }.first ?? 0

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func displayBounds() -> CGRect {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  let id = screenNumber < Int(count) ? ids[screenNumber] : CGMainDisplayID()
  return CGDisplayBounds(id)
}

func trusted() -> Bool { dryRun || AXIsProcessTrusted() }

let source = CGEventSource(stateID: .hidSystemState)
// Events from here must not hold back the real mouse and keyboard.
source?.localEventsSuppressionInterval = 0

var bounds = displayBounds()
var position = CGEvent(source: nil)?.location ?? CGPoint(x: bounds.midX, y: bounds.midY)
var held: [String: Bool] = [:]
var lastMove = Date.distantPast
var lastReported = CGPoint(x: -1, y: -1)
var wasTrusted = trusted()

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
  "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
  ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "\u{60}": 50, "backspace": 51, "escape": 53,
  "left": 123, "right": 124, "down": 125, "up": 126, "delete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func flags(_ names: Any?) -> CGEventFlags {
  var result: CGEventFlags = []
  for name in (names as? [String]) ?? [] {
    switch name {
    case "cmd": result.insert(.maskCommand)
    case "shift": result.insert(.maskShift)
    case "alt": result.insert(.maskAlternate)
    case "ctrl": result.insert(.maskControl)
    default: break
    }
  }
  return result
}

func post(_ event: CGEvent?, _ what: [String: Any]) {
  if dryRun {
    emit(what.merging(["t": "posted"]) { current, _ in current })
    return
  }
  event?.post(tap: .cghidEventTap)
}

func point(_ command: [String: Any]) -> CGPoint? {
  guard let x = command["x"] as? Double, let y = command["y"] as? Double else { return nil }
  // Just inside the far edges: a point on the edge itself belongs to the next display.
  return CGPoint(
    x: bounds.minX + min(max(x, 0), 1) * (bounds.width - 1),
    y: bounds.minY + min(max(y, 0), 1) * (bounds.height - 1)
  )
}

func move(to target: CGPoint) {
  let kind: CGEventType = held["left"] == true ? .leftMouseDragged : held["right"] == true ? .rightMouseDragged : .mouseMoved
  let event = CGEvent(mouseEventSource: source, mouseType: kind, mouseCursorPosition: target, mouseButton: held["right"] == true ? .right : .left)
  event?.setIntegerValueField(.mouseEventDeltaX, value: Int64(target.x - position.x))
  event?.setIntegerValueField(.mouseEventDeltaY, value: Int64(target.y - position.y))
  event?.flags = []
  position = target
  lastMove = Date()
  post(event, ["kind": kind == .mouseMoved ? "move" : "drag", "x": Double(target.x), "y": Double(target.y)])
}

func button(_ name: String, down: Bool, clicks: Int64, modifiers: CGEventFlags) {
  if held[name] == down { return }
  held[name] = down
  let right = name == "right"
  let kind: CGEventType = right ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .leftMouseDown : .leftMouseUp)
  let event = CGEvent(mouseEventSource: source, mouseType: kind, mouseCursorPosition: position, mouseButton: right ? .right : .left)
  event?.setIntegerValueField(.mouseEventClickState, value: clicks)
  event?.flags = modifiers
  lastMove = Date()
  post(event, ["kind": down ? "down" : "up", "b": name, "n": clicks, "x": Double(position.x), "y": Double(position.y), "flags": modifiers.rawValue])
}

func key(_ code: CGKeyCode, modifiers: CGEventFlags, name: String) {
  for down in [true, false] {
    let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
    event?.flags = modifiers
    post(event, ["kind": down ? "keydown" : "keyup", "k": name, "code": Int(code), "flags": modifiers.rawValue])
  }
}

func type(_ text: String) {
  // A string a key event: whatever the keyboard layout or input method, the characters arrive as written.
  let units = Array(text.utf16)
  var index = 0
  while index < units.count {
    var end = min(index + 20, units.count)
    // Not between the halves of a surrogate pair.
    if end < units.count, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
    let chunk = Array(units[index..<end])
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
      event?.flags = []
      event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
      post(event, ["kind": down ? "textdown" : "textup", "s": String(utf16CodeUnits: chunk, count: chunk.count)])
    }
    index = end
  }
}

func releaseAll() {
  for (name, down) in held where down { button(name, down: false, clicks: 1, modifiers: []) }
}

func handle(_ command: [String: Any]) {
  guard let kind = command["t"] as? String else { return }
  if kind == "prompt" {
    // Shows the system's "wants to control this computer" dialog on the Mac, once.
    if !dryRun {
      let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      _ = AXIsProcessTrustedWithOptions(options)
    }
    return
  }
  guard trusted() else { return }
  switch kind {
  case "move":
    if let target = point(command) { move(to: target) }
  case "down", "up":
    let name = (command["b"] as? String) == "right" ? "right" : "left"
    let clicks = Int64(min(max((command["n"] as? Int) ?? 1, 1), 3))
    button(name, down: kind == "down", clicks: clicks, modifiers: flags(command["m"]))
  case "scroll":
    let dx = Int32(max(min((command["dx"] as? Double) ?? 0, 2000), -2000))
    let dy = Int32(max(min((command["dy"] as? Double) ?? 0, 2000), -2000))
    let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
    event?.flags = flags(command["m"])
    post(event, ["kind": "scroll", "dx": Int(dx), "dy": Int(dy)])
  case "key":
    guard let name = command["k"] as? String, let code = keyCodes[name] else { return }
    key(code, modifiers: flags(command["m"]), name: name)
  case "text":
    if let text = command["s"] as? String { type(text) }
  default:
    break
  }
}

func report() {
  let now = trusted()
  if now != wasTrusted {
    wasTrusted = now
    emit(["t": "trusted", "v": now])
  }
  // Where the pointer is when someone at the Mac (or another program) moved it.
  guard Date().timeIntervalSince(lastMove) > 0.3, let location = CGEvent(source: nil)?.location else { return }
  bounds = displayBounds()
  if abs(location.x - lastReported.x) < 0.5, abs(location.y - lastReported.y) < 0.5 { return }
  lastReported = location
  position = location
  guard bounds.contains(location) else { return }
  emit(["t": "cursor", "x": Double((location.x - bounds.minX) / max(bounds.width - 1, 1)), "y": Double((location.y - bounds.minY) / max(bounds.height - 1, 1))])
}

emit(["t": "ready", "trusted": wasTrusted, "w": Double(bounds.width), "h": Double(bounds.height)])

let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: .milliseconds(250))
timer.setEventHandler { report() }
timer.resume()

Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8), let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    DispatchQueue.main.sync { handle(command) }
  }
  // The viewer left: nothing stays pressed.
  DispatchQueue.main.sync { releaseAll() }
  exit(0)
}

dispatchMain()
`;
