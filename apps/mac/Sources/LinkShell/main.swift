import AppKit
import Foundation

// LinkShell.app: the Mac side of LinkShell's remote desktop. It holds the system's permissions
// (Screen Recording, Accessibility) under its own name, sends a display to a viewer — as a video
// track, or encoded for the host to pass on — and posts the viewer's pointer and key events.
// README.md has every message.
//
//   --connect <socket>    An app of its own: the host has the system open it
//                         (open -n -g -a LinkShell.app --args --connect <socket>), so the
//                         permissions are LinkShell's whatever terminal started the host. One
//                         JSON object a line each way (see `Service`); the socket closing ends it.
//   <screen>              One viewer's hands on that display: input events on stdin, answers on
//                         stdout. As a child of the host the permission is the terminal's.
//   --status              What this process is allowed to do, then exit.
//   --setup               The window in which the user gives LinkShell its permissions (see
//                         `Setup`), opened by the system like the first.
//   --dashboard           Native status UI (also the default when opened by the system).
//
//   --dry-run             Events are reported (`posted`), not posted.
//
// For measuring, with --connect:
//
//   --clock               Show the clock strip on a display while it is sent (measures latency).
//   --motion              Show a window of moving text on a display while it is sent (gives the
//                         encoder a busy screen's work).
//   --loopback            Answer each offer inside the app and report what was received.
//   --no-playout-delay    Don't ask the receiver for a zero playout delay (to measure its worth).
//   --encoder own|stock   The video track's H.264 encoder: this app's low-latency one, or
//                         libwebrtc's. Default: own, with automatic fallback to stock.
//   --no-flexfec          Don't advertise or send FlexFEC (for a comparison).
//   --loopback-no-flexfec Have the test receiver decline FlexFEC, like an unsupported viewer.
//   --loopback-network    Pass the test receiver's ICE candidates to tools/flexfec-check.mjs.
//   --no-low-latency      Encode as a Mac without the low-latency rate control does.
//   --trial <name>=<value>  A libwebrtc field trial, beside those of `Tuning` (to try one out).
//   --rtc-log             libwebrtc's own log, as `log` messages.

signal(SIGPIPE, SIG_IGN)

/// This helper is the same app as the dashboard. With the dashboard quit, opening LinkShell from
/// Finder, the Dock or Spotlight reaches this running instance instead of starting one, and
/// nothing would appear: start the dashboard as its own instance (a running one takes it over).
final class HelperReopen: NSObject, NSApplicationDelegate {
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.createsNewApplicationInstance = true
    configuration.arguments = ["--dashboard"]
    NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, error in
      if let error { FileHandle.standardError.write(Data("dashboard did not open: \(error.localizedDescription)\n".utf8)) }
    }
    return false
  }
}

if Launch.has("--status") {
  Link.standard.emit(Permissions.status())
  exit(0)
}
// Opened with nothing by the system (launchd is its parent), not started by a host as its child.
if Launch.has("--setup") {
  Setup.run()
}

if Launch.has("--dashboard") || Launch.has("--dashboard-preview") || (Launch.arguments.isEmpty && getppid() == 1) {
  MainActor.assumeIsolated { Desktop.run() }
}

if let path = Launch.value(after: "--connect") {
  guard let link = Link(path: path) else { exit(1) }
  Engine.playoutDelay = !Launch.has("--no-playout-delay")
  Engine.ownEncoder = Launch.value(after: "--encoder") != "stock"
  Engine.flexfec = !Launch.has("--no-flexfec")
  Engine.report = { link.log($0) }
  if Launch.has("--rtc-log") { Engine.forwardLog(to: link) }
  // With no window and no place in the Dock.
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let reopen = HelperReopen()
  app.delegate = reopen
  let service = Service(link: link, options: ScreenSession.Options(clock: Launch.has("--clock"), loopback: Launch.has("--loopback"), motion: Launch.has("--motion")))
  service.start()
  app.run()
} else {
  let link = Link.standard
  let control = Control(id: nil, link: link, screen: Launch.arguments.compactMap { Int($0) }.first ?? 0)
  control.ready()
  let watch = Watch(link: link) { [control] }
  link.read(each: { command in control.handle(command) }, end: {
    control.releaseAll()
    InputSource.restoreNow()
    watch.cancel()
    exit(0)
  })
  dispatchMain()
}
