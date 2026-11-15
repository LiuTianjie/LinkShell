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
  static func distanceSquared(_ rect: CGRect, _ point: CGPoint) -> CGFloat {
    let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
    let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
    return dx * dx + dy * dy
  }

  func mirror(remote point: CGPoint) -> Mirror? {
    mirrors.first { $0.remote.contains(point) }
  }

  func mirror(local rect: CGRect) -> Mirror? {
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

  func axWindow(pid: pid_t, id: CGWindowID) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(FusionRemoteSession.axApp(pid), kAXWindowsAttribute as CFString, &value) == .success,
          let windows = value as? [AXUIElement] else { return nil }
    return windows.first { var w: CGWindowID = 0; return _AXUIElementGetWindow($0, &w) == .success && w == id }
  }

  /// Classifies a `layer == 0` window once via Accessibility so Chromium/Electron/AppKit borderless child
  /// overlays (such as Google Chrome's omnibox autocomplete dropdown, Find bar, status/permission bubbles)
  /// are recognized as child auxiliary overlays of their parent browser window rather than separate root windows!
  func classifyAXWindow(pid: pid_t, id: CGWindowID, now: Double) -> AXWindowKind {
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

  func track() {
    // Nothing can be told while there is no connection; the next `track()` after a resume sees it all.
    guard !paused, !ended else { return }
    let gone = fused.filter { pid in
      guard let app = NSRunningApplication(processIdentifier: pid) else { return true }
      return app.isTerminated
    }
    if !gone.isEmpty {
      for pid in gone {
        if let bundle = pidToBundle.removeValue(forKey: pid) {
          let stillAlive = fused.contains { $0 != pid && pidToBundle[$0] == bundle }
          if !stillAlive { wire.send(["t": "app.exited", "app": bundle]) }
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
          if originalFrames[id] == nil { originalFrames[id] = (pid, frame) }
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
      lastPopupMirrors = Set(raw.filter { popups.contains($0.id) }.map(\.mirror.index))
      let warm = prewarmUntil > CACurrentMediaTime()
      let busy = lastPopupMirrors
      media?.setOverlaysActive { warm || busy.contains($0) }
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
          media?.moveWindow(existing.key, to: target, group: group)
        } else if existing.groupIDs != group {
          existing.groupIDs = group
          streams[r.id] = existing
          media?.updateGroup(existing.key, group)
        }
      } else {
        openStream(r.id, pid: r.pid, bundle: r.bundle, title: r.title, mirror: r.mirror, groupIDs: group, remoteFrame: r.frame, local: r.local)
      }
    }
    // After a resume: windows that closed while the connection was down are closed there too,
    // and the window that was in use gets its full rate back.
    if let known = resumeKnown, displayReady, !rebuilding, media != nil {
      resumeKnown = nil
      for id in known where streams[id] == nil { wire.send(["t": "wclose", "id": id]) }
      media?.focus(streams[focusedWindowID]?.key)
    }
    var hiddenNow: Set<String> = []
    for id in Array(streams.keys) where !rootSet.contains(id) {
      if let rescueUntil = rescuingWindowIDs[id], now < rescueUntil { continue }
      // A hidden app's windows are hidden, not closed: they come back when it is shown again.
      if let s = streams[id], fused.contains(s.pid), NSRunningApplication(processIdentifier: s.pid)?.isHidden == true {
        hiddenNow.insert(s.app)
        continue
      }
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

    for bundle in hiddenNow.subtracting(hiddenBundles) { wire.send(["t": "app.hidden", "app": bundle, "on": true]) }
    for bundle in hiddenBundles.subtracting(hiddenNow) { wire.send(["t": "app.hidden", "app": bundle, "on": false]) }
    hiddenBundles = hiddenNow

    placeLock.lock()
    let ackSnapshot = appliedSeq
    placeLock.unlock()

    var windowsPayload: [[String: Any]] = []
    for w in raw where (w.root && streams[w.id] != nil) || popups.contains(w.id) {
      var entry: [String: Any] = [
        "id": w.id, "app": w.bundle, "layer": w.layer,
        "own": w.root, "title": w.title, "frame": Fusion.dict(w.local),
        "ack": Int(ackSnapshot[w.id] ?? 0),
      ]
      if !w.root {
        // Associate popup menu with the closest root window of the same app (plus relative offset) so that app's Stub aligns it 1:1.
        if let parent = roots.filter({ $0.pid == w.pid }).min(by: {
          Self.distanceSquared($0.frame, CGPoint(x: w.frame.midX, y: w.frame.minY)) < Self.distanceSquared($1.frame, CGPoint(x: w.frame.midX, y: w.frame.minY))
        }) {
          entry["parent"] = parent.id
          entry["offset"] = ["x": Double(w.frame.minX - parent.frame.minX), "y": Double(w.frame.minY - parent.frame.minY)]
        }
      }
      windowsPayload.append(entry)
    }
    guard let data = try? JSONSerialization.data(withJSONObject: windowsPayload),
          let text = String(data: data, encoding: .utf8), text != lastLayout else { return }
    lastLayout = text
    wire.send(["t": "layout", "windows": windowsPayload])
  }


  /// The AX walk runs on `axQueue`: a hung app costs that queue its timeout, never the main thread
  /// that routes every window's layout and signalling.
  func rescueOffDesktopWindows() {
    guard !ended, let main = mirrors.first, !rescueScanRunning else { return }
    let now = CACurrentMediaTime()
    rescuingWindowIDs = rescuingWindowIDs.filter { $0.value > now }
    let pids = Array(fused)
    let skip = Set(rescuingWindowIDs.keys)
    rescueScanRunning = true
    axQueue.async { [weak self] in
      var found: [(pid: pid_t, wid: CGWindowID, element: AXUIElement, fullScreen: Bool)] = []
      for pid in pids {
        var winsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(FusionRemoteSession.axApp(pid), kAXWindowsAttribute as CFString, &winsRef) == .success,
              let wins = winsRef as? [AXUIElement] else { continue }
        for w in wins {
          var wid: CGWindowID = 0
          guard _AXUIElementGetWindow(w, &wid) == .success, wid != 0, !skip.contains(wid) else { continue }
          var fsRef: CFTypeRef?
          if AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &fsRef) == .success, (fsRef as? Bool) == true {
            found.append((pid, wid, w, true))
            continue
          }
          var minRef: CFTypeRef?
          if AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute as CFString, &minRef) == .success, (minRef as? Bool) == true {
            found.append((pid, wid, w, false))
          }
        }
      }
      DispatchQueue.main.async {
        guard let self else { return }
        self.rescueScanRunning = false
        guard !self.ended else { return }
        let at = CACurrentMediaTime()
        for item in found {
          if let until = self.rescuingWindowIDs[item.wid], at < until { continue }
          let wid = item.wid, w = item.element
          if item.fullScreen {
            let wasLive = self.streams[wid] != nil
            self.rescuingWindowIDs[wid] = at + 2.2
            Fusion.log("rescuing window \(wid) (pid \(item.pid)) out of remote AXFullScreen Space")
            self.axQueue.async { AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, kCFBooleanFalse) }
            let remoteRect = main.remote
            let topInset = min(max(0, main.menuBarHeight), 40)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) { [weak self] in
              guard let self, !self.ended else { return }
              self.axQueue.async {
                var pt = CGPoint(x: remoteRect.minX + 60, y: remoteRect.minY + topInset + 40)
                AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &pt)!)
              }
              if wasLive {
                self.wire.send(["t": "fullscreen", "id": wid, "on": true])
              }
              self.track()
            }
          } else {
            self.rescuingWindowIDs[wid] = at + 1.5
            self.axQueue.async { AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse) }
            if self.streams[wid] != nil {
              self.wire.send(["t": "minimize", "id": wid])
            }
          }
        }
      }
    }
  }

  static func liveCGWindowBounds(_ id: CGWindowID) -> CGRect? {
    guard let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]])?.first,
          let bounds = info[kCGWindowBounds as String] as? [String: Any] else { return nil }
    return CGRect(dictionaryRepresentation: bounds as CFDictionary)
  }
}

extension FusionRemoteSession {
  func focus(_ id: CGWindowID) {
    // Popups (menus, palettes) also become key locally; they are not window streams, and treating
    // them as focus would drop every real window to its background frame rate mid-menu.
    guard let stream = streams[id] else { return }
    noteUserAction(pid: stream.pid)
    if !clipboard.armed {
      // What the remote had copied before Fusion began is not pushed over the local clipboard.
      clipboard.observe(changeCount: NSPasteboard.general.changeCount)
      clipboard.armed = true
    }
    focusedWindowID = id
    media?.focus(stream.key)
    let candidatePids = (streams[id].map { [$0.pid] } ?? []) + Array(fused)
    for pid in candidatePids {
      guard let w = axWindow(pid: pid, id: id) else { continue }
      if let app = NSRunningApplication(processIdentifier: pid) {
        _ = app.activate(options: [.activateIgnoringOtherApps])
      }
      AXUIElementSetAttributeValue(FusionRemoteSession.axApp(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
      AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
      AXUIElementSetAttributeValue(w, kAXFocusedAttribute as CFString, kCFBooleanTrue)
      AXUIElementPerformAction(w, kAXRaiseAction as CFString)
      if let bundle = pidToBundle[pid] ?? streams[id]?.app {
        dockMenuStamps[bundle] = 0
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
          self?.syncDockMenuIfNeeded(pid: pid, bundle: bundle)
        }
      }
      return
    }
  }
}
