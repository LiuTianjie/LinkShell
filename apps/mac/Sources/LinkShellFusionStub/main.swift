import AppKit
import CoreVideo
import Darwin
import Foundation
import IOSurface
import LinkShellScreen

signal(SIGPIPE, SIG_IGN)

/// One local macOS `.app` process per fused remote application (`~/Applications/LinkShell/<Host>/<App>.app`).
/// Owns native `.resizable` macOS windows, Dock icon, ⌘Tab identity, and Metal `DesktopScreenSurface`s,
/// receiving zero-copy `IOSurface` frames over Mach ports (`DesktopFramePort`) from `FusionLocal`.
final class FusionStubApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private let bundleID: String
  private let appName: String
  private let socketPath: String
  private let computerKey: String
  private var hasRealBundleIcon: Bool
  private var fd: Int32 = -1
  private let sendLock = NSLock()
  private let winLock = NSLock()
  private var framePort: DesktopFramePort?
  private var windows: [CGWindowID: StubWindow] = [:]
  private var fastWindows: [CGWindowID: StubWindow] = [:]
  private var popups: [CGWindowID: StubPopup] = [:]
  private var dockItems: [[String: Any]] = []
  private var terminatingRemotely = false
  private var quitting = false
  /// Windows and popups already closed: a frame still in flight on the Mach port (which is not
  /// ordered against the socket) must not bring them back as ghosts.
  private var closedIDs = FusionTombstones(capacity: 512)
  private lazy var menuMirror = StubMenuMirror(owner: self)

  init(bundleID: String, appName: String, socketPath: String, computerKey: String, hasRealBundleIcon: Bool) {
    self.bundleID = bundleID
    self.appName = appName
    self.socketPath = socketPath
    self.computerKey = computerKey
    self.hasRealBundleIcon = hasRealBundleIcon
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    setupMainMenu()
    connectToHub(attempt: 0)
  }

  // The hub needs to know whether any fused app is active here: the remote apps look inactive
  // otherwise, and the clipboard only crosses while one is.
  func applicationDidBecomeActive(_ notification: Notification) {
    send(["t": "active", "on": true])
    menuMirror.refresh()
  }
  func applicationDidResignActive(_ notification: Notification) { send(["t": "active", "on": false]) }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if flag {
      for w in windows.values where w.window.isVisible { w.window.makeKeyAndOrderFront(nil) }
    } else {
      var restored = false
      for w in windows.values where w.window.isMiniaturized {
        w.window.deminiaturize(nil)
        restored = true
      }
      if !restored { send(["t": "reopen", "bundle": bundleID]) }
    }
    return true
  }

  func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let menu = NSMenu()
    let recents = dockItems.filter { ($0["section"] as? String) == "recent" }
    let actions = dockItems.filter { ($0["section"] as? String) != "recent" }

    if !recents.isEmpty {
      let header = NSMenuItem(title: "最近打开", action: nil, keyEquivalent: "")
      header.isEnabled = false
      menu.addItem(header)
      for entry in recents {
        guard let title = entry["title"] as? String, !title.isEmpty else { continue }
        let item = NSMenuItem(title: title, action: #selector(performDockMenuItem(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = entry["path"] ?? [Int]()
        menu.addItem(item)
      }
      menu.addItem(.separator())
    }

    if !actions.isEmpty {
      for entry in actions {
        guard let title = entry["title"] as? String, !title.isEmpty else { continue }
        let item = NSMenuItem(title: title, action: #selector(performDockMenuItem(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = entry["path"] ?? [Int]()
        menu.addItem(item)
      }
    } else {
      let fallback = NSMenuItem(title: "打开新窗口", action: #selector(performDockMenuItem(_:)), keyEquivalent: "")
      fallback.target = self
      fallback.representedObject = [Int]()
      menu.addItem(fallback)
    }
    return menu
  }

  @objc private func performDockMenuItem(_ sender: NSMenuItem) {
    let raw = (sender.representedObject as? [Any])?.compactMap { ($0 as? Int) ?? ($0 as? NSNumber)?.intValue } ?? []
    NSApp.activate(ignoringOtherApps: true)
    if raw.isEmpty {
      send(["t": "reopen", "bundle": bundleID])
    } else {
      send(["t": "dockaction", "bundle": bundleID, "path": raw])
    }
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard !quitting else { return .terminateNow }
    // With windows open, the remote app decides: it may answer with a "save changes?" sheet that
    // must stay visible here. The hub's `app.exited` ends this process once it has really quit.
    // Logging out or shutting down this Mac is not a request to quit the remote app, and must
    // never be held up by it.
    if !terminatingRemotely, fd >= 0, !windows.isEmpty, !Self.systemIsQuitting {
      send(["t": "quit", "bundle": bundleID])
      return .terminateCancel
    }
    quitting = true
    let openWins = Array(windows.values)
    let openPopups = Array(popups.values)
    windows.removeAll()
    winLock.lock()
    fastWindows.removeAll()
    winLock.unlock()
    popups.removeAll()
    openPopups.forEach { $0.close() }
    openWins.forEach { $0.close() }
    if Self.systemIsQuitting {
      // Leaves the remote app running and tells the hub not to bring this stub back.
      send(["t": "detach"])
    } else if !terminatingRemotely {
      send(["t": "quit", "bundle": bundleID])
    }
    framePort?.stop()
    if fd >= 0 { Darwin.close(fd); fd = -1 }
    return .terminateNow
  }

  /// In the system language: the stub is this Mac's app, whatever the remote app is written in.
  func makeAppMenu() -> NSMenu {
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: FusionStubText.hide(appName), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = appMenu.addItem(withTitle: FusionStubText.hideOthers, action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(withTitle: FusionStubText.showAll, action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: FusionStubText.quit(appName), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    return appMenu
  }

  func makeWindowMenu() -> NSMenu {
    let winMenu = NSMenu(title: FusionStubText.window)
    winMenu.addItem(withTitle: FusionStubText.minimize, action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    winMenu.addItem(withTitle: FusionStubText.zoom, action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    let cycle = winMenu.addItem(withTitle: FusionStubText.cycleWindows, action: #selector(cycleWindowsAction(_:)), keyEquivalent: "`")
    cycle.target = self
    let fsItem = winMenu.addItem(withTitle: FusionStubText.enterFullScreen, action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
    fsItem.keyEquivalentModifierMask = [.command, .control]
    return winMenu
  }

  @objc private func cycleWindowsAction(_ sender: Any?) { cycleWindows(backward: false) }

  /// ⌘` among this stub's own windows, as any Mac app does.
  func cycleWindows(backward: Bool) {
    let list = windows.values.map(\.window).filter { $0.isVisible && !$0.isMiniaturized }.sorted { $0.windowNumber < $1.windowNumber }
    guard list.count > 1 else { return }
    let current = list.firstIndex { $0.isKeyWindow } ?? 0
    let next = (current + (backward ? list.count - 1 : 1)) % list.count
    list[next].makeKeyAndOrderFront(nil)
  }

  /// The chords a fused window keeps on this Mac (see `FusionShortcuts`).
  func handleLocalShortcut(_ event: NSEvent, window: NSWindow) -> Bool {
    guard let shortcut = FusionShortcuts.local(keyCode: event.keyCode, modifiers: event.modifierFlags) else {
      if event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) { prewarm(id: 0) }
      return false
    }
    switch shortcut {
    case .hide: NSApp.hide(nil)
    case .hideOthers: NSApp.hideOtherApplications(nil)
    case .minimize: if !window.styleMask.contains(.fullScreen) { window.miniaturize(nil) }
    case .cycleWindows: cycleWindows(backward: false)
    case .cycleWindowsBackward: cycleWindows(backward: true)
    }
    return true
  }

  private var lastPrewarm = 0.0

  /// A menu may open next: the remote warms its popup stream (throttled, it is only a hint).
  func prewarm(id: CGWindowID) {
    let now = CACurrentMediaTime()
    guard now - lastPrewarm > 0.5 else { return }
    lastPrewarm = now
    send(["t": "prewarm", "id": Int(id)])
  }

  private static var systemIsQuitting: Bool {
    guard let reason = NSAppleEventManager.shared().currentAppleEvent?
      .attributeDescriptor(forKeyword: AEKeyword(kAEQuitReason))?.enumCodeValue else { return false }
    let systemReasons: [OSType] = [OSType(kAELogOut), OSType(kAEReallyLogOut), OSType(kAEShowRestartDialog), OSType(kAERestart), OSType(kAEShowShutdownDialog), OSType(kAEShutDown)]
    return systemReasons.contains(reason)
  }

  private func setupMainMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    appItem.submenu = makeAppMenu()

    let winItem = NSMenuItem()
    main.addItem(winItem)
    let winMenu = makeWindowMenu()
    winItem.submenu = winMenu
    NSApp.windowsMenu = winMenu
    NSApp.mainMenu = main
  }

  // MARK: Hub IPC (Unix domain socket + Mach IOSurface port)

  private var connectingWindow: StubConnectingWindow?
  private var connectBeganAt = 0.0
  private var hubOpenedAt = 0.0

  /// Opened from the Dock or Spotlight with no hub running: LinkShell is asked to connect, and a
  /// small window says so (with the real reason if it fails) instead of the icon bouncing and the
  /// stub silently giving up.
  private func connectToHub(attempt: Int) {
    if attempt == 0 { connectBeganAt = CACurrentMediaTime() }
    if let sock = Self.dial(socketPath) {
      connectingWindow?.close()
      connectingWindow = nil
      fd = sock
      guard let port = DesktopFramePort(receiver: true) else { exit(1) }
      framePort = port
      readLoop(sock)
      send(["t": "hello", "bundle": bundleID, "pid": Int(getpid()), "port": port.name])
      if NSApp.isActive { send(["t": "active", "on": true]) }
      return
    }
    if attempt == 0 { openHub() }
    let elapsed = CACurrentMediaTime() - connectBeganAt
    if elapsed > 0.6, connectingWindow == nil {
      let window = StubConnectingWindow(computer: hostName, onRetry: { [weak self] in
        guard let self else { return }
        self.connectBeganAt = CACurrentMediaTime()
        self.openHub()
        self.connectingWindow?.showConnecting()
      }, onOpenLinkShell: { [weak self] in
        self?.openHub(showWindow: true)
      }, onCancel: {
        exit(0)
      })
      connectingWindow = window
      window.show()
    }
    if elapsed > 25, connectingWindow?.failed == false {
      connectingWindow?.showFailure(Self.lastHubError(socketPath: socketPath) ?? FusionStubText.failedToConnect)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.connectToHub(attempt: attempt + 1) }
  }

  private var hostName: String {
    (Bundle.main.object(forInfoDictionaryKey: "LSFusionHostName") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Remote"
  }

  private func openHub(showWindow: Bool = false) {
    guard let hubApp = Bundle.main.object(forInfoDictionaryKey: "LSFusionHubApp") as? String,
          FileManager.default.fileExists(atPath: hubApp) else { return }
    let now = CACurrentMediaTime()
    guard showWindow || now - hubOpenedAt > 3 else { return }
    hubOpenedAt = now
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.createsNewApplicationInstance = true
    var arguments = ["--dashboard"]
    if !computerKey.isEmpty {
      arguments += ["--fusion-connect", computerKey]
      if !showWindow { arguments += ["--fusion-launch", bundleID] }
    }
    cfg.arguments = arguments
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: hubApp), configuration: cfg, completionHandler: nil)
  }

  /// The hub writes why it last exited next to its socket; only a recent reason is worth showing.
  static func lastHubError(socketPath: String) -> String? {
    let path = socketPath.hasSuffix(".sock") ? String(socketPath.dropLast(5)) + ".status.json" : socketPath + ".status.json"
    guard let data = FileManager.default.contents(atPath: path),
          let info = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let message = info["message"] as? String, !message.isEmpty else { return nil }
    let at = (info["at"] as? NSNumber)?.doubleValue ?? 0
    guard Date().timeIntervalSince1970 * 1000 - at < 120_000 else { return nil }
    return message
  }

  static func dial(_ path: String) -> Int32? {
    let sock = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard sock >= 0 else { return nil }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(path.utf8CString)
    guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { Darwin.close(sock); return nil }
    withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
      ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { dst in
        for i in 0..<pathBytes.count { dst[i] = pathBytes[i] }
      }
    }
    let connected = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(sock, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard connected == 0 else { Darwin.close(sock); return nil }
    return sock
  }

  func send(_ message: [String: Any]) {
    guard var data = DesktopMediaIPC.data(message) else { return }
    data.append(10)
    sendLock.lock()
    defer { sendLock.unlock() }
    guard fd >= 0 else { return }
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

  private func readLoop(_ sock: Int32) {
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
          DispatchQueue.main.async { self?.handle(msg) }
        }
      }
      DispatchQueue.main.async {
        guard let self, !self.quitting else { return }
        self.terminatingRemotely = true
        NSApp.terminate(nil)
      }
    }
  }

  private func handle(_ m: [String: Any]) {
    switch m["t"] as? String {
    case "welcome":
      if NSApp.isActive { menuMirror.refresh() }
      if let hubPid = DesktopScreenBridge.integer(m["hubPid"]) {
        framePort?.receive(child: pid_t(hubPid)) { [weak self] surface, token, metadata in
          guard let self, let surface else { self?.send(["t": "release", "token": Int(token)]); return }
          self.receiveSurface(surface, token: token, metadata: metadata)
        }
      }
    case "wopen":
      let id = CGWindowID(DesktopScreenBridge.integer(m["id"]) ?? 0)
      guard id != 0 else { return }
      closedIDs.remove(id)
      let frame = Self.rect(m["frame"])
      let toolbar = m["toolbar"] as? Bool == true
      let radius = (m["r"] as? NSNumber)?.doubleValue ?? (toolbar ? 26.0 : 17.0)
      let win = ensureWindow(id, toolbar: toolbar, radius: radius, title: m["title"] as? String ?? appName)
      if !win.shownOnce { win.activateOnShow = m["activate"] as? Bool ?? true }
      win.updateChrome(buttons: Self.parseButtons(m["buttons"]), hitrects: Self.parseHitRects(m["hitrects"]))
      if let ack = DesktopScreenBridge.integer(m["ack"]), ack > 0 {
        win.ackedSeq = max(win.ackedSeq, UInt64(ack))
      }
      if win.cgFrame == .zero, frame.width > 10 { win.placeFromRemote(frame) }
      if let ctrl = m["control"] as? Bool, ctrl {
        win.setControl(enabled: true, keys: m["keys"] as? Bool ?? true)
      }
    case "style":
      let id = CGWindowID(DesktopScreenBridge.integer(m["id"]) ?? 0)
      if let win = windows[id] {
        let toolbar = m["toolbar"] as? Bool == true
        win.setToolbarMode(toolbar)
        if let r = (m["r"] as? NSNumber)?.doubleValue, r >= 6 {
          win.setCornerRadius(CGFloat(r))
        }
        if let title = m["title"] as? String, !title.isEmpty {
          win.updateTitle(title)
        }
        if m["buttons"] != nil || m["hitrects"] != nil {
          win.updateChrome(buttons: Self.parseButtons(m["buttons"]), hitrects: Self.parseHitRects(m["hitrects"]))
        }
      }
    case "chrome":
      let id = CGWindowID(DesktopScreenBridge.integer(m["id"]) ?? 0)
      windows[id]?.updateChrome(buttons: Self.parseButtons(m["buttons"]), hitrects: Self.parseHitRects(m["hitrects"]))
    case "wlayout":
      let id = CGWindowID(DesktopScreenBridge.integer(m["id"]) ?? 0)
      let ack = UInt64(max(0, DesktopScreenBridge.integer(m["ack"]) ?? 0))
      windows[id]?.receiveRemoteLayout(Self.rect(m["frame"]), ackSeq: ack)
    case "fullscreen":
      let id = CGWindowID(DesktopScreenBridge.integer(m["id"]) ?? 0)
      windows[id]?.setLocalFullScreen(m["on"] as? Bool ?? true)
    case "minimize":
      let id = CGWindowID(DesktopScreenBridge.integer(m["id"]) ?? 0)
      if let w = windows[id]?.window, !w.isMiniaturized, !w.styleMask.contains(.fullScreen) {
        w.miniaturize(nil)
      }
    case "title":
      let id = CGWindowID(DesktopScreenBridge.integer(m["id"]) ?? 0)
      if let title = m["title"] as? String, !title.isEmpty {
        windows[id]?.updateTitle(title)
      }
    case "dockmenu":
      if let items = m["items"] as? [[String: Any]] {
        dockItems = items
      }
    case "menu":
      let path = (m["path"] as? [Any])?.compactMap { ($0 as? NSNumber)?.intValue } ?? []
      menuMirror.receive(path: path, items: m["error"] as? Bool == true ? nil : m["items"] as? [[String: Any]])
    case "hidden":
      if m["on"] as? Bool == true {
        if !NSApp.isHidden { NSApp.hide(nil) }
      } else if NSApp.isHidden {
        NSApp.unhideWithoutActivation()
      }
    case "control":
      let key = m["key"] as? String ?? ""
      let enabled = m["enabled"] as? Bool == true
      let keys = m["keys"] as? Bool == true
      if key.hasPrefix("w"), let id = CGWindowID(key.dropFirst()) {
        // Keep local Stub surface ready for first-click input; `DesktopScreenReceiver` in FusionLocal
        // already enforces the remote capability & permission gate before forwarding onto WebRTC.
        if enabled { windows[id]?.setControl(enabled: true, keys: keys) }
      } else {
        for p in popups.values where p.streamKey == key {
          if enabled {
            p.surface.controlEnabled = true
            p.surface.physicalKeys = keys
          }
        }
      }
    case "cursor":
      let key = m["key"] as? String ?? ""
      guard let cursor = m["m"] as? [String: Any] else { return }
      if key.hasPrefix("w"), let id = CGWindowID(key.dropFirst()) {
        windows[id]?.surface.updateCursor(cursor)
      } else {
        for w in windows.values { w.surface.updateCursor(cursor) }
      }
    case "front":
      let id = CGWindowID(DesktopScreenBridge.integer(m["id"]) ?? 0)
      if let w = windows[id]?.window, w.isVisible {
        if NSApp.isActive { w.makeKeyAndOrderFront(nil) } else { w.orderFront(nil) }
      }
    case "popup.hide":
      let id = CGWindowID(DesktopScreenBridge.integer(m["id"]) ?? 0)
      closedIDs.insert(id)
      if let p = popups.removeValue(forKey: id) { p.close() }
    case "wclose":
      let id = CGWindowID(DesktopScreenBridge.integer(m["id"]) ?? 0)
      closedIDs.insert(id)
      if let w = windows.removeValue(forKey: id) {
        winLock.lock()
        fastWindows.removeValue(forKey: id)
        winLock.unlock()
        w.close()
      }
      for (pid, p) in popups where p.parentID == id { p.close(); popups[pid] = nil }
    case "app.icon":
      // When `AppIcon.icns` already carries the v3 full-size squircle (`LSFusionRealIcon == true`),
      // let macOS 26 `IconServices` render `AppIcon.icns` natively in the Dock without runtime override.
      if (!hasRealBundleIcon || (m["force"] as? Bool == true)),
         let b64 = m["png"] as? String, let data = Data(base64Encoded: b64), let img = NSImage(data: data) {
        NSApp.applicationIconImage = img
        hasRealBundleIcon = true
      }
    case "app.exited":
      terminatingRemotely = true
      NSApp.terminate(nil)
    default:
      break
    }
  }

  private func receiveSurface(_ surface: IOSurface, token: UInt64, metadata: Data) {
    guard let values = try? JSONSerialization.jsonObject(with: metadata) as? [String: Any],
          let widInt = DesktopScreenBridge.integer(values["wid"]), widInt > 0,
          let picture = DesktopScreenFrame.importSurface(surface, metadata: metadata, release: { [weak self] in
            self?.send(["t": "release", "token": Int(token)])
          }) else {
      send(["t": "release", "token": Int(token)])
      return
    }
    let wid = CGWindowID(widInt)
    let isPopup = values["popup"] as? Bool == true
    let fArr = values["f"] as? [Double]
    let iArr = values["in"] as? [Double]
    let relArr = values["rel"] as? [Double]
    let parentID = CGWindowID(DesktopScreenBridge.integer(values["parent"]) ?? 0)
    let streamKey = values["key"] as? String ?? "w\(wid)"
    let dispSize = (values["disp"] as? [Double]).flatMap { $0.count == 2 ? CGSize(width: $0[0], height: $0[1]) : nil }
    let frameScale = (values["fscale"] as? NSNumber)?.doubleValue ?? 1.0
    let frameAck = UInt64(max(0, DesktopScreenBridge.integer(values["fack"]) ?? 0))

    // Steady-state zero-main-thread presentation: if the window is calm and its geometry matches,
    // submit directly to `CAMetalLayer` from the Mach receiver thread (`< 0.35 ms`, 0 main-thread hops)!
    if !isPopup {
      let remoteSize = (fArr?.count == 4) ? CGSize(width: fArr![2], height: fArr![3]) : .zero
      let inRect = (iArr?.count == 4) ? CGRect(x: iArr![0], y: iArr![1], width: iArr![2], height: iArr![3]) : nil
      winLock.lock()
      let fastWin = fastWindows[wid]
      winLock.unlock()
      if let fastWin, fastWin.tryPresentOffMainThread(picture: picture, remoteSize: remoteSize, inRect: inRect, frameScale: frameScale) {
        return
      }
    }

    DispatchQueue.main.async { [weak self] in
      guard let self, !self.quitting else { return }
      if isPopup {
        guard let fArr, fArr.count == 4 else { return }
        var frame = CGRect(x: fArr[0], y: fArr[1], width: fArr[2], height: fArr[3])
        if let relArr, relArr.count == 2, let parentWin = self.windows[parentID] {
          let pf = parentWin.currentCGFrame()
          frame.origin = CGPoint(x: pf.minX + relArr[0], y: pf.minY + relArr[1])
        }
        let inRect = (iArr?.count == 4) ? CGRect(x: iArr![0], y: iArr![1], width: iArr![2], height: iArr![3]) : CGRect(origin: .zero, size: frame.size)
        guard !self.closedIDs.contains(wid), !self.closedIDs.contains(parentID) else { return }
        let popup = self.ensurePopup(wid, parentID: parentID, streamKey: streamKey)
        if self.windows[parentID]?.isDragging != true { popup.place(frame) }
        if let layer = DesktopScreenBridge.integer(values["layer"]) { popup.setRemoteLayer(layer) }
        popup.crop = CGRect(x: picture.cropX, y: picture.cropY, width: picture.cropWidth, height: picture.cropHeight)
        popup.displayPixels = dispSize ?? CGSize(width: surface.width, height: surface.height)
        popup.show(picture, inRect: inRect)
      } else {
        // Windows exist only from `wopen`: a frame alone (late, after `wclose`) never creates one.
        guard let win = self.windows[wid] else { return }
        let remoteSize = (fArr?.count == 4) ? CGSize(width: fArr![2], height: fArr![3]) : .zero
        let inRect = (iArr?.count == 4) ? CGRect(x: iArr![0], y: iArr![1], width: iArr![2], height: iArr![3]) : nil
        win.show(picture, remoteSize: remoteSize, inRect: inRect, frameScale: frameScale, frameAck: frameAck)
      }
    }
  }

  private func ensureWindow(_ id: CGWindowID, toolbar: Bool, radius: Double, title: String) -> StubWindow {
    if let existing = windows[id] { return existing }
    let created = StubWindow(id: id, title: title, toolbar: toolbar, radius: CGFloat(radius), owner: self)
    windows[id] = created
    winLock.lock()
    fastWindows[id] = created
    winLock.unlock()
    return created
  }

  private func ensurePopup(_ id: CGWindowID, parentID: CGWindowID, streamKey: String) -> StubPopup {
    if let existing = popups[id] { return existing }
    let popup = StubPopup(id: id, parentID: parentID, streamKey: streamKey, owner: self)
    if let parent = windows[parentID] {
      parent.window.addChildWindow(popup.window, ordered: .above)
    }
    popups[id] = popup
    return popup
  }

  // MARK: NSWindowDelegate

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    guard let w = sender as? FusionNativeWindow, let stub = windows[w.remoteID] else { return true }
    if stub.closingLocally || quitting { return true }
    send(["t": "wclose.req", "id": Int(w.remoteID)])
    return false
  }

  func windowDidBecomeKey(_ notification: Notification) {
    guard let w = notification.object as? FusionNativeWindow else { return }
    send(["t": "focus", "id": Int(w.remoteID)])
  }

  func windowDidResignKey(_ notification: Notification) {}

  func windowWillStartLiveResize(_ notification: Notification) {
    guard let w = notification.object as? FusionNativeWindow, let stub = windows[w.remoteID] else { return }
    stub.beginLiveResize()
  }

  func windowDidResize(_ notification: Notification) {
    guard let w = notification.object as? FusionNativeWindow, let stub = windows[w.remoteID] else { return }
    stub.updateSurfaceLayout()
    guard !stub.isApplyingRemoteFrame, !stub.isSettling, stub.shownOnce else { return }
    if stub.isResizing {
      // Silent background pre-sync only when mouse pauses >= 160ms; visual presentation stays frozen
      // cleanly to the local window until mouse-up (`windowDidEndLiveResize`).
      stub.scheduleSilentResizePreSync()
    } else if stub.inFullScreenTransition {
      return
    } else {
      // System-initiated resize (macOS Tahoe Window Tiling, Menu Zoom, Rectangle/Raycast AX):
      // lock causal sequence immediately at 0ms and dispatch coalesced resize sync!
      stub.scheduleProgrammaticGeometrySync(resize: true)
    }
  }

  func windowDidEndLiveResize(_ notification: Notification) {
    guard let w = notification.object as? FusionNativeWindow, let stub = windows[w.remoteID] else { return }
    stub.endLiveResize()
  }

  func windowDidMove(_ notification: Notification) {
    guard let w = notification.object as? FusionNativeWindow, let stub = windows[w.remoteID] else { return }
    guard !stub.isApplyingRemoteFrame, !stub.isSettling, stub.shownOnce else { return }
    if stub.inFullScreenTransition || stub.isResizing { return }
    if stub.isDragging {
      // Silent background pre-sync only if the user's hand pauses >= 200ms while still holding the
      // mouse button down; local presentation stays 100% frozen until mouse-up!
      stub.scheduleSilentDragPreSync()
      return
    }
    if NSEvent.pressedMouseButtons & 1 != 0 {
      // Any system/gesture mouse-held move (`Ctrl+Cmd+Drag`, Tiling drag, etc.) freezes presentation
      // immediately and waits for mouse release just like a titlebar drag!
      stub.beginExternalMouseDrag()
      return
    }
    stub.scheduleProgrammaticGeometrySync(resize: false)
  }

  func windowWillEnterFullScreen(_ notification: Notification) {
    guard let w = notification.object as? FusionNativeWindow, let stub = windows[w.remoteID] else { return }
    stub.willEnterFullScreen()
  }

  func windowDidEnterFullScreen(_ notification: Notification) {
    guard let w = notification.object as? FusionNativeWindow, let stub = windows[w.remoteID] else { return }
    stub.didEnterFullScreen()
  }

  func windowWillExitFullScreen(_ notification: Notification) {
    guard let w = notification.object as? FusionNativeWindow, let stub = windows[w.remoteID] else { return }
    stub.willExitFullScreen()
  }

  func windowDidExitFullScreen(_ notification: Notification) {
    guard let w = notification.object as? FusionNativeWindow, let stub = windows[w.remoteID] else { return }
    stub.didExitFullScreen()
  }

  static func parseButtons(_ any: Any?) -> [String: CGRect] {
    guard let raw = any as? [String: Any] else { return [:] }
    var out: [String: CGRect] = [:]
    for (k, v) in raw {
      if let arr = (v as? [Any])?.compactMap({ ($0 as? NSNumber)?.doubleValue }), arr.count == 4 {
        out[k] = CGRect(x: arr[0], y: arr[1], width: arr[2], height: arr[3])
      }
    }
    return out
  }

  static func parseHitRects(_ any: Any?) -> [CGRect] {
    guard let raw = any as? [Any] else { return [] }
    return raw.compactMap { item in
      guard let arr = (item as? [Any])?.compactMap({ ($0 as? NSNumber)?.doubleValue }), arr.count == 4 else { return nil }
      return CGRect(x: arr[0], y: arr[1], width: arr[2], height: arr[3])
    }
  }

  static func rect(_ any: Any?) -> CGRect {
    guard let d = any as? [String: Any] else { return .zero }
    func num(_ v: Any?) -> Double { (v as? Double) ?? Double((v as? Int) ?? 0) }
    return CGRect(x: num(d["x"]), y: num(d["y"]), width: num(d["w"]), height: num(d["h"]))
  }

  static func dict(_ r: CGRect) -> [String: Double] {
    ["x": r.origin.x, "y": r.origin.y, "w": r.size.width, "h": r.size.height]
  }
}

final class FusionNativeWindow: NSWindow {
  var remoteID: CGWindowID = 0
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { styleMask.contains(.titled) || styleMask.contains(.fullScreen) }
}

/// The stub's only window of its own: shown while LinkShell connects, with the reason if it cannot.
final class StubConnectingWindow: NSObject {
  private let panel: NSPanel
  private let title = NSTextField(labelWithString: "")
  private let detail = NSTextField(wrappingLabelWithString: "")
  private let spinner = NSProgressIndicator()
  private let retry: NSButton
  private let open: NSButton
  private let cancel: NSButton
  private let onRetry: () -> Void
  private let onOpen: () -> Void
  private let onCancel: () -> Void
  private(set) var failed = false

  init(computer: String, onRetry: @escaping () -> Void, onOpenLinkShell: @escaping () -> Void, onCancel: @escaping () -> Void) {
    self.onRetry = onRetry
    self.onOpen = onOpenLinkShell
    self.onCancel = onCancel
    panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 150), styleMask: [.titled], backing: .buffered, defer: false)
    retry = NSButton(title: FusionStubText.retry, target: nil, action: nil)
    open = NSButton(title: FusionStubText.openLinkShell, target: nil, action: nil)
    cancel = NSButton(title: FusionStubText.cancel, target: nil, action: nil)
    super.init()
    panel.title = ""
    panel.isReleasedWhenClosed = false
    panel.center()
    title.stringValue = FusionStubText.connecting(computer)
    title.font = .systemFont(ofSize: 14, weight: .semibold)
    detail.stringValue = FusionStubText.stillConnecting
    detail.textColor = .secondaryLabelColor
    detail.font = .systemFont(ofSize: 12)
    spinner.style = .spinning
    spinner.controlSize = .small
    spinner.startAnimation(nil)
    for (button, action) in [(retry, #selector(retryPressed)), (open, #selector(openPressed)), (cancel, #selector(cancelPressed))] {
      button.target = self
      button.action = action
      button.bezelStyle = .rounded
    }
    retry.keyEquivalent = "\r"
    cancel.keyEquivalent = "\u{1b}"
    retry.isHidden = true
    let header = NSStackView(views: [spinner, title])
    header.spacing = 8
    let buttons = NSStackView(views: [cancel, open, retry])
    buttons.spacing = 8
    let stack = NSStackView(views: [header, detail, buttons])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12
    stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 18, right: 20)
    stack.translatesAutoresizingMaskIntoConstraints = false
    let content = NSView()
    content.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      stack.topAnchor.constraint(equalTo: content.topAnchor),
      stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      detail.widthAnchor.constraint(equalToConstant: 340),
    ])
    panel.contentView = content
  }

  func show() {
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
  }

  func showConnecting() {
    failed = false
    spinner.isHidden = false
    spinner.startAnimation(nil)
    detail.stringValue = FusionStubText.stillConnecting
    retry.isHidden = true
  }

  func showFailure(_ message: String) {
    failed = true
    spinner.stopAnimation(nil)
    spinner.isHidden = true
    detail.stringValue = message
    retry.isHidden = false
  }

  func close() { panel.orderOut(nil) }

  @objc private func retryPressed() { onRetry() }
  @objc private func openPressed() { onOpen() }
  @objc private func cancelPressed() { onCancel() }
}

/// Remote menus, tooltips and palettes. Never key, never activating: clicking a menu item must not
/// take the focus from the window the menu belongs to.
final class FusionPopupPanel: NSPanel {
  var remoteID: CGWindowID = 0
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class StubFlippedView: NSView {
  override var isFlipped: Bool { true }
}

/// A genuine native macOS `.resizable` window representing one remote root window,
/// backed by a monotonic `localSeq` / `ackedSeq` eventual-consistency state machine,
/// off-main-thread 120fps Metal presentation, and seamless full-window frosted-glass live resize.
final class StubWindow {
  struct BufferedFrame {
    let picture: DesktopScreenFrame
    let remoteSize: CGSize
    let inRect: CGRect?
    let scale: Double
    let ack: UInt64
  }

  let id: CGWindowID
  let window: FusionNativeWindow
  let container = StubFlippedView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
  let backdropView = NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
  let surface = DesktopScreenSurface(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
  private weak var owner: FusionStubApp?
  var cgFrame: CGRect = .zero
  var isDragging = false
  var isResizing = false
  var isFullScreen = false
  var inFullScreenTransition = false
  var isApplyingRemoteFrame = false
  var closingLocally = false
  var shownOnce = false
  /// Set from `wopen`: only a window that follows the person's own action takes the focus.
  var activateOnShow = true
  var localSeq: UInt64 = 0
  var ackedSeq: UInt64 = 0
  private var savedCornerRadius: CGFloat = 17
  private var toolbarEnabled = false
  private var closeRect: CGRect?
  private var minRect: CGRect?
  private var zoomRect: CGRect?
  private var hitRects: [CGRect] = []
  private var preZoomCGFrame: CGRect?
  private var lastRemoteFullSize: CGSize = .zero
  private var lastInRect: CGRect = .zero
  private var lastDisplayedScale: Double = 1.0
  private var resizeThrottle = FusionResizeThrottle(interval: 1.0 / 30)
  private var pendingBufferedFrame: BufferedFrame?
  private var awaitingPostReleaseFrame = false
  private var awaitingScale: Double = 1.0
  private var lastSentCGFrame: CGRect = .zero
  private var lastSentWasResize = false
  private var postAckFrameGraceUntil: Double = 0
  private var graceSettleTimer: Timer?
  private var preSyncResizeTimer: Timer?
  private var preSyncDragTimer: Timer?
  private var postReleaseUnlockTimer: Timer?
  private var programmaticSyncTimer: Timer?
  private var pendingProgrammaticResize = false
  private var lastSent: Double = 0
  private var dragWatchTimer: Timer?

  // Lock-protected steady-state snapshot for off-main-thread 120fps Mach -> Metal presentation
  private let fastStateLock = NSLock()
  private var fastReady = false
  private var fastContainerSize: CGSize = .zero
  private var fastLastInRect: CGRect = .zero
  private var fastLastScale: Double = 1.0

  init(id: CGWindowID, title: String, toolbar: Bool, radius: CGFloat, owner: FusionStubApp) {
    self.id = id
    self.owner = owner
    self.savedCornerRadius = min(max(radius, 8), 34)
    window = FusionNativeWindow(
      contentRect: NSRect(x: 120, y: 120, width: 800, height: 600),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.remoteID = id
    window.title = title
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    if #available(macOS 11.0, *) { window.titlebarSeparatorStyle = .none }
    window.standardWindowButton(.closeButton)?.isHidden = true
    window.standardWindowButton(.miniaturizeButton)?.isHidden = true
    window.standardWindowButton(.zoomButton)?.isHidden = true
    window.isOpaque = false
    window.backgroundColor = .clear
    // `isMovable = true` + `isMovableByWindowBackground = false` allows AppKit's native
    // `window.performDrag(with:)` to move the window across monitors at 0ms local latency,
    // while `DesktopScreenSurface` never lets content drags move the window accidentally.
    window.isMovable = true
    window.isMovableByWindowBackground = false
    window.isExcludedFromWindowsMenu = false
    window.isReleasedWhenClosed = false
    window.hasShadow = true
    window.acceptsMouseMovedEvents = true
    window.collectionBehavior = [.managed, .participatesInCycle, .fullScreenPrimary]
    window.minSize = NSSize(width: 200, height: 120)
    window.delegate = owner
    NSApp.addWindowsItem(window, title: title.isEmpty ? "Window" : title, filename: false)

    container.wantsLayer = true
    container.layer?.backgroundColor = NSColor.clear.cgColor
    container.layer?.cornerCurve = .continuous
    container.layer?.masksToBounds = true
    container.layer?.cornerRadius = savedCornerRadius

    // While the remote catches up with a resize, the uncovered strip shows the window's own
    // background colour: an ordinary window being resized, not a frosted "please wait" sheet.
    backdropView.wantsLayer = true
    backdropView.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    backdropView.autoresizingMask = [.width, .height]
    backdropView.isHidden = true
    container.addSubview(backdropView)

    surface.fillsBounds = true
    surface.controlEnabled = true
    surface.physicalKeys = true
    container.addSubview(surface)

    window.contentView = container

    setToolbarMode(toolbar)

    surface.onInput = { [weak self] event, replaceable in
      guard let self else { return }
      var mapped = event
      if let x = event["x"] as? Double, let y = event["y"] as? Double,
         self.lastRemoteFullSize.width > 10, self.lastRemoteFullSize.height > 10,
         self.lastInRect.width > 10, self.lastInRect.height > 10 {
        if abs(self.lastInRect.width - self.lastRemoteFullSize.width) > 1.5
          || abs(self.lastInRect.height - self.lastRemoteFullSize.height) > 1.5
          || abs(self.lastInRect.minX) > 1.5
          || abs(self.lastInRect.minY) > 1.5 {
          mapped["x"] = min(1, max(0, (Double(self.lastInRect.minX) + x * Double(self.lastInRect.width)) / Double(self.lastRemoteFullSize.width)))
          mapped["y"] = min(1, max(0, (Double(self.lastInRect.minY) + y * Double(self.lastInRect.height)) / Double(self.lastRemoteFullSize.height)))
        }
      }
      self.owner?.send(["t": "input", "key": "w\(self.id)", "m": mapped, "r": replaceable])
    }

    surface.onLocalMouseDown = { [weak self] downEvent in
      guard let self else { return false }
      let spt = self.surface.convert(downEvent.locationInWindow, from: nil)
      if let cr = self.closeRect, cr.insetBy(dx: -3, dy: -3).contains(spt) {
        self.owner?.send(["t": "wclose.req", "id": Int(self.id)])
        return true
      }
      if let mr = self.minRect, mr.insetBy(dx: -3, dy: -3).contains(spt) {
        if !self.isFullScreen && !self.window.styleMask.contains(.fullScreen) {
          self.window.miniaturize(nil)
        }
        return true
      }
      if let zr = self.zoomRect, zr.insetBy(dx: -3, dy: -3).contains(spt) {
        if downEvent.modifierFlags.contains(.option), !self.isFullScreen, !self.window.styleMask.contains(.fullScreen) {
          self.toggleLocalZoom()
        } else {
          self.window.toggleFullScreen(nil)
        }
        return true
      }
      if !self.isFullScreen, !self.window.styleMask.contains(.fullScreen),
         downEvent.clickCount == 2, self.isDraggableChrome(spt) {
        self.toggleLocalZoom()
        return true
      }
      return false
    }

    surface.shouldDragWindow = { [weak self] downEvent in
      guard let self, downEvent.clickCount == 1 else { return false }
      guard !self.isFullScreen, !self.inFullScreenTransition, !self.window.styleMask.contains(.fullScreen) else { return false }
      let spt = self.surface.convert(downEvent.locationInWindow, from: nil)
      return self.isDraggableChrome(spt)
    }

    surface.localKeyEquivalent = { [weak self] event in
      guard let self, let owner = self.owner else { return false }
      return owner.handleLocalShortcut(event, window: self.window)
    }
    surface.onPointerDown = { [weak self] in
      guard let self else { return }
      self.owner?.prewarm(id: self.id)
    }

    surface.onWindowDragStarted = { [weak self] in
      self?.beginNativeDrag()
    }
    surface.onWindowDragEnded = { [weak self] in
      self?.endNativeDrag()
    }
  }

  func isDraggableChrome(_ spt: CGPoint) -> Bool {
    let maxBarY: CGFloat = toolbarEnabled ? 52 : 42
    guard spt.y >= 0 && spt.y <= maxBarY else { return false }
    if closeRect == nil && minRect == nil && zoomRect == nil {
      if spt.x < 88 && spt.y < 44 { return false }
    } else {
      if let cr = closeRect, cr.insetBy(dx: -4, dy: -4).contains(spt) { return false }
      if let mr = minRect, mr.insetBy(dx: -4, dy: -4).contains(spt) { return false }
      if let zr = zoomRect, zr.insetBy(dx: -4, dy: -4).contains(spt) { return false }
    }
    for hr in hitRects {
      if hr.insetBy(dx: -2, dy: -2).contains(spt) { return false }
    }
    return true
  }

  func updateChrome(buttons: [String: CGRect], hitrects: [CGRect]) {
    if let c = buttons["close"] { closeRect = c }
    if let m = buttons["min"] { minRect = m }
    if let z = buttons["zoom"] { zoomRect = z }
    hitRects = hitrects
  }

  func updateTitle(_ title: String) {
    guard !title.isEmpty, window.title != title else { return }
    window.title = title
    NSApp.changeWindowsItem(window, title: title, filename: false)
  }

  func setCornerRadius(_ radius: CGFloat) {
    savedCornerRadius = min(max(radius, 8), 34)
    guard !isFullScreen, !inFullScreenTransition, !window.styleMask.contains(.fullScreen) else { return }
    guard abs((container.layer?.cornerRadius ?? 0) - savedCornerRadius) >= 0.2 else { return }
    container.layer?.cornerRadius = savedCornerRadius
    window.invalidateShadow()
  }

  func setToolbarMode(_ enabled: Bool) {
    guard enabled != toolbarEnabled else { return }
    toolbarEnabled = enabled
    let saved = window.frame
    isApplyingRemoteFrame = true
    defer { isApplyingRemoteFrame = false }
    if enabled {
      let tb = NSToolbar(identifier: "com.bd.linkshell.fusion.tb.\(id)")
      tb.showsBaselineSeparator = false
      window.toolbar = tb
      if #available(macOS 11.0, *) { window.toolbarStyle = .unified }
    } else {
      window.toolbar = nil
    }
    if cgFrame != .zero, !isFullScreen, window.frame != saved {
      window.setFrame(saved, display: shownOnce)
    }
  }

  func setControl(enabled: Bool, keys: Bool) {
    surface.controlEnabled = enabled
    surface.physicalKeys = keys
  }

  func setLocalFullScreen(_ wantFullScreen: Bool) {
    let currentlyFS = isFullScreen || window.styleMask.contains(.fullScreen)
    guard wantFullScreen != currentlyFS, !inFullScreenTransition else { return }
    window.toggleFullScreen(nil)
  }

  func willEnterFullScreen() {
    clearPostReleaseWait()
    inFullScreenTransition = true
    isFullScreen = true
    bumpLocalSeq()
    container.layer?.cornerRadius = 0
    surface.setPresentationFrozen(true)
    updateSurfaceLayout()
  }

  func didEnterFullScreen() {
    inFullScreenTransition = false
    isFullScreen = true
    container.layer?.cornerRadius = 0
    reportLocalGeometry(resize: true, force: true)
    armPostReleaseWait(targetScale: Double(window.backingScaleFactor), timeout: 0.45)
    updateSurfaceLayout()
  }

  func willExitFullScreen() {
    clearPostReleaseWait()
    inFullScreenTransition = true
    bumpLocalSeq()
    surface.setPresentationFrozen(true)
    updateSurfaceLayout()
  }

  func didExitFullScreen() {
    inFullScreenTransition = false
    isFullScreen = false
    container.layer?.cornerRadius = savedCornerRadius
    window.invalidateShadow()
    reportLocalGeometry(resize: true, force: true)
    armPostReleaseWait(targetScale: Double(window.backingScaleFactor), timeout: 0.45)
    updateSurfaceLayout()
  }

  func toggleLocalZoom() {
    guard !isFullScreen, !inFullScreenTransition, !window.styleMask.contains(.fullScreen) else { return }
    let screen = window.screen ?? NSScreen.main ?? NSScreen.screens.first
    guard let visible = screen?.visibleFrame else {
      window.performZoom(nil)
      return
    }
    let primary = NSScreen.screens.first?.frame.height ?? 0
    let usableCG = CGRect(x: visible.minX, y: primary - visible.maxY, width: visible.width, height: visible.height)
    let cur = currentCGFrame()
    let isNearZoomed = abs(cur.minX - usableCG.minX) <= 8
      && abs(cur.minY - usableCG.minY) <= 8
      && abs(cur.width - usableCG.width) <= 8
      && abs(cur.height - usableCG.height) <= 8

    let targetNS: NSRect
    if isNearZoomed, let prev = preZoomCGFrame, prev.width >= 200, prev.height >= 120 {
      preZoomCGFrame = nil
      targetNS = NSRect(x: prev.minX, y: primary - prev.maxY, width: prev.width, height: prev.height)
    } else {
      preZoomCGFrame = cur
      targetNS = visible
    }
    clearPostReleaseWait()
    surface.setPresentationFrozen(true)
    bumpLocalSeq()
    isApplyingRemoteFrame = true
    window.setFrame(targetNS, display: true)
    isApplyingRemoteFrame = false
    reportLocalGeometry(resize: true, force: true)
    armPostReleaseWait(targetScale: Double(window.backingScaleFactor), timeout: 0.42)
    updateSurfaceLayout()
  }

  func bumpLocalSeq() {
    localSeq &+= 1
    invalidateFastReady()
  }

  private func invalidateFastReady() {
    fastStateLock.lock()
    fastReady = false
    fastStateLock.unlock()
  }

  private func syncFastPresentationState() {
    let ready = shownOnce
      && !closingLocally
      && !isResizing
      && !inFullScreenTransition
      && !awaitingPostReleaseFrame
      && ackedSeq >= localSeq
      && window.isVisible
      && !window.isMiniaturized
    let cbSize = container.bounds.size
    let inRect = lastInRect
    let scale = lastDisplayedScale
    fastStateLock.lock()
    fastReady = ready
    fastContainerSize = cbSize
    fastLastInRect = inRect
    fastLastScale = scale
    fastStateLock.unlock()
  }

  func tryPresentOffMainThread(picture: DesktopScreenFrame, remoteSize: CGSize, inRect: CGRect?, frameScale: Double) -> Bool {
    let effRect = (inRect != nil && inRect!.width > 10 && inRect!.height > 10)
      ? inRect!
      : CGRect(origin: .zero, size: remoteSize)
    guard effRect.width > 10, effRect.height > 10 else { return false }
    fastStateLock.lock()
    let ok = fastReady
      && abs(effRect.minX - fastLastInRect.minX) <= 1.5
      && abs(effRect.minY - fastLastInRect.minY) <= 1.5
      && abs(effRect.width - fastLastInRect.width) <= 1.5
      && abs(effRect.height - fastLastInRect.height) <= 1.5
      && abs(effRect.width - fastContainerSize.width) <= 6
      && abs(effRect.height - fastContainerSize.height) <= 6
      && abs(frameScale - fastLastScale) < 0.25
    fastStateLock.unlock()
    guard ok else { return false }
    surface.receiveImmediate(picture)
    return true
  }

  func beginLiveResize() {
    isResizing = true
    invalidateFastReady()
    clearPostReleaseWait()
    preSyncResizeTimer?.invalidate()
    preSyncResizeTimer = nil
    pendingBufferedFrame = nil
    resizeThrottle.reset()
    bumpLocalSeq()
    surface.setPresentationFrozen(false)
    updateSurfaceLayout()
  }

  /// During the drag the remote follows at ~30 Hz (latest size wins), so the app relays out live
  /// instead of after the mouse is released.
  func scheduleSilentResizePreSync() {
    bumpLocalSeq()
    let now = CACurrentMediaTime()
    if resizeThrottle.offer(currentCGFrame(), now: now) != nil {
      preSyncResizeTimer?.invalidate()
      preSyncResizeTimer = nil
      reportLocalGeometry(resize: true, force: true)
      return
    }
    guard preSyncResizeTimer == nil, let deadline = resizeThrottle.nextDeadline else { return }
    let timer = Timer.scheduledTimer(withTimeInterval: max(0.001, deadline - now), repeats: false) { [weak self] _ in
      guard let self else { return }
      self.preSyncResizeTimer = nil
      guard self.isResizing, self.resizeThrottle.flush(now: CACurrentMediaTime()) != nil else { return }
      self.reportLocalGeometry(resize: true, force: true)
    }
    RunLoop.main.add(timer, forMode: .common)
    preSyncResizeTimer = timer
  }

  func endLiveResize() {
    preSyncResizeTimer?.invalidate()
    preSyncResizeTimer = nil
    isResizing = false
    resizeThrottle.reset()
    if currentCGFrame() != lastSentCGFrame || !lastSentWasResize {
      reportLocalGeometry(resize: true, force: true)
    }
    updateSurfaceLayout()
  }

  func scheduleProgrammaticGeometrySync(resize: Bool) {
    bumpLocalSeq()
    if resize { pendingProgrammaticResize = true }
    programmaticSyncTimer?.invalidate()
    let delay = pendingProgrammaticResize ? 0.04 : 0.08
    let timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
      guard let self else { return }
      if NSEvent.pressedMouseButtons & 1 != 0 && !self.pendingProgrammaticResize {
        self.programmaticSyncTimer = nil
        self.beginExternalMouseDrag()
        return
      }
      let doResize = self.pendingProgrammaticResize
      self.pendingProgrammaticResize = false
      self.programmaticSyncTimer = nil
      self.reportLocalGeometry(resize: doResize, force: true)
    }
    RunLoop.main.add(timer, forMode: .common)
    programmaticSyncTimer = timer
  }

  func beginExternalMouseDrag() {
    guard !isDragging else { return }
    beginNativeDrag()
  }

  private func beginNativeDrag() {
    isDragging = true
    invalidateFastReady()
    clearPostReleaseWait()
    programmaticSyncTimer?.invalidate()
    programmaticSyncTimer = nil
    preSyncDragTimer?.invalidate()
    preSyncDragTimer = nil
    pendingBufferedFrame = nil
    bumpLocalSeq()
    if !backdropView.isHidden { backdropView.isHidden = true }
    // The picture is cut by the remote window's own frame, so moving this window changes nothing in
    // it: frames keep flowing while dragging (a playing video keeps playing).
    dragWatchTimer?.invalidate()
    let timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] timer in
      guard let self else { timer.invalidate(); return }
      if NSEvent.pressedMouseButtons & 1 == 0 {
        self.endNativeDrag()
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    dragWatchTimer = timer
  }

  func scheduleSilentDragPreSync() {
    bumpLocalSeq()
    preSyncDragTimer?.invalidate()
    let timer = Timer.scheduledTimer(withTimeInterval: 0.20, repeats: false) { [weak self] _ in
      guard let self, self.isDragging else { return }
      self.preSyncDragTimer = nil
      // Pre-sync silently in the background while the mouse button is paused; `isDragging == true`
      // keeps local `surface` 100% frozen so nothing changes visually until mouse-up!
      self.reportLocalGeometry(resize: false, force: true)
    }
    RunLoop.main.add(timer, forMode: .common)
    preSyncDragTimer = timer
  }

  private func endNativeDrag() {
    guard isDragging else { return }
    dragWatchTimer?.invalidate()
    dragWatchTimer = nil
    preSyncDragTimer?.invalidate()
    preSyncDragTimer = nil
    isDragging = false
    let cur = currentCGFrame()
    let targetScale = Double(window.backingScaleFactor)
    if cur != lastSentCGFrame || lastSentWasResize {
      reportLocalGeometry(resize: false, force: true)
    }
    // Only a move onto a display of another scale needs the remote's re-rendered frame first.
    if abs(lastDisplayedScale - targetScale) >= 0.25 {
      surface.setPresentationFrozen(true)
      armPostReleaseWait(targetScale: targetScale, timeout: 0.40)
    } else {
      syncFastPresentationState()
    }
  }

  private func armPostReleaseWait(targetScale: Double, timeout: TimeInterval) {
    awaitingPostReleaseFrame = true
    awaitingScale = targetScale
    invalidateFastReady()
    postReleaseUnlockTimer?.invalidate()
    let timer = Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { [weak self] _ in
      guard let self else { return }
      self.postReleaseUnlockTimer = nil
      guard self.awaitingPostReleaseFrame else { return }
      self.awaitingPostReleaseFrame = false
      if let buffered = self.pendingBufferedFrame {
        self.pendingBufferedFrame = nil
        self.commitFrame(buffered, unfreeze: true)
      } else {
        self.surface.setPresentationFrozen(false)
        self.updateSurfaceLayout()
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    postReleaseUnlockTimer = timer
  }

  private func clearPostReleaseWait() {
    awaitingPostReleaseFrame = false
    postReleaseUnlockTimer?.invalidate()
    postReleaseUnlockTimer = nil
  }

  func currentCGFrame() -> CGRect {
    let primary = NSScreen.screens.first?.frame.height ?? 0
    let screenRect: NSRect
    if container.window != nil, container.bounds.width > 0, container.bounds.height > 0 {
      screenRect = window.convertToScreen(container.convert(container.bounds, to: nil))
    } else {
      screenRect = window.frame
    }
    return CGRect(x: screenRect.minX, y: primary - screenRect.maxY, width: screenRect.width, height: screenRect.height)
  }

  func reportLocalGeometry(resize: Bool, force: Bool) {
    let now = CACurrentMediaTime()
    let interval = resize ? 0.075 : 0.08
    guard force || now - lastSent >= interval else { return }
    lastSent = now
    programmaticSyncTimer?.invalidate()
    programmaticSyncTimer = nil
    pendingProgrammaticResize = false
    localSeq &+= 1
    let cg = currentCGFrame()
    cgFrame = cg
    lastSentCGFrame = cg
    lastSentWasResize = resize
    if !isDragging {
      updateSurfaceLayout()
    }
    owner?.send(["t": "place", "id": Int(id), "seq": Int(localSeq), "frame": FusionStubApp.dict(cg), "resize": resize])
  }

  func receiveRemoteLayout(_ remote: CGRect, ackSeq: UInt64) {
    if ackSeq > ackedSeq {
      let justCaughtUp = (ackedSeq < localSeq) && (ackSeq >= localSeq)
      ackedSeq = ackSeq
      if justCaughtUp {
        postAckFrameGraceUntil = CACurrentMediaTime() + 0.28
        graceSettleTimer?.invalidate()
        let timer = Timer.scheduledTimer(withTimeInterval: 0.29, repeats: false) { [weak self] _ in
          self?.updateSurfaceLayout()
        }
        RunLoop.main.add(timer, forMode: .common)
        graceSettleTimer = timer
      }
    }
    guard !isDragging, !isResizing, !isFullScreen, !inFullScreenTransition, !window.styleMask.contains(.fullScreen) else {
      if !isDragging { updateSurfaceLayout() }
      return
    }
    guard remote.width >= 60, remote.height >= 40 else { return }
    if !shownOnce || cgFrame == .zero {
      placeFromRemote(remote)
      updateSurfaceLayout()
      return
    }
    // Strict causal eventual consistency: ignore any remote layout snapshot captured before
    // our latest local window operation (`localSeq`) was committed on the remote Mac!
    guard ackedSeq >= localSeq else {
      updateSurfaceLayout()
      return
    }
    // Local `(x, y)` is always authoritative once shown; only reconcile size if the remote app
    // genuinely changed its own size or enforced a hard min/max size constraint.
    let sizeChanged = abs(remote.width - cgFrame.width) >= 3 || abs(remote.height - cgFrame.height) >= 3
    if sizeChanged {
      // The app refused the size (a minimum or maximum): settle to what it accepted, visibly.
      placeFromRemote(CGRect(origin: cgFrame.origin, size: remote.size), animate: true)
    }
    updateSurfaceLayout()
  }

  private var settlingUntil: Double = 0
  /// A settle animation is running: its resize notifications are ours, not the person's.
  var isSettling: Bool { CACurrentMediaTime() < settlingUntil }

  func placeFromRemote(_ frame: CGRect, animate: Bool = false) {
    guard frame.width >= 60, frame.height >= 40, frame != cgFrame else { return }
    let primary = NSScreen.screens.first?.frame.height ?? 0
    let ns = NSRect(x: frame.minX, y: primary - frame.maxY, width: frame.width, height: frame.height)
    if animate, shownOnce, window.isVisible {
      settlingUntil = CACurrentMediaTime() + 0.3
      cgFrame = frame
      NSAnimationContext.runAnimationGroup({ context in
        context.duration = 0.18
        context.timingFunction = CAMediaTimingFunction(name: .easeOut)
        self.window.animator().setFrame(ns, display: true)
      }, completionHandler: { [weak self] in
        guard let self else { return }
        self.cgFrame = self.currentCGFrame()
        self.updateSurfaceLayout()
      })
      return
    }
    isApplyingRemoteFrame = true
    if window.frame != ns {
      window.setFrame(ns, display: shownOnce)
    }
    isApplyingRemoteFrame = false
    cgFrame = currentCGFrame()
  }

  /// The picture fills the window once its size matches; until then (a resize the remote has not
  /// caught up with, or a size the app refuses) it sits at 1:1 from the top-left corner over the
  /// window's background colour, never stretched.
  func updateSurfaceLayout() {
    let cb = container.bounds
    guard cb.width > 1, cb.height > 1 else { return }
    let size = lastInRect.size
    guard size.width >= 10, size.height >= 10 else {
      if surface.frame != cb { surface.frame = cb }
      if !backdropView.isHidden { backdropView.isHidden = true }
      syncFastPresentationState()
      return
    }
    let sizeMatches = abs(size.width - cb.width) <= 6 && abs(size.height - cb.height) <= 6
    let target: CGRect
    if sizeMatches {
      target = cb
    } else if (isFullScreen || window.styleMask.contains(.fullScreen)) && !inFullScreenTransition && ackedSeq >= localSeq {
      // A fixed-size app in full screen: centred, as macOS shows such windows.
      target = CGRect(x: floor((cb.width - size.width) * 0.5), y: floor((cb.height - size.height) * 0.5), width: size.width, height: size.height)
    } else {
      target = CGRect(origin: .zero, size: size)
    }
    if surface.frame != target { surface.frame = target }
    if surface.alphaValue < 0.99 { surface.alphaValue = 1.0 }
    let covered = target.minX <= 0.5 && target.minY <= 0.5 && target.width >= cb.width - 0.5 && target.height >= cb.height - 0.5
    if backdropView.isHidden == covered { backdropView.isHidden = covered }
    syncFastPresentationState()
  }

  func show(_ picture: DesktopScreenFrame, remoteSize: CGSize, inRect: CGRect?, frameScale: Double, frameAck: UInt64) {
    if frameAck > ackedSeq {
      ackedSeq = frameAck
    }
    let item = BufferedFrame(picture: picture, remoteSize: remoteSize, inRect: inRect, scale: frameScale, ack: frameAck)
    if isResizing && shownOnce {
      // Live resize: the newest frame is drawn at 1:1 from the top-left corner (never stretched)
      // as the remote relays out; the strip it does not cover yet shows the window background.
      commitFrame(item, unfreeze: false)
      return
    }
    if awaitingPostReleaseFrame && shownOnce {
      let ackReady = frameAck >= localSeq
      let scaleReady = abs(frameScale - awaitingScale) < 0.25
      let eff = inRect?.size ?? remoteSize
      let sizeReady = !lastSentWasResize
        || (abs(eff.width - container.bounds.width) <= 6 && abs(eff.height - container.bounds.height) <= 6)
        || (ackedSeq >= localSeq && abs(eff.width - cgFrame.width) <= 6 && abs(eff.height - cgFrame.height) <= 6)
      if ackReady && scaleReady && sizeReady {
        clearPostReleaseWait()
        pendingBufferedFrame = nil
        commitFrame(item, unfreeze: true)
      } else {
        pendingBufferedFrame = item
      }
      return
    }
    commitFrame(item, unfreeze: false)
  }

  private func commitFrame(_ item: BufferedFrame, unfreeze: Bool) {
    if item.remoteSize.width > 10 && item.remoteSize.height > 10 {
      lastRemoteFullSize = item.remoteSize
    }
    if let inRect = item.inRect, inRect.width > 10, inRect.height > 10 {
      lastInRect = inRect
    } else if item.remoteSize.width > 10, item.remoteSize.height > 10 {
      lastInRect = CGRect(origin: .zero, size: item.remoteSize)
    }
    lastDisplayedScale = item.scale
    if unfreeze {
      surface.setPresentationFrozen(false, flushPicture: item.picture)
    } else {
      surface.receiveImmediate(item.picture)
    }
    updateSurfaceLayout()
    if !shownOnce {
      shownOnce = true
      if activateOnShow {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
      } else if NSApp.isActive {
        window.makeKeyAndOrderFront(nil)
      } else {
        window.orderFront(nil)
      }
      window.makeFirstResponder(surface)
      syncFastPresentationState()
    } else if !window.isVisible && !window.isMiniaturized {
      window.orderFront(nil)
      syncFastPresentationState()
    }
  }

  func close() {
    closingLocally = true
    invalidateFastReady()
    pendingBufferedFrame = nil
    clearPostReleaseWait()
    dragWatchTimer?.invalidate()
    dragWatchTimer = nil
    preSyncDragTimer?.invalidate()
    preSyncDragTimer = nil
    preSyncResizeTimer?.invalidate()
    preSyncResizeTimer = nil
    graceSettleTimer?.invalidate()
    graceSettleTimer = nil
    programmaticSyncTimer?.invalidate()
    programmaticSyncTimer = nil
    NSApp.removeWindowsItem(window)
    window.alphaValue = 0
    if window.styleMask.contains(.fullScreen) || isFullScreen {
      window.close()
    } else {
      window.orderOut(nil)
    }
    surface.stop()
  }
}

/// Borderless popup panel for menus/tooltips (`layer > 0`) extending outside the parent window.
final class StubPopup {
  let id: CGWindowID
  let parentID: CGWindowID
  let streamKey: String
  let window: FusionPopupPanel
  let container = StubFlippedView()
  let surface = DesktopScreenSurface(frame: .zero)
  var crop: CGRect = .zero
  var displayPixels: CGSize = .zero
  private var cgFrame: CGRect = .zero

  init(id: CGWindowID, parentID: CGWindowID, streamKey: String, owner: FusionStubApp) {
    self.id = id
    self.parentID = parentID
    self.streamKey = streamKey
    window = FusionPopupPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    window.remoteID = id
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = true
    window.level = .popUpMenu
    window.hidesOnDeactivate = false
    window.becomesKeyOnlyIfNeeded = true
    window.acceptsMouseMovedEvents = true
    window.collectionBehavior = [.transient, .ignoresCycle]
    window.isReleasedWhenClosed = false
    container.wantsLayer = true
    container.layer?.cornerRadius = 10
    container.layer?.cornerCurve = .continuous
    container.layer?.masksToBounds = true
    surface.fillsBounds = true
    surface.controlEnabled = true
    surface.physicalKeys = true
    surface.tracksPointerWhenInactive = true
    container.addSubview(surface)
    window.contentView = container

    surface.onInput = { [weak self, weak owner] event, replaceable in
      guard let self, let owner else { return }
      var mapped = event
      if let x = event["x"] as? Double, let y = event["y"] as? Double, self.displayPixels.width > 0, self.displayPixels.height > 0 {
        mapped["x"] = (Double(self.crop.minX) + x * Double(self.crop.width)) / Double(self.displayPixels.width)
        mapped["y"] = (Double(self.crop.minY) + y * Double(self.crop.height)) / Double(self.displayPixels.height)
      }
      owner.send(["t": "input", "key": self.streamKey, "m": mapped, "r": replaceable])
    }
  }

  /// Floating palettes float over their app; only real menus sit at menu level.
  func setRemoteLayer(_ layer: Int) {
    let level = FusionWindowLevels.local(remoteLayer: layer)
    if window.level != level { window.level = level }
  }

  func place(_ frame: CGRect) {
    guard frame != cgFrame else { return }
    cgFrame = frame
    let primary = NSScreen.screens.first?.frame.height ?? 0
    window.setFrame(NSRect(x: frame.minX, y: primary - frame.maxY, width: frame.width, height: frame.height), display: false)
  }

  func show(_ picture: DesktopScreenFrame, inRect: CGRect) {
    if surface.frame != inRect { surface.frame = inRect }
    surface.receiveImmediate(picture)
    if !window.isVisible {
      window.orderFront(nil)
      window.invalidateShadow()
    }
  }

  func close() {
    window.alphaValue = 0
    window.parent?.removeChildWindow(window)
    window.orderOut(nil)
    surface.stop()
  }
}

/// The remote app's menu bar in this stub's menu bar: top-level titles as soon as they arrive,
/// each submenu fetched (and cached) on demand, clicks pressed on the remote by index path. Any
/// gap — no answer, an error — leaves today's minimal menu in place.
final class StubMenuMirror: NSObject, NSMenuDelegate {
  private weak var owner: FusionStubApp?
  private var cache: [String: [[String: Any]]] = [:]
  private var paths: [ObjectIdentifier: [Int]] = [:]
  private var requested: Set<String> = []
  private(set) var active = false

  init(owner: FusionStubApp) { self.owner = owner }

  func refresh() {
    requested.removeAll()
    fetch([])
  }

  private func fetch(_ path: [Int]) {
    let key = FusionMenuModel.pathKey(path)
    guard !requested.contains(key) else { return }
    requested.insert(key)
    owner?.send(["t": "menufetch", "path": path])
  }

  func receive(path: [Int], items: [[String: Any]]?) {
    let key = FusionMenuModel.pathKey(path)
    requested.remove(key)
    guard let items else { return }
    // Unchanged menus are left alone: rebuilding an open menu would reset its highlight.
    let unchanged = cache[key].map { NSArray(array: $0).isEqual(to: items) } ?? false
    cache[key] = items
    if unchanged && (!path.isEmpty || active) { return }
    if path.isEmpty {
      rebuildBar(items)
      // Top-level menus are fetched right away, so opening one shows it at once.
      for (index, _) in items.enumerated() where FusionMenuModel.mirrorsTopLevel(index: index) { fetch([index]) }
    } else {
      for (menu, menuPath) in pathsSnapshot() where menuPath == path { fill(menu, items: items, path: path) }
    }
  }

  private func pathsSnapshot() -> [(NSMenu, [Int])] {
    menus.compactMap { ref in ref.menu.map { ($0, paths[ObjectIdentifier($0)] ?? []) } }
  }

  private struct WeakMenu { weak var menu: NSMenu? }
  private var menus: [WeakMenu] = []

  private func rebuildBar(_ items: [[String: Any]]) {
    guard let owner, items.count > 2 else { return }
    let main = NSMenu()
    let appItem = NSMenuItem()
    appItem.submenu = owner.makeAppMenu()
    main.addItem(appItem)
    paths.removeAll()
    menus.removeAll()
    for (index, entry) in items.enumerated() where FusionMenuModel.mirrorsTopLevel(index: index) {
      guard let title = entry["title"] as? String, !title.isEmpty else { continue }
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let submenu = NSMenu(title: title)
      submenu.delegate = self
      submenu.autoenablesItems = false
      register(submenu, path: [index])
      if let cached = cache[FusionMenuModel.pathKey([index])] { fill(submenu, items: cached, path: [index]) }
      item.submenu = submenu
      main.addItem(item)
    }
    let windowItem = NSMenuItem()
    let windowMenu = owner.makeWindowMenu()
    windowItem.submenu = windowMenu
    main.addItem(windowItem)
    NSApp.mainMenu = main
    NSApp.windowsMenu = windowMenu
    active = true
  }

  private func register(_ menu: NSMenu, path: [Int]) {
    paths[ObjectIdentifier(menu)] = path
    menus.append(WeakMenu(menu: menu))
  }

  private func fill(_ menu: NSMenu, items: [[String: Any]], path: [Int]) {
    menu.removeAllItems()
    for (index, entry) in items.enumerated() {
      if entry["sep"] as? Bool == true {
        if let last = menu.items.last, !last.isSeparatorItem { menu.addItem(.separator()) }
        continue
      }
      let title = entry["title"] as? String ?? ""
      let item = NSMenuItem(title: title, action: #selector(press(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = path + [index]
      item.isEnabled = entry["enabled"] as? Bool ?? true
      item.state = entry["checked"] as? Bool == true ? .on : .off
      if let key = entry["key"] as? String {
        // Shown only: the keys themselves already go to the remote app through the window.
        item.keyEquivalent = FusionMenuModel.keyEquivalent(key)
        item.keyEquivalentModifierMask = FusionMenuModel.modifiers(entry["mods"] as? Int ?? 0)
      }
      if entry["sub"] as? Bool == true {
        let submenu = NSMenu(title: title)
        submenu.delegate = self
        submenu.autoenablesItems = false
        register(submenu, path: path + [index])
        if let cached = cache[FusionMenuModel.pathKey(path + [index])] { fill(submenu, items: cached, path: path + [index]) }
        item.submenu = submenu
        item.action = nil
      }
      menu.addItem(item)
    }
    if menu.items.last?.isSeparatorItem == true { menu.removeItem(at: menu.numberOfItems - 1) }
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    guard let path = paths[ObjectIdentifier(menu)] else { return }
    // Enabled and checked states change as the app is used: ask again each time it opens.
    requested.remove(FusionMenuModel.pathKey(path))
    fetch(path)
  }

  @objc private func press(_ sender: NSMenuItem) {
    guard let path = sender.representedObject as? [Int] else { return }
    owner?.send(["t": "menupress", "path": path])
  }
}

// MARK: Entry

let info = Bundle.main.infoDictionary ?? [:]
let args = CommandLine.arguments
func argValue(_ flag: String) -> String? {
  guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
  return args[idx + 1]
}
let targetBundle = argValue("--bundle") ?? (info["LSFusionBundleID"] as? String) ?? ""
let displayAppName = (info["CFBundleDisplayName"] as? String) ?? (info["CFBundleName"] as? String) ?? "Remote App"
let sockPath = argValue("--socket") ?? (info["LSFusionSocket"] as? String) ?? (NSHomeDirectory() + "/.linkshell/fusion-lab.sock")
let compKey = argValue("--computer-key") ?? (info["LSFusionComputerKey"] as? String) ?? ""
let realIcon = (info["LSFusionRealIcon"] as? Bool) == true && ((info["LSFusionIconSchema"] as? Int) ?? 0) >= 3
guard !targetBundle.isEmpty else { exit(1) }

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = FusionStubApp(bundleID: targetBundle, appName: displayAppName, socketPath: sockPath, computerKey: compKey, hasRealBundleIcon: realIcon)
app.delegate = delegate
app.run()
