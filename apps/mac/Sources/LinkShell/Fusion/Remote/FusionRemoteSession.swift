import AppKit
import ApplicationServices
import CoreVideo
import Foundation
import LinkShellFusionShim
import LinkShellScreen
import ScreenCaptureKit

/// Window ids from AX elements: private, but stable since macOS 10.x and used by every window manager.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

/// One local computer's Fusion session on this Mac (docs/v2/fusion.md §4): the virtual displays
/// that copy its screens, the fused apps' windows on them, and the pictures of those windows.
///
/// It outlives its connection for `FusionProtocol.resumeGrace` when that drops without a `bye`,
/// so a network blip does not put every window back and take the displays away.
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
    init(index: Int, screenBounds: CGRect, local: CGRect, visible: CGRect, menuBarHeight: CGFloat, scale: Int, hz: Double, display: CGVirtualDisplay) {
      self.index = index; self.screenBounds = screenBounds; self.local = local; self.visible = visible; self.menuBarHeight = menuBarHeight; self.scale = scale; self.hz = hz; self.display = display
    }
    var streamKey: String { "d\(index)" }
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
    let pid: pid_t
    var mirrorIndex: Int
    var groupIDs: Set<CGWindowID>
    var app: String
    var key: String
  }

  private(set) var wire: FusionWire
  let authorize: (String) -> Bool
  let sessionID = "s-" + UUID().uuidString.prefix(8).lowercased()
  static var home = NSHomeDirectory() + "/.linkshell"
  /// A hung remote app must not freeze every fused window: AX calls give up after this.
  static let axTimeout: Float = 0.15
  let iceServers: [[String: Any]]
  var media: FusionMedia?
  var mirrors: [Mirror] = []
  var pidToBundle: [pid_t: String] = [:]
  var fused: Set<pid_t> = [] { didSet { sampler.set(pids: fused) } }
  var moved: Set<CGWindowID> = []
  /// Where each window this session moved was before it, so `end()` can put it back.
  var originalFrames: [CGWindowID: (pid: pid_t, frame: CGRect)] = [:]
  var lastLayout = ""
  var lastPopups: Set<CGWindowID> = []
  var streams: [CGWindowID: WindowStream] = [:]
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
  var localName = ""
  var localFeatures: Set<String> = []
  var displaysSignature = ""
  var statusItem: FusionStatusItem?
  var graceTimer: DispatchSourceTimer?
  /// No connection right now (suspended, or its old one detached for a resume): nothing is sent,
  /// and `track()` waits, so what changes meanwhile is told on the next connection.
  var paused = false
  /// Windows announced before the drop; those not announced again after a resume get `wclose`.
  var resumeKnown: Set<CGWindowID>?
  /// Whether the global capture hooks are this session's: a stray connection's session must not
  /// clear the ones a running session depends on.
  var hooksInstalled = false
  /// Media restarts asked for by the local computer, to stop a loop of failing ones.
  var mediaRestarts: [Double] = []
  /// When a shown window was last brought back onto a virtual display.
  var offDisplayStamps: [CGWindowID: Double] = [:]
  /// When a shown, off-screen window's app first failed to answer AX.
  var axDeferStamps: [CGWindowID: Double] = [:]
  var onAuthenticated: (() -> Void)?
  /// The suspended session a `hello` with `resume` names, if this Mac still has it.
  var resumeTarget: ((String) -> FusionRemoteSession?)?
  /// This placeholder handed its connection to a suspended session.
  var onResumed: ((FusionRemoteSession) -> Void)?

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
    guard authenticated, !ended else { return }
    switch type {
    case "bye":
      Fusion.log("local said bye: \(m["reason"] as? String ?? "")")
      end()
      wire.close(reason: "bye")
    case "launch":
      if let app = m["app"] as? String, !app.isEmpty {
        if displayReady {
          launch(app)
        } else if !pendingRemoteLaunches.contains(app) {
          pendingRemoteLaunches.append(app)
        }
      }
    case "quit":
      if let app = m["app"] as? String { quit(app, force: m["force"] as? Bool == true) }
    case "menu.fetch":
      if let app = m["app"] as? String { sendMenu(bundle: app, path: FusionProtocol.path(m["path"])) }
    case "menu.press":
      if let app = m["app"] as? String { pressMenu(bundle: app, path: FusionProtocol.path(m["path"])) }
    case "dockmenu.press":
      if let app = m["app"] as? String { performDockAction(bundle: app, path: FusionProtocol.path(m["path"])) }
    case "icon": if let app = m["app"] as? String { sendIcon(app) }
    case "focus": focus(CGWindowID(Fusion.number(m["id"])))
    case "place":
      let seq = UInt64(max(0, Fusion.number(m["seq"])))
      enqueuePlace(CGWindowID(Fusion.number(m["id"])), seq: seq, local: Fusion.rect(m["frame"]), resize: m["resize"] as? Bool == true)
    case "wclose.req":
      closeRemoteWindow(CGWindowID(Fusion.number(m["id"])))
    case "ping": wire.send(["t": "pong", "ts": m["ts"] ?? 0])
    case "clip":
      if clipboard.armed, let item = FusionClipboardItem(message: m) {
        clipboard.didWrite(changeCount: item.write(to: NSPasteboard.general))
      }
    case "prewarm":
      if let id = (m["id"] as? NSNumber).map({ CGWindowID($0.uint32Value) }), let s = streams[id] { noteUserAction(pid: s.pid) }
      prewarmOverlay()
    case "app.active":
      // No fused app is in front on the local computer: make the remote apps look inactive too,
      // by giving the remote focus to this (windowless) process. A window becoming key sends `focus`.
      if m["on"] as? Bool == false { NSApp.activate(ignoringOtherApps: true) }
    case "displays":
      if let locals = m["displays"] as? [[String: Any]], !locals.isEmpty {
        Task { @MainActor in await self.rebuildDisplays(locals) }
      }
    case "rtc":
      guard let payload = m["m"] as? [String: Any] else { return }
      if payload["t"] as? String == "restart" { restartMedia() } else { media?.receive(payload) }
    default: break
    }
  }
}

extension FusionRemoteSession {
  @MainActor func hello(_ m: [String: Any]) async {
    guard !authenticated, let presented = m["token"] as? String, authorize(presented) else {
      Fusion.log("wrong or spent token")
      wire.sendThenClose(["t": "bye", "reason": "token"], reason: "token")
      return
    }
    // An older local Mac speaks v1: say why instead of failing half-way.
    guard (m["proto"] as? NSNumber)?.intValue == FusionProtocol.version else {
      Fusion.log("local speaks protocol \(m["proto"] ?? "1"), not \(FusionProtocol.version)")
      wire.sendThenClose(["t": "bye", "reason": "proto", "message": "本机 LinkShell 版本与远端不一致，请把两台电脑都升级到最新版本后再开启融合模式"], reason: "proto")
      return
    }
    authenticated = true
    if let resume = m["resume"] as? String, let target = resumeTarget?(resume) {
      target.resume(with: wire, hello: m)
      onResumed?(target)
      return
    }
    onAuthenticated?()
    adopt(hello: m)
    sendWelcome(resumed: false)
    // The catalog first (<150 ms): the virtual displays take a few seconds.
    wire.send(["t": "apps", "apps": Self.apps()])
    if !AXIsProcessTrusted() { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary) }
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    dockHiddenByUs = FusionDock.hide(home: Self.home)
    let locals = m["displays"] as? [[String: Any]] ?? []
    displaysSignature = FusionProtocol.displaysSignature(locals)
    await buildMirrors(locals)
    guard !ended else { return }
    installCaptureHooks()
    displayReady = true
    sendReady()
    startMedia()
    let queuedLaunches = pendingRemoteLaunches
    pendingRemoteLaunches.removeAll()
    for app in queuedLaunches { launch(app) }
    Fusion.log("ready: " + mirrors.map { "\($0.local) -> \($0.remote) @\($0.scale)x" }.joined(separator: "; "))
    checkHealth()
    statusItem = FusionStatusItem(localName: localName) { [weak self] in self?.endHere() }
    let wsCenter = NSWorkspace.shared.notificationCenter
    workspaceObservers.append(wsCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
      guard let self, !self.ended else { return }
      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      guard app?.activationPolicy != .prohibited else { return }
      self.media?.refreshGroupApps()
    })
    workspaceObservers.append(wsCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
      self?.track()
    })
    timers.append(Timer.scheduledTimer(withTimeInterval: 1.0 / 35, repeats: true) { [weak self] _ in self?.track() })
    timers.append(Timer.scheduledTimer(withTimeInterval: 0.45, repeats: true) { [weak self] _ in self?.rescueOffDesktopWindows() })
    timers.append(Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in self?.checkHealth() })
    timers.append(Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.clipboardTick() })
  }

  private func adopt(hello m: [String: Any]) {
    localName = (m["name"] as? String) ?? ""
    localFeatures = Set((m["features"] as? [String]) ?? [])
  }

  private func sendWelcome(resumed: Bool) {
    wire.send(["t": "welcome", "proto": FusionProtocol.version, "platform": "macos",
               "features": FusionProtocol.remoteFeatures, "session": sessionID, "resumed": resumed])
  }

  /// The connection dropped without a `bye`: keep the displays and windows where they are for a
  /// while, stop the pictures, and wait for the same local computer to come back.
  func suspend() {
    guard !ended, displayReady, graceTimer == nil else { return end() }
    Fusion.log("connection lost: keeping session \(sessionID) for \(Int(FusionProtocol.resumeGrace)) s")
    pause()
    statusItem?.update(state: "正在等待 \(localName.isEmpty ? "本地电脑" : localName) 重新连接…")
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + FusionProtocol.resumeGrace)
    timer.setEventHandler { [weak self] in
      Fusion.log("session not resumed in time: ending")
      self?.end()
    }
    timer.resume()
    graceTimer = timer
  }

  /// Stops what needs a connection: timers, pictures.
  private func pause() {
    paused = true
    timers.forEach { $0.invalidate() }
    timers.removeAll()
    media?.close()
    media = nil
  }

  /// The local computer is resuming on a new connection while this side still had the old one.
  func detachWire() {
    wire.onClose = nil
    wire.close(reason: "replaced")
    pause()
  }

  /// The same local computer is back on a new connection (`hello.resume`).
  @MainActor func resume(with wire: FusionWire, hello m: [String: Any]) {
    guard !ended else { return }
    graceTimer?.cancel()
    graceTimer = nil
    pause()
    paused = false
    self.wire = wire
    authenticated = true
    adopt(hello: m)
    Fusion.log("session \(sessionID) resumed")
    sendWelcome(resumed: true)
    wire.send(["t": "apps", "apps": Self.apps()])
    statusItem?.update(state: nil)
    let locals = m["displays"] as? [[String: Any]] ?? []
    let signature = FusionProtocol.displaysSignature(locals)
    // Every window still open is announced again on the new connection, with a fresh picture; the
    // ones that closed meanwhile are closed there (`resumeKnown`, settled by the first `track()`).
    resumeKnown = Set(streams.keys)
    streams.removeAll()
    lastLayout = ""
    lastPopups = []
    // Another connection's session may have cleared them while this one waited.
    installCaptureHooks()
    if signature != displaysSignature, !locals.isEmpty {
      displaysSignature = signature
      Task { @MainActor in await self.rebuildDisplays(locals) }
    } else {
      sendReady()
      startMedia()
    }
    timers.append(Timer.scheduledTimer(withTimeInterval: 1.0 / 35, repeats: true) { [weak self] _ in self?.track() })
    timers.append(Timer.scheduledTimer(withTimeInterval: 0.45, repeats: true) { [weak self] _ in self?.rescueOffDesktopWindows() })
    timers.append(Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in self?.checkHealth() })
    timers.append(Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.clipboardTick() })
    healthSent.removeAll()
    checkHealth()
  }

  /// Ends the session with a reason the local computer shows.
  func finish(reason: String, message: String? = nil) {
    guard !ended else { return }
    var bye: [String: Any] = ["t": "bye", "reason": reason]
    if let message { bye["message"] = message }
    // The `bye` first: putting windows back is AX work that a hung app can drag past the local
    // side's watchdog, which would take a deliberate end for a dropped connection.
    wire.sendThenClose(bye, reason: "bye")
    end()
  }

  private func endHere() {
    Fusion.log("ended from the menu bar")
    finish(reason: "user", message: "远端电脑上结束了融合模式")
  }

  /// Problems the person at the local computer cannot see from here: each becomes an alert with
  /// a remedy, and is cleared again once it is fixed.
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

  func sendReady() {
    wire.send(["t": "ready", "displays": mirrors.map { ["index": $0.index, "frame": Fusion.dict($0.local)] }])
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

  /// A window takes the focus on the local computer only when it follows something the person did
  /// in that app moments ago (a click, a key, a launch from there), never when it opens on its own.
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
    if !wasWarm { media?.setOverlaysActive { _ in true } }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.05) { [weak self] in
      guard let self, !self.ended, CACurrentMediaTime() >= self.prewarmUntil else { return }
      let busy = self.lastPopupMirrors
      self.media?.setOverlaysActive { busy.contains($0) }
    }
  }
}

extension FusionRemoteSession {
  func end() {
    guard !ended else { return }
    ended = true
    graceTimer?.cancel()
    graceTimer = nil
    timers.forEach { $0.invalidate() }
    let wsCenter = NSWorkspace.shared.notificationCenter
    workspaceObservers.forEach { wsCenter.removeObserver($0) }
    workspaceObservers.removeAll()
    sampler.stop()
    if hooksInstalled {
      ScreenCapturer.fusionFilter = nil
      ScreenCapturer.fusionAnnotate = nil
      ScreenCapturer.fusionAnnotateWindow = nil
      hooksInstalled = false
    }
    media?.close()
    media = nil
    restoreWindows()
    streams.removeAll()
    if dockHiddenByUs { FusionDock.restore(home: Self.home); dockHiddenByUs = false }
    mirrors.removeAll()
    statusItem?.remove()
    statusItem = nil
    Fusion.log("session ended")
  }

  /// Before the virtual displays go: each window this session moved goes back where it was; one
  /// that was born on a virtual display comes to the main display, no larger than it.
  func restoreWindows() {
    guard let main = NSScreen.screens.first else { return }
    let primaryHeight = main.frame.height
    let v = main.visibleFrame
    let usable = CGRect(x: v.minX, y: primaryHeight - v.maxY, width: v.width, height: v.height)
    var targets: [(pid: pid_t, id: CGWindowID, frame: CGRect)] = originalFrames.map { ($0.value.pid, $0.key, $0.value.frame) }
    let restored = Set(originalFrames.keys)
    var offset: CGFloat = 0
    for (id, stream) in streams where !restored.contains(id) {
      guard let now = Self.liveCGWindowBounds(id), mirrors.contains(where: { $0.remote.intersects(now) }) else { continue }
      let size = CGSize(width: min(now.width, usable.width - 40), height: min(now.height, usable.height - 40))
      targets.append((stream.pid, id, CGRect(origin: CGPoint(x: usable.minX + 20 + offset, y: usable.minY + 20 + offset), size: size)))
      offset = (offset + 28).truncatingRemainder(dividingBy: 280)
    }
    for target in targets {
      guard let window = axWindow(pid: target.pid, id: target.id) else { continue }
      var origin = target.frame.origin
      var size = target.frame.size
      AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &origin)!)
      AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
      AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &origin)!)
    }
    if !targets.isEmpty { Fusion.log("put \(targets.count) window(s) back") }
    originalFrames.removeAll()
  }
}
