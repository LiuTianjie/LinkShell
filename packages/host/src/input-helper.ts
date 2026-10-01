// The source of the helper that moves this Mac's pointer and presses its keys
// (see `input.ts`). One source, used two ways:
//
// - built and signed into `LinkShell.app` when the package is made (see
//   `scripts/build-helper.mjs`). The host has the system open it, so it is an
//   app of its own: the Accessibility permission is asked for, listed and
//   kept under the name LinkShell, whatever terminal started the host.
// - compiled on the computer the first time it is needed, where a build has no
//   signed app (a checkout without the signing identity). It then runs as the
//   host's child, and the permission is the terminal's.

export const INPUT_HELPER_SOURCE = String.raw`import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Darwin
import Foundation

// LinkShell's hands on this Mac: reads one JSON command a line and posts the
// mouse or keyboard event it describes. Positions are fractions of the display
// a viewer is watching. With --dry-run the events are reported, not posted.
//
//   <screen>                 one viewer, commands on stdin, answers on stdout
//   --connect <socket>       an app of its own: any number of viewers ("v") over the host's socket,
//                            and the screen captures, which it starts so that they are its own too
//   --status                 what this process is allowed to do, then exit
//   --ask-control | --ask-recording   have the system ask for a permission, then exit

let arguments = Array(CommandLine.arguments.dropFirst())
let dryRun = arguments.contains("--dry-run")

func argument(after flag: String) -> String? {
  guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
  return arguments[index + 1]
}

var output = FileHandle.standardOutput

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
  output.write((line + "\n").data(using: .utf8)!)
}

/// The app the system holds responsible for this process: the one its privacy settings list.
func responsibleApp() -> String {
  typealias Lookup = @convention(c) (pid_t) -> pid_t
  guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return "" }
  let pid = unsafeBitCast(symbol, to: Lookup.self)(getpid())
  guard pid > 0 else { return "" }
  var buffer = [CChar](repeating: 0, count: 4096)
  guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return "" }
  let path = String(cString: buffer)
  // An app is named by its bundle, anything else by its file.
  if let bundle = path.components(separatedBy: "/").last(where: { $0.hasSuffix(".app") }) { return String(bundle.dropLast(4)) }
  return (path as NSString).lastPathComponent
}

func trusted() -> Bool { dryRun || AXIsProcessTrusted() }

/// Whether the screen may be recorded. A process that was refused keeps hearing no after the
/// switch is turned on, so once it has been refused it asks a fresh copy of itself.
func recording() -> Bool {
  if CGPreflightScreenCaptureAccess() { return true }
  if arguments.contains("--status") { return false }
  guard let program = Bundle.main.executablePath else { return false }
  let check = Process()
  check.executableURL = URL(fileURLWithPath: program)
  check.arguments = ["--status"]
  let answer = Pipe()
  check.standardOutput = answer
  check.standardError = FileHandle.nullDevice
  guard (try? check.run()) != nil else { return false }
  let data = answer.fileHandleForReading.readDataToEndOfFile()
  check.waitUntilExit()
  return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["recording"] as? Bool ?? false
}

func status() -> [String: Any] {
  ["t": "status", "trusted": trusted(), "recording": recording(), "app": responsibleApp()]
}

/// The system's own dialog, and the page of its settings where the switch is.
func askControl() {
  if dryRun || AXIsProcessTrusted() { return }
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  _ = AXIsProcessTrustedWithOptions(options)
  if let page = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") { NSWorkspace.shared.open(page) }
}

func askRecording() {
  if CGPreflightScreenCaptureAccess() { return }
  _ = CGRequestScreenCaptureAccess()
  if let page = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") { NSWorkspace.shared.open(page) }
}

let source = CGEventSource(stateID: .hidSystemState)
// Events from here must not hold back the real mouse and keyboard.
source?.localEventsSuppressionInterval = 0

// Keys that are where they are on every layout.
let fixedKeys: [String: CGKeyCode] = [
  "return": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53,
  "left": 123, "right": 124, "down": 125, "up": 126, "delete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func sourceProperty<T>(_ source: TISInputSource, _ key: CFString) -> T? {
  guard let pointer = TISGetInputSourceProperty(source, key) else { return nil }
  return Unmanaged<AnyObject>.fromOpaque(pointer).takeUnretainedValue() as? T
}

// Where each character is on this Mac's own layout: a shortcut's letter is the key that types it
// here, not the key it is on an American keyboard.
var layoutID = ""
var layoutKeys: [String: CGKeyCode] = [:]

func readLayout() {
  guard let layout = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue() else { return }
  let id: String = sourceProperty(layout, kTISPropertyInputSourceID) ?? ""
  if id == layoutID, !layoutKeys.isEmpty { return }
  guard let data: NSData = sourceProperty(layout, kTISPropertyUnicodeKeyLayoutData) else { return }
  layoutID = id
  layoutKeys = [:]
  let table = data.bytes.assumingMemoryBound(to: UCKeyboardLayout.self)
  for code in 0..<127 {
    var dead: UInt32 = 0
    var length = 0
    var characters = [UniChar](repeating: 0, count: 4)
    let status = UCKeyTranslate(table, UInt16(code), UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 4, &length, &characters)
    guard status == noErr, length == 1 else { continue }
    let character = String(utf16CodeUnits: characters, count: 1).lowercased()
    // The main keys come before the number pad's.
    if layoutKeys[character] == nil { layoutKeys[character] = CGKeyCode(code) }
  }
}

func keyCode(_ name: String) -> CGKeyCode? {
  if let fixed = fixedKeys[name] { return fixed }
  readLayout()
  return layoutKeys[name] ?? keyCodes[name]
}

// The keys a modifier is, pressed and let go around what it modifies as a hand does: some programs
// look at the keyboard's state, not at the event's flags.
let modifierKeys: [(name: String, code: CGKeyCode, flag: CGEventFlags)] = [
  ("ctrl", 59, .maskControl), ("alt", 58, .maskAlternate), ("shift", 56, .maskShift), ("cmd", 55, .maskCommand),
]

// Text from the phone is already what it should be. An input method on this Mac (pinyin, say) would
// take its letters and compose with them again, so while text is coming the Mac types with its plain
// layout; a moment after the last of it, the input source the user had is back.
var ownSource: TISInputSource?
var restore: DispatchWorkItem?

func plainWhileTyping() {
  if dryRun { return }
  if let current = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() {
    let plain: Bool = sourceProperty(current, kTISPropertyInputSourceIsASCIICapable) ?? true
    if !plain, let layout = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue() {
      if ownSource == nil { ownSource = current }
      TISSelectInputSource(layout)
      // The program in front takes a moment to follow.
      usleep(150_000)
    }
  }
  guard ownSource != nil else { return }
  restore?.cancel()
  let work = DispatchWorkItem {
    if let source = ownSource { TISSelectInputSource(source) }
    ownSource = nil
  }
  restore = work
  DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: work)
}

/// The American layout, for a Mac whose own can't be read.
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

/// One device watching one display.
final class Viewer {
  let id: String?
  let screen: Int
  var bounds: CGRect
  var position: CGPoint
  var held: [String: Bool] = [:]
  /// Modifiers this viewer is holding down for a click or a drag.
  var holding: [String] = []
  var lastMove = Date.distantPast
  var lastReported = CGPoint(x: -1, y: -1)

  init(id: String?, screen: Int) {
    self.id = id
    self.screen = screen
    bounds = Viewer.bounds(of: screen)
    position = CGEvent(source: nil)?.location ?? CGPoint(x: bounds.midX, y: bounds.midY)
  }

  /// ffmpeg's "Capture screen N" is the Nth active display.
  static func bounds(of screen: Int) -> CGRect {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return CGDisplayBounds(screen < Int(count) ? ids[screen] : CGMainDisplayID())
  }

  func tell(_ object: [String: Any]) {
    var message = object
    if let id = id { message["v"] = id }
    emit(message)
  }

  func post(_ event: CGEvent?, _ what: [String: Any]) {
    if dryRun {
      tell(what.merging(["t": "posted"]) { current, _ in current })
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

  /// Presses (or lets go of) modifier keys; the flags held once it has.
  func modifiers(_ names: [String], down: Bool, over base: CGEventFlags = []) -> CGEventFlags {
    var flags = base
    let keys = modifierKeys.filter { names.contains($0.name) }
    for key in down ? keys : keys.reversed() {
      if down { flags.insert(key.flag) } else { flags.remove(key.flag) }
      let event = CGEvent(keyboardEventSource: source, virtualKey: key.code, keyDown: down)
      event?.type = .flagsChanged
      event?.flags = flags
      post(event, ["kind": down ? "moddown" : "modup", "k": key.name])
    }
    return flags
  }

  func button(_ name: String, down: Bool, clicks: Int64, with names: [String]) {
    if held[name] == down { return }
    held[name] = down
    // Shift-click, command-drag: the keys go down before the button and stay until it is up.
    var modifiers: CGEventFlags = []
    if down {
      holding = names
      modifiers = self.modifiers(names, down: true)
    } else {
      modifiers = flags(holding)
    }
    defer {
      if !down {
        _ = self.modifiers(holding, down: false, over: flags(holding))
        holding = []
      }
    }
    let right = name == "right"
    let kind: CGEventType = right ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .leftMouseDown : .leftMouseUp)
    let event = CGEvent(mouseEventSource: source, mouseType: kind, mouseCursorPosition: position, mouseButton: right ? .right : .left)
    event?.setIntegerValueField(.mouseEventClickState, value: clicks)
    event?.flags = modifiers
    lastMove = Date()
    post(event, ["kind": down ? "down" : "up", "b": name, "n": clicks, "x": Double(position.x), "y": Double(position.y), "flags": modifiers.rawValue])
  }

  func key(_ code: CGKeyCode, with names: [String], name: String) {
    let modifiers = self.modifiers(names, down: true)
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
      event?.flags = modifiers
      post(event, ["kind": down ? "keydown" : "keyup", "k": name, "code": Int(code), "flags": modifiers.rawValue])
    }
    _ = self.modifiers(names, down: false, over: modifiers)
  }

  func type(_ text: String) {
    plainWhileTyping()
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

  /// The viewer left: nothing stays pressed.
  func releaseAll() {
    for (name, down) in held where down { button(name, down: false, clicks: 1, with: []) }
  }

  func handle(_ command: [String: Any]) {
    guard let kind = command["t"] as? String else { return }
    if kind == "prompt" { return askControl() }
    guard trusted() else { return }
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
      let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
      event?.flags = flags(command["m"])
      post(event, ["kind": "scroll", "dx": Int(dx), "dy": Int(dy)])
    case "key":
      guard let name = command["k"] as? String, let code = keyCode(name) else { return }
      key(code, with: (command["m"] as? [String]) ?? [], name: name)
    case "text":
      if let text = command["s"] as? String { type(text) }
    default:
      break
    }
  }

  /// Where the pointer is when someone at the Mac (or another program) moved it.
  func report() {
    guard Date().timeIntervalSince(lastMove) > 0.3, let location = CGEvent(source: nil)?.location else { return }
    bounds = Viewer.bounds(of: screen)
    if abs(location.x - lastReported.x) < 0.5, abs(location.y - lastReported.y) < 0.5 { return }
    lastReported = location
    position = location
    guard bounds.contains(location) else { return }
    tell(["t": "cursor", "x": Double((location.x - bounds.minX) / max(bounds.width - 1, 1)), "y": Double((location.y - bounds.minY) / max(bounds.height - 1, 1))])
  }

  func ready() {
    tell(["t": "ready", "trusted": trusted(), "w": Double(bounds.width), "h": Double(bounds.height), "app": responsibleApp()])
  }
}

var viewers: [String: Viewer] = [:]
var captures: [String: Process] = [:]
var wasTrusted = trusted()

func end(_ process: Process) {
  guard process.isRunning else { return }
  process.terminate()
  // ffmpeg holding a screen can sit through being asked.
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
  }
}

/// Runs a screen capture as this app's own child, so the recording is this app's to be allowed,
/// with its picture going straight down a socket of the host's.
func capture(_ id: String, _ command: [String: Any]) {
  let failed = { (reason: String) in emit(["t": "captured", "v": id, "code": -1, "errors": reason]) }
  guard let program = command["exec"] as? String, let args = command["args"] as? [String], let path = command["socket"] as? String else { return failed("not a capture") }
  // The one program this runs for the host.
  guard dryRun || (program as NSString).lastPathComponent == "ffmpeg" else { return failed("not ffmpeg") }
  guard let sink = connect(to: path) else { return failed("the host's socket could not be reached") }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: program)
  process.arguments = args
  process.standardInput = FileHandle.nullDevice
  process.standardOutput = sink
  let errors = Pipe()
  process.standardError = errors
  var said = Data()
  errors.fileHandleForReading.readabilityHandler = { handle in
    let chunk = handle.availableData
    if chunk.isEmpty {
      handle.readabilityHandler = nil
      return
    }
    DispatchQueue.main.async {
      said.append(chunk)
      if said.count > 2000 { said.removeFirst(said.count - 2000) }
    }
  }
  process.terminationHandler = { finished in
    DispatchQueue.main.async {
      captures[id] = nil
      try? sink.close()
      emit(["t": "captured", "v": id, "code": Int(finished.terminationStatus), "errors": String(data: said, encoding: .utf8) ?? ""])
    }
  }
  do {
    try process.run()
    captures[id] = process
  } catch {
    failed(error.localizedDescription)
  }
}

/// Lines from a pipe or a socket, each handled on the main queue; then end.
func readLines(from handle: FileHandle, each: @escaping (String) -> Void, end: @escaping () -> Void) {
  Thread.detachNewThread {
    var buffer = Data()
    while true {
      let chunk = handle.availableData
      if chunk.isEmpty { break }
      buffer.append(chunk)
      while let newline = buffer.firstIndex(of: 10) {
        let line = String(data: buffer.subdata(in: buffer.startIndex..<newline), encoding: .utf8) ?? ""
        buffer.removeSubrange(buffer.startIndex...newline)
        DispatchQueue.main.sync { each(line) }
      }
    }
    DispatchQueue.main.sync { end() }
  }
}

func object(_ line: String) -> [String: Any]? {
  guard let data = line.data(using: .utf8) else { return nil }
  return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func watch() -> DispatchSourceTimer {
  let timer = DispatchSource.makeTimerSource(queue: .main)
  timer.schedule(deadline: .now(), repeating: .milliseconds(250))
  timer.setEventHandler {
    let now = trusted()
    if now != wasTrusted {
      wasTrusted = now
      emit(["t": "trusted", "on": now])
    }
    for viewer in viewers.values { viewer.report() }
  }
  timer.resume()
  return timer
}

func connect(to path: String) -> FileHandle? {
  let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
  guard descriptor >= 0 else { return nil }
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
  withUnsafeMutablePointer(to: &address.sun_path) { pointer in
    pointer.withMemoryRebound(to: UInt8.self, capacity: bytes.count + 1) { raw in
      for (index, byte) in bytes.enumerated() { raw[index] = byte }
      raw[bytes.count] = 0
    }
  }
  let size = socklen_t(MemoryLayout<sockaddr_un>.size)
  let result = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, size) }
  }
  guard result == 0 else {
    close(descriptor)
    return nil
  }
  return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
}

signal(SIGPIPE, SIG_IGN)

if arguments.contains("--status") {
  emit(status())
  exit(0)
}
if arguments.contains("--ask-control") {
  askControl()
  emit(status())
  exit(0)
}
if arguments.contains("--ask-recording") {
  askRecording()
  emit(status())
  exit(0)
}

if let path = argument(after: "--connect") {
  // An app of its own, with no window and no place in the Dock.
  guard let link = connect(to: path) else { exit(1) }
  output = link
  emit(status())
  let timer = watch()
  readLines(from: link, each: { line in
    guard let command = object(line), let kind = command["t"] as? String else { return }
    if kind == "status" { return emit(status()) }
    if kind == "ask" { return askControl() }
    if kind == "ask-recording" { return askRecording() }
    guard let id = command["v"] as? String else { return }
    if kind == "capture" {
      capture(id, command)
    } else if kind == "stop" {
      if let process = captures[id] { end(process) }
    } else if kind == "open" {
      viewers[id]?.releaseAll()
      let viewer = Viewer(id: id, screen: (command["screen"] as? Int) ?? 0)
      viewers[id] = viewer
      viewer.ready()
    } else if kind == "close" {
      viewers.removeValue(forKey: id)?.releaseAll()
    } else {
      viewers[id]?.handle(command)
    }
  }, end: {
    // The host went: so does this, and what it was running.
    for viewer in viewers.values { viewer.releaseAll() }
    for process in captures.values where process.isRunning { kill(process.processIdentifier, SIGKILL) }
    timer.cancel()
    exit(0)
  })
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  app.run()
} else {
  let viewer = Viewer(id: nil, screen: arguments.compactMap { Int($0) }.first ?? 0)
  viewers[""] = viewer
  viewer.ready()
  let timer = watch()
  readLines(from: FileHandle.standardInput, each: { line in
    if let command = object(line) { viewer.handle(command) }
  }, end: {
    viewer.releaseAll()
    timer.cancel()
    exit(0)
  })
  dispatchMain()
}
`;
