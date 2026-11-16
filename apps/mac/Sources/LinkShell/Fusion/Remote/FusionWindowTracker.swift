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
    let before = windowKinds[id]
    if let cached = before {
      // A new window is listed within a moment, and its titlebar buttons may attach right after
      // creation. Windows that never enter AX (or genuinely stay borderless) back off exponentially.
      if cached.exists && cached.isStandardRoot { return cached }
      if cached.exists && cached.rechecks >= 5 { return cached }
      let attempts = cached.exists ? cached.rechecks : cached.misses
      let wait = attempts < 5 ? 0.15 : min(2, 0.15 * pow(2, Double(attempts - 4)))
      if now - cached.checkedAt < wait { return cached }
    }
    guard let w = axWindow(pid: pid, id: id) else {
      let miss = AXWindowKind(exists: false, isStandardRoot: false, checkedAt: now, misses: (before?.misses ?? 0) + 1, rechecks: 0)
      windowKinds[id] = miss
      return miss
    }
    let isStandardRoot = Self.isStandardAXElement(w)
    let kind = AXWindowKind(exists: true, isStandardRoot: isStandardRoot, checkedAt: now, misses: 0, rechecks: isStandardRoot ? 0 : (before?.rechecks ?? 0) + 1)
    windowKinds[id] = kind
    return kind
  }

  static func isStandardAXElement(_ w: AXUIElement) -> Bool {
    var subRef: CFTypeRef?
    let subrole = AXUIElementCopyAttributeValue(w, kAXSubroleAttribute as CFString, &subRef) == .success ? (subRef as? String ?? "") : ""
    if subrole == "AXStandardWindow" { return true }
    func hasAttr(_ attr: String) -> Bool {
      var ref: CFTypeRef?
      return AXUIElementCopyAttributeValue(w, attr as CFString, &ref) == .success && ref != nil
    }
    return hasAttr(kAXCloseButtonAttribute as String)
      || hasAttr(kAXMinimizeButtonAttribute as String)
      || hasAttr(kAXZoomButtonAttribute as String)
      || hasAttr(kAXFullScreenButtonAttribute as String)
  }

  static func axElementBounds(_ w: AXUIElement) -> CGRect? {
    var posRef: CFTypeRef?; var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &sizeRef) == .success,
          let pv = posRef, let sv = sizeRef else { return nil }
    var pt = CGPoint.zero; var sz = CGSize.zero
    guard AXValueGetValue(pv as! AXValue, .cgPoint, &pt),
          AXValueGetValue(sv as! AXValue, .cgSize, &sz),
          sz.width > 1, sz.height > 1 else { return nil }
    return CGRect(origin: pt, size: sz)
  }

  /// Moves (and clamps if larger than the virtual display) an off-display AX window onto `mirror`
  /// on `placeQueue` so AX IPC never blocks the main thread and oversized windows don't snap back.
  func pullWindowOntoMirror(pid: pid_t, id: CGWindowID, frame: CGRect, mirror: Mirror) {
    let remote = mirror.remote
    let topInset = min(max(0, mirror.menuBarHeight), 40)
    let maxW = max(200, remote.width - 20)
    let maxH = max(140, remote.height - topInset - 20)
    let targetW = min(frame.width, maxW)
    let targetH = min(frame.height, maxH)
    let needsResize = targetW < frame.width - 1 || targetH < frame.height - 1
    let targetX = max(remote.minX + 10, min(remote.maxX - targetW - 10, remote.midX - targetW / 2))
    let targetY = max(remote.minY + topInset + 12, min(remote.maxY - targetH - 10, remote.midY - targetH / 2))
    placeQueue.async { [weak self] in
      guard let self, !self.ended, let w = self.axWindow(pid: pid, id: id) else { return }
      var p = CGPoint(x: targetX, y: targetY)
      var s = CGSize(width: targetW, height: targetH)
      AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &p)!)
      if needsResize {
        AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &s)!)
        AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &p)!)
      }
      self.sampler.sampleNow()
      DispatchQueue.main.async { [weak self] in self?.track() }
    }
  }

  func track() {
    // Nothing can be told while there is no connection; the next `track()` after a resume sees it all.
    guard !paused, !ended else { return }
    let gone = fused.filter { FusionProtocol.processEnded($0) }
    if !gone.isEmpty {
      fused.subtract(gone)
      for pid in gone {
        Fusion.log("app \(pidToBundle[pid] ?? "?") (\(pid)) exited")
        if let bundle = pidToBundle.removeValue(forKey: pid) {
          if fusedBundles.contains(bundle) {
            for live in NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
            where !live.isTerminated && !FusionProtocol.processEnded(live.processIdentifier) {
              pidToBundle[live.processIdentifier] = bundle
              fused.insert(live.processIdentifier)
            }
          }
          let stillAlive = fused.contains { pidToBundle[$0] == bundle }
          if !stillAlive {
            fusedBundles.remove(bundle)
            wire.send(["t": "app.exited", "app": bundle])
          }
        }
      }
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
      let layer = info[kCGWindowLayer as String] as? Int ?? 0
      let alpha = info[kCGWindowAlpha as String] as? Double ?? 1.0
      guard alpha > 0.05 else { continue }
      let prevPeak = peakWindowAlpha[id] ?? alpha
      if alpha < prevPeak - 0.04 {
        // AppKit removes a closing NSWindow from kAXWindowsAttribute before WindowServer runs its
        // close fade-out; a window still listed by Accessibility (terminal opacity, dimming) is alive.
        if layer == 0, axWindow(pid: pid, id: id) == nil { continue }
        peakWindowAlpha[id] = alpha
      } else {
        peakWindowAlpha[id] = max(prevPeak, alpha)
      }
      liveIDs.insert(id)
      let probe = CGPoint(x: frame.midX, y: frame.minY + min(frame.height / 2, 24))
      guard let mirror = mirror(remote: probe) ?? mirror(remote: CGPoint(x: frame.midX, y: frame.midY)) ?? mirrors.first(where: { $0.remote.intersects(frame) }) else {
        // Both already-shown windows that wandered off and newly opened windows whose app restored
        // saved bounds onto the physical display (e.g. Chrome opening a profile window after its
        // Profile Picker closes) are retried until they land on a virtual display, never abandoned
        // after a single attempt!
        let shown = streams[id] != nil
        if shown {
          rescuingWindowIDs[id] = max(rescuingWindowIDs[id] ?? 0, now + 1.8)
        }
        let retryInterval = shown ? 0.5 : 0.35
        if layer == 0, shown || (frame.width >= 160 && frame.height >= 100),
           now - (offDisplayStamps[id] ?? 0) >= retryInterval, let main = mirrors.first {
          let k = classifyAXWindow(pid: pid, id: id, now: now)
          if shown || k.isStandardRoot || (k.exists && !pidsWithStandardRoot.contains(pid)) {
            offDisplayStamps[id] = now
            moved.insert(id)
            if shown { Fusion.log("w\(id): off the virtual displays at \(frame), bringing it back") }
            if originalFrames[id] == nil, !shown { originalFrames[id] = (pid, frame) }
            pullWindowOntoMirror(pid: pid, id: id, frame: frame, mirror: main)
          }
        }
        continue
      }
      offDisplayStamps[id] = nil
      spaceRescueStamps[id] = nil
      var kind: AXWindowKind?
      // A shown window stays classified when it is resized small, or it would stop being one.
      if layer == 0 && ((frame.width >= 160 && frame.height >= 100) || streams[id] != nil) {
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
        if streams[id] != nil, k.exists {
          // Once shown, a window stays one: an app opening a standard window (a prompt, a quick
          // entry box) must not demote its borderless main window to a popup and close it.
          root = true
        } else if k.isStandardRoot {
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
      var reason = "gone"
      if let s = streams[id], fused.contains(s.pid), !rawOnScreenIDs.contains(id) {
        reason = "off screen"
        var listRef: CFTypeRef?
        let listed = AXUIElementCopyAttributeValue(FusionRemoteSession.axApp(s.pid), kAXWindowsAttribute as CFString, &listRef)
        if listed != .success, Self.liveCGWindowBounds(id) != nil, now - (axDeferStamps[id] ?? now) < 3 {
          // The app did not answer (busy, in the background): whether this window was minimized or
          // went full screen can't be told yet, and closing it would be the one wrong answer.
          if axDeferStamps[id] == nil { axDeferStamps[id] = now; Fusion.log("w\(id): off screen, app not answering (\(listed.rawValue)): waiting") }
          continue
        }
        axDeferStamps[id] = nil
        if let w = axWindow(pid: s.pid, id: id) {
          var fsRef: CFTypeRef?
          let isFS = AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &fsRef) == .success && (fsRef as? Bool) == true
          var minRef: CFTypeRef?
          let isMin = AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute as CFString, &minRef) == .success && (minRef as? Bool) == true
          if isFS || isMin {
            rescueOffDesktopWindows()
            continue
          }
          // Still listed by Accessibility (an ordered-out or closed NSWindow is removed immediately):
          // the remote Mac switched Spaces or the window moved to an inactive Space — pull it back!
          let started = spaceRescueStamps[id] ?? now
          spaceRescueStamps[id] = started
          if now - started < 2.5 {
            if let main = mirrors.first, now - (offDisplayStamps[id] ?? 0) >= 0.45 {
              offDisplayStamps[id] = now
              let bounds = Self.axElementBounds(w) ?? Self.liveCGWindowBounds(id) ?? CGRect(x: 0, y: 0, width: 900, height: 640)
              Fusion.log("w\(id): alive in AX on another Space (\(bounds)), pulling onto virtual display")
              pullWindowOntoMirror(pid: s.pid, id: id, frame: bounds, mirror: main)
            }
            continue
          }
        }
      } else if liveIDs.contains(id) {
        reason = "no longer a window of its own"
      } else if rawOnScreenIDs.contains(id) {
        reason = "closing (fading out)"
      }
      if let s = streams[id] { Fusion.log("w\(id) (\(s.app)) closed: \(reason)") }
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
  /// that routes every window's layout and signalling. Rescues windows from Full-Screen Spaces,
  /// Dock minimization, and inactive Desktop Spaces / physical screens back onto `main`.
  func rescueOffDesktopWindows() {
    guard !ended, !mirrors.isEmpty, !rescueScanRunning else { return }
    let now = CACurrentMediaTime()
    rescuingWindowIDs = rescuingWindowIDs.filter { $0.value > now }
    let pids = Array(fused)
    let skip = Set(rescuingWindowIDs.keys)
    let mirrorRects = mirrors.map(\.remote)
    rescueScanRunning = true
    enum RescueMode {
      case fullScreen
      case minimized
      case offDisplay(CGRect)
    }
    axQueue.async { [weak self] in
      var found: [(pid: pid_t, wid: CGWindowID, element: AXUIElement, mode: RescueMode)] = []
      for pid in pids {
        var winsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(FusionRemoteSession.axApp(pid), kAXWindowsAttribute as CFString, &winsRef) == .success,
              let wins = winsRef as? [AXUIElement] else { continue }
        for w in wins {
          var wid: CGWindowID = 0
          guard _AXUIElementGetWindow(w, &wid) == .success, wid != 0, !skip.contains(wid) else { continue }
          var fsRef: CFTypeRef?
          if AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &fsRef) == .success, (fsRef as? Bool) == true {
            found.append((pid, wid, w, .fullScreen))
            continue
          }
          var minRef: CFTypeRef?
          if AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute as CFString, &minRef) == .success, (minRef as? Bool) == true {
            found.append((pid, wid, w, .minimized))
            continue
          }
          if let rect = Self.axElementBounds(w), rect.width >= 160, rect.height >= 100,
             !mirrorRects.contains(where: { $0.intersects(rect) }), Self.isStandardAXElement(w) {
            found.append((pid, wid, w, .offDisplay(rect)))
          }
        }
      }
      DispatchQueue.main.async {
        guard let self else { return }
        self.rescueScanRunning = false
        guard !self.ended, let currentMain = self.mirrors.first else { return }
        let at = CACurrentMediaTime()
        for item in found {
          if let until = self.rescuingWindowIDs[item.wid], at < until { continue }
          let wid = item.wid, w = item.element
          switch item.mode {
          case .fullScreen:
            let wasLive = self.streams[wid] != nil
            self.rescuingWindowIDs[wid] = at + 2.4
            Fusion.log("rescuing window \(wid) (pid \(item.pid)) out of remote AXFullScreen Space")
            self.axQueue.async { AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, kCFBooleanFalse) }
            for delay in [0.65, 1.15] {
              DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, !self.ended, let targetMain = self.mirrors.first else { return }
                let curBounds = Self.liveCGWindowBounds(wid) ?? CGRect(x: 0, y: 0, width: 1000, height: 700)
                self.pullWindowOntoMirror(pid: item.pid, id: wid, frame: curBounds, mirror: targetMain)
                if delay < 0.8, wasLive {
                  self.wire.send(["t": "fullscreen", "id": wid, "on": true])
                }
              }
            }
          case .minimized:
            self.rescuingWindowIDs[wid] = at + 1.5
            self.axQueue.async { AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse) }
            if self.streams[wid] != nil {
              self.wire.send(["t": "minimize", "id": wid])
            }
          case .offDisplay(let rect):
            guard at - (self.offDisplayStamps[wid] ?? 0) >= 0.45 else { continue }
            self.offDisplayStamps[wid] = at
            self.moved.insert(wid)
            if self.originalFrames[wid] == nil, self.streams[wid] == nil {
              self.originalFrames[wid] = (item.pid, rect)
            }
            Fusion.log("rescuing off-display AX window \(wid) (pid \(item.pid)) at \(rect) onto virtual display")
            self.pullWindowOntoMirror(pid: item.pid, id: wid, frame: rect, mirror: currentMain)
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
