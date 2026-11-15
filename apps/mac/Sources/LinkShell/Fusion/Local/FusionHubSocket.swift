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

extension FusionLocal {
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

  func acceptStubConnection(_ fd: Int32) {
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
          wire?.send(["t": "launch", "app": bundle])
        }
      }
    } else {
      for rec in existing {
        let key = rec.stream
        let (ctrl, keys) = control(of: key)
        client.send([
          "t": "wopen", "id": Int(rec.id), "title": rec.title, "toolbar": rec.toolbar, "r": rec.cornerRadius,
          "frame": Fusion.dict(rec.frame), "control": ctrl, "keys": keys,
          "buttons": rec.buttons, "hitrects": rec.hitrects, "ack": rec.ackSeq,
          "activate": false,
        ])
      }
    }
    reloadGrid()
    saveCatalogToDisk()
    refreshStatus()
  }

  func syncFastState(removedWindowIDs: [CGWindowID] = []) {
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

  func fastDeliverInput(_ m: [String: Any]) {
    guard let key = m["key"] as? String, let event = m["m"] as? [String: Any] else { return }
    fastLock.lock()
    let output = fastOutputs[key]
    fastLock.unlock()
    output?.onInput?(event, m["r"] as? Bool == true)
  }

  func isQuitting(_ bundle: String) -> Bool {
    guard let until = quittingBundles[bundle] else { return false }
    if CACurrentMediaTime() < until { return true }
    quittingBundles.removeValue(forKey: bundle)
    syncFastState()
    return false
  }

  func purgeLocalState(forBundle bundle: String) {
    let winIDs = windows.values.filter { $0.bundle == bundle }.map(\.id)
    for id in winIDs {
      let key = windows[id]?.stream ?? "w\(id)"
      media?.remove(key)
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
  func quitLocalBundle(_ bundle: String, force: Bool) {
    guard !bundle.isEmpty else { return }
    quittingBundles[bundle] = CACurrentMediaTime() + 6.0
    launchingStubs.remove(bundle)
    wire?.send(["t": "quit", "app": bundle, "force": force])
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
      wire?.send(["t": "prewarm", "id": DesktopScreenBridge.integer(m["id"]) ?? 0])
    case "active":
      setStubActive(client.bundle, m["on"] as? Bool == true)
    case "reopen":
      if !client.bundle.isEmpty {
        quittingBundles.removeValue(forKey: client.bundle)
        syncFastState()
        let now = CACurrentMediaTime()
        if now - (launchSentAt[client.bundle] ?? 0) >= 2.0 {
          launchSentAt[client.bundle] = now
          wire?.send(["t": "launch", "app": client.bundle])
        }
      }
    case "detach":
      client.closedByHub = true
    case "menufetch", "menupress":
      if !client.bundle.isEmpty {
        // A Windows remote has no menu bar (its menus are in its windows): say so at once.
        if !remoteFeatures.contains("menubar") {
          if m["t"] as? String == "menufetch" { client.send(["t": "menu", "path": FusionProtocol.path(m["path"]), "error": true]) }
          return
        }
        // The stub's own names stay; the wire's are `menu.fetch` / `menu.press`.
        let type = m["t"] as? String == "menufetch" ? "menu.fetch" : "menu.press"
        wire?.send(["t": type, "app": client.bundle, "path": FusionProtocol.path(m["path"])])
      }
    case "dockaction":
      if !client.bundle.isEmpty {
        quittingBundles.removeValue(forKey: client.bundle)
        syncFastState()
        wire?.send(["t": "dockmenu.press", "app": client.bundle, "path": FusionProtocol.path(m["path"])])
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

  func relaunchStubAfterCrash(_ bundle: String) {
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
}

/// Connected per-app Stub `.app` process receiving zero-copy `IOSurface` frames via `DesktopFramePort`.
final class StubClient {
  let fd: Int32
  weak var owner: FusionLocal?
  var bundle = ""
  var pid: pid_t = 0
  var port: DesktopFramePort?
  var closedByQuit = false
  var closedByHub = false
  let writeLock = NSLock()
  let frameLock = NSLock()
  var closed = false
  var serial: UInt64 = 0
  var outstanding: [UInt64: CVPixelBuffer] = [:]
  var outstandingWindow: [UInt64: CGWindowID] = [:]
  var inFlightByWindow: [CGWindowID: Int] = [:]
  var pendingOrder: [CGWindowID] = []
  var pendingFrames: [CGWindowID: (CVPixelBuffer, IOSurface, Data)] = [:]

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
