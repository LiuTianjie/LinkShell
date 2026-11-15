import AppKit
import ApplicationServices
import CoreVideo
import Foundation
import ImageIO
import LinkShellFusionShim
import LinkShellScreen
import Network
import ScreenCaptureKit
import UniformTypeIdentifiers
import WebRTC

/// Window ids from AX elements: private, but stable since macOS 10.x and used by every window manager.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

final class FusionRemoteSession: @unchecked Sendable {
  final class Mirror {
    let index: Int
    let screenBounds: CGRect
    var local: CGRect
    let visible: CGRect
    var menuBarHeight: CGFloat = 30
    let scale: Int
    let hz: Double
    let display: CGVirtualDisplay
    var remote: CGRect = .zero
    var session: ScreenSession?
    var descriptor: Int32 = -1
    init(index: Int, screenBounds: CGRect, local: CGRect, visible: CGRect, menuBarHeight: CGFloat, scale: Int, hz: Double, display: CGVirtualDisplay) {
      self.index = index; self.screenBounds = screenBounds; self.local = local; self.visible = visible; self.menuBarHeight = menuBarHeight; self.scale = scale; self.hz = hz; self.display = display
    }
  }

  struct AXWindowKind {
    let exists: Bool
    let isStandardRoot: Bool
    let checkedAt: Double
  }

  struct PendingPlace {
    let seq: UInt64
    let local: CGRect
    let resize: Bool
    let mirrorIndex: Int
  }

  struct WindowStream {
    let session: ScreenSession
    let descriptor: Int32
    let pid: pid_t
    var mirrorIndex: Int
    var groupIDs: Set<CGWindowID>
    var bundle: String
  }

  let wire: FusionWire
  let authorize: (String) -> Bool
  static var home = NSHomeDirectory() + "/.linkshell"
  /// A hung remote app must not freeze every fused window: AX calls give up after this.
  static let axTimeout: Float = 0.15
  let iceServers: [[String: Any]]
  var mirrors: [Mirror] = []
  var pidToBundle: [pid_t: String] = [:]
  var fused: Set<pid_t> = [] { didSet { sampler.set(pids: fused) } }
  var moved: Set<CGWindowID> = []
  var lastLayout = ""
  var lastPopups: Set<CGWindowID> = []
  var streams: [CGWindowID: WindowStream] = [:]
  var dragZones: [CGWindowID: Bool] = [:]
  var hoverStamps: [CGWindowID: Double] = [:]
  var axTitles: [CGWindowID: (title: String, at: Double)] = [:]
  var windowKinds: [CGWindowID: AXWindowKind] = [:]
  var peakWindowAlpha: [CGWindowID: Double] = [:]
  var clampStamps: [CGWindowID: Double] = [:]
  var nonAXWindowStamps: [CGWindowID: Double] = [:]
  var rescuingWindowIDs: [CGWindowID: Double] = [:]
  var workspaceObservers: [NSObjectProtocol] = []
  let placeQueue = DispatchQueue(label: "com.bd.linkshell.fusion.place", qos: .userInteractive)
  let placeLock = NSLock()
  var pendingPlaces: [CGWindowID: PendingPlace] = [:]
  var appliedSeq: [CGWindowID: UInt64] = [:]
  var placeWorkerRunning = false
  var dockMenuSent: [String: String] = [:]
  var dockMenuStamps: [String: Double] = [:]
  var focusedWindowID: CGWindowID = 0
  var knownRunningPIDs: Set<pid_t> = []
  var dockHiddenByUs = false
  var timers: [Timer] = []
  let sampler = FusionSampler()
  var ended = false
  var authenticated = false
  var displayReady = false
  var pendingRemoteLaunches: [String] = []
  var onAuthenticated: (() -> Void)?

  static let appPathsLock = NSLock()
  static var appPaths: [String: String] = [:]

  init(wire: FusionWire, authorize: @escaping (String) -> Bool, iceServers: [[String: Any]] = []) {
    self.wire = wire
    self.authorize = authorize
    self.iceServers = iceServers
    self.sampler.onWindowDisappeared = { [weak self] in
      self?.track()
    }
  }

  func receive(_ m: [String: Any]) {
    let type = m["t"] as? String
    if type == "hello" {
      Task { @MainActor in await self.hello(m) }
      return
    }
    guard authenticated else { return }
    switch type {
    case "launch":
      if let bundle = m["bundle"] as? String, !bundle.isEmpty {
        if displayReady {
          launch(bundle)
        } else if !pendingRemoteLaunches.contains(bundle) {
          pendingRemoteLaunches.append(bundle)
        }
      }
    case "quit":
      if let bundle = m["bundle"] as? String { quit(bundle, force: m["force"] as? Bool == true) }
    case "menufetch":
      if let bundle = m["bundle"] as? String {
        let path = (m["path"] as? [Any])?.compactMap { ($0 as? NSNumber)?.intValue } ?? []
        sendMenu(bundle: bundle, path: path)
      }
    case "menupress":
      if let bundle = m["bundle"] as? String {
        let path = (m["path"] as? [Any])?.compactMap { ($0 as? NSNumber)?.intValue } ?? []
        pressMenu(bundle: bundle, path: path)
      }
    case "dockaction":
      if let bundle = m["bundle"] as? String {
        let path = (m["path"] as? [Any])?.compactMap { ($0 as? Int) ?? ($0 as? NSNumber)?.intValue } ?? []
        performDockAction(bundle: bundle, path: path)
      }
    case "icon": if let bundle = m["bundle"] as? String { sendIcon(bundle) }
    case "focus": focus(CGWindowID(Fusion.number(m["id"])))
    case "place":
      let seq = UInt64(max(0, Fusion.number(m["seq"])))
      enqueuePlace(CGWindowID(Fusion.number(m["id"])), seq: seq, local: Fusion.rect(m["frame"]), resize: m["resize"] as? Bool == true)
    case "close", "wclose.req":
      closeRemoteWindow(CGWindowID(Fusion.number(m["id"])))
    case "ping": wire.send(["t": "pong", "ts": m["ts"] ?? 0])
    case "clip":
      if clipboard.armed, let item = FusionClipboardItem(message: m) {
        clipboard.didWrite(changeCount: item.write(to: NSPasteboard.general))
      }
    case "prewarm":
      if let id = (m["id"] as? NSNumber).map({ CGWindowID($0.uint32Value) }), let s = streams[id] { noteUserAction(pid: s.pid) }
      prewarmOverlay()
    case "appactive":
      // No stub is active on the local Mac: make the remote apps look inactive too, by giving the
      // remote focus to this (windowless) process. A stub becoming key sends `focus` again.
      if m["on"] as? Bool == false, !ended { NSApp.activate(ignoringOtherApps: true) }
    case "displays":
      if let locals = m["displays"] as? [[String: Any]], !locals.isEmpty {
        Task { @MainActor in await self.rebuildDisplays(locals) }
      }
    case "sig": if let key = m["k"] as? String { signal(key, m["m"] as? [String: Any] ?? [:]) }
    default: break
    }
  }

  // Stored state used by the extensions in other files.
  var healthSent: [String: Bool] = [:]
  var rebuilding = false
  var lastUserAction: [pid_t: Double] = [:]
  var clipboard = FusionClipboardGuard()
  var prewarmUntil: Double = 0
  var lastPopupMirrors: Set<Int> = []
  var hiddenBundles: Set<String> = []
  var pendingDisplays: [[String: Any]]?
  /// Rescues any window that entered a remote macOS Full-Screen Space (`AXFullScreen == true`) or
  /// remote Dock minimization (`kAXMinimizedAttribute == true`) back onto the virtual desktop,
  /// forwarding the intent so the local `NSWindow` performs native local Full-Screen / Minimize instead!
  let axQueue = DispatchQueue(label: "com.bd.linkshell.fusion.ax", qos: .userInitiated)
  var rescueScanRunning = false
}

extension FusionRemoteSession {
  @MainActor func hello(_ m: [String: Any]) async {
    guard !authenticated, let presented = m["token"] as? String, authorize(presented) else {
      Fusion.log("wrong or spent token")
      wire.close(reason: "token")
      return
    }
    authenticated = true
    onAuthenticated?()
    // Deliver the remote app catalog immediately (<150ms) before virtual-display setup sleeps (~3.3s),
    // while still including `apps` in `ready` below for 0.10.102 compatibility.
    let catalog = Self.apps()
    wire.send(["t": "apps", "apps": catalog])
    if !AXIsProcessTrusted() { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary) }
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    dockHiddenByUs = FusionDock.hide(home: Self.home)
    let locals = m["displays"] as? [[String: Any]] ?? []
    await buildMirrors(locals)
    guard !ended else { return }
    installCaptureHooks()
    displayReady = true
    sendReady(catalog: catalog)
    let queuedLaunches = pendingRemoteLaunches
    pendingRemoteLaunches.removeAll()
    for bundle in queuedLaunches {
      launch(bundle)
    }
    startOverlaySessions()
    Fusion.log("ready: " + mirrors.map { "\($0.local) -> \($0.remote) @\($0.scale)x" }.joined(separator: "; "))
    checkHealth()
    let wsCenter = NSWorkspace.shared.notificationCenter
    workspaceObservers.append(wsCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
      guard let self, !self.ended else { return }
      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      guard app?.activationPolicy != .prohibited else { return }
      for s in self.streams.values { s.session.refreshFusionGroupApps() }
    })
    workspaceObservers.append(wsCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
      self?.track()
    })
    timers.append(Timer.scheduledTimer(withTimeInterval: 1.0 / 35, repeats: true) { [weak self] _ in self?.track() })
    timers.append(Timer.scheduledTimer(withTimeInterval: 0.45, repeats: true) { [weak self] _ in self?.rescueOffDesktopWindows() })
    timers.append(Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in self?.checkHealth() })
    timers.append(Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.clipboardTick() })
  }


  /// Problems the person at the local Mac cannot see from here: each becomes an alert with a remedy,
  /// and is cleared again once it is fixed.
  func checkHealth() {
    guard !ended else { return }
    let locked = (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Int == 1
    report("locked", active: locked, message: "远端 Mac 处于锁屏状态（窗口呈非激活状态且键盘受限），请先解锁远端屏幕")
    report("accessibility", active: !AXIsProcessTrusted(), message: "远端 Mac 尚未允许 LinkShell 使用辅助功能，融合窗口无法移动、聚焦或接收输入")
    report("recording", active: !CGPreflightScreenCaptureAccess(), message: "远端 Mac 尚未允许 LinkShell 录制屏幕，融合窗口无法显示")
  }

  func report(_ kind: String, active: Bool, message: String) {
    guard healthSent[kind] != active else { return }
    healthSent[kind] = active
    if active {
      wire.send(["t": "alert", "kind": kind, "message": message])
    } else {
      wire.send(["t": "alert", "kind": kind, "clear": true])
    }
  }

  func sendReady(catalog: [[String: String]]) {
    wire.send([
      "t": "ready",
      "displays": mirrors.map { ["index": $0.index, "local": Fusion.dict($0.local), "remote": Fusion.dict($0.remote), "scale": $0.scale] },
      "apps": catalog,
    ])
  }


  /// Remote → local, only while one of the fused apps is frontmost here (the person is using it).
  func clipboardTick() {
    guard !ended, clipboard.armed,
          let front = NSWorkspace.shared.frontmostApplication?.processIdentifier, fused.contains(front) else { return }
    let pasteboard = NSPasteboard.general
    let count = pasteboard.changeCount
    guard clipboard.isUnseen(changeCount: count) else { return }
    let types = (pasteboard.types ?? []).map(\.rawValue)
    let item = FusionClipboardItem.read(pasteboard)
    guard clipboard.shouldSend(changeCount: count, types: types, bytes: item.bytes) else { return }
    wire.send(item.message)
  }

  func noteUserAction(pid: pid_t) {
    lastUserAction[pid] = CACurrentMediaTime()
  }

  /// A window takes the focus on the local Mac only when it follows something the person did in
  /// that app moments ago (a click, a key, a launch from here), never when it opens on its own.
  func followsUserAction(pid: pid_t) -> Bool {
    guard let at = lastUserAction[pid] else { return false }
    return CACurrentMediaTime() - at < 3.0
  }

  /// A mouse-down or menu key in a fused window: a menu may open next, and its first frame should
  /// not wait for the idle 2 fps overlay to switch up.
  func prewarmOverlay() {
    let until = CACurrentMediaTime() + 2.0
    let wasWarm = prewarmUntil > CACurrentMediaTime()
    prewarmUntil = until
    if !wasWarm { for mirror in mirrors { mirror.session?.setFusionOverlayActive(true) } }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.05) { [weak self] in
      guard let self, !self.ended, CACurrentMediaTime() >= self.prewarmUntil else { return }
      for mirror in self.mirrors {
        let active = self.lastPopupMirrors.contains(mirror.index)
        mirror.session?.setFusionOverlayActive(active)
      }
    }
  }
}

extension FusionRemoteSession {
  func end() {
    guard !ended else { return }
    ended = true
    timers.forEach { $0.invalidate() }
    let wsCenter = NSWorkspace.shared.notificationCenter
    workspaceObservers.forEach { wsCenter.removeObserver($0) }
    workspaceObservers.removeAll()
    sampler.stop()
    ScreenCapturer.fusionFilter = nil
    ScreenCapturer.fusionAnnotate = nil
    ScreenCapturer.fusionAnnotateWindow = nil
    for mirror in mirrors {
      mirror.session?.close()
      if mirror.descriptor >= 0 { close(mirror.descriptor) }
    }
    for id in Array(streams.keys) { closeStream(id) }
    if dockHiddenByUs { FusionDock.restore(home: Self.home); dockHiddenByUs = false }
    mirrors.removeAll()
    Fusion.log("session ended")
  }
}
