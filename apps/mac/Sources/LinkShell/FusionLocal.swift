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
  private static let currentIconSchema = 3

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

  private var host: String
  private var port: UInt16
  private let hostLabel: String
  private let hostSlug: String
  private var token: String
  private var computerKey: String
  private var pendingLaunchBundles: [String]
  private let socketPath: String
  /// Why the last hub exited (and its alerts), for LinkShell Desktop once this process is gone.
  private let statusPath: String
  private let appsDir: URL
  private let iconCacheDir: URL
  private var listenFD: Int32 = -1
  private var wire: FusionWire?
  private var pingTimer: Timer?
  private var displays: [Int: (local: CGRect, scale: Int)] = [:]
  private var outputs: [String: FusionOutput] = [:]
  private var receivers: [String: DesktopScreenReceiver] = [:]
  private var windows: [CGWindowID: WindowRecord] = [:]
  private var lastWindowSEI: [CGWindowID: [Double]] = [:]
  private var popups: [CGWindowID: PopupRecord] = [:]
  private var shownPopupsByDisplay: [String: Set<CGWindowID>] = [:]
  private var pendingStubs: [Int32: StubClient] = [:]
  private var stubs: [String: StubClient] = [:]
  private var launchingStubs: Set<String> = []
  private var stubHadRealIconOnLaunch: Set<String> = []
  private var launchSentAt: [String: Double] = [:]
  private var quittingBundles: [String: Double] = [:]
  private var dockMenus: [String: [[String: Any]]] = [:]
  private var stubURLs: [String: URL] = [:]
  private var existingStubBundles: Set<String> = []
  private var icons: [String: NSImage] = [:]
  private var iconHashes: [String: String] = [:]
  private var realIconBundles: Set<String> = []
  private var iconPNGs: [String: String] = [:]
  private var iconRequested: Set<String> = []
  private var apps: [AppEntry] = []
  private var selectedCategory = "全部"
  private var searchQuery = ""
  private var frontWindowID: CGWindowID?
  private var rtt = 0.0
  private var connected = false
  private var stopping = false
  /// Structured problems LinkShell Desktop shows with a remedy each, keyed by kind (+ subject).
  private var alerts: [String: [String: Any]] = [:]
  private var stubRelaunches: [String: [Double]] = [:]
  private var displayObservers: [NSObjectProtocol] = []
  private var lastDisplaysSignature = ""
  private var displaysTimer: Timer?

  // Lock-protected mirrors for off-main-thread 120fps frame & input routing
  fileprivate let frameQueue = DispatchQueue(label: "com.bd.linkshell.fusion.frames", qos: .userInteractive)
  private let fastLock = NSLock()
  private var fastOutputs: [String: FusionOutput] = [:]
  private var fastWindows: [CGWindowID: (bundle: String, frame: CGRect)] = [:]
  private var fastStubs: [String: StubClient] = [:]
  private var fastDisplays: [Int: (local: CGRect, scale: Int)] = [:]
  private var fastQuitting: [String: Double] = [:]
  private var fastWindowSEI: [CGWindowID: [Double]] = [:]

  // State & disk caches for LinkShell Desktop's embedded Fusion tab
  private let uiIconCacheDir: URL
  private var lastStatusText = "正在初始化融合会话…"
  private let stubQueue = DispatchQueue(label: "com.bd.linkshell.fusion.stubgen", qos: .utility)

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

  fileprivate func handleActivate(client: StubClient, message m: [String: Any]) {
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

  fileprivate func handleHubControl(client: StubClient, message m: [String: Any]) {
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

  // MARK: Local Unix Socket Hub for Stub .app Processes

  func startSocketServer() {
    unlink(socketPath)
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { Fusion.log("cannot create unix socket"); return }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(socketPath.utf8CString)
    withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
      ptr.withMemoryRebound(to: CChar.self, capacity: bytes.count) { dst in
        for i in 0..<bytes.count { dst[i] = bytes[i] }
      }
    }
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bound == 0, Darwin.listen(fd, 32) == 0 else {
      Fusion.log("cannot bind/listen \(socketPath)")
      Darwin.close(fd)
      return
    }
    chmod(socketPath, 0o600)
    listenFD = fd
    Thread.detachNewThread { [weak self] in
      while true {
        var clientAddr = sockaddr_un()
        var len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let client = withUnsafeMutablePointer(to: &clientAddr) {
          $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.accept(fd, $0, &len) }
        }
        if client < 0 {
          if errno == EINTR { continue }
          break
        }
        self?.acceptStubConnection(client)
      }
    }
  }

  private func acceptStubConnection(_ fd: Int32) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { Darwin.close(fd); return }
      let client = StubClient(fd: fd, owner: self)
      self.pendingStubs[fd] = client
      client.startReading()
    }
  }

  func stubDidRegister(_ client: StubClient, bundle: String, pid: pid_t, portName: String) {
    pendingStubs.removeValue(forKey: client.fd)
    guard portName.hasPrefix("com.bd.linkshell.frame."),
          let port = DesktopFramePort(name: portName, receiver: false) else {
      client.close()
      return
    }
    client.bundle = bundle
    client.pid = pid
    client.port = port
    let wasExplicitLaunch = launchingStubs.remove(bundle) != nil
    if !wasExplicitLaunch, isQuitting(bundle) {
      client.closedByHub = true
      client.send(["t": "app.exited"])
      client.close()
      return
    }
    quittingBundles.removeValue(forKey: bundle)
    if let old = stubs[bundle], old !== client {
      old.closedByHub = true
      old.close()
    }
    stubs[bundle] = client
    syncFastState()
    client.send(["t": "welcome", "hubPid": Int(getpid())])
    if !stubHadRealIconOnLaunch.contains(bundle), let png = iconPNGs[bundle] {
      client.send(["t": "app.icon", "png": png, "force": true])
    }
    if let items = dockMenus[bundle] {
      client.send(["t": "dockmenu", "items": items])
    }

    // Replay existing open windows of this app immediately.
    let existing = windows.values.filter { $0.bundle == bundle }
    if existing.isEmpty {
      // Cold launch from Spotlight or Dock: ask remote to launch/activate unless already sent within 4s.
      // Before `ready` the remote drops anything but `hello`: queue it instead of losing it.
      if !connected {
        if !pendingLaunchBundles.contains(bundle) { pendingLaunchBundles.append(bundle) }
      } else {
        let now = CACurrentMediaTime()
        if now - (launchSentAt[bundle] ?? 0) >= 4.0 {
          launchSentAt[bundle] = now
          wire?.send(["t": "launch", "bundle": bundle])
        }
      }
    } else {
      for rec in existing {
        let key = "w\(rec.id)"
        let (ctrl, keys) = control(of: key)
        client.send([
          "t": "wopen", "id": Int(rec.id), "title": rec.title, "toolbar": rec.toolbar, "r": rec.cornerRadius,
          "frame": Fusion.dict(rec.frame), "control": ctrl, "keys": keys,
          "buttons": rec.buttons, "hitrects": rec.hitrects, "ack": rec.ackSeq,
          "activate": false,
        ])
        if let dz = rec.dragZone {
          client.send(["t": "dragzone", "id": Int(rec.id), "ok": dz])
        }
      }
    }
    reloadGrid()
    saveCatalogToDisk()
    refreshStatus()
  }

  private func syncFastState(removedWindowIDs: [CGWindowID] = []) {
    var winSnap: [CGWindowID: (bundle: String, frame: CGRect)] = [:]
    winSnap.reserveCapacity(windows.count)
    for (k, v) in windows { winSnap[k] = (v.bundle, v.frame) }
    fastLock.lock()
    fastOutputs = outputs
    fastStubs = stubs
    fastDisplays = displays
    fastQuitting = quittingBundles
    fastWindows = winSnap
    for wid in removedWindowIDs { fastWindowSEI.removeValue(forKey: wid) }
    fastLock.unlock()
  }

  fileprivate func fastDeliverInput(_ m: [String: Any]) {
    guard let key = m["key"] as? String, let event = m["m"] as? [String: Any] else { return }
    fastLock.lock()
    let output = fastOutputs[key]
    fastLock.unlock()
    output?.onInput?(event, m["r"] as? Bool == true)
  }

  private func isQuitting(_ bundle: String) -> Bool {
    guard let until = quittingBundles[bundle] else { return false }
    if CACurrentMediaTime() < until { return true }
    quittingBundles.removeValue(forKey: bundle)
    syncFastState()
    return false
  }

  private func purgeLocalState(forBundle bundle: String) {
    let winIDs = windows.values.filter { $0.bundle == bundle }.map(\.id)
    for id in winIDs {
      let key = "w\(id)"
      receivers.removeValue(forKey: key)?.stop()
      outputs.removeValue(forKey: key)
      windows.removeValue(forKey: id)
      lastWindowSEI.removeValue(forKey: id)
    }
    for (pid, rec) in popups where rec.bundle == bundle {
      popups.removeValue(forKey: pid)
    }
    syncFastState(removedWindowIDs: winIDs)
  }

  /// Asks the remote app to quit and keeps its windows until the remote says they closed or the app
  /// exited: an app with unsaved changes answers with a sheet the person must be able to see.
  private func quitLocalBundle(_ bundle: String, force: Bool) {
    guard !bundle.isEmpty else { return }
    quittingBundles[bundle] = CACurrentMediaTime() + 6.0
    launchingStubs.remove(bundle)
    wire?.send(["t": "quit", "bundle": bundle, "force": force])
    reloadGrid()
    saveCatalogToDisk()
    refreshStatus()
  }

  func stubDidReceive(_ client: StubClient, message m: [String: Any]) {
    switch m["t"] as? String {
    case "release":
      if let tok = DesktopScreenBridge.integer(m["token"]), tok >= 0 {
        client.released(UInt64(tok))
      }
    case "input":
      guard let key = m["key"] as? String, let event = m["m"] as? [String: Any] else { return }
      outputs[key]?.onInput?(event, m["r"] as? Bool == true)
    case "place":
      let id = CGWindowID(Fusion.number(m["id"]))
      let seq = DesktopScreenBridge.integer(m["seq"]) ?? 0
      let frame = Fusion.rect(m["frame"])
      let resize = m["resize"] as? Bool == true
      windows[id]?.frame = frame
      syncFastState()
      wire?.send(["t": "place", "id": id, "seq": seq, "frame": Fusion.dict(frame), "resize": resize])
    case "wclose.req":
      let id = CGWindowID(Fusion.number(m["id"]))
      wire?.send(["t": "wclose.req", "id": id])
    case "focus":
      let id = CGWindowID(Fusion.number(m["id"]))
      clipboardFocused()
      wire?.send(["t": "focus", "id": id])
    case "prewarm":
      wire?.send(["t": "prewarm", "id": m["id"] ?? 0])
    case "active":
      setStubActive(client.bundle, m["on"] as? Bool == true)
    case "reopen":
      if !client.bundle.isEmpty {
        quittingBundles.removeValue(forKey: client.bundle)
        syncFastState()
        let now = CACurrentMediaTime()
        if now - (launchSentAt[client.bundle] ?? 0) >= 2.0 {
          launchSentAt[client.bundle] = now
          wire?.send(["t": "launch", "bundle": client.bundle])
        }
      }
    case "detach":
      client.closedByHub = true
    case "menufetch", "menupress":
      if !client.bundle.isEmpty {
        wire?.send(["t": m["t"] ?? "", "bundle": client.bundle, "path": m["path"] ?? [Int]()])
      }
    case "dockaction":
      if !client.bundle.isEmpty {
        quittingBundles.removeValue(forKey: client.bundle)
        syncFastState()
        wire?.send(["t": "dockaction", "bundle": client.bundle, "path": m["path"] ?? [Int]()])
      }
    case "quit":
      client.closedByQuit = true
      quitLocalBundle(client.bundle, force: m["force"] as? Bool == true)
    default:
      break
    }
  }

  func stubDidDisconnect(_ client: StubClient) {
    pendingStubs.removeValue(forKey: client.fd)
    if !client.bundle.isEmpty, stubs[client.bundle] === client {
      stubs.removeValue(forKey: client.bundle)
      stubHadRealIconOnLaunch.remove(client.bundle)
      setStubActive(client.bundle, false)
      syncFastState()
      if !client.closedByQuit && !client.closedByHub && connected {
        // The stub crashed or was killed. The remote app may hold unsaved work, so it is never
        // force-quit for that: the stub comes back (a few times) for the windows still open.
        relaunchStubAfterCrash(client.bundle)
      } else {
        reloadGrid()
        refreshStatus()
      }
    }
  }

  private func relaunchStubAfterCrash(_ bundle: String) {
    let now = CACurrentMediaTime()
    var recent = (stubRelaunches[bundle] ?? []).filter { now - $0 < 60 }
    guard recent.count < 3 else {
      setAlert("stub", subject: bundle, message: "本机的融合应用反复退出，已停止自动重新打开；远端应用仍在运行")
      stubRelaunches[bundle] = recent
      reloadGrid()
      refreshStatus()
      return
    }
    recent.append(now)
    stubRelaunches[bundle] = recent
    guard windows.values.contains(where: { $0.bundle == bundle }) else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      guard let self, self.connected, self.stubs[bundle] == nil else { return }
      self.ensureStubRunning(bundle: bundle, activate: false)
    }
  }

  // MARK: Focus across stubs (C9) and the clipboard (C3)

  private var activeStubs: Set<String> = []
  private var appActiveTimer: Timer?
  private var remoteAppActive = false
  private var clipboard = FusionClipboardGuard()
  private var clipboardTimer: Timer?

  /// Debounced: going from one stub to another passes through "none active" for a moment, and the
  /// remote apps must not flicker inactive for it.
  private func setStubActive(_ bundle: String, _ on: Bool) {
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
  private func clipboardFocused() {
    // Whatever is on this Mac's clipboard when a fused window gets the focus is what the person
    // expects ⌘V to paste there, so the first tick after arming sends it.
    clipboard.armed = true
    clipboardTick()
    if clipboardTimer == nil {
      clipboardTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.clipboardTick() }
    }
  }

  /// Local → remote, only while a fused app is active here.
  private func clipboardTick() {
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
  private func receiveRemoteClipboard(_ m: [String: Any]) {
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
  private func observeDisplays() {
    guard displayObservers.isEmpty else { return }
    let schedule: (Notification) -> Void = { [weak self] _ in self?.scheduleDisplaysUpdate() }
    displayObservers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main, using: schedule))
    displayObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main, using: schedule))
    displayObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main, using: schedule))
  }

  private func scheduleDisplaysUpdate() {
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

  private func hello() {
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

  private func receiver(_ key: String, picture: @escaping (CVPixelBuffer, Data?) -> Void) {
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

  private func ensureIcons() {
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
  private func pruneStubs(keeping catalog: [AppEntry]) {
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

  private static func unregisterFromLaunchServices(_ appURL: URL) {
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

  private func applyCatalog(_ m: [String: Any]) {
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

  private func ready(_ m: [String: Any]) {
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

  private func closed(reason: String = "closed") {
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

  // MARK: Window & Frame Routing to Per-App Stubs

  private static func parseButtons(_ any: Any?) -> [String: [Double]] {
    guard let raw = any as? [String: Any] else { return [:] }
    var out: [String: [Double]] = [:]
    for (k, v) in raw {
      if let arr = (v as? [Any])?.compactMap({ ($0 as? NSNumber)?.doubleValue }), arr.count == 4 {
        out[k] = arr
      }
    }
    return out
  }

  private static func parseHitRects(_ any: Any?) -> [[Double]] {
    guard let raw = any as? [Any] else { return [] }
    return raw.compactMap { item in
      guard let arr = (item as? [Any])?.compactMap({ ($0 as? NSNumber)?.doubleValue }), arr.count == 4 else { return nil }
      return arr
    }
  }

  private func remoteWindowOpened(_ m: [String: Any]) {
    let id = CGWindowID(Fusion.number(m["id"]))
    let bundle = m["bundle"] as? String ?? ""
    // A window that opens while the app is quitting is usually its "save changes?" prompt: show it.
    quittingBundles.removeValue(forKey: bundle)
    let title = m["title"] as? String ?? (apps.first(where: { $0.bundle == bundle })?.name ?? "")
    let toolbar = m["toolbar"] as? Bool == true
    let radius = toolbar ? 26.0 : 17.0
    let frame = Fusion.rect(m["frame"])
    let buttons = Self.parseButtons(m["buttons"])
    let hitrects = Self.parseHitRects(m["hitrects"])
    windows[id] = WindowRecord(
      id: id, bundle: bundle, title: title, toolbar: toolbar, cornerRadius: radius,
      frame: frame, dragZone: nil, buttons: buttons, hitrects: hitrects, ackSeq: 0
    )

    let key = "w\(id)"
    // Only a window that follows something the person did in that app takes the focus here;
    // windows replayed on reconnect or opened by the app on its own never steal it.
    let activate = m["activate"] as? Bool == true
    receiver(key) { [weak self] buffer, sei in
      self?.handleWindowPicture(id: id, key: key, buffer: buffer, sei: sei)
    }
    if !bundle.isEmpty { ensureStubRunning(bundle: bundle, activate: activate) }
    if let stub = stubs[bundle] {
      let (ctrl, keys) = control(of: key)
      stub.send([
        "t": "wopen", "id": Int(id), "title": title, "toolbar": toolbar, "r": radius,
        "frame": Fusion.dict(frame), "control": ctrl, "keys": keys,
        "buttons": buttons, "hitrects": hitrects, "ack": 0,
        "activate": activate,
      ])
    }
    refreshStatus()
  }

  private func remoteWindowClosed(_ m: [String: Any]) {
    let id = CGWindowID(Fusion.number(m["id"]))
    let key = "w\(id)"
    receivers.removeValue(forKey: key)?.stop()
    outputs.removeValue(forKey: key)
    lastWindowSEI.removeValue(forKey: id)
    clearAlert("webrtc", subject: key)
    let rec = windows.removeValue(forKey: id)
    syncFastState(removedWindowIDs: [id])
    if let rec {
      stubs[rec.bundle]?.send(["t": "wclose", "id": Int(id)])
    }
    refreshStatus()
  }

  private func remoteWindowStyle(_ m: [String: Any]) {
    let id = CGWindowID(Fusion.number(m["id"]))
    let toolbar = m["toolbar"] as? Bool == true
    let r = Fusion.number(m["r"])
    let radius = r >= 6 ? r : (toolbar ? 26.0 : 17.0)
    let title = m["title"] as? String ?? ""
    let buttons = Self.parseButtons(m["buttons"])
    let hitrects = Self.parseHitRects(m["hitrects"])
    windows[id]?.toolbar = toolbar
    windows[id]?.cornerRadius = radius
    if !title.isEmpty { windows[id]?.title = title }
    if !buttons.isEmpty { windows[id]?.buttons = buttons }
    if m["hitrects"] != nil { windows[id]?.hitrects = hitrects }
    if let bundle = windows[id]?.bundle {
      stubs[bundle]?.send([
        "t": "style", "id": Int(id), "toolbar": toolbar, "r": radius, "title": title,
        "buttons": windows[id]?.buttons ?? buttons, "hitrects": windows[id]?.hitrects ?? hitrects,
      ])
    }
  }

  private func remoteWindowChrome(_ m: [String: Any]) {
    let id = CGWindowID(Fusion.number(m["id"]))
    let buttons = Self.parseButtons(m["buttons"])
    let hitrects = Self.parseHitRects(m["hitrects"])
    if !buttons.isEmpty { windows[id]?.buttons = buttons }
    windows[id]?.hitrects = hitrects
    if let bundle = windows[id]?.bundle {
      stubs[bundle]?.send([
        "t": "chrome", "id": Int(id),
        "buttons": windows[id]?.buttons ?? buttons,
        "hitrects": hitrects,
      ])
    }
  }

  private func remoteDragZone(_ m: [String: Any]) {
    let id = CGWindowID(Fusion.number(m["id"]))
    let ok = m["ok"] as? Bool == true
    windows[id]?.dragZone = ok
    if let bundle = windows[id]?.bundle {
      stubs[bundle]?.send(["t": "dragzone", "id": Int(id), "ok": ok])
    }
  }

  private func remoteLayout(_ list: [[String: Any]]) {
    var seenPopups: Set<CGWindowID> = []
    var windowsChanged = false
    for entry in list {
      let id = CGWindowID(Fusion.number(entry["id"]))
      let own = entry["own"] as? Bool == true
      let bundle = entry["bundle"] as? String ?? ""
      let frame = Fusion.rect(entry["frame"])
      if own {
        if windows[id] != nil {
          if !bundle.isEmpty, windows[id]?.bundle != bundle {
            windows[id]?.bundle = bundle
            windowsChanged = true
          }
          let ownerBundle = !bundle.isEmpty ? bundle : (windows[id]?.bundle ?? "")
          if let newTitle = entry["title"] as? String, !newTitle.isEmpty, windows[id]?.title != newTitle {
            windows[id]?.title = newTitle
            stubs[ownerBundle]?.send(["t": "title", "id": Int(id), "title": newTitle])
          }
          let ack = DesktopScreenBridge.integer(entry["ack"]) ?? 0
          let prevAck = windows[id]?.ackSeq ?? 0
          let prevFrame = windows[id]?.frame ?? .zero
          if ack != prevAck || frame != prevFrame {
            windows[id]?.ackSeq = ack
            windows[id]?.frame = frame
            windowsChanged = true
            stubs[ownerBundle]?.send(["t": "wlayout", "id": Int(id), "frame": Fusion.dict(frame), "ack": ack])
          }
        }
      } else {
        seenPopups.insert(id)
        let parent = CGWindowID(Fusion.number(entry["parent"]))
        let pdx = (entry["pdx"] as? NSNumber)?.doubleValue
        let pdy = (entry["pdy"] as? NSNumber)?.doubleValue
        popups[id] = PopupRecord(id: id, bundle: bundle, parentID: parent, frame: frame, pdx: pdx, pdy: pdy, layer: Int(Fusion.number(entry["layer"])))
      }
    }
    if windowsChanged { syncFastState() }
    for (pid, rec) in popups where !seenPopups.contains(pid) {
      stubs[rec.bundle]?.send(["t": "popup.hide", "id": Int(pid)])
      popups.removeValue(forKey: pid)
    }
    if let topEntry = list.first(where: { ($0["own"] as? Bool) == true }) {
      let topID = CGWindowID(Fusion.number(topEntry["id"]))
      if topID != frontWindowID {
        frontWindowID = topID
        if let bundle = windows[topID]?.bundle {
          stubs[bundle]?.send(["t": "front", "id": Int(topID)])
        }
      }
    }
  }

  private static func computeFallbackWindowCrop(for frame: CGRect, in displays: [Int: (local: CGRect, scale: Int)]) -> [Double]? {
    let best = displays.values.max { a, b in
      let ia = a.local.intersection(frame), ib = b.local.intersection(frame)
      let areaA = ia.isNull ? 0 : ia.width * ia.height
      let areaB = ib.isNull ? 0 : ib.width * ib.height
      return areaA < areaB
    }
    guard let disp = best, disp.local.width > 0, disp.local.height > 0 else { return nil }
    let vis = frame.intersection(disp.local)
    guard !vis.isNull, vis.width >= 2, vis.height >= 2 else { return nil }
    let nx = min(1, max(0, Double((vis.minX - disp.local.minX) / disp.local.width)))
    let ny = min(1, max(0, Double((vis.minY - disp.local.minY) / disp.local.height)))
    let nw = min(1 - nx, max(0.001, Double(vis.width / disp.local.width)))
    let nh = min(1 - ny, max(0.001, Double(vis.height / disp.local.height)))
    return [
      Double(frame.minX), Double(frame.minY), Double(frame.width), Double(frame.height),
      nx, ny, nw, nh,
      Double(vis.minX - frame.minX), Double(vis.minY - frame.minY), Double(vis.width), Double(vis.height),
    ]
  }

  fileprivate func handleWindowPictureFast(id: CGWindowID, key: String, buffer: CVPixelBuffer, sei: Data?) {
    let parsedSEI = sei.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [Double] }
    let now = CACurrentMediaTime()
    fastLock.lock()
    guard let winInfo = fastWindows[id], !winInfo.bundle.isEmpty else { fastLock.unlock(); return }
    guard let stub = fastStubs[winInfo.bundle] else { fastLock.unlock(); return }
    var resolved: [Double]?
    if let arr = parsedSEI, arr.count >= 12 {
      fastWindowSEI[id] = arr
      resolved = arr
    } else if fastWindowSEI[id] == nil {
      resolved = Self.computeFallbackWindowCrop(for: winInfo.frame, in: fastDisplays)
    }
    fastLock.unlock()

    // Never apply stale `fastWindowSEI` to an SEI-less buffer, and never fall back to uncropped `(0, 0, bw, bh)`.
    guard let arr = resolved, arr.count >= 12 else { return }
    guard let surface = CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue() else { return }
    let bw = min(CVPixelBufferGetWidth(buffer), IOSurfaceGetWidth(surface))
    let bh = min(CVPixelBufferGetHeight(buffer), IOSurfaceGetHeight(surface))
    guard bw >= 4, bh >= 4 else { return }

    let lx = arr[0], ly = arr[1], lw = arr[2], lh = arr[3]
    var cx: Int, cy: Int, cw: Int, ch: Int
    if arr[6] <= 1.0001 && arr[7] <= 1.0001 {
      cx = Int((arr[4] * Double(bw)).rounded())
      cy = Int((arr[5] * Double(bh)).rounded())
      cw = Int((arr[6] * Double(bw)).rounded())
      ch = Int((arr[7] * Double(bh)).rounded())
    } else {
      cx = Int(arr[4]); cy = Int(arr[5]); cw = Int(arr[6]); ch = Int(arr[7])
    }
    let ix = arr[8], iy = arr[9], iw = arr[10], ih = arr[11]
    let fscale = arr.count >= 13 ? arr[12] : 1.0
    let fack = arr.count >= 14 ? Int(arr[13]) : 0
    cx = max(0, min(cx, bw - 2)); cy = max(0, min(cy, bh - 2))
    cw = max(2, min(cw, bw - cx)); ch = max(2, min(ch, bh - cy))
    let matrix = (CVBufferCopyAttachment(buffer, kCVImageBufferYCbCrMatrixKey, nil) as? String) ?? ""
    let metaObj: [String: Any] = [
      "width": cw, "height": ch, "rotation": 0,
      "x": cx, "y": cy, "w": cw, "h": ch, "matrix": matrix,
      "wid": Int(id), "popup": false, "key": key,
      "f": [lx, ly, lw, lh],
      "in": [ix, iy, iw, ih],
      "fscale": fscale,
      "fack": fack,
    ]
    guard let meta = try? JSONSerialization.data(withJSONObject: metaObj), meta.count < 1024 else { return }
    stub.deliver(windowKey: id, buffer: buffer, surface: surface, metadata: meta)
  }

  private func handleWindowPicture(id: CGWindowID, key: String, buffer: CVPixelBuffer, sei: Data?) {
    handleWindowPictureFast(id: id, key: key, buffer: buffer, sei: sei)
  }

  private func handleDisplayPicture(_ index: Int, _ buffer: CVPixelBuffer, _ sei: Data?) {
    guard let display = displays[index],
          let sei, let list = (try? JSONSerialization.jsonObject(with: sei)) as? [[Double]] else { return }
    guard let surface = CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue() else { return }
    let bw = min(CVPixelBufferGetWidth(buffer), IOSurfaceGetWidth(surface))
    let bh = min(CVPixelBufferGetHeight(buffer), IOSurfaceGetHeight(surface))
    let scale = CGFloat(bw) / max(display.local.width, 1)
    let key = "d\(index)"
    let matrix = (CVBufferCopyAttachment(buffer, kCVImageBufferYCbCrMatrixKey, nil) as? String) ?? ""
    var active: Set<CGWindowID> = []

    for e in list where e.count == 6 {
      let id = CGWindowID(e[0])
      guard let rec = popups[id], let stub = stubs[rec.bundle] else { continue }
      let frame = CGRect(x: e[2], y: e[3], width: e[4], height: e[5])
      let visible = frame.intersection(display.local)
      guard !visible.isNull, visible.width >= 2, visible.height >= 2 else { continue }
      let crop = CGRect(x: (visible.minX - display.local.minX) * scale,
                        y: (visible.minY - display.local.minY) * scale,
                        width: visible.width * scale,
                        height: visible.height * scale)
        .integral.intersection(CGRect(x: 0, y: 0, width: bw, height: bh))
      guard crop.width >= 2, crop.height >= 2 else { continue }
      active.insert(id)
      let inWin = CGRect(x: visible.minX - frame.minX, y: visible.minY - frame.minY, width: visible.width, height: visible.height)
      var metaObj: [String: Any] = [
        "width": Int(crop.width), "height": Int(crop.height), "rotation": 0,
        "x": Int(crop.minX), "y": Int(crop.minY), "w": Int(crop.width), "h": Int(crop.height), "matrix": matrix,
        "wid": Int(id), "popup": true, "parent": Int(rec.parentID), "key": key, "layer": rec.layer,
        "disp": [Double(bw), Double(bh)],
        "f": [Double(frame.minX), Double(frame.minY), Double(frame.width), Double(frame.height)],
        "in": [Double(inWin.minX), Double(inWin.minY), Double(inWin.width), Double(inWin.height)],
      ]
      if let pdx = rec.pdx, let pdy = rec.pdy {
        metaObj["rel"] = [pdx, pdy]
      }
      if let meta = try? JSONSerialization.data(withJSONObject: metaObj), meta.count < 1024 {
        stub.deliver(windowKey: id, buffer: buffer, surface: surface, metadata: meta)
      }
    }

    let previous = shownPopupsByDisplay[key] ?? []
    for gone in previous.subtracting(active) {
      if let rec = popups[gone] { stubs[rec.bundle]?.send(["t": "popup.hide", "id": Int(gone)]) }
    }
    shownPopupsByDisplay[key] = active
  }

  func controlChanged(_ key: String) {
    let (enabled, keys) = control(of: key)
    if key.hasPrefix("w"), let id = CGWindowID(key.dropFirst()), let bundle = windows[id]?.bundle {
      stubs[bundle]?.send(["t": "control", "key": key, "enabled": enabled, "keys": keys])
    } else {
      for stub in stubs.values {
        stub.send(["t": "control", "key": key, "enabled": enabled, "keys": keys])
      }
    }
  }

  func control(of key: String) -> (Bool, Bool) {
    (outputs[key]?.controlEnabled ?? false, outputs[key]?.physicalKeys ?? false)
  }

  func cursor(_ key: String, _ message: [String: Any]) {
    guard message["t"] as? String == "shape" else { return }
    if key.hasPrefix("w"), let id = CGWindowID(key.dropFirst()), let bundle = windows[id]?.bundle {
      stubs[bundle]?.send(["t": "cursor", "key": key, "m": message])
    } else {
      for stub in stubs.values { stub.send(["t": "cursor", "key": key, "m": message]) }
    }
  }

  // MARK: Stub .app Bundle Generation & Badged Icon Compositor

  private func iconCacheFile(for bundle: String) -> URL {
    let safe = bundle.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
    return iconCacheDir.appendingPathComponent("\(safe).png")
  }

  private func uiIconFile(for bundle: String) -> URL {
    let safe = bundle.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
    return uiIconCacheDir.appendingPathComponent("\(safe).png")
  }

  private static func writeUITilePNG(image: NSImage, to url: URL) {
    let px = 160
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else { return }
    rep.size = NSSize(width: 80, height: 80)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: 80, height: 80), from: .zero, operation: .copy, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()
    if let png = rep.representation(using: .png, properties: [:]) {
      try? png.write(to: url, options: .atomic)
    }
  }

  private func saveCatalogToDisk() {
    guard !apps.isEmpty else { return }
    let payload: [String: Any] = [
      "computerKey": computerKey,
      "hostLabel": hostLabel,
      "hostSlug": hostSlug,
      "appsDir": appsDir.path,
      "updatedAt": Int(Date().timeIntervalSince1970 * 1000),
      "apps": apps.map { entry -> [String: Any] in
        [
          "name": entry.name,
          "bundle": entry.bundle,
          "category": entry.category,
          "rawCategory": entry.rawCategory,
          "isSystem": entry.isSystem,
          "stubPath": stubURLs[entry.bundle]?.path ?? "",
        ]
      },
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: []) {
      try? data.write(to: iconCacheDir.appendingPathComponent("catalog.json"), options: .atomic)
    }
  }

  private static func shortSHA256(_ data: Data) -> String {
    let digest = SHA256.hash(data: data)
    return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
  }

  func preloadCachedIcons() {
    guard let files = try? FileManager.default.contentsOfDirectory(at: iconCacheDir, includingPropertiesForKeys: nil) else { return }
    for file in files where file.pathExtension == "png" {
      let bundle = file.deletingPathExtension().lastPathComponent
      guard !bundle.isEmpty,
            let data = try? Data(contentsOf: file),
            let raw = NSImage(data: data) else { continue }
      let (badged, badgedPNG) = Self.composeBadgedIcon(base: raw, hostLabel: hostLabel)
      icons[bundle] = badged
      iconHashes[bundle] = Self.shortSHA256(data)
      realIconBundles.insert(bundle)
      if let badgedPNG { iconPNGs[bundle] = badgedPNG }
      let uiURL = uiIconFile(for: bundle)
      if !FileManager.default.fileExists(atPath: uiURL.path) {
        stubQueue.async {
          Self.writeUITilePNG(image: badged, to: uiURL)
        }
      }
    }
  }

  /// Resolves the best available icon for `bundle` before the remote icon arrives over the wire:
  /// 1) Disk cache (`~/.linkshell/fusion-icons/<host>/<bundle>.png`),
  /// 2) Same-bundle local macOS app (resolving symlinks so Safari never gets an alias arrow!),
  /// 3) Generic `.applicationBundle` fallback (`isReal = false`).
  struct ResolvedIcon {
    let image: NSImage
    let isReal: Bool
    let hash: String
    let png: String?
    let fromCache: Bool
  }

  /// Pure, so it can run on `stubQueue`: the disk cache, then a same-bundle local app (symlinks
  /// resolved so Safari never gets an alias arrow), then a generic app icon (`isReal = false`).
  static func resolveFallbackIcon(bundle: String, cacheFile: URL, hostLabel: String) -> ResolvedIcon {
    if let data = try? Data(contentsOf: cacheFile), let raw = NSImage(data: data) {
      let (badged, png) = composeBadgedIcon(base: raw, hostLabel: hostLabel)
      return ResolvedIcon(image: badged, isReal: true, hash: shortSHA256(data), png: png, fromCache: true)
    }
    if let localURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle),
       !localURL.path.contains("/Applications/LinkShell/") {
      let raw = NSWorkspace.shared.icon(forFile: localURL.resolvingSymlinksInPath().path)
      let (badged, _) = composeBadgedIcon(base: raw, hostLabel: hostLabel)
      return ResolvedIcon(image: badged, isReal: true, hash: "local-\(bundle)", png: nil, fromCache: false)
    }
    let generic = composeBadgedIcon(base: NSWorkspace.shared.icon(for: .applicationBundle), hostLabel: hostLabel).image
    return ResolvedIcon(image: generic, isReal: false, hash: "generic", png: nil, fromCache: false)
  }

  /// Main thread only: records a cache hit so later lookups are free.
  private func adopt(_ icon: ResolvedIcon, for bundle: String) {
    guard icon.fromCache else { return }
    icons[bundle] = icon.image
    iconHashes[bundle] = icon.hash
    realIconBundles.insert(bundle)
    if let png = icon.png { iconPNGs[bundle] = png }
  }

  private func requestIconIfNeeded(_ bundle: String) {
    guard !bundle.isEmpty, !iconRequested.contains(bundle) else { return }
    iconRequested.insert(bundle)
    wire?.send(["t": "icon", "bundle": bundle])
  }

  private func remoteIcon(_ m: [String: Any]) {
    guard let bundle = m["bundle"] as? String,
          let b64 = m["png"] as? String,
          let data = Data(base64Encoded: b64),
          let raw = NSImage(data: data) else { return }
    let newHash = Self.shortSHA256(data)
    try? data.write(to: iconCacheFile(for: bundle), options: .atomic)
    let (badged, badgedPNG) = Self.composeBadgedIcon(base: raw, hostLabel: hostLabel)
    let uiURL = uiIconFile(for: bundle)
    stubQueue.async {
      Self.writeUITilePNG(image: badged, to: uiURL)
    }
    icons[bundle] = badged
    iconHashes[bundle] = newHash
    realIconBundles.insert(bundle)
    if let badgedPNG {
      iconPNGs[bundle] = badgedPNG
      if !stubHadRealIconOnLaunch.contains(bundle) {
        stubs[bundle]?.send(["t": "app.icon", "png": badgedPNG, "force": true])
        stubHadRealIconOnLaunch.insert(bundle)
      }
    }
    if let entry = apps.first(where: { $0.bundle == bundle }) {
      let shouldMaterialize = !entry.isSystem
        || entry.bundle == "com.apple.Safari"
        || stubs[bundle] != nil
        || launchingStubs.contains(bundle)
        || stubURLs[bundle] != nil
        || existingStubBundles.contains(bundle)
      if shouldMaterialize {
        let isLive = stubs[bundle] != nil || launchingStubs.contains(bundle)
        stubQueue.async { [weak self] in
          guard let self else { return }
          let url = self.materializeStubBundle(
            entry: entry,
            badgedIcon: badged,
            isRealIcon: true,
            iconHash: newHash,
            preserveRunningBinary: isLive
          )
          DispatchQueue.main.async {
            if let url { self.stubURLs[bundle] = url }
          }
        }
      }
    }
    reloadGrid()
    saveCatalogToDisk()
    refreshStatus()
  }

  func launchApp(bundle: String) {
    quittingBundles.removeValue(forKey: bundle)
    syncFastState()
    requestIconIfNeeded(bundle)
    launchSentAt[bundle] = CACurrentMediaTime()
    wire?.send(["t": "launch", "bundle": bundle])
    ensureStubRunning(bundle: bundle, activate: true)
  }

  /// Bundle generation (iconutil, codesign, lsregister) runs on the serial `stubQueue`, never on
  /// the main thread that routes frames and control messages, and never twice at once for a bundle.
  private func ensureStubRunning(bundle: String, activate: Bool) {
    if let active = stubs[bundle] {
      if activate, let running = NSRunningApplication(processIdentifier: active.pid) {
        running.activate(options: [.activateIgnoringOtherApps])
      }
      return
    }
    guard !launchingStubs.contains(bundle) else { return }
    launchingStubs.insert(bundle)
    let entry = apps.first(where: { $0.bundle == bundle }) ?? AppEntry(name: bundle.split(separator: ".").last.map(String.init) ?? bundle, bundle: bundle, rawCategory: "", category: "其他", isSystem: false)
    let cached: ResolvedIcon? = (realIconBundles.contains(bundle) ? icons[bundle] : nil).map {
      ResolvedIcon(image: $0, isReal: true, hash: iconHashes[bundle] ?? "cached", png: iconPNGs[bundle], fromCache: false)
    }
    let cacheFile = iconCacheFile(for: bundle)
    let label = hostLabel
    stubQueue.async { [weak self] in
      guard let self else { return }
      let resolved = cached ?? Self.resolveFallbackIcon(bundle: bundle, cacheFile: cacheFile, hostLabel: label)
      let appURL = self.materializeStubBundle(
        entry: entry,
        badgedIcon: resolved.image,
        isRealIcon: resolved.isReal,
        iconHash: resolved.hash,
        preserveRunningBinary: false
      )
      DispatchQueue.main.async {
        self.adopt(resolved, for: bundle)
        guard let appURL, self.launchingStubs.contains(bundle) else {
          self.launchingStubs.remove(bundle)
          return
        }
        if resolved.isReal { self.stubHadRealIconOnLaunch.insert(bundle) }
        self.stubURLs[bundle] = appURL
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = activate
        NSWorkspace.shared.openApplication(at: appURL, configuration: cfg) { [weak self] _, error in
          DispatchQueue.main.async {
            if let error {
              Fusion.log("failed to launch stub \(appURL.path): \(error.localizedDescription)")
              self?.launchingStubs.remove(bundle)
            }
          }
        }
      }
    }
  }

  private func stubBinarySourceURL() -> URL? {
    let candidates = [
      Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/LinkShellFusionStub"),
      URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("LinkShellFusionStub"),
    ]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0.path) }
  }

  private static func registerWithLaunchServices(_ appURL: URL) {
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: appURL.path)
    NSWorkspace.shared.noteFileSystemChanged(appURL.path)
    let lsreg = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    guard FileManager.default.isExecutableFile(atPath: lsreg) else { return }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: lsreg)
    proc.arguments = ["-f", appURL.path]
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    try? proc.run()
    proc.waitUntilExit()
  }

  /// Prefers a desktop-capable LinkShell bundle (`Contents/MacOS/LinkShell Desktop`) for Dock cold-launch
  /// stubs so running `FusionLocal` from a dev helper build (`apps/mac/build/LinkShell.app`) never points
  /// `LSFusionHubApp` at a helper-only bundle without Electron.
  private static var preferredHubAppPath: String {
    let own = Bundle.main.bundlePath
    if FileManager.default.isExecutableFile(atPath: own + "/Contents/MacOS/LinkShell Desktop") {
      return own
    }
    let installed = "/Applications/LinkShell.app"
    if FileManager.default.isExecutableFile(atPath: installed + "/Contents/MacOS/LinkShell Desktop") {
      return installed
    }
    return own
  }

  /// Refreshes existing Stub `.app` bundles on disk (binary, hub path, socket path, and macOS 26
  /// v3 full-size squircle `.icns`) so pinned Dock items and Spotlight launches stay crisp & up to date.
  func upgradeExistingStubs() {
    guard let srcBin = stubBinarySourceURL() else { return }
    let appsDir = self.appsDir
    let socketPath = self.socketPath
    let hubPath = Self.preferredHubAppPath
    let computerKey = self.computerKey
    let fm = FileManager.default
    if let items = try? fm.contentsOfDirectory(at: appsDir, includingPropertiesForKeys: nil) {
      for appURL in items where appURL.pathExtension == "app" {
        let plistURL = appURL.appendingPathComponent("Contents/Info.plist")
        if let dict = NSDictionary(contentsOf: plistURL) as? [String: Any],
           let bundle = dict["LSFusionBundleID"] as? String, !bundle.isEmpty {
          existingStubBundles.insert(bundle)
          stubURLs[bundle] = appURL
        }
      }
    }
    stubQueue.async { [weak self] in
      guard let self else { return }
      guard let items = try? fm.contentsOfDirectory(at: appsDir, includingPropertiesForKeys: nil) else { return }
      let srcData = try? Data(contentsOf: srcBin)
      for appURL in items where appURL.pathExtension == "app" {
        let contentsURL = appURL.appendingPathComponent("Contents", isDirectory: true)
        let dstBin = contentsURL.appendingPathComponent("MacOS/FusionStub")
        let plistURL = contentsURL.appendingPathComponent("Info.plist")
        let icnsURL = contentsURL.appendingPathComponent("Resources/AppIcon.icns")
        guard fm.fileExists(atPath: dstBin.path),
              var plist = NSDictionary(contentsOf: plistURL) as? [String: Any],
              let bundle = plist["LSFusionBundleID"] as? String, !bundle.isEmpty else { continue }

        var binaryUpdated = false
        if let srcData, (try? Data(contentsOf: dstBin)) != srcData {
          try? fm.removeItem(at: dstBin)
          if (try? fm.copyItem(at: srcBin, to: dstBin)) != nil {
            try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dstBin.path)
            binaryUpdated = true
          }
        }

        let schema = (plist["LSFusionIconSchema"] as? Int) ?? 0
        let wasReal = (plist["LSFusionRealIcon"] as? Bool) == true
        var plistChanged = false
        if (plist["LSFusionSocket"] as? String) != socketPath {
          plist["LSFusionSocket"] = socketPath
          plistChanged = true
        }
        if (plist["LSFusionHubApp"] as? String) != hubPath {
          plist["LSFusionHubApp"] = hubPath
          plistChanged = true
        }
        if !computerKey.isEmpty && (plist["LSFusionComputerKey"] as? String) != computerKey {
          plist["LSFusionComputerKey"] = computerKey
          plistChanged = true
        }
        if (plist["LSFusionHostName"] as? String) != self.hostLabel {
          plist["LSFusionHostName"] = self.hostLabel
          plistChanged = true
        }

        var iconUpdated = false
        if schema < Self.currentIconSchema || !wasReal {
          let fallback = Self.resolveFallbackIcon(bundle: bundle, cacheFile: self.iconCacheFile(for: bundle), hostLabel: self.hostLabel)
          Self.writeICNS(image: fallback.image, to: icnsURL)
          plist["LSFusionIconSchema"] = Self.currentIconSchema
          plist["LSFusionRealIcon"] = fallback.isReal
          plist["LSFusionIconHash"] = fallback.hash
          iconUpdated = true
          plistChanged = true
        }

        guard binaryUpdated || plistChanged || iconUpdated else { continue }
        let prevVer = Int(plist["CFBundleVersion"] as? String ?? "1") ?? 1
        plist["CFBundleVersion"] = String(prevVer + 1)
        if let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
          try? data.write(to: plistURL, options: .atomic)
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        proc.arguments = ["--force", "--sign", "-", appURL.path]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        proc.waitUntilExit()
        if iconUpdated || plistChanged {
          Self.registerWithLaunchServices(appURL)
        }
      }
    }
  }

  private func hasLocalCollision(name: String, bundle: String) -> Bool {
    if FileManager.default.fileExists(atPath: "/Applications/\(name).app")
      || FileManager.default.fileExists(atPath: "/System/Applications/\(name).app") {
      return true
    }
    if let found = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle),
       !found.path.contains("/Applications/LinkShell/") {
      return true
    }
    return false
  }

  private func materializeStubBundle(
    entry: AppEntry,
    badgedIcon: NSImage,
    isRealIcon: Bool,
    iconHash: String,
    preserveRunningBinary: Bool
  ) -> URL? {
    guard let srcBin = stubBinarySourceURL() else {
      Fusion.log("LinkShellFusionStub binary not found next to executable")
      return nil
    }
    let fm = FileManager.default
    let displayName = hasLocalCollision(name: entry.name, bundle: entry.bundle) ? "\(entry.name) · \(hostLabel)" : entry.name
    let safeFileName = displayName.replacingOccurrences(of: "/", with: "-")
    let appURL = appsDir.appendingPathComponent("\(safeFileName).app", isDirectory: true)
    let contentsURL = appURL.appendingPathComponent("Contents", isDirectory: true)
    let macosURL = contentsURL.appendingPathComponent("MacOS", isDirectory: true)
    let resURL = contentsURL.appendingPathComponent("Resources", isDirectory: true)
    let dstBin = macosURL.appendingPathComponent("FusionStub")
    let icnsURL = resURL.appendingPathComponent("Resources/AppIcon.icns").standardizedFileURL
    let actualIcnsURL = resURL.appendingPathComponent("AppIcon.icns")
    let plistURL = contentsURL.appendingPathComponent("Info.plist")
    _ = icnsURL

    let existingPlist = NSDictionary(contentsOf: plistURL) as? [String: Any]
    let existingSchema = (existingPlist?["LSFusionIconSchema"] as? Int) ?? 0
    let existingReal = (existingPlist?["LSFusionRealIcon"] as? Bool) == true
    let existingHash = (existingPlist?["LSFusionIconHash"] as? String) ?? ""
    let existingSocket = (existingPlist?["LSFusionSocket"] as? String) ?? ""
    let existingHub = (existingPlist?["LSFusionHubApp"] as? String) ?? ""
    let existingCompKey = (existingPlist?["LSFusionComputerKey"] as? String) ?? ""

    let srcData = try? Data(contentsOf: srcBin)
    let dstExists = fm.isExecutableFile(atPath: dstBin.path)
    let binMatches = dstExists && srcData != nil && ((try? Data(contentsOf: dstBin)) == srcData)
    let iconMatches = fm.fileExists(atPath: actualIcnsURL.path)
      && existingSchema == Self.currentIconSchema
      && existingReal == isRealIcon
      && (!isRealIcon || existingHash == iconHash)
    let hubPath = Self.preferredHubAppPath
    let metaMatches = existingSocket == socketPath
      && existingHub == hubPath
      && (computerKey.isEmpty || existingCompKey == computerKey)

    if binMatches && iconMatches && metaMatches {
      return appURL
    }
    // Never overwrite a certified real icon on disk with a temporary generic fallback!
    if !isRealIcon && existingReal && existingSchema == Self.currentIconSchema && binMatches && metaMatches {
      return appURL
    }

    try? fm.createDirectory(at: macosURL, withIntermediateDirectories: true)
    try? fm.createDirectory(at: resURL, withIntermediateDirectories: true)

    if !preserveRunningBinary && !binMatches {
      if fm.fileExists(atPath: dstBin.path) { try? fm.removeItem(at: dstBin) }
      do {
        try fm.copyItem(at: srcBin, to: dstBin)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dstBin.path)
      } catch {
        if !fm.isExecutableFile(atPath: dstBin.path) {
          Fusion.log("copy stub bin failed: \(error.localizedDescription)")
          return nil
        }
      }
    }

    let finalRealIcon: Bool
    let finalHash: String
    if !isRealIcon && existingReal && existingSchema == Self.currentIconSchema && fm.fileExists(atPath: actualIcnsURL.path) {
      finalRealIcon = true
      finalHash = existingHash
    } else {
      Self.writeICNS(image: badgedIcon, to: actualIcnsURL)
      finalRealIcon = isRealIcon
      finalHash = iconHash
    }

    let prevVer = Int(existingPlist?["CFBundleVersion"] as? String ?? "0") ?? 0
    let cleanBundle = entry.bundle.lowercased().map { ($0.isLetter || $0.isNumber || $0 == ".") ? String($0) : "-" }.joined()
    let stubBundleID = "com.bd.linkshell.fusion.\(hostSlug).\(cleanBundle)"
    var plist: [String: Any] = [
      "CFBundleDevelopmentRegion": "zh_CN",
      "CFBundleExecutable": "FusionStub",
      "CFBundleIdentifier": stubBundleID,
      "CFBundleInfoDictionaryVersion": "6.0",
      "CFBundleName": displayName,
      "CFBundleDisplayName": displayName,
      "CFBundleIconFile": "AppIcon",
      "CFBundlePackageType": "APPL",
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": String(prevVer + 1),
      "LSMinimumSystemVersion": "13.0",
      "NSHighResolutionCapable": true,
      "UIDesignRequiresCompatibility": false,
      "LSFusionBundleID": entry.bundle,
      "LSFusionSocket": socketPath,
      "LSFusionHubApp": hubPath,
      "LSFusionComputerKey": computerKey.isEmpty ? existingCompKey : computerKey,
      "LSFusionHostName": hostLabel,
      "LSFusionIconSchema": Self.currentIconSchema,
      "LSFusionRealIcon": finalRealIcon,
      "LSFusionIconHash": finalHash,
    ]
    if !entry.rawCategory.isEmpty {
      plist["LSApplicationCategoryType"] = entry.rawCategory
    } else if let prevCat = existingPlist?["LSApplicationCategoryType"] as? String, !prevCat.isEmpty {
      plist["LSApplicationCategoryType"] = prevCat
    }
    if let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
      try? data.write(to: plistURL, options: .atomic)
    }

    // Ad-hoc sign + LaunchServices re-register so Dock & Spotlight pick up updated icons immediately.
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    proc.arguments = ["--force", "--sign", "-", appURL.path]
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    try? proc.run()
    proc.waitUntilExit()
    Self.registerWithLaunchServices(appURL)
    return appURL
  }

  /// Composes a `1024×1024` (`512×512 pt @2x`) macOS 26 squircle-compliant app icon:
  /// Clips strictly to macOS's standard `824×824 px` (`412×412 pt` at `(50, 50)`) continuous squircle
  /// and tucks the computer badge inside `(434 - badgeW, 74)` so zero non-transparent pixels exist
  /// outside the squircle mask — preventing macOS 26 `IconServices` from shrinking the icon onto a grey plate!
  static func composeBadgedIcon(base: NSImage, hostLabel: String) -> (image: NSImage, pngBase64: String?) {
    let ptSize = NSSize(width: 512, height: 512)
    let px = 1024
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else {
      return (base, nil)
    }
    rep.size = ptSize
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high

    let squircleRect = NSRect(x: 50, y: 50, width: 412, height: 412)
    let squircleClip = NSBezierPath(roundedRect: squircleRect, xRadius: 92.5, yRadius: 92.5)
    squircleClip.addClip()

    base.draw(in: NSRect(origin: .zero, size: ptSize), from: .zero, operation: .sourceOver, fraction: 1.0)

    let label = String(hostLabel.prefix(4)).uppercased()
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 33, weight: .bold),
      .foregroundColor: NSColor.white,
    ]
    let textSize = (label as NSString).size(withAttributes: attrs)
    let badgeW = max(112, min(176, ceil(textSize.width + 38)))
    let badgeH: CGFloat = 64
    let badgeRect = NSRect(x: 434 - badgeW, y: 74, width: badgeW, height: badgeH)

    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.38)
    shadow.shadowBlurRadius = 10
    shadow.shadowOffset = NSSize(width: 0, height: -2.5)
    NSGraphicsContext.saveGraphicsState()
    shadow.set()
    let bg = NSBezierPath(roundedRect: badgeRect, xRadius: 20, yRadius: 20)
    // LinkShell `accentFill` (#4c5fd5) from `brand-colors.json`.
    NSColor(srgbRed: 0x4c / 255.0, green: 0x5f / 255.0, blue: 0xd5 / 255.0, alpha: 0.97).setFill()
    bg.fill()
    NSGraphicsContext.restoreGraphicsState()

    NSColor.white.withAlphaComponent(0.92).setStroke()
    bg.lineWidth = 3.5
    bg.stroke()

    let textRect = NSRect(
      x: badgeRect.midX - textSize.width / 2,
      y: badgeRect.midY - textSize.height / 2,
      width: textSize.width,
      height: textSize.height
    )
    (label as NSString).draw(in: textRect, withAttributes: attrs)
    NSGraphicsContext.restoreGraphicsState()

    let out = NSImage(size: ptSize)
    out.addRepresentation(rep)
    let pngB64 = rep.representation(using: .png, properties: [:])?.base64EncodedString()
    return (out, pngB64)
  }

  /// Writes a complete 10-representation macOS `.icns` (`16..512 @1x/@2x` up to `1024×1024`) via
  /// `/usr/bin/iconutil` so macOS 26 Dock, Finder, Spotlight, and ⌘Tab render crisp native squircles.
  static func writeICNS(image: NSImage, to url: URL) {
    let fm = FileManager.default
    let tempIconset = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("ls-fusion-\(UUID().uuidString).iconset", isDirectory: true)
    if (try? fm.createDirectory(at: tempIconset, withIntermediateDirectories: true)) != nil {
      defer { try? fm.removeItem(at: tempIconset) }
      let slots: [(pt: Int, scale: Int)] = [
        (16, 1), (16, 2), (32, 1), (32, 2),
        (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2),
      ]
      var wroteAll = true
      for slot in slots {
        let px = slot.pt * slot.scale
        guard let rep = NSBitmapImageRep(
          bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
          hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { wroteAll = false; break }
        rep.size = NSSize(width: slot.pt, height: slot.pt)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSGraphicsContext.current?.imageInterpolation = .high
        image.draw(in: NSRect(x: 0, y: 0, width: slot.pt, height: slot.pt), from: .zero, operation: .copy, fraction: 1.0)
        NSGraphicsContext.restoreGraphicsState()
        let name = slot.scale == 2 ? "icon_\(slot.pt)x\(slot.pt)@2x.png" : "icon_\(slot.pt)x\(slot.pt).png"
        guard let png = rep.representation(using: .png, properties: [:]),
              (try? png.write(to: tempIconset.appendingPathComponent(name))) != nil else {
          wroteAll = false
          break
        }
      }
      if wroteAll {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
        proc.arguments = ["-c", "icns", tempIconset.path, "-o", url.path]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        proc.waitUntilExit()
        if proc.terminationStatus == 0 && fm.fileExists(atPath: url.path) {
          return
        }
      }
    }

    let sizes = [1024, 512, 256, 128, 64, 32]
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "com.apple.icns" as CFString, sizes.count, nil) else { return }
    for px in sizes {
      guard let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: px * 4,
                                space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
      NSGraphicsContext.current?.imageInterpolation = .high
      image.draw(in: NSRect(x: 0, y: 0, width: px, height: px), from: .zero, operation: .copy, fraction: 1)
      NSGraphicsContext.restoreGraphicsState()
      if let cg = ctx.makeImage() {
        CGImageDestinationAddImage(dest, cg, nil)
      }
    }
    CGImageDestinationFinalize(dest)
  }

  static func mapCategory(_ raw: String) -> String {
    if raw.contains("developer-tools") { return "开发工具" }
    if raw.contains("productivity") || raw.contains("finance") || raw.contains("business") { return "效率" }
    if raw.contains("utilities") { return "实用工具" }
    if raw.contains("social-networking") { return "社交" }
    if raw.contains("entertainment") || raw.contains("games") || raw.contains("music") || raw.contains("video") { return "娱乐" }
    if raw.contains("graphics-design") || raw.contains("photography") { return "创意" }
    return "其他"
  }

  private func reloadGrid() {}

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

  private func clearAlerts(kind: String) {
    alerts = alerts.filter { ($0.value["kind"] as? String) != kind }
  }

  private var alertList: [[String: Any]] {
    alerts.values.sorted { (($0["at"] as? Int) ?? 0) < (($1["at"] as? Int) ?? 0) }
  }

  /// LinkShell Desktop reads this when the hub is gone, so "disconnected" carries its reason.
  private func writeExitStatus(reason: String) {
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
    case "tls", "token": return "融合连接的会话凭据已失效，请重新开启融合模式"
    case "unreachable", "failed": return "无法连接到远端 Mac 的融合服务"
    case "stopped": return "融合模式已停止"
    default: return "与远端 Mac 的融合连接已断开"
    }
  }

  private func updateStatus(_ text: String) {
    lastStatusText = text
    Fusion.log(text)
  }

  private func refreshStatus() {
    guard connected else { return }
    let activeApps = stubs.count
    let activeWins = windows.count
    lastStatusText = "\(hostLabel) 已连接 · RTT \(Int(rtt)) ms · 已融合 \(activeApps) 个应用 / \(activeWins) 个独立窗口"
  }
}

/// Connected per-app Stub `.app` process receiving zero-copy `IOSurface` frames via `DesktopFramePort`.
final class StubClient {
  let fd: Int32
  private weak var owner: FusionLocal?
  var bundle = ""
  var pid: pid_t = 0
  var port: DesktopFramePort?
  var closedByQuit = false
  var closedByHub = false
  private let writeLock = NSLock()
  private let frameLock = NSLock()
  private var closed = false
  private var serial: UInt64 = 0
  private var outstanding: [UInt64: CVPixelBuffer] = [:]
  private var outstandingWindow: [UInt64: CGWindowID] = [:]
  private var inFlightByWindow: [CGWindowID: Int] = [:]
  private var pendingOrder: [CGWindowID] = []
  private var pendingFrames: [CGWindowID: (CVPixelBuffer, IOSurface, Data)] = [:]

  init(fd: Int32, owner: FusionLocal) {
    self.fd = fd
    self.owner = owner
  }

  func startReading() {
    let sock = fd
    Thread.detachNewThread { [weak self] in
      var buffer = Data()
      var chunk = [UInt8](repeating: 0, count: 65536)
      while true {
        let n = Darwin.read(sock, &chunk, chunk.count)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { break }
        buffer.append(chunk, count: n)
        while let nl = buffer.firstIndex(of: 10) {
          let line = buffer.subdata(in: buffer.startIndex..<nl)
          buffer.removeSubrange(buffer.startIndex...nl)
          guard let msg = DesktopMediaIPC.message(line) else { continue }
          let type = msg["t"] as? String
          // Zero-main-thread fast path for 120fps IOSurface releases & pointer/scroll/key input!
          if type == "release" {
            if let tok = DesktopScreenBridge.integer(msg["token"]), tok >= 0 {
              self?.released(UInt64(tok))
            }
            continue
          }
          if type == "input" {
            self?.owner?.fastDeliverInput(msg)
            continue
          }
          DispatchQueue.main.async {
            guard let self else { return }
            if type == "activate" {
              self.owner?.handleActivate(client: self, message: msg)
            } else if type == "status" || type == "launchApp" || type == "quitApp" || type == "stopHub" {
              self.owner?.handleHubControl(client: self, message: msg)
            } else if type == "hello" {
              let b = msg["bundle"] as? String ?? ""
              let p = pid_t(DesktopScreenBridge.integer(msg["pid"]) ?? 0)
              let portName = msg["port"] as? String ?? ""
              self.owner?.stubDidRegister(self, bundle: b, pid: p, portName: portName)
            } else {
              self.owner?.stubDidReceive(self, message: msg)
            }
          }
        }
      }
      DispatchQueue.main.async {
        guard let self else { return }
        self.close()
        self.owner?.stubDidDisconnect(self)
      }
    }
  }

  func send(_ message: [String: Any]) {
    guard var data = DesktopMediaIPC.data(message) else { return }
    data.append(10)
    writeLock.lock()
    defer { writeLock.unlock() }
    guard !closed else { return }
    data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      var offset = 0
      while offset < raw.count {
        let n = Darwin.write(fd, base.advanced(by: offset), raw.count - offset)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { break }
        offset += n
      }
    }
  }

  func deliver(windowKey: CGWindowID, buffer: CVPixelBuffer, surface: IOSurface, metadata: Data) {
    frameLock.lock()
    guard !closed, let port else { frameLock.unlock(); return }
    // Allow at most 3 surfaces per window (1 displayed in `renderer.current` + 1 finishing GPU draw + 1 in Mach transit)
    // so frames never build a multi-frame FIFO inside the kernel Mach port queue; 4th+ frames overwrite a single-slot latest-wins mailbox!
    let inFlightForWin = inFlightByWindow[windowKey] ?? 0
    if inFlightForWin >= 3 || outstanding.count >= 12 {
      if pendingFrames[windowKey] == nil { pendingOrder.append(windowKey) }
      pendingFrames[windowKey] = (buffer, surface, metadata)
      frameLock.unlock()
      return
    }
    serial &+= 1
    let token = serial
    outstanding[token] = buffer
    outstandingWindow[token] = windowKey
    inFlightByWindow[windowKey] = inFlightForWin + 1
    frameLock.unlock()
    if !port.send(surface, token: token, metadata: metadata) {
      released(token)
    }
  }

  func released(_ token: UInt64) {
    var nextItem: (UInt64, IOSurface, Data, DesktopFramePort)?
    frameLock.lock()
    guard outstanding.removeValue(forKey: token) != nil else { frameLock.unlock(); return }
    if let winKey = outstandingWindow.removeValue(forKey: token) {
      let remaining = (inFlightByWindow[winKey] ?? 1) - 1
      if remaining <= 0 { inFlightByWindow.removeValue(forKey: winKey) } else { inFlightByWindow[winKey] = remaining }
    }
    if !closed, let port, outstanding.count < 12,
       let idx = pendingOrder.firstIndex(where: { (inFlightByWindow[$0] ?? 0) < 3 }) {
      let key = pendingOrder.remove(at: idx)
      if let (buf, surf, meta) = pendingFrames.removeValue(forKey: key) {
        serial &+= 1
        let nextToken = serial
        outstanding[nextToken] = buf
        outstandingWindow[nextToken] = key
        inFlightByWindow[key] = (inFlightByWindow[key] ?? 0) + 1
        nextItem = (nextToken, surf, meta, port)
      }
    }
    frameLock.unlock()
    if let (nextToken, surf, meta, port) = nextItem {
      if !port.send(surf, token: nextToken, metadata: meta) {
        released(nextToken)
      }
    }
  }

  func close() {
    writeLock.lock()
    let wasClosed = closed
    closed = true
    writeLock.unlock()
    guard !wasClosed else { return }
    frameLock.lock()
    outstanding.removeAll()
    outstandingWindow.removeAll()
    inFlightByWindow.removeAll()
    pendingFrames.removeAll()
    pendingOrder.removeAll()
    frameLock.unlock()
    port?.stop()
    Darwin.close(fd)
  }
}

final class FusionOutput: NSObject, DesktopScreenOutput {
  let key: String
  let windowID: CGWindowID?
  private weak var owner: FusionLocal?
  private let picture: (CVPixelBuffer, Data?) -> Void
  var onInput: (([String: Any], Bool) -> Void)?
  var onFirstFrame: (() -> Void)?
  var onFailure: ((String) -> Void)?
  var controlEnabled = false { didSet { owner?.controlChanged(key) } }
  var physicalKeys = false { didSet { owner?.controlChanged(key) } }
  private var first = true

  init(key: String, owner: FusionLocal, picture: @escaping (CVPixelBuffer, Data?) -> Void) {
    self.key = key
    self.windowID = key.hasPrefix("w") ? CGWindowID(key.dropFirst()) : nil
    self.owner = owner
    self.picture = picture
  }

  func setSize(_ size: CGSize) {}

  func renderFrame(_ frame: RTCVideoFrame?) {
    guard let frame, let buffer = frame.buffer as? RTCCVPixelBuffer else { return }
    let pixels = buffer.pixelBuffer
    let layout = FusionMetadata.layout(of: pixels)
    if first { first = false; onFirstFrame?() }
    if let wid = windowID, let owner {
      let k = key
      owner.frameQueue.async { [weak owner] in
        owner?.handleWindowPictureFast(id: wid, key: k, buffer: pixels, sei: layout)
      }
    } else {
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.picture(pixels, layout)
      }
    }
  }

  func updateCursor(_ message: [String: Any]) { owner?.cursor(key, message) }
  func stop() {}
}
