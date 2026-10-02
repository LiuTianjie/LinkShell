import AppKit
import Darwin
import Foundation

/// `--setup`: the window in which the user gives LinkShell its two permissions, the first time
/// they are wanted. It says what each is for, takes the user to its switch in System Settings,
/// and ticks each off as the switch is turned on; with both on it says so and closes. Closing
/// it ends the process.
///
///   --quiet-if-done                    Nothing is shown when both are already on.
///   --pretend <state>                  Believes that state instead of asking the system, and
///   --pretend-after <seconds> <state>  that one later (see `Pretend`). Pretending, a button
///                                      asks the system nothing and opens no settings.
///   --pressed                          Pretending: the first missing row's button is pressed
///                                      as the window opens.
///   --snapshot <file.png>              Draws the window into that file and exits, showing
///   --appearance light|dark            nothing; as the system looks, or as said.
///
/// The system's requests (`Permissions.request`) are made here and nowhere else, and only when
/// a button is pressed.
final class Setup: NSObject, NSApplicationDelegate {
  /// How long the window says that all is set before it closes, in seconds.
  private static let farewell: TimeInterval = 2.5
  /// A second window is asked for: the one there is comes forward.
  private static let wanted = Notification.Name("com.bd.linkshell.host.setup.wanted")

  private let pretend: Pretend?
  private let face: SetupWindow
  private let opened = Date()
  private var granted: Granted
  private var pressed: Set<Permission> = []
  private var checking = false
  private var leaving = false
  private var timers: [Timer] = []

  /// Opens the window in a process of its own, as the host does: for a viewer who asked to be
  /// allowed to control this Mac (`prompt`). Nothing in a dry run, which shows nothing.
  static func open() {
    if Launch.dryRun { return }
    _ = launched(with: ["--setup", "--quiet-if-done"])
  }

  /// Has the system open this app anew with these arguments; the `open` that does it.
  private static func launched(with arguments: [String]) -> Process? {
    let open = Process()
    open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    open.arguments = ["-n", "-a", Bundle.main.bundlePath, "--args"] + arguments
    return (try? open.run()) == nil ? nil : open
  }

  static func run() -> Never {
    // Started as someone's child, what it shows and asks for would be that someone's permissions
    // (the terminal's), not LinkShell's. The system opens it instead: then launchd is its parent.
    // Once only (`--reopened`), wherever that should not hold.
    if getppid() != 1, !Launch.has("--reopened") {
      launched(with: Launch.arguments + ["--reopened"])?.waitUntilExit()
      exit(0)
    }
    let pretend: Pretend?
    do {
      pretend = try Pretend(arguments: Launch.arguments)
    } catch {
      FileHandle.standardError.write(Data("LinkShell --setup: \(error)\n".utf8))
      exit(2)
    }
    let granted = pretend?.granted(after: 0) ?? read()
    // Before anything of the app's is on the screen, or in front.
    if granted.all, Launch.has("--quiet-if-done") { exit(0) }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    if let file = Launch.value(after: "--snapshot") {
      let face = SetupWindow(text: .preferred())
      face.show(granted, pressed: pressedAtFirst(pretend, granted))
      let appearance = Launch.value(after: "--appearance").flatMap { NSAppearance(named: $0 == "dark" ? .darkAqua : .aqua) }
      guard let picture = face.picture(appearance: appearance), (try? picture.write(to: URL(fileURLWithPath: file))) != nil else { exit(1) }
      exit(0)
    }
    guard holdsTheOnlyWindow() else {
      DistributedNotificationCenter.default().postNotificationName(wanted, object: nil, userInfo: nil, deliverImmediately: true)
      exit(0)
    }
    let setup = Setup(pretend: pretend, granted: granted)
    app.delegate = setup
    // The app's hold on its delegate keeps nothing alive.
    withExtendedLifetime(setup) { app.run() }
    exit(0)
  }

  /// What the system allows now. Screen Recording is asked of a fresh copy of the app
  /// (`Permissions.recording`): takes a moment, so not on the main queue once the window is up.
  private static func read() -> Granted {
    Granted(recording: Permissions.recording(), control: Permissions.trusted())
  }

  /// `--pressed`, which only a pretended window heeds: a real press asks the system.
  private static func pressedAtFirst(_ pretend: Pretend?, _ granted: Granted) -> Set<Permission> {
    guard pretend != nil, Launch.has("--pressed"), let next = granted.next else { return [] }
    return [next]
  }

  /// One setup window at a time, whichever copy of the app shows it: the process that has the
  /// lock on this file has the window. The lock goes with the process, however it ends.
  private static func holdsTheOnlyWindow() -> Bool {
    let descriptor = Darwin.open(NSTemporaryDirectory() + "com.bd.linkshell.host.setup.lock", O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
    // No lock to be had: better two windows than none.
    return descriptor < 0 || flock(descriptor, LOCK_EX | LOCK_NB) == 0
  }

  private init(pretend: Pretend?, granted: Granted) {
    self.pretend = pretend
    self.granted = granted
    face = SetupWindow(text: .preferred())
    super.init()
    face.onOpen = { [unowned self] permission in openSettings(for: permission) }
  }

  // MARK: NSApplicationDelegate

  func applicationDidFinishLaunching(_ notification: Notification) {
    // An app with no place in the Dock has no menus to be seen, but their keys work.
    let menu = NSMenu()
    let keys = NSMenu()
    keys.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    keys.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    let item = NSMenuItem()
    item.submenu = keys
    menu.addItem(item)
    NSApp.mainMenu = menu

    face.show(granted, pressed: pressed)
    face.window.center()
    face.comeForward()
    DistributedNotificationCenter.default().addObserver(self, selector: #selector(comeForward), name: Setup.wanted, object: nil, suspensionBehavior: .deliverImmediately)
    if granted.all { return farewell() }
    every(1) { [unowned self] _ in check() }
    for permission in Setup.pressedAtFirst(pretend, granted) { openSettings(for: permission) }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  @objc private func comeForward() {
    face.comeForward()
  }

  // MARK: What it does

  private func every(_ seconds: TimeInterval, _ work: @escaping (Timer) -> Void) {
    let timer = Timer(timeInterval: seconds, repeats: true, block: work)
    // In the common modes: the rows tick while the window is being dragged, too.
    RunLoop.main.add(timer, forMode: .common)
    timers.append(timer)
  }

  /// Once a second: the switches may have been turned on (or off) in System Settings.
  private func check() {
    if let pretend { return take(pretend.granted(after: Date().timeIntervalSince(opened))) }
    guard !checking else { return }
    checking = true
    DispatchQueue.global(qos: .userInitiated).async {
      let now = Setup.read()
      DispatchQueue.main.async { [self] in
        checking = false
        take(now)
      }
    }
  }

  private func take(_ now: Granted) {
    guard now != granted, !leaving else { return }
    let gained = now.gained(since: granted)
    granted = now
    face.show(granted, pressed: pressed)
    // The user is in System Settings: this window comes back, with its tick and what is next.
    // After the Screen Recording switch System Settings asks whether to quit LinkShell, and
    // keeps the keyboard for the answer: the window is then only put where it can be seen.
    if gained.contains(.recording) {
      face.window.orderFrontRegardless()
    } else if !gained.isEmpty {
      face.comeForward()
    }
    if granted.all { farewell() }
  }

  /// Both are on: it says so for a moment, then closes.
  private func farewell() {
    leaving = true
    timers.forEach { $0.invalidate() }
    Timer.scheduledTimer(withTimeInterval: Setup.farewell, repeats: false) { [face] _ in face.window.close() }
  }

  /// A row's button. The first press for a permission has the system make its own request,
  /// which is what puts LinkShell in the list; every press opens System Settings at the list.
  private func openSettings(for permission: Permission) {
    let first = pressed.insert(permission).inserted
    if pretend == nil {
      if first { Permissions.request(permission) }
      NSWorkspace.shared.open(Permissions.settings(permission))
    }
    face.show(granted, pressed: pressed)
    stepAside()
  }

  /// Out of System Settings' way. Its window takes a moment to come up: looked for four times a
  /// second, and after three seconds the edge of the screen it is.
  private func stepAside() {
    var looks = 0
    every(0.25) { [unowned self] timer in
      looks += 1
      let other = Setup.settingsWindow()
      guard other != nil || looks >= 12 else { return }
      timer.invalidate()
      face.move(beside: other)
    }
  }

  /// Where System Settings' window is, in AppKit's coordinates; nil while it has none on the
  /// screen. Where windows are and whose they are is anyone's to know: no permission is needed,
  /// and none is asked for.
  private static func settingsWindow() -> CGRect? {
    let settings = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").map { Int($0.processIdentifier) })
    guard !settings.isEmpty,
          let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          let top = NSScreen.screens.first?.frame.maxY
    else { return nil }
    let frames = windows.compactMap { window -> CGRect? in
      guard window[kCGWindowLayer as String] as? Int == 0,
            let owner = window[kCGWindowOwnerPID as String] as? Int, settings.contains(owner),
            let bounds = window[kCGWindowBounds as String] as? NSDictionary
      else { return nil }
      return CGRect(dictionaryRepresentation: bounds)
    }
    guard let frame = frames.max(by: { $0.width * $0.height < $1.width * $1.height }) else { return nil }
    // The window list counts down from the top of the main display.
    return CGRect(x: frame.minX, y: top - frame.maxY, width: frame.width, height: frame.height)
  }
}
