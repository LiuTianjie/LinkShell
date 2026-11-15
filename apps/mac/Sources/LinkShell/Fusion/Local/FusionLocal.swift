import AppKit
import CoreVideo
import CryptoKit
import Darwin
import Foundation
import IOSurface
import ImageIO
import LinkShellScreen
import Network
import UniformTypeIdentifiers
import WebRTC

/// Headless Fusion Hub on the local Mac: `LinkShell --fusion-local --host H --port P --token T`.
///
/// 1. Maintains the control + multi-stream WebRTC connection to the remote Mac (`FusionRemote`),
/// 2. Materializes real per-app Stub `.app` bundles under `~/Applications/LinkShell/<Host>/` with
///    macOS-26-compliant full-size squircle `.icns` icons (indexed by Spotlight & Applications),
/// 3. Serves a local Unix socket (`~/.linkshell/fusion-<slug>.sock`) for both per-app Stub Mach
///    `IOSurface` routing and LinkShell Desktop's embedded Fusion tab (`status`, `launchApp`, `quitApp`).
final class FusionLocal: NSObject, NSApplicationDelegate {
  static let currentIconSchema = 3

  static func run() -> Never {
    FusionMetadata.enabled = true
    let host = Launch.value(after: "--host") ?? ""
    let port = Launch.value(after: "--port").flatMap(UInt16.init) ?? FusionWire.port
    // From the environment, never argv: any local user can read another process's arguments.
    let token = ProcessInfo.processInfo.environment["LINKSHELL_FUSION_TOKEN"] ?? ""
    unsetenv("LINKSHELL_FUSION_TOKEN")
    let computerKey = Launch.value(after: "--computer-key") ?? ""
    let launchArg = Launch.value(after: "--launch") ?? ""
    let local = FusionLocal(host: host, port: port, token: token, computerKey: computerKey, initialLaunch: launchArg)
    if local.tryActivateExistingInstance() {
      exit(0)
    }
    _ = Engine.factory
    let app = NSApplication.shared
    // Keep `.accessory` with zero own windows so FusionLocal runs purely as a headless media hub;
    // the Launchpad UI lives inside LinkShell Desktop's left-sidebar "融合模式" tab.
    app.setActivationPolicy(.accessory)
    app.delegate = local
    local.preloadCachedIcons()
    local.upgradeExistingStubs()
    local.startSocketServer()
    local.connect()
    app.run()
    exit(0)
  }

  struct AppEntry {
    let name: String
    let bundle: String
    let rawCategory: String
    let category: String
    let isSystem: Bool
  }

  struct WindowRecord {
    let id: CGWindowID
    var bundle: String
    var title: String
    var toolbar: Bool
    var cornerRadius: Double
    var frame: CGRect
    var buttons: [String: [Double]]
    var hitrects: [[Double]]
    var ackSeq: Int
    /// Its stream key on the shared media connection (`wopen.stream`).
    var stream: String
  }

  struct PopupRecord {
    let id: CGWindowID
    var bundle: String
    var parentID: CGWindowID
    var frame: CGRect
    var pdx: Double?
    var pdy: Double?
    var layer: Int = 101
  }

  var host: String
  var port: UInt16
  let hostLabel: String
  let hostSlug: String
  var token: String
  var computerKey: String
  var pendingLaunchBundles: [String]
  let socketPath: String
  /// Why the last hub exited (and its alerts), for LinkShell Desktop once this process is gone.
  let statusPath: String
  let appsDir: URL
  let iconCacheDir: URL
  var listenFD: Int32 = -1
  var wire: FusionWire?
  var pingTimer: Timer?
  var displays: [Int: (local: CGRect, scale: Int)] = [:]
  var outputs: [String: FusionOutput] = [:]
  var media: FusionMediaReceiver?
  /// The remote's answer to `hello`; nothing else counts before it (docs/v2/fusion.md §4.2).
  var welcomed = false
  /// `welcome.session`: offered as `resume` when this hub reconnects after a drop.
  var sessionID: String?
  var remoteFeatures: Set<String> = []
  /// The connection dropped without a `bye`: windows stay, waiting for a new token to resume with.
  var suspended = false
  var suspendTimer: Timer?
  /// What the remote (or a protocol mismatch) said, shown instead of a generic reason.
  var exitMessage: String?
  var mediaRestarts: [Double] = []
  /// How the hub leaves once its session is over; tests stay alive.
  var terminate: () -> Void = { NSApp.terminate(nil) }
  var windows: [CGWindowID: WindowRecord] = [:]
  var lastWindowSEI: [CGWindowID: [Double]] = [:]
  var popups: [CGWindowID: PopupRecord] = [:]
  var shownPopupsByDisplay: [String: Set<CGWindowID>] = [:]
  var pendingStubs: [Int32: StubClient] = [:]
  var stubs: [String: StubClient] = [:]
  var launchingStubs: Set<String> = []
  var stubHadRealIconOnLaunch: Set<String> = []
  var launchSentAt: [String: Double] = [:]
  var quittingBundles: [String: Double] = [:]
  var dockMenus: [String: [[String: Any]]] = [:]
  var stubURLs: [String: URL] = [:]
  var existingStubBundles: Set<String> = []
  var icons: [String: NSImage] = [:]
  var iconHashes: [String: String] = [:]
  var realIconBundles: Set<String> = []
  var iconPNGs: [String: String] = [:]
  var iconRequested: Set<String> = []
  var apps: [AppEntry] = []
  var selectedCategory = "全部"
  var searchQuery = ""
  var frontWindowID: CGWindowID?
  var rtt = 0.0
  var connected = false
  var stopping = false
  /// Structured problems LinkShell Desktop shows with a remedy each, keyed by kind (+ subject).
  var alerts: [String: [String: Any]] = [:]
  var stubRelaunches: [String: [Double]] = [:]
  var displayObservers: [NSObjectProtocol] = []
  var lastDisplaysSignature = ""
  var displaysTimer: Timer?

  // Lock-protected mirrors for off-main-thread 120fps frame & input routing
  let frameQueue = DispatchQueue(label: "com.bd.linkshell.fusion.frames", qos: .userInteractive)
  let fastLock = NSLock()
  var fastOutputs: [String: FusionOutput] = [:]
  var fastWindows: [CGWindowID: (bundle: String, frame: CGRect)] = [:]
  var fastStubs: [String: StubClient] = [:]
  var fastDisplays: [Int: (local: CGRect, scale: Int)] = [:]
  var fastQuitting: [String: Double] = [:]
  var fastWindowSEI: [CGWindowID: [Double]] = [:]

  // State & disk caches for LinkShell Desktop's embedded Fusion tab
  let uiIconCacheDir: URL
  var lastStatusText = "正在初始化融合会话…"
  let stubQueue = DispatchQueue(label: "com.bd.linkshell.fusion.stubgen", qos: .utility)

  init(
    host: String,
    port: UInt16,
    token: String,
    computerKey: String,
    initialLaunch: String,
    homeDirectory: String? = nil,
    linkshellHome: String? = nil,
    hostName: String? = nil
  ) {
    self.host = host
    self.port = port
    self.token = token
    self.computerKey = computerKey
    self.pendingLaunchBundles = initialLaunch.split(separator: ",").map(String.init).filter { !$0.isEmpty }
    let rawLabel = (hostName ?? Launch.value(after: "--name") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let label = rawLabel.isEmpty ? "Remote" : rawLabel.replacingOccurrences(of: "/", with: "-")
    self.hostLabel = label
    // Keyed by the computer, not its name: two computers may share a name, and a rename must not
    // orphan the socket, the icon cache or the stub bundle ids.
    self.hostSlug = Fusion.slug(computerKey: computerKey.isEmpty ? label : computerKey)
    let resolvedHome = homeDirectory ?? NSHomeDirectory()
    let envLinkshellHome = ProcessInfo.processInfo.environment["LINKSHELL_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    let lsDir: String
    if let explicit = linkshellHome, !explicit.isEmpty {
      lsDir = explicit
    } else if homeDirectory == nil, let envHome = envLinkshellHome, !envHome.isEmpty {
      lsDir = envHome
    } else {
      lsDir = resolvedHome + "/.linkshell"
    }
    try? FileManager.default.createDirectory(atPath: lsDir, withIntermediateDirectories: true)
    self.statusPath = lsDir + "/fusion-\(self.hostSlug).status.json"
    if homeDirectory == nil { Fusion.logPath = lsDir + "/fusion-local.log" }
    self.socketPath = lsDir + "/fusion-\(self.hostSlug).sock"
    if homeDirectory == nil,
       let envAppsRoot = ProcessInfo.processInfo.environment["LINKSHELL_FUSION_APPS_DIR"],
       !envAppsRoot.isEmpty {
      self.appsDir = URL(fileURLWithPath: envAppsRoot).appendingPathComponent(label, isDirectory: true)
    } else {
      self.appsDir = URL(fileURLWithPath: resolvedHome)
        .appendingPathComponent("Applications/LinkShell/\(label)", isDirectory: true)
    }
    self.iconCacheDir = URL(fileURLWithPath: lsDir)
      .appendingPathComponent("fusion-icons/\(self.hostSlug)", isDirectory: true)
    self.uiIconCacheDir = self.iconCacheDir.appendingPathComponent("ui", isDirectory: true)
    try? FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(at: iconCacheDir, withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(at: uiIconCacheDir, withIntermediateDirectories: true)
    super.init()
  }

  /// If a FusionLocal hub for this computer is already running, forward the activation/launch
  /// request over its Unix domain socket and exit cleanly so active fused windows stay untouched.
  func tryActivateExistingInstance() -> Bool {
    let sock = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard sock >= 0 else { return false }
    defer { Darwin.close(sock) }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(socketPath.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { return false }
    withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
      ptr.withMemoryRebound(to: CChar.self, capacity: bytes.count) { dst in
        for i in 0..<bytes.count { dst[i] = bytes[i] }
      }
    }
    let rc = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(sock, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard rc == 0 else { return false }
    let msg: [String: Any] = [
      "t": "activate",
      "host": host,
      "port": Int(port),
      "token": token,
      "computerKey": computerKey,
      "launch": pendingLaunchBundles.joined(separator: ","),
    ]
    if var data = DesktopMediaIPC.data(msg) {
      data.append(10)
      data.withUnsafeBytes { raw in
        if let base = raw.baseAddress { _ = Darwin.write(sock, base, raw.count) }
      }
    }
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    pingTimer?.invalidate()
    pingTimer = nil
    for stub in stubs.values {
      stub.closedByHub = true
      stub.close()
    }
    if listenFD >= 0 { Darwin.close(listenFD); listenFD = -1 }
    unlink(socketPath)
    return .terminateNow
  }

  func handleActivate(client: StubClient, message m: [String: Any]) {
    pendingStubs.removeValue(forKey: client.fd)
    client.close()
    let extraLaunch = (m["launch"] as? String ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty }
    if let ck = m["computerKey"] as? String, !ck.isEmpty {
      computerKey = ck
    }
    if !connected {
      if let newHost = m["host"] as? String, !newHost.isEmpty { host = newHost }
      if let newPort = DesktopScreenBridge.integer(m["port"]), newPort > 0, newPort <= 65535 { port = UInt16(newPort) }
      if let newToken = m["token"] as? String, !newToken.isEmpty { token = newToken }
      pendingLaunchBundles.append(contentsOf: extraLaunch)
      connect()
    } else if !extraLaunch.isEmpty {
      for b in extraLaunch { launchApp(bundle: b) }
    }
  }

  func handleHubControl(client: StubClient, message m: [String: Any]) {
    pendingStubs.removeValue(forKey: client.fd)
    let type = m["t"] as? String ?? ""
    switch type {
    case "status":
      var winCounts: [String: Int] = [:]
      for w in windows.values where !w.bundle.isEmpty {
        winCounts[w.bundle, default: 0] += 1
      }
      var activeSet = Set(stubs.keys)
      for b in winCounts.keys { activeSet.insert(b) }
      activeSet.subtract(quittingBundles.keys)
      let appItems: [[String: Any]] = apps.map { entry in
        let stubPath = stubURLs[entry.bundle]?.path ?? ""
        return [
          "name": entry.name,
          "bundle": entry.bundle,
          "category": entry.category,
          "rawCategory": entry.rawCategory,
          "isSystem": entry.isSystem,
          "stubPath": stubPath,
        ]
      }
      client.send([
        "t": "status",
        "connected": connected,
        "reconnecting": suspended,
        "rttMs": Int(rtt.rounded()),
        "hostLabel": hostLabel,
        "hostSlug": hostSlug,
        "computerKey": computerKey,
        "appsDir": appsDir.path,
        "statusText": lastStatusText,
        "activeBundles": Array(activeSet).sorted(),
        "windowCounts": winCounts,
        "iconBundles": Array(realIconBundles).sorted(),
        "apps": appItems,
        "alerts": alertList,
      ])
      client.close()
    case "launchApp":
      if let bundle = m["bundle"] as? String, !bundle.isEmpty {
        if connected {
          launchApp(bundle: bundle)
        } else if !pendingLaunchBundles.contains(bundle) {
          pendingLaunchBundles.append(bundle)
        }
      }
      client.send(["t": "ok"])
      client.close()
    case "quitApp":
      if let bundle = m["bundle"] as? String, !bundle.isEmpty {
        // The stub stays until the remote app has really exited (`app.exited`): a "save changes?"
        // sheet must remain visible and answerable.
        quitLocalBundle(bundle, force: m["force"] as? Bool == true)
      }
      client.send(["t": "ok"])
      client.close()
    case "stopHub":
      client.send(["t": "ok"])
      client.close()
      sayBye()
      stopping = true
      writeExitStatus(reason: "stopped")
      // The `bye` must leave before the process does, or the remote waits out its grace period.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.terminate() }
    default:
      client.close()
    }
  }

  // Stored state used by the extensions in other files.
  var activeStubs: Set<String> = []
  var appActiveTimer: Timer?
  var remoteAppActive = false
  var clipboard = FusionClipboardGuard()
  var clipboardTimer: Timer?
}

extension FusionLocal {
  // MARK: Focus across stubs (C9) and the clipboard (C3)


  /// Debounced: going from one stub to another passes through "none active" for a moment, and the
  /// remote apps must not flicker inactive for it.
  func setStubActive(_ bundle: String, _ on: Bool) {
    guard !bundle.isEmpty else { return }
    if on { activeStubs.insert(bundle) } else { activeStubs.remove(bundle) }
    appActiveTimer?.invalidate()
    if !activeStubs.isEmpty {
      remoteAppActive = true
      clipboardTick()
      return
    }
    appActiveTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: false) { [weak self] _ in
      guard let self, self.activeStubs.isEmpty, self.remoteAppActive else { return }
      self.remoteAppActive = false
      self.wire?.send(["t": "app.active", "on": false])
    }
  }

  /// The first focus of a fused window arms the clipboard; what was copied before is not sent.
  func clipboardFocused() {
    // Whatever is on this Mac's clipboard when a fused window gets the focus is what the person
    // expects ⌘V to paste there, so the first tick after arming sends it.
    clipboard.armed = true
    clipboardTick()
    if clipboardTimer == nil {
      clipboardTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.clipboardTick() }
    }
  }

  /// Local → remote, only while a fused app is active here.
  func clipboardTick() {
    guard connected, !activeStubs.isEmpty, clipboard.armed else { return }
    let pasteboard = NSPasteboard.general
    let types = (pasteboard.types ?? []).map(\.rawValue)
    let count = pasteboard.changeCount
    // Cheap check first: the contents (up to 8 MB) are read only when something changed.
    guard clipboard.isUnseen(changeCount: count) else { return }
    let item = FusionClipboardItem.read(pasteboard)
    guard clipboard.shouldSend(changeCount: count, types: types, bytes: item.bytes) else { return }
    wire?.send(item.message)
  }

  /// Remote → local: the remote only sends while one of the fused apps is frontmost there.
  func receiveRemoteClipboard(_ m: [String: Any]) {
    guard clipboard.armed, let item = FusionClipboardItem(message: m) else { return }
    let count = item.write(to: NSPasteboard.general)
    clipboard.didWrite(changeCount: count)
  }

  // MARK: Remote Connection

  func connect() {
    wire?.onClose = nil
    wire?.close()
    iconRequested.removeAll()
    let endpointPort = NWEndpoint.Port(rawValue: port) ?? NWEndpoint.Port(rawValue: FusionWire.port)!
    let connection = NWConnection(host: NWEndpoint.Host(host), port: endpointPort, using: FusionWire.parameters(token: token))
    let wire = FusionWire(connection)
    self.wire = wire
    wire.onReady = { [weak self] in
      // The remote answers every 1.5 s ping: 5 s of silence is a dead link, not frozen windows.
      wire.startWatchdog(timeout: 5)
      DispatchQueue.main.async { self?.hello() }
    }
    wire.onMessage = { [weak self] in self?.receive($0) }
    wire.onClose = { [weak self] reason in self?.closed(reason: reason) }
    wire.start()
    updateStatus("正在连接 \(hostLabel) (\(host):\(port))…")
  }

  static func localDisplays() -> [[String: Any]] {
    let primary = NSScreen.screens.first?.frame.height ?? 0
    return NSScreen.screens.compactMap { screen in
      guard let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value else { return nil }
      let v = screen.visibleFrame
      let visible = CGRect(x: v.minX, y: primary - v.maxY, width: v.width, height: v.height)
      // Built-in panels can report 0 Hz; the screen's own maximum is the truth for ProMotion.
      let modeHz = CGDisplayCopyDisplayMode(id)?.refreshRate ?? 0
      let hz = max(modeHz, Double(screen.maximumFramesPerSecond), 60)
      return ["frame": Fusion.dict(CGDisplayBounds(id)), "visible": Fusion.dict(visible), "scale": Double(screen.backingScaleFactor), "hz": hz]
    }
  }

  static func displaysSignature(_ displays: [[String: Any]]) -> String { FusionProtocol.displaysSignature(displays) }

  /// Plugging a display, changing a scale or waking re-describes the local screens; the remote
  /// rebuilds its virtual displays to match, otherwise windows clamp onto stale ones.
  func observeDisplays() {
    guard displayObservers.isEmpty else { return }
    let schedule: (Notification) -> Void = { [weak self] _ in self?.scheduleDisplaysUpdate() }
    displayObservers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main, using: schedule))
    displayObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main, using: schedule))
    displayObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main, using: schedule))
  }

  func scheduleDisplaysUpdate() {
    displaysTimer?.invalidate()
    displaysTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: false) { [weak self] _ in
      guard let self, self.connected else { return }
      let displays = Self.localDisplays()
      let signature = Self.displaysSignature(displays)
      guard signature != self.lastDisplaysSignature else { return }
      self.lastDisplaysSignature = signature
      Fusion.log("local displays changed: \(signature)")
      self.wire?.send(["t": "displays", "displays": displays])
    }
  }

  func hello() {
    let screens = Self.localDisplays()
    lastDisplaysSignature = Self.displaysSignature(screens)
    observeDisplays()
    welcomed = false
    var hello: [String: Any] = [
      "t": "hello", "proto": FusionProtocol.version, "token": token, "platform": "macos",
      "features": FusionProtocol.localFeatures, "displays": screens,
      "name": Host.current().localizedName ?? "",
    ]
    if suspended, let sessionID { hello["resume"] = sessionID }
    wire?.send(hello)
    pingTimer?.invalidate()
    pingTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      self?.wire?.send(["t": "ping", "ts": CACurrentMediaTime()])
    }
  }

  func welcome(_ m: [String: Any]) {
    guard (m["proto"] as? NSNumber)?.intValue == FusionProtocol.version else {
      return outdated("远端 LinkShell 版本与本机不一致，请把两台电脑都升级到最新版本后再开启融合模式")
    }
    welcomed = true
    let resumed = m["resumed"] as? Bool == true && suspended
    sessionID = m["session"] as? String
    remoteFeatures = Set((m["features"] as? [String]) ?? [])
    suspendTimer?.invalidate()
    suspendTimer = nil
    suspended = false
    if !resumed {
      // A new session on the remote: windows from before it are gone there too.
      dropWindows()
    }
    clearAlert("reconnecting")
    startMedia()
    Fusion.log("welcome: session \(sessionID ?? "?")\(resumed ? " (resumed)" : ""), features \(remoteFeatures.sorted())")
  }

  /// A new peer connection for the pictures, with every stream already announced added to it.
  func startMedia() {
    media?.stop()
    let media = FusionMediaReceiver(physicalKeys: remoteFeatures.contains("keys"), onSignal: { [weak self] payload in
      self?.wire?.send(["t": "rtc", "m": payload])
    }, onStatus: { [weak self] status in
      guard let self else { return }
      if let error = status["controlError"] as? String, !error.isEmpty { self.setAlert("accessibility", message: error) }
      if status["live"] as? Bool == true { self.clearAlert("webrtc") }
      self.refreshStatus()
    }, onFailure: { [weak self] message in
      self?.mediaFailed(message)
    })
    self.media = media
    for output in outputs.values {
      output.receivedPicture = false
      media.add(output)
    }
  }

  /// The pictures' connection failed while the control connection lives (video goes its own way,
  /// direct or through TURN): ask the remote for a fresh one, a few times a minute at most.
  func mediaFailed(_ message: String) {
    updateStatus("融合视频：\(message)")
    let now = CACurrentMediaTime()
    mediaRestarts = mediaRestarts.filter { now - $0 < 60 } + [now]
    guard connected, welcomed, mediaRestarts.count <= 3 else {
      setAlert("webrtc", message: message)
      return
    }
    Fusion.log("media failed (\(message)): restarting it")
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
      guard let self, self.connected, self.welcomed else { return }
      self.startMedia()
      self.wire?.send(["t": "rtc", "m": ["t": "restart"]])
    }
  }

  /// The remote is older (or newer) than this hub: say so and stop, there is nothing to retry.
  func outdated(_ message: String) {
    Fusion.log("protocol mismatch: \(message)")
    exitMessage = message
    stopping = true
    wire?.onClose = nil
    wire?.close(reason: "proto")
    closed(reason: "proto")
  }

  func receive(_ m: [String: Any]) {
    let type = m["t"] as? String
    if type == "welcome" { return welcome(m) }
    if type == "bye" { return bye(m) }
    // A v1 remote answers `hello` with `apps`: it cannot speak to this hub.
    guard welcomed else {
      if type == "apps" || type == "ready" { outdated("远端 LinkShell 版本较旧，请先升级远端电脑的 LinkShell 后再开启融合模式") }
      return
    }
    switch type {
    case "apps": applyCatalog(m)
    case "ready": ready(m)
    case "rtc": if let payload = m["m"] as? [String: Any] { media?.receive(payload) }
    case "wopen": remoteWindowOpened(m)
    case "wclose": remoteWindowClosed(m)
    case "wstyle": remoteWindowStyle(m)
    case "fullscreen":
      let id = CGWindowID(Fusion.number(m["id"]))
      if let bundle = windows[id]?.bundle {
        stubs[bundle]?.send(["t": "fullscreen", "id": Int(id), "on": m["on"] as? Bool ?? true])
      }
    case "minimize":
      let id = CGWindowID(Fusion.number(m["id"]))
      if let bundle = windows[id]?.bundle {
        stubs[bundle]?.send(["t": "minimize", "id": Int(id)])
      }
    case "app.hidden":
      if let bundle = m["app"] as? String {
        stubs[bundle]?.send(["t": "hidden", "on": m["on"] as? Bool == true])
      }
    case "clip":
      receiveRemoteClipboard(m)
    case "menu":
      if let bundle = m["app"] as? String {
        var forward = m
        forward.removeValue(forKey: "app")
        stubs[bundle]?.send(forward)
      }
    case "layout": remoteLayout(m["windows"] as? [[String: Any]] ?? [])
    case "icon": remoteIcon(m)
    case "dockmenu":
      if let bundle = m["app"] as? String, let items = m["items"] as? [[String: Any]] {
        dockMenus[bundle] = items
        stubs[bundle]?.send(["t": "dockmenu", "items": items])
      }
    case "app.exited":
      if let bundle = m["app"] as? String {
        quittingBundles.removeValue(forKey: bundle)
        purgeLocalState(forBundle: bundle)
        if let stub = stubs[bundle] {
          stub.closedByHub = true
          stub.send(["t": "app.exited"])
        }
        reloadGrid()
        refreshStatus()
      }
    case "pong":
      rtt = (CACurrentMediaTime() - Fusion.number(m["ts"])) * 1000
      refreshStatus()
    case "alert":
      let kind = m["kind"] as? String ?? "remote"
      let subject = m["subject"] as? String ?? ""
      if m["clear"] as? Bool == true {
        clearAlert(kind, subject: subject)
      } else {
        setAlert(kind, subject: subject, message: m["message"] as? String ?? "")
      }
    default:
      break
    }
  }

  /// The remote ended the session (stopped there, another computer took over, a protocol mismatch):
  /// its message is what the person sees, and there is nothing to resume.
  func bye(_ m: [String: Any]) {
    let reason = m["reason"] as? String ?? "stopped"
    Fusion.log("remote said bye: \(reason)")
    exitMessage = m["message"] as? String
    stopping = reason == "user" || reason == "stopped"
    // Said on purpose: there is no session left to resume.
    sessionID = nil
    suspended = false
    wire?.onClose = nil
    wire?.close(reason: "bye")
    closed(reason: reason == "proto" ? "proto" : (stopping ? "stopped" : reason))
  }

  /// Ends the session from here: the remote puts its windows back at once instead of waiting.
  func sayBye() {
    wire?.send(["t": "bye", "reason": "user"])
  }

  /// A stream the remote announced: its frames arrive on the shared media connection.
  func receiver(_ key: String, picture: @escaping (CVPixelBuffer, Data?) -> Void) {
    let output = FusionOutput(key: key, owner: self, picture: picture)
    outputs[key] = output
    syncFastState()
    media?.add(output)
  }

  static func parseApps(_ raw: Any?) -> [AppEntry] {
    ((raw as? [[String: Any]]) ?? []).compactMap { item in
      guard let bundle = item["app"] as? String, !bundle.isEmpty else { return nil }
      let rawCat = item["category"] as? String ?? ""
      return AppEntry(
        name: item["name"] as? String ?? "",
        bundle: bundle,
        rawCategory: rawCat,
        category: Self.mapCategory(rawCat),
        isSystem: item["system"] as? Bool == true
      )
    }
  }

  func ensureIcons() {
    // Request icons progressively: prioritize existing Stub `.app` bundles + common apps first.
    // Apps with a stub on disk first: their Dock and Spotlight icons are the ones people see.
    var priority: [String] = []
    for b in existingStubBundles.sorted() where !priority.contains(b) {
      priority.append(b)
    }
    let ordered = priority + apps.map(\.bundle).filter { !priority.contains($0) }
    for (idx, bundle) in ordered.enumerated() {
      DispatchQueue.main.asyncAfter(deadline: .now() + Double(idx) * 0.02) { [weak self] in
        self?.requestIconIfNeeded(bundle)
      }
    }
  }

  /// Stub bundles whose app left the remote are removed, so Spotlight and Launchpad stop offering
  /// apps that can no longer open. Only our own bundles (marked `LSFusionBundleID`) in this
  /// computer's folder are touched, and never one whose stub is running.
  func pruneStubs(keeping catalog: [AppEntry]) {
    guard !catalog.isEmpty else { return }
    let keep = Set(catalog.map(\.bundle)).union(stubs.keys).union(launchingStubs).union(windows.values.map(\.bundle))
    let dir = appsDir
    stubQueue.async { [weak self] in
      let removed = Self.staleStubBundles(in: dir, keeping: keep)
      for url in removed {
        Self.unregisterFromLaunchServices(url)
        try? FileManager.default.removeItem(at: url)
        Fusion.log("removed stale stub \(url.lastPathComponent)")
      }
      guard !removed.isEmpty else { return }
      DispatchQueue.main.async {
        guard let self else { return }
        for (bundle, url) in self.stubURLs where removed.contains(url) {
          self.stubURLs.removeValue(forKey: bundle)
          self.existingStubBundles.remove(bundle)
        }
      }
    }
  }

  static func staleStubBundles(in dir: URL, keeping keep: Set<String>) -> [URL] {
    let items = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
    return items.filter { url in
      guard url.pathExtension == "app",
            let info = NSDictionary(contentsOf: url.appendingPathComponent("Contents/Info.plist")) as? [String: Any],
            let bundle = info["LSFusionBundleID"] as? String, !bundle.isEmpty else { return false }
      return !keep.contains(bundle)
    }
  }

  static func unregisterFromLaunchServices(_ appURL: URL) {
    let lsreg = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    guard FileManager.default.isExecutableFile(atPath: lsreg) else { return }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: lsreg)
    proc.arguments = ["-u", appURL.path]
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    try? proc.run()
    proc.waitUntilExit()
  }

  func applyCatalog(_ m: [String: Any]) {
    let parsed = Self.parseApps(m["apps"])
    guard !parsed.isEmpty || m["apps"] != nil else { return }
    if !parsed.isEmpty || apps.isEmpty {
      apps = parsed
    }
    pruneStubs(keeping: parsed)
    reloadGrid()
    saveCatalogToDisk()
    if connected {
      refreshStatus()
    } else if !apps.isEmpty {
      updateStatus("已同步 \(apps.count) 个远端应用，正在准备融合显示环境…")
    }
    ensureIcons()
  }

  func ready(_ m: [String: Any]) {
    connected = true
    let list = m["displays"] as? [[String: Any]] ?? []
    let screens = Self.localDisplays()
    let indices = Set(list.map { Int(Fusion.number($0["index"])) })
    for index in displays.keys where !indices.contains(index) {
      displays.removeValue(forKey: index)
      media?.remove("d\(index)")
      outputs.removeValue(forKey: "d\(index)")
    }
    for d in list {
      let index = Int(Fusion.number(d["index"]))
      // The remote's virtual display is 1x or 2x whatever this screen's scale (Windows' 1.5 included).
      let scale = index < screens.count ? FusionProtocol.backingScale(Fusion.number(screens[index]["scale"])) : 2
      displays[index] = (Fusion.rect(d["frame"]), scale)
      media?.remove("d\(index)")
      receiver("d\(index)") { [weak self] buffer, layout in self?.handleDisplayPicture(index, buffer, layout) }
    }
    syncFastState()
    reloadGrid()
    saveCatalogToDisk()
    refreshStatus()
    ensureIcons()

    let toLaunch = pendingLaunchBundles
    pendingLaunchBundles.removeAll()
    for bundle in toLaunch where !bundle.isEmpty {
      launchApp(bundle: bundle)
    }
  }

  /// Windows of a session that is gone: their stubs close them.
  func dropWindows() {
    let ids = Array(windows.keys)
    for (id, record) in windows {
      stubs[record.bundle]?.send(["t": "wclose", "id": Int(id)])
    }
    windows.removeAll()
    lastWindowSEI.removeAll()
    popups.removeAll()
    shownPopupsByDisplay.removeAll()
    outputs.removeAll()
    syncFastState(removedWindowIDs: ids)
  }

  func closed(reason: String = "closed") {
    connected = false
    pingTimer?.invalidate()
    pingTimer = nil
    media?.stop()
    media = nil
    // A drop after a session was running is likely a blip: the windows stay, and the desktop
    // brings a new token (`activate`) to resume with (docs/v2/fusion.md §4.3).
    // A failed attempt to resume (unreachable, refused) keeps waiting too: the desktop tries again.
    if !stopping, welcomed || suspended, sessionID != nil, reason != "proto", reason != "token" {
      welcomed = false
      outputs.values.forEach { $0.receivedPicture = false; $0.controlEnabled = false }
      updateStatus("与 \(hostLabel) 的连接中断，正在重新连接…")
      setAlert("reconnecting", message: "与 \(hostLabel) 的连接中断，正在重新连接…")
      // Armed once, at the first drop: the remote's grace counts from then, not from each retry.
      if !suspended {
        suspended = true
        suspendTimer?.invalidate()
        suspendTimer = Timer.scheduledTimer(withTimeInterval: FusionProtocol.resumeGrace + 5, repeats: false) { [weak self] _ in
          guard let self, self.suspended else { return }
          self.suspended = false
          self.sessionID = nil
          self.closed(reason: reason)
        }
      }
      Fusion.log("connection lost (\(reason)): keeping windows for a resume")
      return
    }
    writeExitStatus(reason: reason == "proto" ? "proto" : (stopping ? "stopped" : reason))
    outputs.removeAll()
    windows.removeAll()
    lastWindowSEI.removeAll()
    popups.removeAll()
    shownPopupsByDisplay.removeAll()
    for stub in stubs.values {
      stub.closedByHub = true
      stub.send(["t": "app.exited"])
      stub.close()
    }
    stubs.removeAll()
    stubHadRealIconOnLaunch.removeAll()
    syncFastState()
    updateStatus("与 \(hostLabel) 的连接已断开 — 可在 LinkShell 中重新开启融合模式")
    terminate()
  }
}

extension FusionLocal {
  static func mapCategory(_ raw: String) -> String {
    if raw.contains("developer-tools") { return "开发工具" }
    if raw.contains("productivity") || raw.contains("finance") || raw.contains("business") { return "效率" }
    if raw.contains("utilities") { return "实用工具" }
    if raw.contains("social-networking") { return "社交" }
    if raw.contains("entertainment") || raw.contains("games") || raw.contains("music") || raw.contains("video") { return "娱乐" }
    if raw.contains("graphics-design") || raw.contains("photography") { return "创意" }
    return "其他"
  }

  func reloadGrid() {}

  func setAlert(_ kind: String, subject: String = "", message: String, extra: [String: Any] = [:]) {
    var entry: [String: Any] = ["kind": kind, "message": message, "at": Int(Date().timeIntervalSince1970 * 1000)]
    if !subject.isEmpty { entry["subject"] = subject }
    for (k, v) in extra { entry[k] = v }
    alerts[subject.isEmpty ? kind : "\(kind):\(subject)"] = entry
    Fusion.log("alert \(kind) \(subject): \(message)")
  }

  func clearAlert(_ kind: String, subject: String = "") {
    alerts.removeValue(forKey: subject.isEmpty ? kind : "\(kind):\(subject)")
  }

  func clearAlerts(kind: String) {
    alerts = alerts.filter { ($0.value["kind"] as? String) != kind }
  }

  var alertList: [[String: Any]] {
    alerts.values.sorted { (($0["at"] as? Int) ?? 0) < (($1["at"] as? Int) ?? 0) }
  }

  /// LinkShell Desktop reads this when the hub is gone, so "disconnected" carries its reason.
  func writeExitStatus(reason: String) {
    let payload: [String: Any] = [
      "reason": reason,
      "message": exitMessage ?? Self.describeClose(reason),
      "at": Int(Date().timeIntervalSince1970 * 1000),
      "wasConnected": connected,
      "alerts": alertList,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload) {
      try? data.write(to: URL(fileURLWithPath: statusPath), options: .atomic)
    }
  }

  static func describeClose(_ reason: String) -> String {
    switch reason {
    case "timeout": return "远端 Mac 已无响应（可能已睡眠或网络中断）"
    case "tls", "token": return "无法与远端 Mac 的融合服务完成加密握手（直连可能被代理或 VPN 拦截），请重新开启融合模式"
    case "unreachable", "failed": return "无法连接到远端 Mac 的融合服务"
    case "stopped": return "融合模式已停止"
    case "proto": return "两台电脑的 LinkShell 版本不一致，请都升级到最新版本后再开启融合模式"
    case "replaced": return "另一台电脑开启了与远端的融合模式"
    default: return "与远端 Mac 的融合连接已断开"
    }
  }

  func updateStatus(_ text: String) {
    lastStatusText = text
    Fusion.log(text)
  }

  func refreshStatus() {
    guard connected else { return }
    let activeApps = stubs.count
    let activeWins = windows.count
    lastStatusText = "\(hostLabel) 已连接 · RTT \(Int(rtt)) ms · 已融合 \(activeApps) 个应用 / \(activeWins) 个独立窗口"
  }
}
