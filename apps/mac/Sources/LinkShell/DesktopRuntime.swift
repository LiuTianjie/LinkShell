import AppKit
import CryptoKit
import Foundation

/// All paths remain inside the signed bundle; PATH is never used to select a standalone runtime.
enum DesktopRuntime {
  static var bundled: Bool { FileManager.default.fileExists(atPath: Bundle.main.bundlePath + "/Contents/Resources/standalone.json") }
  static var node: String { Bundle.main.bundlePath + "/Contents/MacOS/node" }
  static var cli: String { Bundle.main.bundlePath + "/Contents/Resources/runtime/cli/dist/cli/src/index.js" }
  static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版" }
  private static var homeKey: String { "desktop.home." + SHA256.hash(data: Data(Bundle.main.bundlePath.utf8)).map { String(format: "%02x", $0) }.joined() }
  static var home: String {
    if let chosen = Launch.value(after: "--home") ?? ProcessInfo.processInfo.environment["LINKSHELL_HOME"] {
      // Sparkle relaunches without command-line arguments. Preserve only the state directory, never credentials.
      if bundled { UserDefaults.standard.set(chosen, forKey: homeKey) }
      return chosen
    }
    if bundled, let saved = UserDefaults.standard.string(forKey: homeKey) { return saved }
    return NSHomeDirectory() + "/.linkshell"
  }
  static func installCommand() throws -> String {
    let directory = URL(fileURLWithPath: NSHomeDirectory() + "/.local/bin")
    let link = directory.appendingPathComponent("linkshell")
    let target = Bundle.main.bundlePath + "/Contents/MacOS/linkshell-cli"
    guard bundled else { throw NSError(domain: "LinkShell", code: 1, userInfo: [NSLocalizedDescriptionKey: "当前不是独立 App 安装"]) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if let existing = try? FileManager.default.destinationOfSymbolicLink(atPath: link.path), existing == target { return link.path }
    // A different installation's command is never silently replaced.
    if FileManager.default.fileExists(atPath: link.path) || (try? FileManager.default.destinationOfSymbolicLink(atPath: link.path)) != nil {
      throw NSError(domain: "LinkShell", code: 1, userInfo: [NSLocalizedDescriptionKey: "~/.local/bin/linkshell 已存在，未覆盖。可直接使用 App 内 Contents/MacOS/linkshell-cli。"])
    }
    try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: target)
    return link.path
  }
}
