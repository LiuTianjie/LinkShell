import AppKit

// A test tool (tools/input-check.mjs --shapes): gives the pointer one picture after another without
// touching the mouse, so that LinkShell.app's `shape` channel can be seen to follow. No event is
// posted, and the arrow is put back at the end.
//
//   pointer-shapes [seconds each, default 0.6]
//
// A program in the background may not set the pointer's picture; the window server lets it once
// its connection says "SetsCursorInBackground". That is not public API: this is a tool for a
// developer's Mac, and nothing the app itself does.

@_silgen_name("_CGSDefaultConnection") func defaultConnection() -> Int32
@_silgen_name("CGSSetConnectionProperty") func setConnectionProperty(_ connection: Int32, _ target: Int32, _ key: CFString, _ value: CFTypeRef) -> Int32

_ = NSApplication.shared
let connection = defaultConnection()
_ = setConnectionProperty(connection, connection, "SetsCursorInBackground" as CFString, kCFBooleanTrue)
let hold = Double(CommandLine.arguments.dropFirst().first ?? "") ?? 0.6
for (name, cursor) in [("I-beam", NSCursor.iBeam), ("hand", NSCursor.pointingHand), ("crosshair", NSCursor.crosshair), ("arrow", NSCursor.arrow)] {
  cursor.set()
  print(name)
  fflush(stdout)
  Thread.sleep(forTimeInterval: hold)
}
