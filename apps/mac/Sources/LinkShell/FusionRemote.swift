import AppKit
import ApplicationServices
import CoreVideo
import Foundation
import ImageIO
import LinkShellFusionShim
import Network
import ScreenCaptureKit
import UniformTypeIdentifiers
import WebRTC

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

/// Fusion lab (experimental), the Mac whose apps are fused: `LinkShell --fusion-remote --token T`.
///
/// Mirrors the local Mac's displays as 1:1 `CGVirtualDisplay`s (hiding the remote Dock so zoom
/// matches the local usable frame), isolates each root window + its child/traffic-light windows on
/// its virtual display (`excludingApplications: all, exceptingWindows: group`) at fixed display
/// resolution (zero `VTCompressionSession` resets during live resize, zero cross-window ghosting,
/// intact Electron traffic lights), and streams popup menus (`layer > 0`) on a lightweight overlay.
final class FusionRemote {
  static func run() -> Never {
    Engine.ownEncoder = true
    Engine.report = { Fusion.log($0) }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let requestedPort = Launch.value(after: "--port").flatMap(UInt16.init) ?? FusionWire.port
    let parentSock = Launch.value(after: "--parent-sock")
    let iceServers = Self.parseICEServers(Launch.value(after: "--ice-servers"))
    let remote = FusionRemote(
      token: Launch.value(after: "--token") ?? "",
      port: requestedPort,
      parentSocketPath: parentSock,
      iceServers: iceServers
    )
    remote.listen()
    app.run()
    exit(0)
  }

  private static func parseICEServers(_ raw: String?) -> [[String: Any]] {
    guard let raw, !raw.isEmpty,
          let data = raw.data(using: .utf8),
          let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
      return []
    }
    return list
  }

  private let token: String
  private let requestedPort: UInt16
  private let parentSocketPath: String?
  private let iceServers: [[String: Any]]
  private var parentFD: Int32 = -1
  private var listener: NWListener?
  private var current: FusionRemoteSession?
  private var pending: [ObjectIdentifier: FusionRemoteSession] = [:]

  init(token: String, port: UInt16, parentSocketPath: String?, iceServers: [[String: Any]]) {
    self.token = token
    self.requestedPort = port
    self.parentSocketPath = parentSocketPath
    self.iceServers = iceServers
  }

  func listen() {
    let endpointPort: NWEndpoint.Port = requestedPort == 0 ? .any : (NWEndpoint.Port(rawValue: requestedPort) ?? NWEndpoint.Port(rawValue: FusionWire.port)!)
    let listener: NWListener
    if let exact = try? NWListener(using: FusionWire.parameters(), on: endpointPort) {
      listener = exact
    } else if let anyListener = try? NWListener(using: FusionWire.parameters(), on: .any) {
      listener = anyListener
    } else {
      Fusion.log("cannot listen on \(requestedPort)")
      exit(1)
    }
    listener.stateUpdateHandler = { [weak self, weak listener] state in
      guard let self, let listener else { return }
      switch state {
      case .ready:
        let actual = listener.port?.rawValue ?? self.requestedPort
        Fusion.log("fusion remote on \(actual): AX \(AXIsProcessTrusted()), capture \(CGPreflightScreenCaptureAccess())")
        self.connectParentLifecycleSocket(port: actual)
      case .failed(let error):
        Fusion.log("fusion listener failed: \(error)")
        self.current?.end()
        exit(1)
      default:
        break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      DispatchQueue.main.async {
        guard let self else { return }
        Fusion.log("connection from \(connection.endpoint)")
        let wire = FusionWire(connection)
        let session = FusionRemoteSession(wire: wire, token: self.token, iceServers: self.iceServers)
        let key = ObjectIdentifier(session)
        self.pending[key] = session
        session.onAuthenticated = { [weak self, weak session] in
          guard let self, let session else { return }
          self.pending.removeValue(forKey: key)
          if self.current !== session {
            self.current?.end()
            self.current = session
          }
        }
        wire.onMessage = { [weak session] in session?.receive($0) }
        wire.onClose = { [weak self, weak session] in
          self?.pending.removeValue(forKey: key)
          session?.end()
          if self?.current === session { self?.current = nil }
        }
        wire.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + 8.0) { [weak self, weak session] in
          guard let self, let session, self.pending[key] != nil else { return }
          self.pending.removeValue(forKey: key)
          session.end()
        }
      }
    }
    listener.start(queue: .main)
    self.listener = listener
  }

  private func connectParentLifecycleSocket(port: UInt16) {
    guard let path = parentSocketPath, !path.isEmpty, parentFD < 0 else { return }
    let sock = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard sock >= 0 else { return }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { Darwin.close(sock); return }
    withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
      ptr.withMemoryRebound(to: CChar.self, capacity: bytes.count) { dst in
        for i in 0..<bytes.count { dst[i] = bytes[i] }
      }
    }
    let connected = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(sock, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard connected == 0 else {
      Darwin.close(sock)
      Fusion.log("parent lifecycle socket unavailable: \(path)")
      exit(1)
    }
    parentFD = sock
    if var payload = try? JSONSerialization.data(withJSONObject: ["ready": true, "port": Int(port), "pid": Int(getpid())]) {
      payload.append(10)
      payload.withUnsafeBytes { raw in
        if let base = raw.baseAddress { _ = Darwin.write(sock, base, raw.count) }
      }
    }
    Thread.detachNewThread { [weak self] in
      var buf = [UInt8](repeating: 0, count: 256)
      while true {
        let n = Darwin.read(sock, &buf, buf.count)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { break }
      }
      DispatchQueue.main.async {
        self?.current?.end()
        exit(0)
      }
    }
  }
}

/// High-frequency window geometry ring buffer so each captured `CVPixelBuffer` gets the exact
/// crop and local window coordinates from the `mach_absolute_time()` it was composited.
final class FusionSampler {
  struct Window { let id: CGWindowID; let pid: pid_t; let layer: Int; let frame: CGRect }
  struct Mirror { let id: CGDirectDisplayID; let remote: CGRect; let local: CGRect; let scale: Int }

  private let lock = NSLock()
  private let queue = DispatchQueue(label: "linkshell.fusion.sampler", qos: .userInteractive)
  private var timer: DispatchSourceTimer?
  private var pids: Set<pid_t> = []
  private var popupWindowIDs: Set<CGWindowID> = []
  private var overlayWindowIDs: Set<CGWindowID> = []
  private var mirrors: [Mirror] = []
  private var ring: [(time: UInt64, windows: [CGWindowID: Window])] = []
  private var peakAlpha: [CGWindowID: Double] = [:]
  private var previousVisibleIDs: Set<CGWindowID> = []
  private var disappearancePending = false
  var onWindowDisappeared: (() -> Void)?
  private var ackHistory: [CGWindowID: [(seq: UInt64, time: UInt64)]] = [:]
  private var activeTransitions: [CGWindowID: UInt64] = [:]
  private var transitionRanges: [CGWindowID: [(start: UInt64, end: UInt64)]] = [:]

  var fused: Set<pid_t> { lock.lock(); defer { lock.unlock() }; return pids }
  var popups: Set<CGWindowID> { lock.lock(); defer { lock.unlock() }; return popupWindowIDs }
  var overlayIncluded: Set<CGWindowID> { lock.lock(); defer { lock.unlock() }; return overlayWindowIDs }
  func set(pids: Set<pid_t>) { lock.lock(); self.pids = pids; lock.unlock() }
  func set(popups: Set<CGWindowID>, parents: Set<CGWindowID> = []) {
    lock.lock()
    self.popupWindowIDs = popups
    self.overlayWindowIDs = popups.union(parents)
    lock.unlock()
  }
  func set(mirrors: [Mirror]) { lock.lock(); self.mirrors = mirrors; lock.unlock() }

  func latestFrame(window id: CGWindowID) -> CGRect? {
    lock.lock()
    defer { lock.unlock() }
    for i in stride(from: ring.count - 1, through: 0, by: -1) {
      if let f = ring[i].windows[id]?.frame { return f }
    }
    return nil
  }

  func beginTransition(window id: CGWindowID, at start: UInt64) {
    lock.lock()
    if activeTransitions[id] == nil {
      activeTransitions[id] = start
    }
    lock.unlock()
  }

  func endTransition(window id: CGWindowID, moved: Bool, at settled: UInt64, seq: UInt64) {
    lock.lock()
    if let start = activeTransitions.removeValue(forKey: id), moved, settled > start {
      var ranges = transitionRanges[id] ?? []
      ranges.append((start, settled))
      if ranges.count > 12 { ranges.removeFirst(ranges.count - 12) }
      transitionRanges[id] = ranges
    }
    if seq > 0 {
      var list = ackHistory[id] ?? []
      if (list.last?.seq ?? 0) < seq {
        list.append((seq, settled))
        if list.count > 16 { list.removeFirst(list.count - 16) }
        ackHistory[id] = list
      }
    }
    lock.unlock()
  }

  func clearWindow(_ id: CGWindowID) {
    lock.lock()
    ackHistory[id] = nil
    activeTransitions[id] = nil
    transitionRanges[id] = nil
    lock.unlock()
  }

  func sampleNow() {
    sample()
  }

  func start() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(4), leeway: .milliseconds(1))
    timer.setEventHandler { [weak self] in self?.sample() }
    timer.resume()
    self.timer = timer
  }

  func stop() { timer?.cancel(); timer = nil }

  private func sample() {
    let pids = fused
    guard !pids.isEmpty, let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return }
    let time = mach_absolute_time()
    var windows: [CGWindowID: Window] = [:]
    var rawOnScreenIDs: Set<CGWindowID> = []
    var notifyDisappeared = false

    lock.lock()
    for info in list {
      guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, pids.contains(pid),
            let id = info[kCGWindowNumber as String] as? CGWindowID,
            let bounds = info[kCGWindowBounds as String] as? [String: Any],
            let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.width > 1, frame.height > 1 else { continue }
      rawOnScreenIDs.insert(id)
      let alpha = info[kCGWindowAlpha as String] as? Double ?? 1.0
      let peak = max(peakAlpha[id] ?? 0, alpha)
      peakAlpha[id] = peak
      // Drop closing windows on Frame #1 of macOS's close fade-out (`1.0 -> 0.86 -> ... -> 0.0`)
      // so `SCContentFilter` never composites a fading window over its black void background!
      guard alpha > 0.05, alpha >= peak - 0.04 else { continue }
      windows[id] = Window(id: id, pid: pid, layer: info[kCGWindowLayer as String] as? Int ?? 0, frame: frame)
    }
    if peakAlpha.count > rawOnScreenIDs.count {
      peakAlpha = peakAlpha.filter { rawOnScreenIDs.contains($0.key) }
    }
    let currentIDs = Set(windows.keys)
    if !previousVisibleIDs.subtracting(currentIDs).isEmpty, !disappearancePending {
      disappearancePending = true
      notifyDisappeared = true
    }
    previousVisibleIDs = currentIDs
    ring.append((time, windows))
    if ring.count > 64 { ring.removeFirst(ring.count - 64) }
    let callback = notifyDisappeared ? onWindowDisappeared : nil
    lock.unlock()

    if let callback {
      DispatchQueue.main.async { [weak self] in
        if let self {
          self.lock.lock()
          self.disappearancePending = false
          self.lock.unlock()
        }
        callback()
      }
    }
  }

  /// Exact normalized crop (`0..1`) inside `buffer` + local Mac point frame + in-window visible rect + display scale + causal `ackSeq`.
  /// Format: `[lx, ly, lw, lh, nx, ny, nw, nh, ix, iy, iw, ih, scale, ack]`.
  func windowCrop(window id: CGWindowID, display: CGDirectDisplayID, at time: UInt64) -> Data? {
    lock.lock()
    let ring = self.ring
    let mirror = self.mirrors.first { $0.id == display }
    let acks = self.ackHistory[id] ?? []
    let inFlightStart = self.activeTransitions[id]
    let ranges = self.transitionRanges[id] ?? []
    lock.unlock()
    guard let mirror, mirror.remote.width > 0, mirror.remote.height > 0 else { return nil }
    // Drop frames captured while `AXUIElementSetAttributeValue` was actively moving/resizing `id`
    // in WindowServer so a pre-move pixel buffer is never cropped with post-move coordinates!
    if let inFlightStart, time >= inFlightStart { return nil }
    if ranges.contains(where: { time >= $0.start && time < $0.end }) { return nil }
    // If `id` has already vanished or started its close fade in the latest 250Hz sample, drop immediately
    // so a post-close black `SCStream` frame never gets stamped with pre-close SEI coordinates!
    guard let latest = ring.last, latest.windows[id] != nil else { return nil }
    let sampleIdx = ring.lastIndex(where: { $0.time <= time }) ?? 0
    guard let frame = ring[sampleIdx].windows[id]?.frame else { return nil }
    let visible = frame.intersection(mirror.remote)
    guard !visible.isNull, visible.width >= 2, visible.height >= 2 else { return nil }
    let ackAtTime = acks.last(where: { $0.time <= time })?.seq ?? 0
    let nx = min(1, max(0, Double((visible.minX - mirror.remote.minX) / mirror.remote.width)))
    let ny = min(1, max(0, Double((visible.minY - mirror.remote.minY) / mirror.remote.height)))
    let nw = min(1 - nx, max(0.001, Double(visible.width / mirror.remote.width)))
    let nh = min(1 - ny, max(0.001, Double(visible.height / mirror.remote.height)))
    let local = frame.offsetBy(dx: mirror.local.minX - mirror.remote.minX, dy: mirror.local.minY - mirror.remote.minY)
    let inWin = CGRect(x: visible.minX - frame.minX, y: visible.minY - frame.minY, width: visible.width, height: visible.height)
    func r2(_ v: CGFloat) -> Double { (Double(v) * 100).rounded() / 100 }
    func r6(_ v: Double) -> Double { (v * 1_000_000).rounded() / 1_000_000 }
    return try? JSONSerialization.data(withJSONObject: [
      r2(local.minX), r2(local.minY), r2(local.width), r2(local.height),
      r6(nx), r6(ny), r6(nw), r6(nh),
      r2(inWin.minX), r2(inWin.minY), r2(inWin.width), r2(inWin.height),
      Double(mirror.scale), Double(ackAtTime),
    ])
  }

  /// Popup windows (`layer > 0` / ungrouped) on `display` at `time`: `[[id, layer, x, y, w, h]]`.
  func layout(display: CGDirectDisplayID, at time: UInt64) -> Data? {
    lock.lock()
    let ring = self.ring
    let popups = self.popupWindowIDs
    let mirror = mirrors.first { $0.id == display }
    lock.unlock()
    guard let mirror, !ring.isEmpty else { return nil }
    let after = ring.firstIndex { $0.time > time }
    let beforeIndex: Int?
    if let after { beforeIndex = after > 0 ? after - 1 : nil } else { beforeIndex = ring.count - 1 }
    var result: [[Double]] = []
    let base = ring[beforeIndex ?? after!]
    let next = after.map { ring[$0] }
    var weight = 0.0
    if let next, beforeIndex != nil, next.time > base.time {
      weight = min(max(Double(time &- base.time) / Double(next.time - base.time), 0), 1)
    }
    for window in base.windows.values where popups.contains(window.id) {
      var frame = window.frame
      if let other = next?.windows[window.id], weight > 0 {
        frame = CGRect(x: frame.minX + (other.frame.minX - frame.minX) * weight,
                       y: frame.minY + (other.frame.minY - frame.minY) * weight,
                       width: frame.width + (other.frame.width - frame.width) * weight,
                       height: frame.height + (other.frame.height - frame.height) * weight)
      }
      guard frame.intersects(mirror.remote) else { continue }
      let local = frame.offsetBy(dx: mirror.local.minX - mirror.remote.minX, dy: mirror.local.minY - mirror.remote.minY)
      result.append([Double(window.id), Double(window.layer), local.minX, local.minY, local.width, local.height])
    }
    return try? JSONSerialization.data(withJSONObject: result)
  }
}

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

  private struct AXWindowKind {
    let exists: Bool
    let isStandardRoot: Bool
    let checkedAt: Double
  }

  private struct PendingPlace {
    let seq: UInt64
    let local: CGRect
    let resize: Bool
    let mirrorIndex: Int
  }

  private struct WindowStream {
    let session: ScreenSession
    let descriptor: Int32
    let pid: pid_t
    var mirrorIndex: Int
    var groupIDs: Set<CGWindowID>
    var bundle: String
  }

  private let wire: FusionWire
  private let token: String
  private let iceServers: [[String: Any]]
  private var mirrors: [Mirror] = []
  private var pidToBundle: [pid_t: String] = [:]
  private var fused: Set<pid_t> = [] { didSet { sampler.set(pids: fused) } }
  private var moved: Set<CGWindowID> = []
  private var lastLayout = ""
  private var lastPopups: Set<CGWindowID> = []
  private var streams: [CGWindowID: WindowStream] = [:]
  private var dragZones: [CGWindowID: Bool] = [:]
  private var hoverStamps: [CGWindowID: Double] = [:]
  private var axTitles: [CGWindowID: (title: String, at: Double)] = [:]
  private var windowKinds: [CGWindowID: AXWindowKind] = [:]
  private var peakWindowAlpha: [CGWindowID: Double] = [:]
  private var clampStamps: [CGWindowID: Double] = [:]
  private var nonAXWindowStamps: [CGWindowID: Double] = [:]
  private var rescuingWindowIDs: [CGWindowID: Double] = [:]
  private var workspaceObservers: [NSObjectProtocol] = []
  private let placeQueue = DispatchQueue(label: "com.bd.linkshell.fusion.place", qos: .userInteractive)
  private let placeLock = NSLock()
  private var pendingPlaces: [CGWindowID: PendingPlace] = [:]
  private var appliedSeq: [CGWindowID: UInt64] = [:]
  private var placeWorkerRunning = false
  private var dockMenuSent: [String: String] = [:]
  private var dockMenuStamps: [String: Double] = [:]
  private var focusedWindowID: CGWindowID = 0
  private var knownRunningPIDs: Set<pid_t> = []
  private var dockWasHidden: Bool?
  private var timers: [Timer] = []
  private let sampler = FusionSampler()
  private var ended = false
  private var authenticated = false
  private var displayReady = false
  private var pendingRemoteLaunches: [String] = []
  var onAuthenticated: (() -> Void)?

  private static let appPathsLock = NSLock()
  private static var appPaths: [String: String] = [:]

  init(wire: FusionWire, token: String, iceServers: [[String: Any]] = []) {
    self.wire = wire
    self.token = token
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
    case "sig": if let key = m["k"] as? String { signal(key, m["m"] as? [String: Any] ?? [:]) }
    default: break
    }
  }

  // MARK: displays

  private static func settings(points: CGSize, scale: Int, hz: Double) -> CGVirtualDisplaySettings {
    let s = CGVirtualDisplaySettings()
    s.hiDPI = scale > 1 ? 1 : 0
    s.modes = [CGVirtualDisplayMode(width: UInt32(points.width.rounded()), height: UInt32(points.height.rounded()), refreshRate: min(max(hz, 60), 120))]
    return s
  }

  private static func makeDisplay(index: Int, points: CGSize, scale: Int, hz: Double) -> CGVirtualDisplay? {
    let d = CGVirtualDisplayDescriptor()
    d.queue = .main
    d.name = "LinkShell Fusion \(index + 1)"
    d.maxPixelsWide = UInt32(points.width + 200) * UInt32(scale)
    d.maxPixelsHigh = UInt32(points.height + 200) * UInt32(scale)
    d.sizeInMillimeters = CGSize(width: points.width / 110 * 25.4, height: points.height / 110 * 25.4)
    d.vendorID = 0x4C53; d.productID = 0x4600 + UInt32(index); d.serialNum = 100 + UInt32(index)
    d.terminationHandler = { _, _ in Fusion.log("virtual display \(index) ended by the system") }
    guard let display = CGVirtualDisplay(descriptor: d) else { return nil }
    if !display.apply(settings(points: points, scale: scale, hz: hz)) { Fusion.log("virtual display \(index): settings refused") }
    return display
  }

  @MainActor private func hello(_ m: [String: Any]) async {
    guard m["token"] as? String == token else { Fusion.log("wrong token"); wire.close(); return }
    authenticated = true
    onAuthenticated?()
    // Deliver the remote app catalog immediately (<150ms) before virtual-display setup sleeps (~3.3s),
    // while still including `apps` in `ready` below for 0.10.102 compatibility.
    let catalog = Self.apps()
    wire.send(["t": "apps", "apps": catalog])
    if !AXIsProcessTrusted() { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary) }
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    dockWasHidden = Self.dockHidden()
    if dockWasHidden == false { Self.setDockHidden(true) }
    let locals = m["displays"] as? [[String: Any]] ?? []
    var menuBar: CGFloat = 30
    // Size each virtual display to `screenBounds.width × ceil4(screenBounds.height + menuBar)` so even
    // below the remote macOS menu bar, 100% of a full-screen window's height fits on the desktop with
    // clean macroblock-friendly even pixel alignment!
    func region(_ screen: CGRect) -> CGRect {
      let w = ceil(screen.width / 4.0) * 4.0
      let h = ceil((screen.height + menuBar) / 4.0) * 4.0
      return CGRect(x: screen.minX, y: screen.minY - menuBar, width: w, height: h)
    }
    var hz: [Int: Double] = [:]
    for (i, d) in locals.enumerated() {
      let frame = Fusion.rect(d["frame"]); let scale = max(Int(Fusion.number(d["scale"])), 1)
      var visible = Fusion.rect(d["visible"])
      if visible.width < 100 || visible.height < 100 { visible = frame }
      hz[i] = max(Fusion.number(d["hz"]), 60)
      guard let vd = Self.makeDisplay(index: i, points: region(frame).size, scale: scale, hz: hz[i]!) else { continue }
      mirrors.append(Mirror(index: i, screenBounds: frame, local: region(frame), visible: visible, menuBarHeight: menuBar, scale: scale, hz: hz[i]!, display: vd))
    }
    try? await Task.sleep(nanoseconds: 1_500_000_000)
    guard !ended else { return }
    let measured = mirrors.compactMap { mirror -> CGFloat? in
      guard let screen = NSScreen.screens.first(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == mirror.display.displayID }) else { return nil }
      return screen.frame.maxY - screen.visibleFrame.maxY
    }.max()
    if let measured, measured > 0, abs(measured - menuBar) > 0.5 {
      Fusion.log("menu bar here is \(measured) pt, not \(menuBar): resizing")
      menuBar = measured
      for mirror in mirrors {
        mirror.menuBarHeight = menuBar
        mirror.local = region(mirror.screenBounds)
        _ = mirror.display.apply(Self.settings(points: mirror.local.size, scale: mirror.scale, hz: hz[mirror.index] ?? 60))
      }
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      guard !ended else { return }
    }
    let ours = Set(mirrors.map { $0.display.displayID })
    let own = Display.all.map(\.id).filter { !ours.contains($0) }
    var cursorX = Int32((own.map { CGDisplayBounds($0).maxX }.max() ?? 0).rounded())
    var config: CGDisplayConfigRef?
    CGBeginDisplayConfiguration(&config)
    for mirror in mirrors {
      CGConfigureDisplayOrigin(config, mirror.display.displayID, cursorX, 0)
      cursorX += Int32(mirror.local.width.rounded())
    }
    CGCompleteDisplayConfiguration(config, .forSession)
    try? await Task.sleep(nanoseconds: 800_000_000)
    guard !ended else { return }
    for mirror in mirrors { mirror.remote = CGDisplayBounds(mirror.display.displayID) }
    sampler.set(mirrors: mirrors.map { .init(id: $0.display.displayID, remote: $0.remote, local: $0.local, scale: $0.scale) })
    sampler.start()

    let sampler = self.sampler
    // Display overlay streams carry popup windows (menus, tooltips) plus their parent root windows
    // so rounded popup corners composite against their parent window rather than black.
    ScreenCapturer.fusionFilter = { display, content in
      let included = sampler.overlayIncluded
      let group = content.windows.filter { included.contains($0.windowID) }
      let filter = SCContentFilter(display: display, excludingApplications: content.applications, exceptingWindows: group)
      if #available(macOS 14.2, *) { filter.includeMenuBar = false }
      return filter
    }
    ScreenCapturer.fusionAnnotateWindow = { window, display, buffer, time in
      guard let json = sampler.windowCrop(window: window, display: display, at: time) else {
        return false
      }
      FusionMetadata.attach(json, to: buffer)
      return true
    }
    ScreenCapturer.fusionAnnotate = { display, buffer, time in
      if let json = sampler.layout(display: display, at: time) { FusionMetadata.attach(json, to: buffer) }
    }

    displayReady = true
    wire.send([
      "t": "ready",
      "displays": mirrors.map { ["index": $0.index, "local": Fusion.dict($0.local), "remote": Fusion.dict($0.remote), "scale": $0.scale] },
      "apps": catalog,
    ])
    let queuedLaunches = pendingRemoteLaunches
    pendingRemoteLaunches.removeAll()
    for bundle in queuedLaunches {
      launch(bundle)
    }
    for mirror in mirrors {
      guard let screen = Display.all.firstIndex(where: { $0.id == mirror.display.displayID }) else { continue }
      var pair: [Int32] = [0, 0]
      guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else { continue }
      mirror.descriptor = pair[1]
      let link = Link(input: pair[0], output: pair[0])
      read(pair[1], key: "d\(mirror.index)")
      wire.send(["t": "sig", "k": "d\(mirror.index)", "m": ["rtc": ["t": "config", "iceServers": iceServers]]])
      wire.send(["t": "sig", "k": "d\(mirror.index)", "m": ["session": ["t": "capabilities", "version": 1, "configure": false, "keys": true]]])
      let pixels = Int(mirror.remote.width) * mirror.scale
      let session = ScreenSession(request: ScreenRequest(viewer: "fusion-\(mirror.index)", ["screen": screen, "maxWidth": pixels, "maxFps": 60, "codec": "h264"]),
                                  options: ScreenSession.Options(), link: link)
      session.fusionMode = true
      session.fusionBitrateCap = 400_000
      mirror.session = session
      session.start()
      session.setFusionOverlayActive(false)
    }
    Fusion.log("ready: " + mirrors.map { "\($0.local) -> \($0.remote) @\($0.scale)x" }.joined(separator: "; "))
    if (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Int == 1 {
      Fusion.log("warning: remote macOS session is screen-locked (loginwindow holds focus)")
      wire.send(["t": "error", "message": "远端 Mac 处于锁屏状态（窗口红绿灯呈非激活灰且键盘受限），请先解锁远端屏幕"])
    }
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
  }

  private func read(_ descriptor: Int32, key: String) {
    Thread.detachNewThread { [weak self] in
      var buffer = Data()
      var chunk = [UInt8](repeating: 0, count: 65536)
      while true {
        let count = Darwin.read(descriptor, &chunk, chunk.count)
        if count < 0, errno == EINTR { continue }
        if count <= 0 { break }
        buffer.append(chunk, count: count)
        while let newline = buffer.firstIndex(of: 10) {
          let line = buffer.subdata(in: buffer.startIndex..<newline)
          buffer.removeSubrange(buffer.startIndex...newline)
          guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
          DispatchQueue.main.async { self?.forward(key, message) }
        }
      }
    }
  }

  private func forward(_ key: String, _ m: [String: Any]) {
    switch m["t"] as? String {
    case "rtc.offer": wire.send(["t": "sig", "k": key, "m": ["rtc": ["t": "offer", "sdp": m["sdp"] ?? ""]]])
    case "rtc.ice":
      wire.send(["t": "sig", "k": key, "m": ["rtc": ["t": "ice", "candidate": m["candidate"] ?? "", "sdpMid": m["sdpMid"] ?? NSNull(), "sdpMLineIndex": m["sdpMLineIndex"] ?? 0]]])
    case "rtc.error":
      Fusion.log("\(key): \(m["message"] ?? "")")
      wire.send(["t": "error", "message": "\(key)：\(m["message"] as? String ?? "")"])
    case "rtc.state": Fusion.log("\(key): ice \(m["ice"] ?? "") connection \(m["connection"] ?? "")")
    case "log": Fusion.log("\(key): \(m["message"] ?? "")")
    default: break
    }
  }

  private func session(for key: String) -> ScreenSession? {
    if key.hasPrefix("w"), let id = CGWindowID(key.dropFirst()) { return streams[id]?.session }
    if key.hasPrefix("d"), let index = Int(key.dropFirst()) { return mirrors.first { $0.index == index }?.session }
    return nil
  }

  private func signal(_ key: String, _ m: [String: Any]) {
    switch m["t"] as? String {
    case "rtc.answer": if let sdp = m["sdp"] as? String { session(for: key)?.answer(sdp) }
    case "rtc.ice": session(for: key)?.candidate(m)
    case "control": wire.send(["t": "sig", "k": key, "m": ["control": ["available": true, "trusted": AXIsProcessTrusted()]]])
    default: break
    }
  }

  // MARK: root window group streams

  private func openStream(_ id: CGWindowID, pid: pid_t, bundle: String, title: String, mirror: Mirror, groupIDs: Set<CGWindowID>, remoteFrame: CGRect, local: CGRect) {
    guard let screen = Display.all.firstIndex(where: { $0.id == mirror.display.displayID }) else { return }
    var pair: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else { return }
    let key = "w\(id)"
    read(pair[1], key: key)
    let hasTB = hasToolbar(pid: pid, id: id)
    let resolvedTitle = resolveWindowTitle(pid: pid, id: id, cgTitle: title, bundle: bundle)
    let (buttons, hitrects) = inspectWindowChrome(pid: pid, id: id, frame: remoteFrame)
    wire.send([
      "t": "wopen", "id": id, "pid": pid, "bundle": bundle, "title": resolvedTitle,
      "toolbar": hasTB, "frame": Fusion.dict(local), "buttons": buttons, "hitrects": hitrects,
    ])
    wire.send(["t": "sig", "k": key, "m": ["rtc": ["t": "config", "iceServers": iceServers]]])
    wire.send(["t": "sig", "k": key, "m": ["session": ["t": "capabilities", "version": 1, "configure": false, "keys": true]]])
    let pixels = Int(mirror.remote.width) * mirror.scale
    let maxFps = mirror.hz >= 90 ? 120 : 60
    let session = ScreenSession(request: ScreenRequest(viewer: "fusion-\(key)", ["screen": screen, "window": Int(id), "maxWidth": pixels, "maxFps": maxFps, "codec": "h264"]),
                                options: ScreenSession.Options(), link: Link(input: pair[0], output: pair[0]))
    session.fusionWindowIDs = groupIDs
    let samplerRef = self.sampler
    session.fusionWindowBounds = { [weak samplerRef] in
      samplerRef?.latestFrame(window: id) ?? remoteFrame
    }
    session.onWindowInteract = { [weak self] in
      guard let self, self.focusedWindowID != id else { return }
      self.focus(id)
    }
    streams[id] = WindowStream(session: session, descriptor: pair[1], pid: pid, mirrorIndex: mirror.index, groupIDs: groupIDs, bundle: bundle)
    session.start()
    focusedWindowID = id
    for (wid, s) in streams { s.session.setFusionFocused(wid == id) }
    measureStyle(id: id, pid: pid, bundle: bundle, title: resolvedTitle, initialToolbar: hasTB)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
      self?.syncDockMenuIfNeeded(pid: pid, bundle: bundle, force: true)
    }
  }

  private func closeStream(_ id: CGWindowID) {
    guard let stream = streams.removeValue(forKey: id) else { return }
    dragZones[id] = nil
    hoverStamps[id] = nil
    axTitles[id] = nil
    windowKinds[id] = nil
    clampStamps[id] = nil
    nonAXWindowStamps[id] = nil
    rescuingWindowIDs[id] = nil
    placeLock.lock()
    pendingPlaces[id] = nil
    appliedSeq[id] = nil
    placeLock.unlock()
    sampler.clearWindow(id)
    if focusedWindowID == id { focusedWindowID = 0 }
    wire.send(["t": "wclose", "id": id, "bundle": stream.bundle])
    let sessionToClose = stream.session
    let fdToClose = stream.descriptor
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
      sessionToClose.close()
      close(fdToClose)
    }
  }

  /// Extracts window-relative rects for `[🔴, 🟡, 🟢]` traffic lights and interactive titlebar controls
  /// (`hitrects`) so the local Stub `.app` intercepts window operations at `0 ms` without hover lag.
  private func inspectWindowChrome(pid: pid_t, id: CGWindowID, frame: CGRect) -> ([String: [Double]], [[Double]]) {
    guard let w = axWindow(pid: pid, id: id) else { return ([:], []) }
    func r1(_ v: CGFloat) -> Double { (Double(v) * 10).rounded() / 10 }
    func elementRect(_ el: AXUIElement) -> CGRect? {
      var posRef: CFTypeRef?; var sizeRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
            AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success,
            let pv = posRef, let sv = sizeRef else { return nil }
      var pt = CGPoint.zero; var sz = CGSize.zero
      guard AXValueGetValue(pv as! AXValue, .cgPoint, &pt),
            AXValueGetValue(sv as! AXValue, .cgSize, &sz),
            sz.width > 1, sz.height > 1 else { return nil }
      return CGRect(x: pt.x - frame.minX, y: pt.y - frame.minY, width: sz.width, height: sz.height)
    }
    var buttons: [String: [Double]] = [:]
    var buttonRects: [CGRect] = []
    func readBtn(_ attr: String, key: String) {
      var ref: CFTypeRef?
      if AXUIElementCopyAttributeValue(w, attr as CFString, &ref) == .success, let el = ref,
         let r = elementRect(el as! AXUIElement), r.minY < 60, r.minX < 140 {
        buttons[key] = [r1(r.minX), r1(r.minY), r1(r.width), r1(r.height)]
        buttonRects.append(r.insetBy(dx: -1, dy: -1))
      }
    }
    readBtn(kAXCloseButtonAttribute as String, key: "close")
    readBtn(kAXMinimizeButtonAttribute as String, key: "min")
    readBtn(kAXFullScreenButtonAttribute as String, key: "zoom")
    if buttons["zoom"] == nil {
      readBtn(kAXZoomButtonAttribute as String, key: "zoom")
    }

    let interactiveRoles: Set<String> = [
      "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox",
      "AXPopUpButton", "AXMenuButton", "AXRadioButton", "AXCheckBox", "AXTabGroup",
      "AXSegmentedControl", "AXSlider", "AXIncrementor", "AXLink", "AXColorWell",
    ]
    let bodyContainerRoles: Set<String> = [
      "AXWebArea", "AXScrollArea", "AXTable", "AXOutline", "AXList",
    ]
    var hitrects: [[Double]] = []
    func walk(_ el: AXUIElement, depth: Int) {
      guard depth <= 8, hitrects.count < 64 else { return }
      var roleRef: CFTypeRef?
      let role = AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleRef) == .success ? (roleRef as? String ?? "") : ""
      if depth > 0, let r = elementRect(el) {
        if r.minY > 58 { return }
        if bodyContainerRoles.contains(role), r.height > 80 { return }
        if interactiveRoles.contains(role), r.width < frame.width * 0.94 {
          let isTrafficLight = buttonRects.contains { $0.intersects(r) && r.width <= 26 && r.height <= 26 }
          if !isTrafficLight {
            hitrects.append([r1(r.minX), r1(r.minY), r1(r.width), r1(r.height)])
          }
          if role != "AXTabGroup" && role != "AXSegmentedControl" { return }
        }
      }
      var chRef: CFTypeRef?
      if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &chRef) == .success,
         let children = chRef as? [AXUIElement] {
        for c in children.prefix(40) { walk(c, depth: depth + 1) }
      }
    }
    walk(w, depth: 0)
    return (buttons, hitrects)
  }

  private func hasToolbar(pid: pid_t, id: CGWindowID) -> Bool {
    guard let w = axWindow(pid: pid, id: id) else { return false }
    var childrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(w, kAXChildrenAttribute as CFString, &childrenRef) == .success,
          let children = childrenRef as? [AXUIElement] else { return false }
    for child in children {
      var roleRef: CFTypeRef?
      if AXUIElementCopyAttributeValue(child, kAXRoleAttribute as CFString, &roleRef) == .success,
         (roleRef as? String) == "AXToolbar" {
        return true
      }
    }
    return false
  }

  /// Evaluates via Accessibility whether the hovered titlebar spot is empty draggable chrome vs an interactive button/input.
  private func evaluateDragZone(id: CGWindowID, pid: pid_t, nx: Double, ny: Double) {
    let now = CACurrentMediaTime()
    guard now - (hoverStamps[id] ?? 0) >= 1.0 / 60 else { return }
    hoverStamps[id] = now
    guard let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]])?.first,
          let bounds = info[kCGWindowBounds as String] as? [String: Any],
          let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return }
    let x = nx * frame.width, y = ny * frame.height
    var ok = false
    if y <= 54, x >= 88 {
      ok = true
      let gx = Float(frame.minX + x), gy = Float(frame.minY + y)
      var hit: AXUIElement?
      if AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), gx, gy, &hit) == .success, var element = hit {
        let interactive: Set<String> = [
          "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox",
          "AXPopUpButton", "AXMenuButton", "AXRadioButton", "AXCheckBox", "AXTabGroup",
          "AXSegmentedControl", "AXSlider", "AXIncrementor", "AXLink", "AXColorWell",
        ]
        for _ in 0..<5 {
          var roleRef: CFTypeRef?
          let role = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef) == .success ? (roleRef as? String ?? "") : ""
          if role == "AXWindow" || role == "AXApplication" { break }
          if interactive.contains(role) { ok = false; break }
          var parentRef: CFTypeRef?
          guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &parentRef) == .success, let parent = parentRef else { break }
          element = parent as! AXUIElement
        }
      }
    }
    if dragZones[id] != ok {
      dragZones[id] = ok
      wire.send(["t": "dragzone", "id": id, "ok": ok])
    }
  }

  /// Measures true corner radius (accounting for 1x vs 2x scale!) so macOS 26 Tahoe 27pt vs 17pt corners match 1:1.
  private func measureStyle(id: CGWindowID, pid: pid_t, bundle: String, title: String, initialToolbar: Bool) {
    guard #available(macOS 14.0, *) else { return }
    let wire = self.wire
    Task {
      try? await Task.sleep(nanoseconds: 120_000_000)
      let content: SCShareableContent? = await withCheckedContinuation { cont in
        ScreenCapturer.fetchShareableContent(maxAge: 0.15) { c, _ in cont.resume(returning: c) }
      }
      guard let content,
            let window = content.windows.first(where: { $0.windowID == id }), window.frame.width > 40 else { return }
      let configuration = SCStreamConfiguration()
      configuration.width = max(Int(window.frame.width * 2), 80)
      configuration.height = max(Int(window.frame.height * 2), 80)
      configuration.scalesToFit = true
      configuration.pixelFormat = kCVPixelFormatType_32BGRA
      configuration.showsCursor = false
      if #available(macOS 14.2, *) { configuration.ignoreShadowsSingleWindow = true }
      guard let image = try? await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration),
            let data = image.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return }
      let row = image.bytesPerRow, step = image.bitsPerPixel / 8
      let scale = Double(image.width) / Double(window.frame.width)
      var d = 0
      let limit = min(image.width, image.height) / 3
      while d < limit, bytes[d * row + d * step + 3] < 128 { d += 1 }
      guard d > 0, d < limit, scale > 0 else { return }
      let radius = (Double(d) / (1 - 0.70710678)) / scale
      let toolbar = initialToolbar || radius > 21.5
      let (buttons, hitrects) = await MainActor.run { self.inspectWindowChrome(pid: pid, id: id, frame: window.frame) }
      wire.send(["t": "style", "id": id, "bundle": bundle, "toolbar": toolbar, "r": radius, "title": title, "buttons": buttons, "hitrects": hitrects])
      Fusion.log("window \(id) (\(bundle)) corner \(String(format: "%.1f", radius)) pt toolbar=\(toolbar)")
    }
  }

  // MARK: Dock

  private typealias DockGet = @convention(c) () -> Bool
  private typealias DockSet = @convention(c) (Bool) -> Void
  private static let services = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_NOW)
  static func dockHidden() -> Bool? {
    guard let symbol = dlsym(services, "CoreDockGetAutoHideEnabled") else { return nil }
    return unsafeBitCast(symbol, to: DockGet.self)()
  }
  static func setDockHidden(_ hidden: Bool) {
    guard let symbol = dlsym(services, "CoreDockSetAutoHideEnabled") else { return }
    unsafeBitCast(symbol, to: DockSet.self)(hidden)
  }

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
    if dockWasHidden == false { Self.setDockHidden(false) }
    mirrors.removeAll()
    Fusion.log("session ended")
  }

  // MARK: apps, icons, and windows

  static func apps() -> [[String: String]] {
    var seen: Set<String> = []
    var paths: [String: String] = [:]
    var result: [[String: String]] = []
    let folders = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]
    for folder in folders {
      for name in (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? [] where name.hasSuffix(".app") {
        let rawURL = URL(fileURLWithPath: folder).appendingPathComponent(name)
        let resolvedURL = rawURL.resolvingSymlinksInPath()
        guard let bundle = Bundle(url: resolvedURL) ?? Bundle(url: rawURL),
              let id = bundle.bundleIdentifier, !seen.contains(id),
              id != "com.bd.linkshell.host", !id.hasPrefix("com.bd.linkshell."),
              bundle.object(forInfoDictionaryKey: "LSUIElement") as? Bool != true,
              bundle.object(forInfoDictionaryKey: "LSBackgroundOnly") as? Bool != true else { continue }
        seen.insert(id)
        paths[id] = resolvedURL.path
        let cat = bundle.object(forInfoDictionaryKey: "LSApplicationCategoryType") as? String ?? ""
        let isSystem = id != "com.apple.Safari" && (folder.hasPrefix("/System/") || resolvedURL.path.hasPrefix("/System/Applications/"))
        result.append([
          "name": FileManager.default.displayName(atPath: resolvedURL.path).replacingOccurrences(of: ".app", with: ""),
          "bundle": id,
          "category": cat,
          "system": isSystem ? "1" : "0",
        ])
      }
    }
    appPathsLock.lock()
    appPaths = paths
    appPathsLock.unlock()
    return result.sorted { $0["name"]!.localizedStandardCompare($1["name"]!) == .orderedAscending }
  }

  private static func resolvedApplicationURL(for bundle: String) -> URL? {
    if let wsURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) {
      return wsURL.resolvingSymlinksInPath()
    }
    appPathsLock.lock()
    let stored = appPaths[bundle]
    appPathsLock.unlock()
    if let stored, FileManager.default.fileExists(atPath: stored) {
      return URL(fileURLWithPath: stored).resolvingSymlinksInPath()
    }
    return nil
  }

  private func sendIcon(_ bundle: String) {
    // Always resolve symlinks (e.g. `/Applications/Safari.app -> .../Cryptexes/.../Safari.app`)
    // before `NSWorkspace.shared.icon(forFile:)` so macOS never stamps a shortcut alias arrow!
    guard let resolvedURL = Self.resolvedApplicationURL(for: bundle) else { return }
    let icon = NSWorkspace.shared.icon(forFile: resolvedURL.path)
    let ptSize = NSSize(width: 512, height: 512)
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else { return }
    rep.size = ptSize
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    icon.draw(in: NSRect(origin: .zero, size: ptSize), from: .zero, operation: .copy, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()
    guard let data = rep.representation(using: .png, properties: [:]) else { return }
    wire.send(["t": "icon", "bundle": bundle, "png": data.base64EncodedString()])
  }

  private func launch(_ bundle: String) {
    guard let url = Self.resolvedApplicationURL(for: bundle) else {
      return wire.send(["t": "error", "message": "远端没有 \(bundle)"])
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { [weak self] app, error in
      DispatchQueue.main.async {
        guard let self, let app else { return Fusion.log("launch \(bundle) failed: \(error?.localizedDescription ?? "?")") }
        self.pidToBundle[app.processIdentifier] = bundle
        self.fused.insert(app.processIdentifier)
        _ = app.activate(options: [.activateIgnoringOtherApps])
        Fusion.log("fused \(bundle) (\(app.processIdentifier))")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
          self?.rescueOffDesktopWindows()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
          self?.syncDockMenuIfNeeded(pid: app.processIdentifier, bundle: bundle, force: true)
        }
      }
    }
  }

  private func quit(_ bundle: String, force: Bool) {
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
    if running.isEmpty {
      wire.send(["t": "app.exited", "bundle": bundle])
      return
    }
    for app in running {
      if force {
        _ = app.forceTerminate()
      } else {
        _ = app.activate(options: [.activateIgnoringOtherApps])
        _ = app.terminate()
      }
    }
    guard !force else { return }
    // If an app closed all its visible windows upon `terminate()` (no Save confirmation dialog)
    // yet lingered as a windowless background process, finish terminating it promptly.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
      guard let self, !self.ended else { return }
      let still = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated }
      guard !still.isEmpty else { return }
      let pids = Set(still.map(\.processIdentifier))
      let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
      let hasVisibleWindow = list.contains { info in
        guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, pids.contains(pid),
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let f = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              f.width >= 80, f.height >= 50,
              (info[kCGWindowLayer as String] as? Int ?? 0) <= 3 else { return false }
        return true
      }
      if !hasVisibleWindow {
        for app in still { _ = app.forceTerminate() }
      }
    }
  }

  private func resolveWindowTitle(pid: pid_t, id: CGWindowID, cgTitle: String, bundle: String) -> String {
    if !cgTitle.isEmpty { return cgTitle }
    let now = CACurrentMediaTime()
    if let cached = axTitles[id], now - cached.at < 2.0, !cached.title.isEmpty {
      return cached.title
    }
    var resolved = ""
    if let w = axWindow(pid: pid, id: id) {
      var ref: CFTypeRef?
      if AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &ref) == .success,
         let s = ref as? String, !s.isEmpty {
        resolved = s
      }
    }
    if resolved.isEmpty {
      resolved = NSRunningApplication(processIdentifier: pid)?.localizedName
        ?? bundle.split(separator: ".").last.map(String.init) ?? "Window"
    }
    axTitles[id] = (resolved, now)
    return resolved
  }

  // MARK: Remote Dock Right-Click Menu Mirroring (Accessibility Menu Bar + Open Recent)

  private func syncDockMenuIfNeeded(pid: pid_t, bundle: String, force: Bool = false) {
    guard !bundle.isEmpty else { return }
    let now = CACurrentMediaTime()
    if !force, now - (dockMenuStamps[bundle] ?? 0) < 3.0 { return }
    dockMenuStamps[bundle] = now
    let items = extractDockMenu(pid: pid)
    guard let data = try? JSONSerialization.data(withJSONObject: items),
          let sig = String(data: data, encoding: .utf8),
          force || dockMenuSent[bundle] != sig else { return }
    dockMenuSent[bundle] = sig
    wire.send(["t": "dockmenu", "bundle": bundle, "items": items])
  }

  private func extractDockMenu(pid: pid_t) -> [[String: Any]] {
    let axApp = AXUIElementCreateApplication(pid)
    var mbRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXMenuBarAttribute as CFString, &mbRef) == .success,
          let mb = mbRef else { return [] }
    var barChildrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(mb as! AXUIElement, kAXChildrenAttribute as CFString, &barChildrenRef) == .success,
          let barItems = barChildrenRef as? [AXUIElement], barItems.count > 2 else { return [] }

    var actions: [[String: Any]] = []
    var recents: [[String: Any]] = []
    let candidateBars = Array(2..<min(barItems.count, 5))

    for barIdx in candidateBars {
      var subRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(barItems[barIdx], kAXChildrenAttribute as CFString, &subRef) == .success,
            let menu = (subRef as? [AXUIElement])?.first else { continue }
      var itemsRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(menu, kAXChildrenAttribute as CFString, &itemsRef) == .success,
            let items = itemsRef as? [AXUIElement] else { continue }

      var passedCreationGroup = false
      for (itemIdx, item) in items.prefix(28).enumerated() {
        var roleRef: CFTypeRef?
        let role = AXUIElementCopyAttributeValue(item, kAXRoleAttribute as CFString, &roleRef) == .success ? (roleRef as? String ?? "") : ""
        if role == "AXMenuItem" {
          var titleRef: CFTypeRef?
          let title = (AXUIElementCopyAttributeValue(item, kAXTitleAttribute as CFString, &titleRef) == .success ? (titleRef as? String) : nil)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
          if title.isEmpty {
            if !actions.isEmpty { passedCreationGroup = true }
            continue
          }
          var enRef: CFTypeRef?
          let enabled = (AXUIElementCopyAttributeValue(item, kAXEnabledAttribute as CFString, &enRef) == .success ? (enRef as? Bool) : nil) ?? true
          var childMenuRef: CFTypeRef?
          let childMenus = (AXUIElementCopyAttributeValue(item, kAXChildrenAttribute as CFString, &childMenuRef) == .success ? (childMenuRef as? [AXUIElement]) : nil) ?? []

          let lower = title.lowercased()
          // Capture "Open Recent" / "打开最近..." submenu items (workspaces, documents, projects).
          if !childMenus.isEmpty, lower.contains("recent") || title.contains("最近") {
            var subItemsRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(childMenus[0], kAXChildrenAttribute as CFString, &subItemsRef) == .success,
               let subItems = subItemsRef as? [AXUIElement] {
              for (subIdx, subItem) in subItems.prefix(12).enumerated() where recents.count < 8 {
                var stRef: CFTypeRef?; var senRef: CFTypeRef?
                let st = (AXUIElementCopyAttributeValue(subItem, kAXTitleAttribute as CFString, &stRef) == .success ? (stRef as? String) : nil)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let sen = (AXUIElementCopyAttributeValue(subItem, kAXEnabledAttribute as CFString, &senRef) == .success ? (senRef as? Bool) : nil) ?? true
                guard !st.isEmpty, sen else { continue }
                let stLower = st.lowercased()
                if st.contains("清除") || stLower.contains("clear ") || stLower == "clear" || stLower.contains("more…") || stLower.contains("more...") {
                  continue
                }
                recents.append(["title": st, "section": "recent", "path": [barIdx, itemIdx, subIdx]])
              }
            }
            continue
          }

          guard childMenus.isEmpty, enabled, actions.count < 6 else { continue }
          let isNewPrefix = title.hasPrefix("新建") || lower.hasPrefix("new ") || title == "New"
          let isWindowKeyword = title.contains("窗口") || lower.contains("window") || title.contains("无痕") || lower.contains("private") || lower.contains("incognito") || title.contains("标签") || lower.contains("tab") || title.contains("对话") || lower.contains("chat") || lower.contains("conversation")
          if barIdx == 2 && (!passedCreationGroup && isNewPrefix || (isNewPrefix && isWindowKeyword)) {
            if !actions.contains(where: { ($0["title"] as? String) == title }) {
              actions.append(["title": title, "section": "action", "path": [barIdx, itemIdx]])
            }
          } else if barIdx > 2 && actions.isEmpty && isNewPrefix && isWindowKeyword {
            actions.append(["title": title, "section": "action", "path": [barIdx, itemIdx]])
          }
        }
      }
      if !actions.isEmpty && !recents.isEmpty { break }
    }
    return recents + actions
  }

  private func performDockAction(bundle: String, path: [Int]) {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first(where: { !$0.isTerminated }) else {
      launch(bundle)
      return
    }
    let pid = app.processIdentifier
    pidToBundle[pid] = bundle
    fused.insert(pid)
    let wasActive = app.isActive
    _ = app.activate(options: [.activateIgnoringOtherApps])
    let axApp = AXUIElementCreateApplication(pid)
    AXUIElementSetAttributeValue(axApp, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    guard path.count >= 2 else {
      launch(bundle)
      return
    }
    let invoke = { [weak self] in
      guard let self, !self.ended else { return }
      var mbRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(axApp, kAXMenuBarAttribute as CFString, &mbRef) == .success,
            let mb = mbRef else { return }
      var barRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(mb as! AXUIElement, kAXChildrenAttribute as CFString, &barRef) == .success,
            let barItems = barRef as? [AXUIElement], path[0] < barItems.count else { return }
      var menuRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(barItems[path[0]], kAXChildrenAttribute as CFString, &menuRef) == .success,
            let menu = (menuRef as? [AXUIElement])?.first else { return }
      var itemsRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(menu, kAXChildrenAttribute as CFString, &itemsRef) == .success,
            let items = itemsRef as? [AXUIElement], path[1] < items.count else { return }

      var target = items[path[1]]
      if path.count >= 3 {
        var subMenuRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(target, kAXChildrenAttribute as CFString, &subMenuRef) == .success,
              let subMenu = (subMenuRef as? [AXUIElement])?.first else { return }
        var subItemsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(subMenu, kAXChildrenAttribute as CFString, &subItemsRef) == .success,
              let subItems = subItemsRef as? [AXUIElement], path[2] < subItems.count else { return }
        target = subItems[path[2]]
      }
      AXUIElementPerformAction(target, kAXPressAction as CFString)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in self?.track() }
    }
    if wasActive {
      invoke()
    } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.08, execute: invoke)
    }
  }

  private func closeRemoteWindow(_ id: CGWindowID) {
    for pid in fused {
      guard let w = axWindow(pid: pid, id: id) else { continue }
      var button: CFTypeRef?
      if AXUIElementCopyAttributeValue(w, kAXCloseButtonAttribute as CFString, &button) == .success, let button {
        AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString)
        sampler.sampleNow()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.008) { [weak self] in self?.track() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.024) { [weak self] in self?.track() }
      }
      return
    }
  }

  private static func distanceSquared(_ rect: CGRect, _ point: CGPoint) -> CGFloat {
    let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
    let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
    return dx * dx + dy * dy
  }

  private func mirror(remote point: CGPoint) -> Mirror? {
    mirrors.first { $0.remote.contains(point) }
  }

  private func mirror(local rect: CGRect) -> Mirror? {
    let bestByArea = mirrors.max { a, b in
      let ia = a.screenBounds.intersection(rect), ib = b.screenBounds.intersection(rect)
      let areaA = ia.isNull ? 0 : ia.width * ia.height
      let areaB = ib.isNull ? 0 : ib.width * ib.height
      return areaA < areaB
    }
    if let bestByArea {
      let inter = bestByArea.screenBounds.intersection(rect)
      if !inter.isNull, inter.width * inter.height > 0 { return bestByArea }
    }
    let center = CGPoint(x: rect.midX, y: rect.midY)
    return mirrors.min { Self.distanceSquared($0.screenBounds, center) < Self.distanceSquared($1.screenBounds, center) }
  }

  private func axWindow(pid: pid_t, id: CGWindowID) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &value) == .success,
          let windows = value as? [AXUIElement] else { return nil }
    return windows.first { var w: CGWindowID = 0; return _AXUIElementGetWindow($0, &w) == .success && w == id }
  }

  /// Classifies a `layer == 0` window once via Accessibility so Chromium/Electron/AppKit borderless child
  /// overlays (such as Google Chrome's omnibox autocomplete dropdown, Find bar, status/permission bubbles)
  /// are recognized as child auxiliary overlays of their parent browser window rather than separate root windows!
  private func classifyAXWindow(pid: pid_t, id: CGWindowID, now: Double) -> AXWindowKind {
    if let cached = windowKinds[id] {
      if cached.exists || now - cached.checkedAt < 0.15 { return cached }
    }
    guard let w = axWindow(pid: pid, id: id) else {
      let miss = AXWindowKind(exists: false, isStandardRoot: false, checkedAt: now)
      windowKinds[id] = miss
      return miss
    }
    var subRef: CFTypeRef?
    let subrole = AXUIElementCopyAttributeValue(w, kAXSubroleAttribute as CFString, &subRef) == .success ? (subRef as? String ?? "") : ""
    func hasAttr(_ attr: String) -> Bool {
      var ref: CFTypeRef?
      return AXUIElementCopyAttributeValue(w, attr as CFString, &ref) == .success && ref != nil
    }
    let hasButtons = hasAttr(kAXCloseButtonAttribute as String)
      || hasAttr(kAXMinimizeButtonAttribute as String)
      || hasAttr(kAXZoomButtonAttribute as String)
      || hasAttr(kAXFullScreenButtonAttribute as String)
    let isStandardRoot = hasButtons || subrole == "AXStandardWindow"
    let kind = AXWindowKind(exists: true, isStandardRoot: isStandardRoot, checkedAt: now)
    windowKinds[id] = kind
    return kind
  }

  private func track() {
    let gone = fused.filter { pid in
      guard let app = NSRunningApplication(processIdentifier: pid) else { return true }
      return app.isTerminated
    }
    if !gone.isEmpty {
      for pid in gone {
        if let bundle = pidToBundle.removeValue(forKey: pid) {
          let stillAlive = fused.contains { $0 != pid && pidToBundle[$0] == bundle }
          if !stillAlive { wire.send(["t": "app.exited", "bundle": bundle]) }
        }
      }
      fused.subtract(gone)
    }

    let now = CACurrentMediaTime()
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    struct CandidateWin {
      let id: CGWindowID; let pid: pid_t; let rawTitle: String
      let layer: Int; let z: Int; let frame: CGRect; let mirror: Mirror; let kind: AXWindowKind?
    }
    var candidates: [CandidateWin] = []
    var liveIDs: Set<CGWindowID> = []
    var rawOnScreenIDs: Set<CGWindowID> = []
    var pidsWithStandardRoot: Set<pid_t> = []
    var largestBorderlessByPID: [pid_t: (id: CGWindowID, area: CGFloat)] = [:]

    for (z, info) in list.enumerated() {
      guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, fused.contains(pid),
            let id = info[kCGWindowNumber as String] as? CGWindowID,
            let bounds = info[kCGWindowBounds as String] as? [String: Any],
            let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.width > 1, frame.height > 1 else { continue }
      rawOnScreenIDs.insert(id)
      let alpha = info[kCGWindowAlpha as String] as? Double ?? 1.0
      let peak = max(peakWindowAlpha[id] ?? 0, alpha)
      peakWindowAlpha[id] = peak
      // As soon as a window starts its macOS close fade-out (`alpha < peak - 0.04`), treat it as closed
      // immediately so it closes crisply in a single frame instead of fading to black first!
      guard alpha > 0.05, alpha >= peak - 0.04 else { continue }
      liveIDs.insert(id)
      let layer = info[kCGWindowLayer as String] as? Int ?? 0
      let probe = CGPoint(x: frame.midX, y: frame.minY + min(frame.height / 2, 24))
      guard let mirror = mirror(remote: probe) ?? mirror(remote: CGPoint(x: frame.midX, y: frame.midY)) ?? mirrors.first(where: { $0.remote.intersects(frame) }) else {
        if layer == 0, !moved.contains(id), let main = mirrors.first, let w = axWindow(pid: pid, id: id) {
          moved.insert(id)
          var p = CGPoint(x: main.remote.midX - frame.width / 2, y: max(main.remote.minY + 60, main.remote.midY - frame.height / 2))
          AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &p)!)
        }
        continue
      }
      var kind: AXWindowKind?
      if layer == 0 && frame.width >= 160 && frame.height >= 100 {
        let k = classifyAXWindow(pid: pid, id: id, now: now)
        kind = k
        if k.isStandardRoot {
          pidsWithStandardRoot.insert(pid)
        } else if k.exists {
          let area = frame.width * frame.height
          if area > (largestBorderlessByPID[pid]?.area ?? 0) {
            largestBorderlessByPID[pid] = (id, area)
          }
        }
      }
      let rawTitle = info[kCGWindowName as String] as? String ?? ""
      candidates.append(CandidateWin(id: id, pid: pid, rawTitle: rawTitle, layer: layer, z: z, frame: frame, mirror: mirror, kind: kind))
    }

    if peakWindowAlpha.count > rawOnScreenIDs.count {
      peakWindowAlpha = peakWindowAlpha.filter { rawOnScreenIDs.contains($0.key) }
    }
    if windowKinds.count > liveIDs.count + 32 {
      windowKinds = windowKinds.filter { liveIDs.contains($0.key) || streams[$0.key] != nil }
    }

    struct RawWin {
      let id: CGWindowID; let pid: pid_t; let bundle: String; let title: String
      let layer: Int; let z: Int; let frame: CGRect; let mirror: Mirror; let local: CGRect; let root: Bool
    }
    var raw: [RawWin] = []
    for c in candidates {
      let id = c.id; let pid = c.pid; let frame = c.frame; let mirror = c.mirror; let layer = c.layer
      let root: Bool
      if let k = c.kind {
        if k.isStandardRoot || streams[id] != nil {
          root = k.isStandardRoot || (!pidsWithStandardRoot.contains(pid) && k.exists)
        } else if !pidsWithStandardRoot.contains(pid), k.exists, largestBorderlessByPID[pid]?.id == id {
          root = true
        } else {
          root = false
        }
      } else {
        root = false
      }
      // Ensure every root window sits 100% inside its virtual display on the remote Mac so
      // `ScreenCaptureKit` never clips left/right/bottom edges when an app opens straddling displays!
      if root {
        let outOfBounds = frame.minX < mirror.remote.minX - 0.5
          || frame.maxX > mirror.remote.maxX + 0.5
          || frame.minY < mirror.remote.minY - 0.5
          || frame.maxY > mirror.remote.maxY + 0.5
        if outOfBounds, now - (clampStamps[id] ?? 0) >= 0.45 {
          clampStamps[id] = now
          let localUnclamped = frame.offsetBy(dx: mirror.local.minX - mirror.remote.minX, dy: mirror.local.minY - mirror.remote.minY)
          let resizeNeeded = frame.width > mirror.remote.width + 0.5 || frame.height > (mirror.remote.height - min(max(0, mirror.menuBarHeight), 40)) + 0.5
          enqueuePlace(id, seq: appliedSeq[id] ?? 0, local: localUnclamped, resize: resizeNeeded)
        }
      }
      let local = frame.offsetBy(dx: mirror.local.minX - mirror.remote.minX, dy: mirror.local.minY - mirror.remote.minY)
      let bundle = pidToBundle[pid] ?? NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
      let title = root ? resolveWindowTitle(pid: pid, id: id, cgTitle: c.rawTitle, bundle: bundle) : c.rawTitle
      raw.append(RawWin(id: id, pid: pid, bundle: bundle, title: title, layer: layer, z: c.z, frame: frame, mirror: mirror, local: local, root: root))
    }

    // Build each root window's isolated display-bound group (includes child widgets like Electron's 132×40 traffic lights,
    // plus contained child popups/sheets like Google Chrome's omnibox autocomplete dropdown and Find bar!).
    let roots = raw.filter(\.root)
    var grouped: Set<CGWindowID> = []
    var groups: [CGWindowID: Set<CGWindowID>] = [:]
    for r in roots {
      groups[r.id] = [r.id]
      grouped.insert(r.id)
    }
    for aux in raw where !aux.root {
      let sameMirrorRoots = roots.filter { $0.pid == aux.pid && $0.mirror.index == aux.mirror.index }
      guard let targetRoot = sameMirrorRoots.min(by: {
        Self.distanceSquared($0.frame, CGPoint(x: aux.frame.midX, y: aux.frame.minY)) < Self.distanceSquared($1.frame, CGPoint(x: aux.frame.midX, y: aux.frame.minY))
      }) else { continue }
      let isSmallTitlebarWidget = aux.layer == 0 && aux.frame.height <= 64 && targetRoot.frame.insetBy(dx: -24, dy: -24).intersects(aux.frame)
      let fitsInsideRoot = aux.layer <= 8 && targetRoot.frame.insetBy(dx: -28, dy: -28).contains(aux.frame)
      if isSmallTitlebarWidget || fitsInsideRoot {
        groups[targetRoot.id, default: [targetRoot.id]].insert(aux.id)
        grouped.insert(aux.id)
      }
    }

    let popups = Set(raw.map(\.id).filter { !grouped.contains($0) })
    if popups != lastPopups {
      lastPopups = popups
      var popupParents: Set<CGWindowID> = []
      for pWin in raw where popups.contains(pWin.id) {
        if let parent = roots.filter({ $0.pid == pWin.pid && $0.mirror.index == pWin.mirror.index }).min(by: {
          Self.distanceSquared($0.frame, CGPoint(x: pWin.frame.midX, y: pWin.frame.minY)) < Self.distanceSquared($1.frame, CGPoint(x: pWin.frame.midX, y: pWin.frame.minY))
        }) {
          popupParents.insert(parent.id)
        }
      }
      sampler.set(popups: popups, parents: popupParents)
      for mirror in mirrors {
        let activeOnMirror = raw.contains { popups.contains($0.id) && $0.mirror.index == mirror.index }
        mirror.session?.setFusionOverlayActive(activeOnMirror)
      }
    }

    let rootSet = Set(roots.map(\.id))
    for r in roots {
      let group = groups[r.id] ?? [r.id]
      if var existing = streams[r.id] {
        if existing.mirrorIndex != r.mirror.index, let target = Display.all.first(where: { $0.id == r.mirror.display.displayID }) {
          existing.mirrorIndex = r.mirror.index
          existing.groupIDs = group
          streams[r.id] = existing
          Fusion.log("w\(r.id): switching to display \(r.mirror.index) (\(target.pixelWidth)×\(target.pixelHeight) @\(r.mirror.scale)x)")
          existing.session.switchFusionDisplay(target, windowIDs: group)
        } else if existing.groupIDs != group {
          existing.groupIDs = group
          streams[r.id] = existing
          existing.session.updateFusionWindowGroup(group)
        }
      } else {
        openStream(r.id, pid: r.pid, bundle: r.bundle, title: r.title, mirror: r.mirror, groupIDs: group, remoteFrame: r.frame, local: r.local)
      }
    }
    for id in Array(streams.keys) where !rootSet.contains(id) {
      if let rescueUntil = rescuingWindowIDs[id], now < rescueUntil { continue }
      // Only hold a stream open if the remote window entered Full-Screen Space or Dock Minimization
      // (rescue it back onto the virtual desktop); for any genuine close or orderOut, close at 0ms!
      if let s = streams[id], fused.contains(s.pid), !rawOnScreenIDs.contains(id), let w = axWindow(pid: s.pid, id: id) {
        var fsRef: CFTypeRef?
        let isFS = AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &fsRef) == .success && (fsRef as? Bool) == true
        var minRef: CFTypeRef?
        let isMin = AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute as CFString, &minRef) == .success && (minRef as? Bool) == true
        if isFS || isMin {
          rescueOffDesktopWindows()
          continue
        }
      }
      closeStream(id)
    }

    placeLock.lock()
    let ackSnapshot = appliedSeq
    placeLock.unlock()

    var windowsPayload: [[String: Any]] = []
    for w in raw where (w.root && streams[w.id] != nil) || popups.contains(w.id) {
      var entry: [String: Any] = [
        "id": w.id, "pid": w.pid, "bundle": w.bundle, "layer": w.layer, "z": w.z,
        "own": w.root, "title": w.title, "frame": Fusion.dict(w.local),
        "ack": Int(ackSnapshot[w.id] ?? 0),
      ]
      if !w.root {
        // Associate popup menu with the closest root window of the same app (plus relative offset) so that app's Stub aligns it 1:1.
        if let parent = roots.filter({ $0.pid == w.pid }).min(by: {
          Self.distanceSquared($0.frame, CGPoint(x: w.frame.midX, y: w.frame.minY)) < Self.distanceSquared($1.frame, CGPoint(x: w.frame.midX, y: w.frame.minY))
        }) {
          entry["parent"] = parent.id
          entry["pdx"] = Double(w.frame.minX - parent.frame.minX)
          entry["pdy"] = Double(w.frame.minY - parent.frame.minY)
        }
      }
      windowsPayload.append(entry)
    }
    guard let data = try? JSONSerialization.data(withJSONObject: windowsPayload),
          let text = String(data: data, encoding: .utf8), text != lastLayout else { return }
    lastLayout = text
    wire.send(["t": "layout", "windows": windowsPayload])
  }

  /// Rescues any window that entered a remote macOS Full-Screen Space (`AXFullScreen == true`) or
  /// remote Dock minimization (`kAXMinimizedAttribute == true`) back onto the virtual desktop,
  /// forwarding the intent so the local `NSWindow` performs native local Full-Screen / Minimize instead!
  private func rescueOffDesktopWindows() {
    guard !ended, let main = mirrors.first else { return }
    let now = CACurrentMediaTime()
    rescuingWindowIDs = rescuingWindowIDs.filter { $0.value > now }
    for pid in fused {
      let axApp = AXUIElementCreateApplication(pid)
      var winsRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winsRef) == .success,
            let wins = winsRef as? [AXUIElement] else { continue }
      for w in wins {
        var wid: CGWindowID = 0
        guard _AXUIElementGetWindow(w, &wid) == .success, wid != 0 else { continue }
        if let until = rescuingWindowIDs[wid], now < until { continue }
        var fsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &fsRef) == .success,
           (fsRef as? Bool) == true {
          let wasLive = streams[wid] != nil
          rescuingWindowIDs[wid] = now + 2.2
          Fusion.log("rescuing window \(wid) (pid \(pid)) out of remote AXFullScreen Space")
          AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, kCFBooleanFalse)
          let remoteRect = main.remote
          let topInset = min(max(0, main.menuBarHeight), 40)
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) { [weak self] in
            guard let self, !self.ended else { return }
            var pt = CGPoint(x: remoteRect.minX + 60, y: remoteRect.minY + topInset + 40)
            AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &pt)!)
            if wasLive {
              self.wire.send(["t": "fullscreen", "id": wid, "on": true])
            }
            self.track()
          }
          continue
        }
        var minRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute as CFString, &minRef) == .success,
           (minRef as? Bool) == true {
          rescuingWindowIDs[wid] = now + 1.5
          AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
          if streams[wid] != nil {
            wire.send(["t": "minimize", "id": wid])
          }
        }
      }
    }
  }

  private static func liveCGWindowBounds(_ id: CGWindowID) -> CGRect? {
    guard let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]])?.first,
          let bounds = info[kCGWindowBounds as String] as? [String: Any] else { return nil }
    return CGRect(dictionaryRepresentation: bounds as CFDictionary)
  }

  /// Coalesces rapid local moves/resizes on a serial background AX queue (`placeQueue`) so intermediate
  /// sizes never pile up in a FIFO backlog and `AXUIElementSetAttributeValue` never blocks the main thread.
  private func enqueuePlace(_ id: CGWindowID, seq: UInt64, local: CGRect, resize: Bool) {
    guard let mirror = mirror(local: local) ?? mirrors.first else { return }
    let size = CGSize(width: max(local.width, 80), height: max(local.height, 60))
    var px = local.minX - mirror.local.minX + mirror.remote.minX
    var py = local.minY - mirror.local.minY + mirror.remote.minY
    let topInset = min(max(0, mirror.menuBarHeight), 40)
    let minY = mirror.remote.minY + topInset
    if size.width <= mirror.remote.width {
      px = min(max(px, mirror.remote.minX), mirror.remote.maxX - size.width)
    } else {
      px = mirror.remote.minX
    }
    if size.height <= mirror.remote.height - topInset {
      py = min(max(py, minY), mirror.remote.maxY - size.height)
    } else {
      py = minY
    }
    let remoteTarget = CGRect(origin: CGPoint(x: px, y: py), size: size)
    let candidatePids = (streams[id].map { [$0.pid] } ?? []) + Array(fused)

    placeLock.lock()
    let prevSeq = pendingPlaces[id]?.seq ?? 0
    let prevResize = pendingPlaces[id]?.resize ?? false
    if seq == 0 || seq >= prevSeq {
      pendingPlaces[id] = PendingPlace(seq: max(seq, prevSeq), local: remoteTarget, resize: resize || prevResize, mirrorIndex: mirror.index)
    }
    let shouldStart = !placeWorkerRunning
    if shouldStart { placeWorkerRunning = true }
    placeLock.unlock()

    guard shouldStart else { return }
    placeQueue.async { [weak self] in
      self?.drainPlacements(defaultPids: candidatePids)
    }
  }

  private func drainPlacements(defaultPids: [pid_t]) {
    while true {
      placeLock.lock()
      guard let (id, job) = pendingPlaces.first else {
        placeWorkerRunning = false
        placeLock.unlock()
        break
      }
      pendingPlaces.removeValue(forKey: id)
      placeLock.unlock()

      let beforeBounds = Self.liveCGWindowBounds(id)
      let transitionStart = mach_absolute_time()
      sampler.beginTransition(window: id, at: transitionStart)
      var matchedPid: pid_t = 0
      var targetPoint = job.local.origin
      var targetSize = job.local.size
      for pid in defaultPids {
        guard let w = axWindow(pid: pid, id: id) else { continue }
        matchedPid = pid
        if job.resize {
          AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &targetPoint)!)
          AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &targetSize)!)
          AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &targetPoint)!)
        } else {
          AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &targetPoint)!)
        }
        break
      }

      // Poll at 1.5ms–4ms resolution on background `placeQueue` for the target process to commit
      // `CGWindowBounds` to WindowServer before stamping `appliedSeq` / switching virtual display,
      // aborting immediately if a newer `PendingPlace` arrives for `id`.
      var superseded = false
      if matchedPid != 0 {
        if job.resize {
          var prevSample: CGSize?
          var stableTicks = 0
          for _ in 0..<24 {
            placeLock.lock()
            let hasNewer = pendingPlaces[id] != nil
            placeLock.unlock()
            if hasNewer { superseded = true; break }
            if let live = Self.liveCGWindowBounds(id) {
              let posOk = abs(live.minX - targetPoint.x) <= 2 && abs(live.minY - targetPoint.y) <= 2
              let sizeOk = abs(live.width - targetSize.width) <= 2 && abs(live.height - targetSize.height) <= 2
              if posOk && sizeOk { break }
              if let b = beforeBounds, (abs(live.width - b.width) > 1.5 || abs(live.height - b.height) > 1.5) {
                if let prev = prevSample, abs(live.width - prev.width) < 0.5, abs(live.height - prev.height) < 0.5 {
                  stableTicks += 1
                  if stableTicks >= 2 && posOk { break }
                } else {
                  stableTicks = 0
                }
              }
              prevSample = live.size
            }
            usleep(4_000)
          }
        } else {
          for _ in 0..<20 {
            placeLock.lock()
            let hasNewer = pendingPlaces[id] != nil
            placeLock.unlock()
            if hasNewer { superseded = true; break }
            if let live = Self.liveCGWindowBounds(id),
               abs(live.minX - targetPoint.x) <= 2, abs(live.minY - targetPoint.y) <= 2 {
              break
            }
            usleep(1_500)
          }
        }
      }
      if superseded { continue }

      let settledAt = mach_absolute_time()
      let settledRect = Self.liveCGWindowBounds(id) ?? job.local
      let didMoveRect: Bool
      if let b = beforeBounds {
        didMoveRect = abs(settledRect.minX - b.minX) > 1 || abs(settledRect.minY - b.minY) > 1 || abs(settledRect.width - b.width) > 1 || abs(settledRect.height - b.height) > 1
      } else {
        didMoveRect = true
      }
      sampler.sampleNow()
      sampler.endTransition(window: id, moved: didMoveRect, at: settledAt, seq: job.seq)
      placeLock.lock()
      if job.seq > (appliedSeq[id] ?? 0) {
        appliedSeq[id] = job.seq
      }
      placeLock.unlock()

      let didResize = job.resize
      let resolvedPid = matchedPid
      DispatchQueue.main.async { [weak self] in
        guard let self, !self.ended else { return }
        if didResize, resolvedPid != 0, self.streams[id] != nil {
          let (buttons, hitrects) = self.inspectWindowChrome(pid: resolvedPid, id: id, frame: settledRect)
          self.wire.send(["t": "chrome", "id": id, "buttons": buttons, "hitrects": hitrects])
        }
        self.lastLayout = ""
        self.track()
      }
    }
  }

  private func focus(_ id: CGWindowID) {
    focusedWindowID = id
    for (wid, s) in streams { s.session.setFusionFocused(wid == id) }
    let candidatePids = (streams[id].map { [$0.pid] } ?? []) + Array(fused)
    for pid in candidatePids {
      guard let w = axWindow(pid: pid, id: id) else { continue }
      if let app = NSRunningApplication(processIdentifier: pid) {
        _ = app.activate(options: [.activateIgnoringOtherApps])
      }
      AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
      AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
      AXUIElementSetAttributeValue(w, kAXFocusedAttribute as CFString, kCFBooleanTrue)
      AXUIElementPerformAction(w, kAXRaiseAction as CFString)
      if let bundle = pidToBundle[pid] ?? streams[id]?.bundle {
        dockMenuStamps[bundle] = 0
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
          self?.syncDockMenuIfNeeded(pid: pid, bundle: bundle)
        }
      }
      return
    }
  }
}
