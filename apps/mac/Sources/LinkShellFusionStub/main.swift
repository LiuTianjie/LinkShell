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
    if !terminatingRemotely {
      send(["t": "quit", "bundle": bundleID])
    }
    framePort?.stop()
    if fd >= 0 { Darwin.close(fd); fd = -1 }
    return .terminateNow
  }

  private func setupMainMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "隐藏 \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "退出 \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu

    let winItem = NSMenuItem()
    main.addItem(winItem)
    let winMenu = NSMenu(title: "窗口")
    winMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    winMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    let fsItem = winMenu.addItem(withTitle: "进入全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
    fsItem.keyEquivalentModifierMask = [.command, .control]
    winItem.submenu = winMenu
    NSApp.windowsMenu = winMenu
    NSApp.mainMenu = main
  }

  // MARK: Hub IPC (Unix domain socket + Mach IOSurface port)

  private func connectToHub(attempt: Int) {
    let sock = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard sock >= 0 else { exit(1) }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8CString)
    guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { Darwin.close(sock); exit(1) }
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
    if connected != 0 {
      Darwin.close(sock)
      if attempt == 0, let hubApp = Bundle.main.object(forInfoDictionaryKey: "LSFusionHubApp") as? String,
         FileManager.default.fileExists(atPath: hubApp) {
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.createsNewApplicationInstance = true
        if !computerKey.isEmpty {
          cfg.arguments = ["--dashboard", "--fusion-connect", computerKey, "--fusion-launch", bundleID]
        }
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: hubApp), configuration: cfg, completionHandler: nil)
      }
      if attempt < 48 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.connectToHub(attempt: attempt + 1) }
        return
      }
      exit(0)
    }
    fd = sock
    guard let port = DesktopFramePort(receiver: true) else { exit(1) }
    framePort = port
    readLoop(sock)
    send(["t": "hello", "bundle": bundleID, "pid": Int(getpid()), "port": port.name])
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
      if let hubPid = DesktopScreenBridge.integer(m["hubPid"]) {
        framePort?.receive(child: pid_t(hubPid)) { [weak self] surface, token, metadata in
          guard let self, let surface else { self?.send(["t": "release", "token": Int(token)]); return }
          self.receiveSurface(surface, token: token, metadata: metadata)
        }
      }
    case "wopen":
      let id = CGWindowID(DesktopScreenBridge.integer(m["id"]) ?? 0)
      guard id != 0 else { return }
      let frame = Self.rect(m["frame"])
      let toolbar = m["toolbar"] as? Bool == true
      let radius = (m["r"] as? NSNumber)?.doubleValue ?? (toolbar ? 26.0 : 17.0)
      let win = ensureWindow(id, toolbar: toolbar, radius: radius, title: m["title"] as? String ?? appName)
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
    case "dragzone":
      break
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
      if let p = popups.removeValue(forKey: id) { p.close() }
    case "wclose":
      let id = CGWindowID(DesktopScreenBridge.integer(m["id"]) ?? 0)
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
        let popup = self.ensurePopup(wid, parentID: parentID, streamKey: streamKey)
        if self.windows[parentID]?.isDragging != true { popup.place(frame) }
        popup.crop = CGRect(x: picture.cropX, y: picture.cropY, width: picture.cropWidth, height: picture.cropHeight)
        popup.displayPixels = dispSize ?? CGSize(width: surface.width, height: surface.height)
        popup.show(picture, inRect: inRect)
      } else {
        let win = self.ensureWindow(wid, toolbar: false, radius: 17.0, title: self.appName)
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
    guard !stub.isApplyingRemoteFrame, stub.shownOnce else { return }
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
    guard !stub.isApplyingRemoteFrame, stub.shownOnce else { return }
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

final class StubFlippedView: NSView {
  override var isFlipped: Bool { true }
}

final class PassthroughVisualEffectView: NSVisualEffectView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
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
  let backdropView = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
  let surface = DesktopScreenSurface(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
  private let resizeGlassOverlay = PassthroughVisualEffectView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
  private let resizePill = PassthroughVisualEffectView(frame: NSRect(x: 0, y: 0, width: 136, height: 32))
  private let resizeLabel = NSTextField(labelWithString: "")
  private let syncBadge = PassthroughVisualEffectView(frame: NSRect(x: 0, y: 0, width: 86, height: 24))
  private let syncLabel = NSTextField(labelWithString: "同步中…")
  private weak var owner: FusionStubApp?
  var cgFrame: CGRect = .zero
  var isDragging = false
  var isResizing = false
  var isFullScreen = false
  var inFullScreenTransition = false
  var isApplyingRemoteFrame = false
  var closingLocally = false
  var shownOnce = false
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
  private var frozenResizeSize: CGSize = .zero
  private var glassSheetActive = false
  private var glassFadeToken: UInt64 = 0
  private var pendingBufferedFrame: BufferedFrame?
  private var awaitingPostReleaseFrame = false
  private var awaitingScale: Double = 1.0
  private var lastSentCGFrame: CGRect = .zero
  private var lastSentWasResize = false
  private var postAckFrameGraceUntil: Double = 0
  private var syncStartStamp: Double = 0
  private var syncBadgeTimer: Timer?
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

    backdropView.material = .underWindowBackground
    backdropView.blendingMode = .behindWindow
    backdropView.state = .active
    backdropView.autoresizingMask = [.width, .height]
    backdropView.isHidden = true
    container.addSubview(backdropView)

    surface.fillsBounds = true
    surface.controlEnabled = true
    surface.physicalKeys = true
    container.addSubview(surface)

    resizeGlassOverlay.material = .popover
    resizeGlassOverlay.blendingMode = .withinWindow
    resizeGlassOverlay.state = .active
    resizeGlassOverlay.autoresizingMask = [.width, .height]
    resizeGlassOverlay.wantsLayer = true
    resizeGlassOverlay.alphaValue = 0
    resizeGlassOverlay.isHidden = true

    resizePill.material = .hudWindow
    resizePill.blendingMode = .withinWindow
    resizePill.state = .active
    resizePill.wantsLayer = true
    resizePill.layer?.cornerRadius = 16
    resizePill.layer?.cornerCurve = .continuous
    resizePill.layer?.masksToBounds = true
    resizePill.layer?.borderWidth = 0.5
    resizePill.layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
    resizeLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
    resizeLabel.textColor = .white.withAlphaComponent(0.92)
    resizeLabel.alignment = .center
    resizeLabel.frame = NSRect(x: 0, y: 7, width: 136, height: 18)
    resizePill.addSubview(resizeLabel)
    resizeGlassOverlay.addSubview(resizePill)
    container.addSubview(resizeGlassOverlay)

    syncBadge.material = .hudWindow
    syncBadge.blendingMode = .withinWindow
    syncBadge.state = .active
    syncBadge.wantsLayer = true
    syncBadge.layer?.cornerRadius = 12
    syncBadge.layer?.cornerCurve = .continuous
    syncBadge.layer?.masksToBounds = true
    syncBadge.isHidden = true
    syncLabel.font = .systemFont(ofSize: 11, weight: .medium)
    syncLabel.textColor = .secondaryLabelColor
    syncLabel.alignment = .center
    syncLabel.frame = NSRect(x: 0, y: 4, width: 86, height: 16)
    syncBadge.addSubview(syncLabel)
    container.addSubview(syncBadge)

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
      && !isDragging
      && !isResizing
      && !inFullScreenTransition
      && !awaitingPostReleaseFrame
      && ackedSeq >= localSeq
      && !glassSheetActive
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
    frozenResizeSize = (lastInRect.width >= 10 && lastInRect.height >= 10) ? lastInRect.size : container.bounds.size
    bumpLocalSeq()
    surface.setPresentationFrozen(true)
    updateSurfaceLayout()
  }

  func scheduleSilentResizePreSync() {
    bumpLocalSeq()
    preSyncResizeTimer?.invalidate()
    let timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: false) { [weak self] _ in
      guard let self, self.isResizing else { return }
      self.preSyncResizeTimer = nil
      self.reportLocalGeometry(resize: true, force: true)
    }
    RunLoop.main.add(timer, forMode: .common)
    preSyncResizeTimer = timer
  }

  func endLiveResize() {
    preSyncResizeTimer?.invalidate()
    preSyncResizeTimer = nil
    isResizing = false
    let cur = currentCGFrame()
    let targetScale = Double(window.backingScaleFactor)
    if cur != lastSentCGFrame || !lastSentWasResize {
      reportLocalGeometry(resize: true, force: true)
    }
    if let buffered = pendingBufferedFrame,
       buffered.ack >= localSeq,
       abs(buffered.scale - targetScale) < 0.25 {
      let eff = buffered.inRect?.size ?? buffered.remoteSize
      if abs(eff.width - container.bounds.width) <= 6 && abs(eff.height - container.bounds.height) <= 6 {
        pendingBufferedFrame = nil
        commitFrame(buffered, unfreeze: true)
        return
      }
    }
    armPostReleaseWait(targetScale: targetScale, timeout: 0.42)
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
    dismissResizeGlass(animated: false)
    hideSyncBadge()
    surface.setPresentationFrozen(true)
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
    if let buffered = pendingBufferedFrame,
       buffered.ack >= localSeq,
       abs(buffered.scale - targetScale) < 0.25 {
      pendingBufferedFrame = nil
      commitFrame(buffered, unfreeze: true)
      return
    }
    let sameScale = abs(lastDisplayedScale - targetScale) < 0.25
    armPostReleaseWait(targetScale: targetScale, timeout: sameScale ? 0.20 : 0.40)
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
      placeFromRemote(CGRect(origin: cgFrame.origin, size: remote.size))
    }
    updateSurfaceLayout()
  }

  func placeFromRemote(_ frame: CGRect) {
    guard frame.width >= 60, frame.height >= 40, frame != cgFrame else { return }
    let primary = NSScreen.screens.first?.frame.height ?? 0
    let ns = NSRect(x: frame.minX, y: primary - frame.maxY, width: frame.width, height: frame.height)
    isApplyingRemoteFrame = true
    if window.frame != ns {
      window.setFrame(ns, display: shownOnce)
    }
    isApplyingRemoteFrame = false
    cgFrame = currentCGFrame()
  }

  func updateSurfaceLayout() {
    let cb = container.bounds
    guard cb.width > 1, cb.height > 1 else { return }
    if isDragging {
      if !backdropView.isHidden { backdropView.isHidden = true }
      dismissResizeGlass(animated: false)
      hideSyncBadge()
      syncFastPresentationState()
      return
    }
    syncBadge.frame = NSRect(x: max(12, cb.width - 98), y: max(12, cb.height - 36), width: 86, height: 24)

    let activeSize = isResizing ? frozenResizeSize : lastInRect.size
    guard activeSize.width >= 10, activeSize.height >= 10 else {
      if surface.frame != cb { surface.frame = cb }
      surface.alphaValue = 1.0
      if !backdropView.isHidden { backdropView.isHidden = true }
      dismissResizeGlass(animated: false)
      hideSyncBadge()
      syncFastPresentationState()
      return
    }

    if isResizing {
      // Full-window seamless frosted-glass live resize: `surface` fills 100% of `cb` underneath
      // `resizeGlassOverlay` (`.withinWindow` Gaussian blur) so the entire window becomes one uniform
      // frosted glass sheet tinted by the app's own colors, with zero L-shaped seam or frame flicker!
      if backdropView.isHidden { backdropView.isHidden = false }
      if surface.frame != cb { surface.frame = cb }
      if abs(surface.alphaValue - 0.58) > 0.02 { surface.alphaValue = 0.58 }
      showResizeGlass(bounds: cb, text: "\(Int(cb.width.rounded())) × \(Int(cb.height.rounded()))")
      hideSyncBadge()
      syncFastPresentationState()
      return
    }

    let sizeMatches = abs(lastInRect.width - cb.width) <= 6 && abs(lastInRect.height - cb.height) <= 6
    let now = CACurrentMediaTime()
    let isSyncPending = awaitingPostReleaseFrame || inFullScreenTransition || ackedSeq < localSeq || now < postAckFrameGraceUntil

    if sizeMatches {
      if surface.frame != cb { surface.frame = cb }
      if surface.alphaValue < 0.99 { surface.alphaValue = 1.0 }
      if glassSheetActive {
        dismissResizeGlass(animated: true) { [weak self] in
          guard let self, !self.isResizing, !self.glassSheetActive else { return }
          if !self.backdropView.isHidden { self.backdropView.isHidden = true }
        }
      } else if !backdropView.isHidden {
        backdropView.isHidden = true
      }
      hideSyncBadge()
    } else if isSyncPending {
      if glassSheetActive || lastSentWasResize {
        // Hold the exact same full-window frosted glass steady after mouse-up until the crisp 1:1
        // resized frame lands, avoiding any intermediate crop jump before dissolving smoothly!
        if backdropView.isHidden { backdropView.isHidden = false }
        if surface.frame != cb { surface.frame = cb }
        if abs(surface.alphaValue - 0.58) > 0.02 { surface.alphaValue = 0.58 }
        showResizeGlass(bounds: cb, text: "\(Int(cb.width.rounded())) × \(Int(cb.height.rounded()))")
        hideSyncBadge()
      } else {
        if backdropView.isHidden { backdropView.isHidden = false }
        let unstretched = CGRect(origin: .zero, size: lastInRect.size)
        if surface.frame != unstretched { surface.frame = unstretched }
        if abs(surface.alphaValue - 0.82) > 0.02 { surface.alphaValue = 0.82 }
        scheduleSyncBadgeIfNeeded()
      }
    } else {
      // Remote settled at a constrained size (e.g. fixed-size app in Full-Screen).
      dismissResizeGlass(animated: true)
      if backdropView.isHidden { backdropView.isHidden = false }
      let settled: CGRect
      if isFullScreen || window.styleMask.contains(.fullScreen) {
        settled = CGRect(
          x: floor((cb.width - lastInRect.width) * 0.5),
          y: floor((cb.height - lastInRect.height) * 0.5),
          width: lastInRect.width,
          height: lastInRect.height
        )
      } else {
        settled = CGRect(origin: .zero, size: lastInRect.size)
      }
      if surface.frame != settled { surface.frame = settled }
      if surface.alphaValue < 0.99 { surface.alphaValue = 1.0 }
      hideSyncBadge()
    }
    syncFastPresentationState()
  }

  private func showResizeGlass(bounds cb: CGRect, text: String) {
    glassFadeToken &+= 1
    glassSheetActive = true
    if resizeGlassOverlay.frame != cb { resizeGlassOverlay.frame = cb }
    let pillW: CGFloat = 136
    let pillH: CGFloat = 32
    let pillFrame = NSRect(x: floor((cb.width - pillW) * 0.5), y: floor((cb.height - pillH) * 0.5), width: pillW, height: pillH)
    if resizePill.frame != pillFrame { resizePill.frame = pillFrame }
    if resizeLabel.stringValue != text { resizeLabel.stringValue = text }
    if resizeGlassOverlay.isHidden { resizeGlassOverlay.isHidden = false }
    if resizeGlassOverlay.alphaValue < 0.99 {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0
        resizeGlassOverlay.animator().alphaValue = 1.0
      }
      resizeGlassOverlay.alphaValue = 1.0
    }
  }

  private func dismissResizeGlass(animated: Bool, completion: (() -> Void)? = nil) {
    guard glassSheetActive || !resizeGlassOverlay.isHidden else {
      completion?()
      return
    }
    glassSheetActive = false
    glassFadeToken &+= 1
    let tok = glassFadeToken
    if !animated {
      resizeGlassOverlay.alphaValue = 0
      resizeGlassOverlay.isHidden = true
      completion?()
      return
    }
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = 0.12
      ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
      resizeGlassOverlay.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      guard let self, self.glassFadeToken == tok, !self.glassSheetActive else { return }
      self.resizeGlassOverlay.isHidden = true
      self.syncFastPresentationState()
      completion?()
    })
  }

  private func scheduleSyncBadgeIfNeeded() {
    let now = CACurrentMediaTime()
    if syncStartStamp == 0 { syncStartStamp = now }
    if now - syncStartStamp >= 0.15 {
      syncBadge.isHidden = false
      return
    }
    guard syncBadgeTimer == nil else { return }
    let timer = Timer.scheduledTimer(withTimeInterval: 0.16, repeats: false) { [weak self] _ in
      guard let self else { return }
      self.syncBadgeTimer = nil
      if self.syncStartStamp > 0 {
        self.syncBadge.isHidden = false
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    syncBadgeTimer = timer
  }

  private func hideSyncBadge() {
    syncStartStamp = 0
    syncBadgeTimer?.invalidate()
    syncBadgeTimer = nil
    if !syncBadge.isHidden { syncBadge.isHidden = true }
  }

  func show(_ picture: DesktopScreenFrame, remoteSize: CGSize, inRect: CGRect?, frameScale: Double, frameAck: UInt64) {
    if frameAck > ackedSeq {
      ackedSeq = frameAck
    }
    let item = BufferedFrame(picture: picture, remoteSize: remoteSize, inRect: inRect, scale: frameScale, ack: frameAck)
    if (isDragging || isResizing) && shownOnce {
      // Hold all incoming frames off-screen while the mouse button is held down so local dragging
      // and live resizing are 100% pure local WindowServer operations with zero flicker!
      pendingBufferedFrame = item
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
      NSApp.activate(ignoringOtherApps: true)
      window.makeKeyAndOrderFront(nil)
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
    syncBadgeTimer?.invalidate()
    syncBadgeTimer = nil
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
  let window: FusionNativeWindow
  let container = StubFlippedView()
  let surface = DesktopScreenSurface(frame: .zero)
  var crop: CGRect = .zero
  var displayPixels: CGSize = .zero
  private var cgFrame: CGRect = .zero

  init(id: CGWindowID, parentID: CGWindowID, streamKey: String, owner: FusionStubApp) {
    self.id = id
    self.parentID = parentID
    self.streamKey = streamKey
    window = FusionNativeWindow(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: false)
    window.remoteID = id
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = true
    window.level = .popUpMenu
    window.collectionBehavior = [.transient, .ignoresCycle]
    window.isReleasedWhenClosed = false
    container.wantsLayer = true
    container.layer?.cornerRadius = 10
    container.layer?.cornerCurve = .continuous
    container.layer?.masksToBounds = true
    surface.fillsBounds = true
    surface.controlEnabled = true
    surface.physicalKeys = true
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
