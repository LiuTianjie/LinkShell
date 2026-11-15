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
    let home = Launch.value(after: "--home") ?? (NSHomeDirectory() + "/.linkshell")
    try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    Fusion.logPath = home + "/fusion-remote.log"
    FusionRemoteSession.home = home
    // An earlier run that died without `end()` left the user's Dock hidden: put it back first.
    FusionDock.restoreIfMarked(home: home)
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    _ = AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), FusionRemoteSession.axTimeout)
    let requestedPort = Launch.value(after: "--port").flatMap(UInt16.init) ?? FusionWire.port
    let remote = FusionRemote(port: requestedPort, parentSocketPath: Launch.value(after: "--parent-sock"))
    remote.installSignalHandlers()
    remote.connectParentLifecycleSocket()
    app.run()
    exit(0)
  }

  let requestedPort: UInt16
  let parentSocketPath: String?
  var parentFD: Int32 = -1
  let parentWriteLock = NSLock()
  /// Single use: cleared by the `hello` that presents it, so a token seen once (by anyone) opens
  /// nothing later. The host hands out a fresh one with every `fusion.start`.
  var token: String?
  var iceServers: [[String: Any]] = []
  var listener: NWListener?
  var listenerGeneration = 0
  var current: FusionRemoteSession?
  /// A session whose connection dropped without a `bye`, kept for `resume` (docs/v2/fusion.md §4.3).
  var suspended: FusionRemoteSession?
  var pending: [ObjectIdentifier: FusionRemoteSession] = [:]
  var signalSources: [DispatchSourceSignal] = []

  init(port: UInt16, parentSocketPath: String?) {
    self.requestedPort = port
    self.parentSocketPath = parentSocketPath
  }

  /// Constant time, so the comparison does not tell an attacker how much of a guess was right.
  static func tokensMatch(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8), y = Array(b.utf8)
    guard x.count == y.count, !x.isEmpty else { return false }
    var diff: UInt8 = 0
    for i in 0..<x.count { diff |= x[i] ^ y[i] }
    return diff == 0
  }

  func consume(token candidate: String) -> Bool {
    guard let token, Self.tokensMatch(token, candidate) else { return false }
    self.token = nil
    return true
  }

  func installSignalHandlers() {
    for sig in [SIGTERM, SIGINT, SIGHUP] {
      signal(sig, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
      source.setEventHandler { [weak self] in
        Fusion.log("signal \(sig): ending")
        self?.current?.finish(reason: "stopped", message: "远端 LinkShell 已退出")
        self?.suspended?.end()
        self?.pending.values.forEach { $0.end() }
        exit(0)
      }
      source.resume()
      signalSources.append(source)
    }
  }

  /// Each token gets its own listener, keyed to it: a TLS-PSK listener's key is fixed once started.
  /// Sessions already accepted keep running on their connections when the old listener goes.
  func relisten() {
    guard let token else { return }
    listener?.newConnectionHandler = nil
    listener?.stateUpdateHandler = nil
    listener?.cancel()
    listener = nil
    listenerGeneration += 1
    let generation = listenerGeneration
    let parameters = FusionWire.parameters(token: token)
    let endpointPort: NWEndpoint.Port = requestedPort == 0 ? .any : (NWEndpoint.Port(rawValue: requestedPort) ?? .any)
    guard let listener = (try? NWListener(using: parameters, on: endpointPort)) ?? (try? NWListener(using: parameters, on: .any)) else {
      Fusion.log("cannot listen on \(requestedPort)")
      writeParent(["t": "error", "message": "远端融合模式无法监听端口"])
      return
    }
    listener.stateUpdateHandler = { [weak self, weak listener] state in
      guard let self, let listener, generation == self.listenerGeneration else { return }
      switch state {
      case .ready:
        let actual = listener.port?.rawValue ?? self.requestedPort
        Fusion.log("fusion remote on \(actual): AX \(AXIsProcessTrusted()), capture \(CGPreflightScreenCaptureAccess())")
        self.writeParent(["t": "ready", "ready": true, "port": Int(actual), "pid": Int(getpid())])
      case .failed(let error):
        Fusion.log("fusion listener failed: \(error)")
        self.writeParent(["t": "error", "message": "远端融合模式监听失败：\(error.localizedDescription)"])
      default:
        break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      DispatchQueue.main.async { self?.accept(connection) }
    }
    listener.start(queue: .main)
    self.listener = listener
  }

  func accept(_ connection: NWConnection) {
    Fusion.log("connection from \(connection.endpoint)")
    let wire = FusionWire(connection)
    let session = FusionRemoteSession(wire: wire, authorize: { [weak self] in self?.consume(token: $0) == true }, iceServers: iceServers)
    let key = ObjectIdentifier(session)
    pending[key] = session
    session.onAuthenticated = { [weak self, weak session] in
      guard let self, let session else { return }
      self.pending.removeValue(forKey: key)
      // A new local computer (or the same one, not resuming): whatever was here gives way.
      self.suspended?.end()
      self.suspended = nil
      if self.current !== session {
        self.current?.finish(reason: "replaced", message: "另一台电脑开启了与这台 Mac 的融合模式")
        self.current = session
      }
      // The client pings every 1.5 s: silence means it is gone (asleep, off the network).
      wire.startWatchdog(timeout: 8)
    }
    session.resumeTarget = { [weak self] id in
      guard let self else { return nil }
      if let old = self.suspended, old.sessionID == id {
        self.suspended = nil
        // Its grace may have run out already: nothing left to resume, start afresh.
        return old.ended ? nil : old
      }
      // The local computer often notices a dead link (5 s) before this side does (8 s): the session
      // is still current here, on a connection that is gone. Take it over.
      if let current = self.current, current.sessionID == id, !current.ended {
        current.detachWire()
        return current
      }
      return nil
    }
    session.onResumed = { [weak self, weak session] old in
      guard let self else { return }
      if let session { self.pending.removeValue(forKey: ObjectIdentifier(session)) }
      if self.current !== old { self.current?.finish(reason: "replaced") }
      self.current = old
      self.attach(old, to: wire)
      wire.startWatchdog(timeout: 8)
    }
    wire.onMessage = { [weak session] in session?.receive($0) }
    wire.onClose = { [weak self, weak session] reason in
      guard let self else { return }
      self.pending.removeValue(forKey: key)
      guard let session else { return }
      self.closed(session, reason: reason)
    }
    wire.start()
    DispatchQueue.main.asyncAfter(deadline: .now() + 8.0) { [weak self, weak session] in
      guard let self, let session, self.pending[key] != nil else { return }
      self.pending.removeValue(forKey: key)
      session.end()
      wire.close(reason: "unauthenticated")
    }
  }

  /// A resumed session takes over the new connection.
  func attach(_ session: FusionRemoteSession, to wire: FusionWire) {
    wire.onMessage = { [weak session] in session?.receive($0) }
    wire.onClose = { [weak self, weak session] reason in
      guard let self, let session else { return }
      self.closed(session, reason: reason)
    }
  }

  /// A `bye` (either way) has already ended the session; anything else may be a blip.
  func closed(_ session: FusionRemoteSession, reason: String) {
    Fusion.log("connection closed: \(reason)")
    guard current === session else { return session.end() }
    current = nil
    if session.ended || reason == "bye" || reason == "token" || reason == "proto" { return session.end() }
    suspended?.end()
    suspended = session
    session.suspend()
  }

  func handleParent(_ message: [String: Any]) {
    switch message["t"] as? String {
    case "token":
      guard let next = message["token"] as? String, !next.isEmpty else { return }
      token = next
      iceServers = (message["ice"] as? [[String: Any]]) ?? []
      relisten()
    case "stop":
      current?.finish(reason: "stopped", message: "远端电脑结束了融合模式")
      current = nil
      suspended?.end()
      suspended = nil
    default:
      break
    }
  }

  func writeParent(_ object: [String: Any]) {
    guard parentFD >= 0, var payload = try? JSONSerialization.data(withJSONObject: object) else { return }
    payload.append(10)
    parentWriteLock.lock()
    defer { parentWriteLock.unlock() }
    payload.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      var offset = 0
      while offset < raw.count {
        let n = Darwin.write(parentFD, base.advanced(by: offset), raw.count - offset)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { break }
        offset += n
      }
    }
  }

  /// The host's unix socket (0600) is the only way in for secrets: a token on the command line
  /// would be readable by any local process through `ps`.
  func connectParentLifecycleSocket() {
    guard let path = parentSocketPath, !path.isEmpty else {
      Fusion.log("no parent socket: nothing would ever hand out a token")
      exit(1)
    }
    let sock = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard sock >= 0 else { exit(1) }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { Darwin.close(sock); exit(1) }
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
    writeParent(["t": "hello", "pid": Int(getpid())])
    Thread.detachNewThread { [weak self] in
      var buffer = Data()
      var chunk = [UInt8](repeating: 0, count: 4096)
      while true {
        let n = Darwin.read(sock, &chunk, chunk.count)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { break }
        buffer.append(chunk, count: n)
        while let newline = buffer.firstIndex(of: 10) {
          let line = buffer.subdata(in: buffer.startIndex..<newline)
          buffer.removeSubrange(buffer.startIndex...newline)
          guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
          DispatchQueue.main.async { self?.handleParent(message) }
        }
      }
      // The host is gone (stopped, upgraded): end everything here, a held session included,
      // and let the `bye` leave before the process does.
      DispatchQueue.main.async {
        self?.current?.finish(reason: "stopped", message: "远端 LinkShell 已停止")
        self?.suspended?.end()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
      }
    }
  }
}
