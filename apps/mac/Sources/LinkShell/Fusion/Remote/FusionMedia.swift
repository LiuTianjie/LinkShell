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

extension FusionRemoteSession {
  func installCaptureHooks() {
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

  }

  func startOverlaySessions() {
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
  }

  func read(_ descriptor: Int32, key: String) {
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

  func forward(_ key: String, _ m: [String: Any]) {
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

  func session(for key: String) -> ScreenSession? {
    if key.hasPrefix("w"), let id = CGWindowID(key.dropFirst()) { return streams[id]?.session }
    if key.hasPrefix("d"), let index = Int(key.dropFirst()) { return mirrors.first { $0.index == index }?.session }
    return nil
  }

  func signal(_ key: String, _ m: [String: Any]) {
    switch m["t"] as? String {
    case "rtc.answer": if let sdp = m["sdp"] as? String { session(for: key)?.answer(sdp) }
    case "rtc.ice": session(for: key)?.candidate(m)
    case "control": wire.send(["t": "sig", "k": key, "m": ["control": ["available": true, "trusted": AXIsProcessTrusted()]]])
    default: break
    }
  }

  // MARK: root window group streams

  func openStream(_ id: CGWindowID, pid: pid_t, bundle: String, title: String, mirror: Mirror, groupIDs: Set<CGWindowID>, remoteFrame: CGRect, local: CGRect) {
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
      "activate": followsUserAction(pid: pid),
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
      guard let self else { return }
      self.noteUserAction(pid: pid)
      guard self.focusedWindowID != id else { return }
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

  func closeStream(_ id: CGWindowID) {
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
}
