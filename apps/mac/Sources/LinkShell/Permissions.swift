import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

/// The two things the system has to allow LinkShell, in the order the setup window lists them.
enum Permission: String, CaseIterable {
  /// Screen Recording: the screen can be shown on the phone.
  case recording
  /// Accessibility: the pointer can be moved, and keys typed.
  case control
}

/// What the system lets this process do, and under which app's name.
enum Permissions {
  /// The app the system holds responsible for this process: the one its privacy settings list.
  static func responsibleApp() -> String {
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

  /// Whether the pointer and the keys may be moved. A dry run moves nothing, so it always may.
  static func trusted() -> Bool {
    Launch.dryRun || AXIsProcessTrusted()
  }

  /// Whether the screen may be recorded. A process that was refused keeps hearing no after the
  /// switch is turned on, so once it has been refused it asks a fresh copy of itself (which asks
  /// the system nothing more than this does).
  static func recording() -> Bool {
    if CGPreflightScreenCaptureAccess() { return true }
    if Launch.has("--status") { return false }
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

  /// What a session says when it is refused because the screen may not be recorded.
  static let notRecording = "screen recording is not allowed for LinkShell"

  /// `video`: this app can send a screen as a video track (`rtc.open`). `w`, `h`: the main
  /// display, in pixels.
  static func status() -> [String: Any] {
    let main = Display.main
    return [
      "t": "status",
      "trusted": trusted(),
      "recording": recording(),
      "app": responsibleApp(),
      "video": true,
      "w": main.pixelWidth,
      "h": main.pixelHeight,
      "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
    ]
  }

  /// The system's own request for a permission: what puts LinkShell in the list its switch is
  /// in. Only the setup window makes it, when its button is pressed.
  static func request(_ permission: Permission) {
    switch permission {
    case .recording:
      _ = CGRequestScreenCaptureAccess()
    case .control:
      _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }
  }

  /// The page of System Settings › Privacy & Security that has a permission's switch.
  static func settings(_ permission: Permission) -> URL {
    let page = permission == .recording ? "Privacy_ScreenCapture" : "Privacy_Accessibility"
    return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(page)")!
  }
}
