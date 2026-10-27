import Darwin
import Foundation

/// The desktop window: Electron, packaged inside LinkShell.app (Contents/MacOS/LinkShell Desktop
/// and its framework and helpers in Contents/Frameworks). This executable stays the bundle's
/// CFBundleExecutable because installed hosts run it directly (`--status`, a screen's input,
/// `--connect`); when it is opened to show the window, it replaces itself with Electron, so the
/// window is the same process, bundle id and signature the system already knows.
enum DesktopShell {
  static var executable: String { Bundle.main.bundlePath + "/Contents/MacOS/LinkShell Desktop" }

  /// Returns only when there is no Electron in this bundle (a CLI-managed helper build): the
  /// caller then shows the native dashboard as before.
  static func exec() {
    let path = executable
    guard access(path, X_OK) == 0 else { return }
    // Electron reads its own switches; ours are passed on for its main process to read.
    let arguments = [path] + Launch.arguments
    var argv = arguments.map { strdup($0) }
    argv.append(nil)
    execv(path, argv)
    FileHandle.standardError.write(Data("LinkShell Desktop could not start: \(String(cString: strerror(errno)))\n".utf8))
  }
}
