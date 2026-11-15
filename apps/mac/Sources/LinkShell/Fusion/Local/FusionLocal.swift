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
    var dragZone: Bool?
    var buttons: [String: [Double]]
    var hitrects: [[Double]]
    var ackSeq: Int
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
  var receivers: [String: DesktopScreenReceiver] = [:]
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
      stopping = true
      writeExitStatus(reason: "stopped")
      NSApp.terminate(nil)
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
      self.wire?.send(["t": "appactive", "on": false])
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
      return ["id": id, "frame": Fusion.dict(CGDisplayBounds(id)), "visible": Fusion.dict(visible), "scale": screen.backingScaleFactor, "hz": hz]
    }
  }

  static func displaysSignature(_ displays: [[String: Any]]) -> String {
    let parts = displays.map { d -> String in
      let f = Fusion.rect(d["frame"]), v = Fusion.rect(d["visible"])
      return "\(f.minX),\(f.minY),\(f.width),\(f.height)|\(v.minY),\(v.height)|\(Fusion.number(d["scale"]))"
    }
    return parts.joined(separator: ";")
  }

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
    wire?.send(["t": "hello", "token": token, "displays": screens])
    pingTimer?.invalidate()
    pingTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      self?.wire?.send(["t": "ping", "ts": CACurrentMediaTime()])
    }
  }

  func receive(_ m: [String: Any]) {
    switch m["t"] as? String {
    case "apps": applyCatalog(m)
    case "ready": ready(m)
    case "sig": if let key = m["k"] as? String { receivers[key]?.receive(m["m"] as? [String: Any] ?? [:]) }
    case "wopen": remoteWindowOpened(m)
    case "wclose": remoteWindowClosed(m)
    case "style": remoteWindowStyle(m)
    case "chrome": remoteWindowChrome(m)
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
    case "apphidden":
      if let bundle = m["bundle"] as? String {
        stubs[bundle]?.send(["t": "hidden", "on": m["on"] as? Bool == true])
      }
    case "clip":
      receiveRemoteClipboard(m)
    case "menu":
      if let bundle = m["bundle"] as? String {
        var forward = m
        forward.removeValue(forKey: "bundle")
        stubs[bundle]?.send(forward)
      }
    case "dragzone": remoteDragZone(m)
    case "layout": remoteLayout(m["windows"] as? [[String: Any]] ?? [])
    case "icon": remoteIcon(m)
    case "dockmenu":
      if let bundle = m["bundle"] as? String, let items = m["items"] as? [[String: Any]] {
        dockMenus[bundle] = items
        stubs[bundle]?.send(["t": "dockmenu", "items": items])
      }
    case "app.exited":
      if let bundle = m["bundle"] as? String {
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
    case "error":
      updateStatus("远端提示：\(m["message"] as? String ?? "")")
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

  func receiver(_ key: String, picture: @escaping (CVPixelBuffer, Data?) -> Void) {
    let output = FusionOutput(key: key, owner: self, picture: picture)
    outputs[key] = output
    syncFastState()
    receivers[key] = DesktopScreenReceiver(surface: output, preferH264: true, onSignal: { [weak self] message in
      self?.wire?.send(["t": "sig", "k": key, "m": message])
    }, onStatus: { [weak self] status in
      guard let self else { return }
      if let error = status["controlError"] as? String, !error.isEmpty {
        self.setAlert("accessibility", message: error)
      } else if status["control"] as? Bool == true {
        self.clearAlert("accessibility")
      }
      if status["live"] as? Bool == true { self.clearAlert("webrtc", subject: key) }
      self.refreshStatus()
    }, onFailure: { [weak self] message in
      guard let self else { return }
      self.updateStatus("\(key)：\(message)")
      var extra: [String: Any] = ["stream": key]
      if key.hasPrefix("w"), let id = CGWindowID(key.dropFirst()), let bundle = self.windows[id]?.bundle { extra["bundle"] = bundle }
      self.setAlert("webrtc", subject: key, message: message, extra: extra)
    })
    receivers[key]?.setControl(true)
  }

  static func parseApps(_ raw: Any?) -> [AppEntry] {
    let list: [[String: String]]
    if let direct = raw as? [[String: String]] {
      list = direct
    } else if let generic = raw as? [[String: Any]] {
      list = generic.map { dict in
        var out: [String: String] = [:]
        for (k, v) in dict {
          if let s = v as? String { out[k] = s }
        }
        return out
      }
    } else {
      list = []
    }
    return list.compactMap { item in
      let name = item["name"] ?? ""
      let bundle = item["bundle"] ?? ""
      guard !bundle.isEmpty else { return nil }
      let rawCat = item["category"] ?? ""
      return AppEntry(
        name: name,
        bundle: bundle,
        rawCategory: rawCat,
        category: Self.mapCategory(rawCat),
        isSystem: item["system"] == "1"
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
    let indices = Set((m["displays"] as? [[String: Any]] ?? []).map { Int(Fusion.number($0["index"])) })
    for index in displays.keys where !indices.contains(index) {
      displays.removeValue(forKey: index)
      receivers.removeValue(forKey: "d\(index)")?.stop()
      outputs.removeValue(forKey: "d\(index)")
    }
    for d in m["displays"] as? [[String: Any]] ?? [] {
      let index = Int(Fusion.number(d["index"]))
      displays[index] = (Fusion.rect(d["local"]), Int(Fusion.number(d["scale"])))
      // A display rebuild sends `ready` again: the old overlay peer must not linger beside the new one.
      receivers.removeValue(forKey: "d\(index)")?.stop()
      receiver("d\(index)") { [weak self] buffer, layout in self?.handleDisplayPicture(index, buffer, layout) }
    }
    syncFastState()
    let parsed = Self.parseApps(m["apps"])
    if !parsed.isEmpty || apps.isEmpty {
      apps = parsed
    }
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

  func closed(reason: String = "closed") {
    writeExitStatus(reason: stopping ? "stopped" : reason)
    connected = false
    pingTimer?.invalidate()
    pingTimer = nil
    receivers.values.forEach { $0.stop() }
    receivers.removeAll()
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
    NSApp.terminate(nil)
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
      "message": Self.describeClose(reason),
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
