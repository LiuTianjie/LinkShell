import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

/// Which windows become pictures, and how the session's one `FusionMedia` carries them.
extension FusionRemoteSession {
  func installCaptureHooks() {
    hooksInstalled = true
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

  /// A fresh connection for the pictures, with every virtual display's popup layer on it.
  /// Windows join as `track()` finds them.
  func startMedia() {
    media?.close()
    let media = FusionMedia(iceServers: iceServers)
    media.onSignal = { [weak self] payload in self?.wire.send(["t": "rtc", "m": payload]) }
    media.onInteract = { [weak self] key in
      guard let self, let id = Self.windowID(key), let stream = self.streams[id] else { return }
      self.noteUserAction(pid: stream.pid)
      if self.focusedWindowID != id { self.focus(id) }
    }
    media.onStreamError = { [weak self] key, message in
      Fusion.log("\(key): \(message)")
      self?.wire.send(["t": "alert", "kind": "webrtc", "subject": key, "message": message])
    }
    self.media = media
    media.start()
    for mirror in mirrors { openOverlay(mirror) }
  }

  /// The local computer lost the pictures (its peer connection failed) while the control connection
  /// lives: a new peer connection, with every display layer and window on it again.
  func restartMedia() {
    let now = CACurrentMediaTime()
    mediaRestarts = mediaRestarts.filter { now - $0 < 60 } + [now]
    guard displayReady, !paused, mediaRestarts.count <= 4 else {
      Fusion.log("media restart refused (\(mediaRestarts.count) in a minute)")
      return
    }
    Fusion.log("media restart")
    startMedia()
    for (id, stream) in streams {
      guard let mirror = mirrors.first(where: { $0.index == stream.mirrorIndex }),
            let display = Display.all.first(where: { $0.id == mirror.display.displayID }) else { continue }
      let sampler = self.sampler
      let fallback = Self.liveCGWindowBounds(id) ?? .zero
      media?.openWindow(id: id, display: display, group: stream.groupIDs) { [weak sampler] in
        sampler?.latestFrame(window: id) ?? fallback
      }
    }
    media?.focus(streams[focusedWindowID]?.key)
  }

  func openOverlay(_ mirror: Mirror) {
    guard let display = Display.all.first(where: { $0.id == mirror.display.displayID }) else { return }
    media?.openOverlay(index: mirror.index, display: display, width: Int(mirror.remote.width) * mirror.scale)
  }

  static func windowID(_ key: String) -> CGWindowID? {
    key.hasPrefix("w") ? CGWindowID(key.dropFirst()) : nil
  }

  func openStream(_ id: CGWindowID, pid: pid_t, bundle: String, title: String, mirror: Mirror, groupIDs: Set<CGWindowID>, remoteFrame: CGRect, local: CGRect) {
    guard let display = Display.all.first(where: { $0.id == mirror.display.displayID }), let media else { return }
    let key = "w\(id)"
    let hasTB = hasToolbar(pid: pid, id: id)
    let resolvedTitle = resolveWindowTitle(pid: pid, id: id, cgTitle: title, bundle: bundle)
    let (buttons, hitrects) = inspectWindowChrome(pid: pid, id: id, frame: remoteFrame)
    // `wopen` before the stream is offered: the receiver must know the window when its track comes.
    wire.send([
      "t": "wopen", "id": id, "app": bundle, "title": resolvedTitle,
      "activate": followsUserAction(pid: pid), "frame": Fusion.dict(local),
      "chrome": FusionProtocol.chrome(toolbar: hasTB, radius: nil, buttons: buttons, hitrects: hitrects),
      "stream": key,
    ])
    streams[id] = WindowStream(pid: pid, mirrorIndex: mirror.index, groupIDs: groupIDs, app: bundle, key: key)
    let sampler = self.sampler
    media.openWindow(id: id, display: display, group: groupIDs) { [weak sampler] in
      sampler?.latestFrame(window: id) ?? remoteFrame
    }
    // Windows announced again after a resume don't take the focus: the one key on the local
    // computer keeps it (restored once they are all back, in `track()`).
    if resumeKnown == nil {
      focusedWindowID = id
      media.focus(key)
    }
    measureStyle(id: id, pid: pid, bundle: bundle, title: resolvedTitle, initialToolbar: hasTB)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
      self?.syncDockMenuIfNeeded(pid: pid, bundle: bundle, force: true)
    }
  }

  func closeStream(_ id: CGWindowID) {
    guard let stream = streams.removeValue(forKey: id) else { return }
    hoverStamps[id] = nil
    axTitles[id] = nil
    windowKinds[id] = nil
    clampStamps[id] = nil
    nonAXWindowStamps[id] = nil
    rescuingWindowIDs[id] = nil
    offDisplayStamps[id] = nil
    axDeferStamps[id] = nil
    placeLock.lock()
    pendingPlaces[id] = nil
    appliedSeq[id] = nil
    placeLock.unlock()
    sampler.clearWindow(id)
    if focusedWindowID == id { focusedWindowID = 0 }
    wire.send(["t": "wclose", "id": id])
    media?.closeStream(stream.key)
  }
}
